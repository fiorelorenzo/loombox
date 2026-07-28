import { readFile } from 'node:fs/promises';
import os from 'node:os';
import checkDiskSpace from 'check-disk-space';

import { shQuote } from './ssh/remote-transport';
import type { RemoteTransport } from './ssh/remote-transport';

/**
 * One point-in-time CPU/RAM/disk reading for a target (SPEC §7.16's
 * "resource awareness (CPU/RAM/disk per target)"; issue #253). `healthy` is
 * the proxy for #269's "agent-process health": it's `false` only when the
 * sample itself couldn't be taken (an `ssh:` exec failure, an unreadable
 * disk path) — never merely because usage is high. A target under heavy
 * load but still reachable/exec-able is `healthy: true` with high
 * percentages; that's overload, a different cause than a dead target, and
 * the status view (#269) distinguishes the two. `cpuPercent`/`memPercent`/
 * `diskPercent` are all clamped to `[0, 100]` by {@link clampPercent} —
 * display figures, not raw ratios (CPU load can nominally exceed 100% on an
 * overloaded multi-core host).
 *
 * `cpuPercent` is a **misnomer kept only for wire back-compat**: it has
 * always been (and remains) the 1-minute load average normalized by core
 * count — a run-queue-length proxy (every runnable *and*
 * uninterruptible-sleep task), not CPU utilization; a host can read 100%
 * here while its cores sit mostly idle waiting on disk/network (an 8-core
 * box at load 11 reads "100%" though real utilization may be far lower).
 * {@link ResourceSample.loadPercent} is the exact same figure under its
 * honest name — read that one in new code; `cpuPercent` stays populated
 * (identical value) purely so a peer that predates `loadPercent` keeps
 * reading a working field. `hostname`/`platform`/`arch` are additive
 * identification metadata — a target labeled e.g. "Local" is otherwise
 * indistinguishable across machines (see {@link LocalOsSource.hostname}'s
 * doc comment) — still "routing metadata only" per SPEC §8's boundary:
 * `provisioning.ts`'s doc comment already establishes a hostname isn't a
 * secret that boundary hides.
 */
