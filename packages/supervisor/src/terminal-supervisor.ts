import { spawn as spawnPty, type IPty } from 'node-pty';

/**
 * Owns every interactive PTY terminal spawned on this host (SPEC §7.5;
 * issues #172/#173/#174), the sibling of `AgentSupervisor`'s ACP child-
 * process ownership (`AGENTS.md`: "a PTY is used only for the interactive
 * terminals" — this is that PTY). A terminal started here keeps running
 * independent of any single caller for as long as its shell is alive:
 * `open()` spawns exactly once per `terminalId`, and closing one terminal
 * never affects any other (issue #173's acceptance criterion) since each is
 * tracked independently, keyed by its own `terminalId`. Sharing a working
 * directory across several terminals for the same project (issue #173) is
 * simply a property of the `cwd` a caller passes to each `open()` call —
 * this class needs no special-casing for it.
 *
 * Deliberately decoupled from *how* a PTY is backed: {@link open} spawns a
 * real local PTY via `node-pty` (the `local` target case), but
 * {@link openWithPty} adopts any already-constructed {@link PtyLike} — the
 * seam `@loombox/node` uses to hand in an `ssh:` target's terminal (an
 * `ssh2` shell-channel adapter), so this package never needs to know
 * anything about SSH.
 */

/** The minimal PTY surface this class actually drives — node-pty's `IPty` satisfies it directly; an `ssh:` shell-channel adapter (`@loombox/node`) implements it without depending on `node-pty` at all. */
export interface PtyLike {
  readonly pid?: number;
  /** Registers a listener for output chunks; returns an unsubscribe function. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Registers a listener for the PTY's own exit (the shell process exited on its own); returns an unsubscribe function. */
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalExitEvent {
  exitCode: number;
  signal?: number;
}

export interface TerminalSpawnOptions {
  terminalId: string;
  /** The program to run, e.g. `'bash'`. */
  file: string;
  args?: string[];
  /** Working directory the shell starts in — the session's project root/worktree (issue #173's "sharing the session's working directory"). */
  cwd: string;
  cols: number;
  rows: number;
  /** Extra environment variables merged over this process's own environment. */
  env?: Record<string, string>;
}

/** Injectable PTY factory (tests/an `ssh:` backend can supply their own); defaults to {@link defaultPtySpawn}, a real local `node-pty` spawn. */
export type PtySpawnFn = (options: TerminalSpawnOptions) => PtyLike;

/**
 * Wraps `node-pty`'s real `spawn()` into {@link PtyLike}. Runs in `node-pty`'s
 * default UTF-8 string mode (rather than `encoding: null`/raw `Buffer` mode)
 * so its typings stay accurate; output is re-encoded to `Uint8Array` at this
 * boundary so every caller above this module deals in bytes uniformly,
 * matching the wire's `terminalDataPayloadV1` (base64 bytes) and the
 * existing display-only `TerminalOutput` component's `Uint8Array[]` shape.
 */
function defaultPtySpawn(options: TerminalSpawnOptions): PtyLike {
  const pty: IPty = spawnPty(options.file, options.args ?? [], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as Record<string, string>,
  });

  return {
    pid: pty.pid,
    onData(listener) {
      const disposable = pty.onData((data: string) => listener(new TextEncoder().encode(data)));
      return () => disposable.dispose();
    },
    onExit(listener) {
      const disposable = pty.onExit((event) => listener(event));
      return () => disposable.dispose();
    },
    write(data) {
      // `IPty.write` accepts a `Buffer` directly, so a `Uint8Array` chunk
      // (typed input arriving off the wire as decoded base64 bytes) never
      // has to round-trip through a lossy string decode first.
      pty.write(typeof data === 'string' ? data : Buffer.from(data));
    },
    resize(cols, rows) {
      pty.resize(cols, rows);
    },
    kill() {
      pty.kill();
    },
  };
}

