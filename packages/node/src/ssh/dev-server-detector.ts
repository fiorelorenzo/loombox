import { PortForwardRuleManager, type PortForwardRule } from './port-forward-rules';
import type { PortForwardTransport } from './port-forward-transport';

/**
 * Automatic dev-server detection + forwarding on an `ssh:` target (issue
 * #94, SPEC §7.8 / §16: "Auto port-forward — emdash `preview-servers/
 * terminal-url-detector.ts` (PTY-output URL sniff + probe, not port-table
 * scan) + `port-forward-tunnel.ts`", reimplemented clean-room). Two pieces:
 *
 * - {@link parseDevServerBanner}: pure text matching against one line of a
 *   session's stdout, no I/O — recognizes the "Local: <url>" shape vite,
 *   Next.js, and most other JS dev servers print once they're up.
 * - {@link DevServerForwardDetector}: feeds lines through the parser and,
 *   once one matches, *probes* the remote destination is actually accepting
 *   connections (opening and immediately closing a real forward channel —
 *   not scanning a port table) before ever exposing a local forwarded port
 *   for it, then auto-creates a rule via `./port-forward-rules.ts` — the
 *   exact same manager `#93`'s manual rules go through, tagged `origin:
 *   'auto'` so a client can tell the two apart.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** Strips ANSI SGR escape sequences ("ESC[...m") that chalk/picocolors-style banner formatting glues directly around the URL. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching the ESC control character to strip terminal color codes
  return text.replace(/\u001b?\[[0-9;]*m/g, '');
}

export interface DevServerBannerMatch {
  /** The URL exactly as printed (after stripping ANSI codes), e.g. `"http://localhost:5173/"`. */
  url: string;
  host: string;
  port: number;
  /** Path + query from the printed URL, e.g. `"/"` or `"/app?x=1"` — preserved in the local URL reported back to the session. */
  pathAndQuery: string;
}

const LOCAL_BANNER_RE = /Local:\s*(\S+)/i;

/**
 * Matches one line of a session's stdout against the "Local: <url>" shape
 * vite/Next.js/most JS dev servers print (issue #94's acceptance: "detected
 * from its stdout, not from scanning a port table"). Only ever matches a
 * `http(s)://` URL whose host is one of the remote host's own loopback
 * spellings — a dev server printing a LAN/public URL is deliberately never
 * auto-forwarded (nothing distinguishes "the user's own machine" from "some
 * other reachable host" there, and this feature is specifically about
 * reaching the remote's own loopback-bound dev server). Returns `undefined`
 * for anything that doesn't match, including a malformed URL after `Local:`.
 */
export function parseDevServerBanner(line: string): DevServerBannerMatch | undefined {
  const match = LOCAL_BANNER_RE.exec(line);
  if (!match) return undefined;

  const raw = stripAnsi(match[1] ?? '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return undefined;

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return {
    url: raw,
    host: parsed.hostname,
    port,
    pathAndQuery: `${parsed.pathname}${parsed.search}`,
  };
}

export interface DevServerForward {
  detection: DevServerBannerMatch;
  rule: PortForwardRule;
  /** The URL to open locally (or send to the phone) — `rule`'s forwarded local host/port with the banner's own path/query preserved. */
  localUrl: string;
}

export interface DevServerForwardDetectorOptions {
  targetId: string;
  /** How often to retry the reachability probe. Default 200ms. */
  probeIntervalMs?: number;
  /** How many probe attempts before giving up on a detected banner (issue #94: a probe confirms reachability before ever exposing the forward — this bounds how long a bad/stale banner blocks). Default 25 (≈5s at the default interval). */
  probeMaxAttempts?: number;
  /** Called once a detected banner is successfully auto-forwarded — the session-facing hook for "report the resulting local URL back to the session so the user can open it". */
  onForward?: (forward: DevServerForward) => void;
  /** Called when a detected banner's remote port never became reachable within the probe budget — best-effort observability, never thrown. */
  onProbeFailed?: (detection: DevServerBannerMatch) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probes whether `host:port` is actually accepting connections through
 * `transport`, by opening a real forward channel and immediately closing it
 * — never by scanning a remote port table (SPEC §16's explicit "not
 * port-table scan" note). Retries on failure (a banner can print a moment
 * before the socket is actually accepting) up to `maxAttempts`, waiting
 * `intervalMs` between tries.
 */
async function probeReachable(
  transport: PortForwardTransport,
  host: string,
  port: number,
  { intervalMs, maxAttempts }: { intervalMs: number; maxAttempts: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const channel = await transport.openForwardChannel('127.0.0.1', 0, host, port);
      channel.destroy();
      return true;
    } catch {
      if (attempt < maxAttempts - 1) {
        await sleep(intervalMs);
      }
    }
  }
  return false;
}

/**
 * Feeds a session's stdout, one line at a time, through
 * {@link parseDevServerBanner} and auto-forwards the first confirmed-live
 * match (issue #94). One detector instance is scoped to a single session on
 * a single `ssh:` target — construct a fresh one per session.
 */
export class DevServerForwardDetector {
  constructor(
    private readonly transport: PortForwardTransport,
    private readonly ruleManager: PortForwardRuleManager,
    private readonly options: DevServerForwardDetectorOptions,
  ) {}

  /**
   * Processes one stdout line. Resolves `undefined` immediately for a
   * non-matching line. For a matching line, probes the remote destination
   * (see {@link probeReachable}) and, once confirmed reachable, creates an
   * `origin: 'auto'` rule via `PortForwardRuleManager` — reusing an
   * already-active rule for the same remote destination instead of creating
   * a duplicate tunnel (a dev server can reprint its own banner, e.g. on
   * HMR restart). Resolves `undefined` (no rule created) if the probe budget
   * is exhausted without the port ever becoming reachable.
   */
  async feed(line: string): Promise<DevServerForward | undefined> {
    const detection = parseDevServerBanner(line);
    if (!detection) return undefined;

    // The banner's host is always some loopback spelling as seen on the
    // remote itself; normalize to 127.0.0.1 for the actual forward
    // destination (`::1`, `0.0.0.0`, and `localhost` all resolve to the same
    // remote-local socket in practice for this purpose), while `detection`
    // above keeps the literal parsed host for reporting.
    const remoteHost = '127.0.0.1';

    const existing = this.ruleManager.findByRemote(
      this.options.targetId,
      remoteHost,
      detection.port,
    );
    if (existing) {
      return { detection, rule: existing, localUrl: this.buildLocalUrl(existing, detection) };
    }

    const reachable = await probeReachable(this.transport, remoteHost, detection.port, {
      intervalMs: this.options.probeIntervalMs ?? 200,
      maxAttempts: this.options.probeMaxAttempts ?? 25,
    });
    if (!reachable) {
      this.options.onProbeFailed?.(detection);
      return undefined;
    }

    const rule = await this.ruleManager.create({
      targetId: this.options.targetId,
      remoteHost,
      remotePort: detection.port,
      origin: 'auto',
    });

    const forward: DevServerForward = {
      detection,
      rule,
      localUrl: this.buildLocalUrl(rule, detection),
    };
    this.options.onForward?.(forward);
    return forward;
  }

  private buildLocalUrl(rule: PortForwardRule, detection: DevServerBannerMatch): string {
    return `http://${rule.localHost}:${rule.localPort}${detection.pathAndQuery}`;
  }
}