export interface ResourceSample {
  /**
   * @deprecated Actually the load-average-derived figure {@link ResourceSample.loadPercent}
   * also carries (identical value) — not CPU utilization. Kept only for
   * wire back-compat with a peer that predates `loadPercent`; new code
   * should read `loadPercent` instead. See this interface's own doc
   * comment for the full story.
   */
  cpuPercent: number;
  /**
   * 1-minute load average (`os.loadavg()[0]` locally, `uptime`'s load
   * average over `ssh:`) normalized by core count and clamped to
   * `[0, 100]` — honestly named, unlike the deprecated `cpuPercent` above
   * (same value): a run-queue-length proxy, not CPU utilization. Always
   * populated by this codebase; optional on the wire
   * (`@loombox/protocol`'s `targetHealth.loadPercent`) only so a message
   * from an older peer that predates this field still parses.
   */
  loadPercent: number;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  healthy: boolean;
  /** Milliseconds since epoch (the sampling node's own clock), when this reading was taken. */
  sampledAt: number;
  /**
   * This target's machine hostname (`os.hostname()` locally, `uname -n`
   * over `ssh:`) — lets a UI tell apart two targets that would otherwise
   * share a generic label like "Local" (the reported confusion: unclear
   * whether a target named "Local" is the devbox or someone's Mac).
   * `undefined` only for a peer that predates this field, or the rare case
   * the underlying read itself fails.
   */
  hostname?: string;
  /**
   * `os.platform()`'s value locally (`'linux'`, `'darwin'`, ... —
   * `NodeJS.Platform`), normalized to the same vocabulary over `ssh:`
   * (`uname -s`, lowercased: `"Darwin"` → `"darwin"`).
   */
  platform?: string;
  /**
   * `os.arch()`'s value locally (`'x64'`, `'arm64'`, ...), normalized to
   * the same vocabulary over `ssh:` (`uname -m`, with `x86_64`→`x64` and
   * `aarch64`→`arm64` — the two naming conventions POSIX `uname` and
   * Node's `os.arch()` disagree on for identical hardware).
   */
  arch?: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** The all-zero, `healthy: false` reading a probe returns when it couldn't sample at all — see {@link ResourceSample.healthy}'s doc comment for why this is the "agent-process health" signal, not a usage figure. */
export function failedSample(sampledAt: number): ResourceSample {
  return {
    cpuPercent: 0,
    loadPercent: 0,
    memPercent: 0,
    memUsedBytes: 0,
    memTotalBytes: 0,
    diskPercent: 0,
    diskUsedBytes: 0,
    diskTotalBytes: 0,
    healthy: false,
    sampledAt,
  };
}

/** The subset of `node:os` {@link sampleLocalResources} reads — injectable so tests never depend on this machine's real load/memory/identity. */
export interface LocalOsSource {
  totalmem(): number;
  freemem(): number;
  cpus(): unknown[];
  loadavg(): number[];
  /** `os.hostname()` — see {@link ResourceSample.hostname}'s doc comment for why this is sampled at all: a target labeled "Local" tells a user nothing about which physical machine it is. */
  hostname(): string;
  /** `os.platform()`. */
  platform(): string;
  /** `os.arch()`. */
  arch(): string;
}

export interface LocalResourceProbeOptions {
  /** Filesystem path to check disk space for; defaults to `os.homedir()` (a path guaranteed to exist and live on the target's own primary disk). */
  diskPath?: string;
  now?: () => number;
  osSource?: LocalOsSource;
  checkDiskSpaceFn?: typeof checkDiskSpace;
  /**
   * Reads `/proc/meminfo`'s raw text so {@link sampleLocalResources} can
   * use its `MemAvailable` line instead of `os.freemem()` (which on Linux
   * reports `MemFree` — reclaimable page cache counted as "used", the
   * reason a healthy Linux box used to read 85-90%). Injected so tests can
   * supply synthetic content, or simulate the file being unavailable, wit
   * hout depending on this machine's real `/proc/meminfo`. Defaults to
   * `readFile('/proc/meminfo', 'utf8')` — its rejection on any platform
   * without `/proc` (macOS, the desktop app's own platform) is a plain
   * promise rejection {@link readMemAvailableBytes} already catches, never
   * a special case the caller has to know about.
   */
  readMemInfo?: () => Promise<string>;
}

/**
 * Samples this process's own host: CPU via `os.loadavg()`'s 1-minute load
 * normalized by core count, surfaced honestly as
 * {@link ResourceSample.loadPercent} (a run-queue-length proxy, not
 * utilization — no blocking two-snapshot delta needed, unlike
 * `/proc/stat`-style sampling, which is the very tradeoff that got the
 * now-deprecated `cpuPercent` name wrong in the first place; SPEC §16's
 * grounding notes this differs from emdash's `pidusage`, which measures
 * one process rather than the whole host — per-target sampling here needs
 * the latter since the throttling concern in §7.16 is host-wide OOM risk,
 * not one process's own footprint), RAM via `os.totalmem()` plus Linux's
 * `/proc/meminfo` `MemAvailable` (`MemTotal - MemAvailable` is what "RAM
 * used" means to a human, since `MemAvailable` already excludes
 * reclaimable page/slab cache the way `os.freemem()`'s `MemFree` doesn't —
 * see {@link readMemAvailableBytes}), falling back to `os.freemem()` on any
 * platform or environment without `/proc/meminfo` (macOS included — that
 * read's rejection is caught, never thrown, so the desktop app never
 * crashes over it), and disk via `check-disk-space` (issue #253's
 * grounding — the "novel" part is extending this per-target to `ssh:`
 * hosts, see {@link sampleRemoteResources}). Also reads this host's own
 * hostname/platform/arch so a target labeled e.g. "Local" is identifiable
 * across machines.
 */
export async function sampleLocalResources(
  options: LocalResourceProbeOptions = {},
): Promise<ResourceSample> {
  const now = options.now ?? Date.now;
  const osSource = options.osSource ?? os;
  const checkDiskSpaceFn = options.checkDiskSpaceFn ?? checkDiskSpace;
  const readMemInfo = options.readMemInfo ?? (() => readFile('/proc/meminfo', 'utf8'));

  try {
    const memTotalBytes = osSource.totalmem();
    const memAvailableBytes = await readMemAvailableBytes(readMemInfo);
    const memFreeBytes = memAvailableBytes ?? osSource.freemem();
    const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
    const memPercent = clampPercent((memUsedBytes / memTotalBytes) * 100);

    const cpuCount = osSource.cpus().length || 1;
    const load1 = osSource.loadavg()[0] ?? 0;
    const loadPercent = clampPercent((load1 / cpuCount) * 100);

    const diskPath = options.diskPath ?? os.homedir();
    const disk = await checkDiskSpaceFn(diskPath);
    const diskTotalBytes = disk.size;
    const diskUsedBytes = Math.max(0, disk.size - disk.free);
    const diskPercent = clampPercent((diskUsedBytes / diskTotalBytes) * 100);

    return {
      cpuPercent: loadPercent,
      loadPercent,
      memPercent,
      memUsedBytes,
      memTotalBytes,
      diskPercent,
      diskUsedBytes,
      diskTotalBytes,
      healthy: true,
      sampledAt: now(),
      hostname: osSource.hostname(),
      platform: osSource.platform(),
      arch: osSource.arch(),
    };
  } catch {
    return failedSample(now());
  }
}

/**
 * Linux's `/proc/meminfo` `MemAvailable` (kernel 3.14+, 2014) estimates
 * memory available to a new process without swapping — reclaimable
 * page/slab cache included — which is what "RAM used" (`MemTotal -
 * MemAvailable`) means to a human, unlike `os.freemem()`'s `MemFree`
 * (reclaimable cache counted as used, the reason a healthy Linux box used
 * to read 85-90% "used"). Never throws: any failure to read or parse
 * (macOS has no `/proc` at all; a container without `/proc` mounted; a
 * pre-3.14 kernel missing the line) resolves `undefined` so the caller's
 * `os.freemem()` fallback is the only failure path it ever has to reason
 * about.
 */
async function readMemAvailableBytes(
  readMemInfo: () => Promise<string>,
): Promise<number | undefined> {
  let text: string;
  try {
    text = await readMemInfo();
  } catch {
    return undefined;
  }
  const match = /^MemAvailable:\s*(\d+)\s*kB$/m.exec(text);
  return match ? Number(match[1]) * 1024 : undefined;
}

export interface RemoteResourceProbeOptions {
  /** Filesystem path to check disk space for on the remote host; defaults to `/` (always present, unlike a project path which may not exist yet). */
  diskPath?: string;
  now?: () => number;
}

/**
 * The single portable POSIX `sh` script {@link sampleRemoteResources} runs
 * over `transport` — one round trip, `KEY=VALUE` lines on stdout so parsing
 * never has to guess field order. Branches on `uname -s` internally for the
 * one part (RAM) that genuinely differs between Linux and Darwin (the two
 * OSes `./ssh/remote-runtime.ts`'s `detectRemoteOsArch` recognizes); CPU
 * (`uptime`'s load average ÷ `getconf _NPROCESSORS_ONLN`) and disk
 * (`df -Pk`) both work unmodified on either. Also echoes `UNAME`/
 * `HOSTNAME`/`ARCH` (`uname -s`/`-n`/`-m`) so {@link parseRemoteSample} can
 * fill in the sample's identification fields — same motivation as
 * `sampleLocalResources`'s `os.hostname()`/`platform()`/`arch()` reads.
 * Written for `dash`/BusyBox `sh` (no bashisms: no `[[`, no `local`, no
 * process substitution) since that's what a typical remote's
 * non-interactive `sh -c` actually runs.
 */
function remoteSampleScript(diskPath: string): string {
  return [
    'NPROC=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)',
    "LOAD=$(uptime | sed -e 's/.*load average[s]*: *//' -e \"s/,.*//\" | tr -d ' ')",
    'UNAME=$(uname -s)',
    'HOSTNAME=$(uname -n)',
    'ARCH=$(uname -m)',
    'if [ "$UNAME" = "Darwin" ]; then',
    '  MEMTOTAL=$(sysctl -n hw.memsize)',
    '  PAGESIZE=$(sysctl -n hw.pagesize)',
    '  FREEPAGES=$(vm_stat | awk \'/Pages free/{gsub(/\\./,"",$3); print $3}\')',
    '  MEMFREE=$((FREEPAGES * PAGESIZE))',
    'else',
    "  MEMTOTAL=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo)",
    "  MEMFREE=$(awk '/MemAvailable/{print $2*1024}' /proc/meminfo)",
    'fi',
    `DISK=$(df -Pk ${shQuote(diskPath)} | tail -1 | awk '{print $2, $3, $4}')`,
    'echo "NPROC=$NPROC"',
    'echo "LOAD=$LOAD"',
    'echo "MEMTOTAL=$MEMTOTAL"',
    'echo "MEMFREE=$MEMFREE"',
    'echo "DISK=$DISK"',
    'echo "UNAME=$UNAME"',
    'echo "HOSTNAME=$HOSTNAME"',
    'echo "ARCH=$ARCH"',
  ].join('\n');
}

function parseKeyValueLines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

/**
 * Normalizes POSIX `uname -m`'s architecture naming to `os.arch()`'s
 * vocabulary, so a UI keying off `arch` (e.g. an icon table) never needs a
 * second lookup table just for `ssh:` targets: `uname` and Node disagree on
 * naming for identical hardware (`x86_64`/`x64`, `aarch64`/`arm64`).
 */
function normalizeUnameArch(unameArch: string | undefined): string | undefined {
  if (!unameArch) return undefined;
  if (unameArch === 'x86_64') return 'x64';
  if (unameArch === 'aarch64') return 'arm64';
  return unameArch;
}

/** Parses {@link remoteSampleScript}'s stdout into a {@link ResourceSample} — split out from {@link sampleRemoteResources} so the parsing logic is unit-testable against crafted stdout without a real (or even fake) transport. Returns a failed sample for any output that doesn't carry every field this needs (a script that errored partway, or ran against an unsupported shell). `hostname`/`platform`/`arch` are best-effort: their absence from `stdout` (an older script version) never fails the sample. */
export function parseRemoteSample(stdout: string, sampledAt: number): ResourceSample {
  const kv = parseKeyValueLines(stdout);
  const nproc = Number(kv.NPROC);
  const load = Number(kv.LOAD);
  const memTotalBytes = Number(kv.MEMTOTAL);
  const memFreeBytes = Number(kv.MEMFREE);
  const diskFields = (kv.DISK ?? '').trim().split(/\s+/).map(Number);
  const [diskTotalKb, diskUsedKb] = diskFields;

  if (
    !Number.isFinite(nproc) ||
    nproc <= 0 ||
    !Number.isFinite(memTotalBytes) ||
    memTotalBytes <= 0 ||
    !Number.isFinite(diskTotalKb ?? NaN) ||
    (diskTotalKb ?? 0) <= 0
  ) {
    return failedSample(sampledAt);
  }

  const memUsedBytes = Number.isFinite(memFreeBytes)
    ? Math.max(0, memTotalBytes - memFreeBytes)
    : 0;
  const loadPercent = clampPercent(((Number.isFinite(load) ? load : 0) / nproc) * 100);
  const memPercent = clampPercent((memUsedBytes / memTotalBytes) * 100);
  const diskTotalBytes = (diskTotalKb ?? 0) * 1024;
  const diskUsedBytes = (Number.isFinite(diskUsedKb) ? (diskUsedKb ?? 0) : 0) * 1024;
  const diskPercent = clampPercent((diskUsedBytes / diskTotalBytes) * 100);

  return {
    cpuPercent: loadPercent,
    loadPercent,
    memPercent,
    memUsedBytes,
    memTotalBytes,
    diskPercent,
    diskUsedBytes,
    diskTotalBytes,
    healthy: true,
    sampledAt,
    hostname: kv.HOSTNAME || undefined,
    platform: kv.UNAME ? kv.UNAME.toLowerCase() : undefined,
    arch: normalizeUnameArch(kv.ARCH),
  };
}

/**
 * Samples an `ssh:` target's host over its existing `RemoteTransport`
 * (issue #253's "reuse remote-runtime/transport" — no second connection,
 * same pooled transport `NodeDaemon.getSshTransport` already holds for that
 * target). One `exec` call; any failure (unreachable host, non-zero exit,
 * unparseable output) yields {@link failedSample}, which is itself the
 * "target unreachable/unhealthy" signal the status view (#269) shows,
 * rather than throwing and losing every other target's sample in the same
 * pass (see `TargetHealthSampler`).
 */
export async function sampleRemoteResources(
  transport: RemoteTransport,
  options: RemoteResourceProbeOptions = {},
): Promise<ResourceSample> {
  const now = options.now ?? Date.now;
  const diskPath = options.diskPath ?? '/';
  try {
    const result = await transport.exec(remoteSampleScript(diskPath));
    if (result.exitCode !== 0) return failedSample(now());
    return parseRemoteSample(result.stdout, now());
  } catch {
    return failedSample(now());
  }
}