/** One open terminal: a thin, testable wrapper around a {@link PtyLike} that fans its data/exit events out to any number of listeners (mirrors `AgentSession`'s own multi-listener event shape) rather than the single-callback shape `PtyLike` itself exposes. */
export class TerminalSession {
  readonly terminalId: string;
  private readonly pty: PtyLike;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>();
  private _closed = false;

  constructor(terminalId: string, pty: PtyLike) {
    this.terminalId = terminalId;
    this.pty = pty;
    pty.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    pty.onExit((event) => {
      this._closed = true;
      for (const listener of this.exitListeners) listener(event);
    });
  }

  get pid(): number | undefined {
    return this.pty.pid;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Registers a listener for output chunks; returns an unsubscribe function. */
  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /** Registers a listener for this terminal's exit, whether from {@link close} or the shell exiting on its own; returns an unsubscribe function. */
  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Streams one chunk of typed input to this terminal's stdin. A no-op once closed. */
  write(data: Uint8Array | string): void {
    if (this._closed) return;
    this.pty.write(data);
  }

  /** Renegotiates this terminal's PTY window size. A no-op once closed. */
  resize(cols: number, rows: number): void {
    if (this._closed) return;
    this.pty.resize(cols, rows);
  }

  /** Deliberately terminates this terminal. Idempotent. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.pty.kill();
  }
}

/**
 * Owns every open terminal on this host, keyed by `terminalId`. See this
 * module's own doc comment for the local/`ssh:` backend split.
 */
export class TerminalSupervisor {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly spawnPty: PtySpawnFn;

  constructor(options: { spawnPty?: PtySpawnFn } = {}) {
    this.spawnPty = options.spawnPty ?? defaultPtySpawn;
  }

  /** Spawns a new local terminal (via this supervisor's `PtySpawnFn`, `node-pty` by default) and holds it alive. Throws if `terminalId` is already open. */
  open(options: TerminalSpawnOptions): TerminalSession {
    if (this.sessions.has(options.terminalId)) {
      throw new Error(`TerminalSupervisor: terminal "${options.terminalId}" is already open`);
    }
    const pty = this.spawnPty(options);
    return this.adopt(options.terminalId, pty);
  }

  /** Adopts an already-constructed {@link PtyLike} under `terminalId` (the `ssh:` backend seam — see this module's doc comment). Throws if `terminalId` is already open. */
  openWithPty(terminalId: string, pty: PtyLike): TerminalSession {
    if (this.sessions.has(terminalId)) {
      throw new Error(`TerminalSupervisor: terminal "${terminalId}" is already open`);
    }
    return this.adopt(terminalId, pty);
  }

  private adopt(terminalId: string, pty: PtyLike): TerminalSession {
    const session = new TerminalSession(terminalId, pty);
    this.sessions.set(terminalId, session);
    session.onExit(() => {
      this.sessions.delete(terminalId);
    });
    return session;
  }

  /** Looks up a still-open terminal by id. */
  get(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  /** Every terminal currently held by this supervisor. */
  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  /** Streams one chunk of typed input to `terminalId`'s stdin. A silent no-op for an unknown/already-closed id, mirroring `close`/`resize` below. */
  write(terminalId: string, data: Uint8Array | string): void {
    this.sessions.get(terminalId)?.write(data);
  }

  /** Renegotiates `terminalId`'s PTY window size. A silent no-op for an unknown/already-closed id. */
  resize(terminalId: string, cols: number, rows: number): void {
    this.sessions.get(terminalId)?.resize(cols, rows);
  }

  /** Deliberately terminates `terminalId` and stops tracking it. A silent no-op for an unknown/already-closed id. */
  close(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.close();
    this.sessions.delete(terminalId);
  }

  /** Closes every open terminal (`NodeDaemon.close()`'s shutdown path). */
  closeAll(): void {
    for (const terminalId of [...this.sessions.keys()]) this.close(terminalId);
  }
}
