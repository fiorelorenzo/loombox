import type { PtyLike, TerminalExitEvent } from '@loombox/supervisor';

import {
  evaluateCommandLine,
  logPolicyViolation,
  type PermissionPolicy,
  type PolicyViolation,
} from './permission-policy';

/**
 * Enforces a project's {@link PermissionPolicy} on an interactive terminal
 * (SPEC §7.5/§7.17; issue #256) — wraps any {@link PtyLike} so a denied
 * line is never forwarded to the real shell process at all, whether that
 * shell is a local `node-pty` fork (`TerminalSupervisor.open`) or a remote
 * `ssh2` shell channel (`TerminalSupervisor.openWithPty`, the `ssh:`
 * backend seam) — both plug in identically, matching `PtyLike`'s own
 * "deliberately decoupled from *how* a PTY is backed" design. This is the
 * one enforcement surface this PR actually gates in production today (see
 * `policy-enforced-execution-target.ts`'s doc comment for the honest
 * status of the other candidate, `ExecutionTarget.exec()`).
 *
 * **How a denied line is stopped without breaking live echo.** Every
 * byte typed is still forwarded to the real PTY immediately as it
 * arrives, so the shell's own line-discipline echo keeps working exactly
 * like today (SPEC §7.5's live interactive terminal). This class buffers
 * the same bytes into `lineBuffer` purely to know what the pending,
 * not-yet-submitted line reads. Only once Enter (`\r`/`\n`) arrives does
 * it evaluate that buffered line:
 *   - **allowed** → the Enter byte is forwarded, submitting the line to
 *     the shell exactly as if this class weren't there.
 *   - **denied** → the Enter byte is withheld (so the shell never sees a
 *     complete, submittable line), a `\x15` (Ctrl-U / POSIX `VKILL`) is
 *     sent to the real PTY to erase the shell's own pending input buffer
 *     (visible to the user as their typed line being wiped, exactly like
 *     a restricted shell rejecting a command), and a banner explaining
 *     why is written directly into this terminal's own output stream —
 *     `NodeDaemon.wireTerminalSession()` already forwards every
 *     `onData` chunk to the client as `terminal_output`, so this reuses
 *     that existing, already-encrypted surface rather than inventing a
 *     new one (SPEC §7.17's "logged and surfaced to the user").
 *
 * **The policy is re-read on every submitted line, never snapshotted**
 * (issue #751's "a rule added in the UI takes effect on the next tool
 * call with no node restart"): a terminal is long-lived — it stays open
 * for as long as the user keeps it open, potentially the whole session —
 * so capturing `PermissionPolicy` once at construction time would mean a
 * policy edited mid-terminal-session never applies until that terminal is
 * closed and reopened. `policy` is therefore a resolver
 * (`() => PermissionPolicy`), called fresh inside {@link submitLine} for
 * every Enter, exactly the way `NodeDaemon.getExecutionTarget()` already
 * reads `PermissionPolicyStore.get()` fresh on every project-scoped exec
 * call rather than caching a `PolicyEnforcedExecutionTarget` — this
 * brings the terminal surface to the same "always current" contract.
 *
 * **Named, not closed, gaps** (see the PR description for the full
 * inventory): mid-line cursor edits via arrow keys are not tracked (only
 * append/backspace/Ctrl-C/Ctrl-U are), so an ANSI cursor-movement escape
 * sequence lands in `lineBuffer` as literal bytes rather than being
 * interpreted — this can desync the buffered text from what's on screen,
 * which in practice means a bypass attempt via arrow-key mid-line editing
 * is more likely to *fail* the match than succeed, but is not guaranteed
 * either way. Shell history recall (Ctrl-R, up-arrow) is not intercepted
 * at all: the recalled line only ever reaches the shell's own input
 * buffer via the exact same byte stream this class already gates, so a
 * *plain* recall-and-submit is still caught, but a recall followed by
 * further arrow-key mid-line editing inherits the same cursor-tracking
 * gap above.
 */
export interface PolicyEnforcedPtyOptions {
  inner: PtyLike;
  projectPath: string;
  /** Resolves this project's current policy — called fresh on every submitted line, never cached across this instance's lifetime. See this file's own doc comment. */
  policy: () => PermissionPolicy;
  onViolation?: (violation: PolicyViolation) => void;
}

const ENTER_BYTES = new Set([0x0d, 0x0a]);
const ERASE_BYTES = new Set([0x7f, 0x08]);
const CLEAR_LINE_BYTES = new Set([0x03, 0x04, 0x15]); // Ctrl-C, Ctrl-D, Ctrl-U
const CTRL_U = new Uint8Array([0x15]);

export class PolicyEnforcedPty implements PtyLike {
  readonly pid: number | undefined;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly decoder = new TextDecoder('utf-8');
  private lineBuffer = '';

  constructor(private readonly options: PolicyEnforcedPtyOptions) {
    this.pid = options.inner.pid;
    options.inner.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    return this.options.inner.onExit(listener);
  }

  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const text = this.decoder.decode(bytes, { stream: true });
    // Batches every passthrough byte of one incoming chunk into as few
    // underlying `inner.write()` calls as possible (flushing only at an
    // Enter boundary, which needs its own conditional handling) — still
    // exactly as "live" as today for a real client, which already sends
    // one wire chunk per keystroke or per paste; this just avoids issuing
    // a separate write() syscall per character within a chunk that
    // already arrived atomically.
    let passthrough = '';
    const flush = (): void => {
      if (passthrough.length === 0) return;
      this.options.inner.write(passthrough);
      passthrough = '';
    };
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (ENTER_BYTES.has(code)) {
        flush();
        this.submitLine(ch);
      } else if (ERASE_BYTES.has(code)) {
        this.lineBuffer = this.lineBuffer.slice(0, -1);
        passthrough += ch;
      } else if (CLEAR_LINE_BYTES.has(code)) {
        this.lineBuffer = '';
        passthrough += ch;
      } else {
        this.lineBuffer += ch;
        passthrough += ch;
      }
    }
    flush();
  }

  resize(cols: number, rows: number): void {
    this.options.inner.resize(cols, rows);
  }

  kill(): void {
    this.options.inner.kill();
  }

  private submitLine(enterChar: string): void {
    const line = this.lineBuffer;
    this.lineBuffer = '';
    const decision = evaluateCommandLine(this.options.policy(), line);
    if (decision.allowed) {
      this.options.inner.write(enterChar);
      return;
    }

    const violation: PolicyViolation = {
      projectPath: this.options.projectPath,
      surface: 'terminal',
      dimension: decision.dimension,
      rule: decision.rule,
      matched: decision.matched,
      command: line,
      timestamp: new Date().toISOString(),
    };
    logPolicyViolation(violation);
    this.options.onViolation?.(violation);

    this.options.inner.write(CTRL_U);
    const banner = `\r\n\x1b[31mblocked by permission policy (${violation.dimension} deny rule "${violation.rule}"): ${line}\x1b[0m\r\n`;
    const bannerBytes = new TextEncoder().encode(banner);
    for (const listener of this.dataListeners) listener(bannerBytes);
  }
}
