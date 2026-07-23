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
 */
export interface ResourceSample {
  cpuPercent: number;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  healthy: boolean;
  /** Milliseconds since epoch (the sampling node's own clock), when this reading was taken. */
  sampledAt: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** The all-zero, `healthy: false` reading a probe returns when it couldn't sample at all — see {@link ResourceSample.healthy}'s doc comment for why this is the "agent-process health" signal, not a usage figure. */
export function failedSample(sampledAt: number): ResourceSample {
  return {
    cpuPercent: 0,
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

/** The subset of `node:os` {@link sampleLocalResources} reads — injectable so tests never depend on this machine's real load/memory. */
export interface LocalOsSource {
  totalmem(): number;
  freemem(): number;
  cpus(): unknown[];
  loadavg(): number[];
}

export interface LocalResourceProbeOptions {
  /** Filesystem path to check disk space for; defaults to `os.homedir()` (a path guaranteed to exist and live on the target's own primary disk). */
  diskPath?: string;
  now?: () => number;
  osSource?: LocalOsSource;
  checkDiskSpaceFn?: typeof checkDiskSpace;
}

/**
 * Samples this process's own host: CPU via `os.loadavg()`'s 1-minute load
 * normalized by core count (no blocking two-snapshot delta needed, unlike
 * `/proc/stat`-style sampling — SPEC §16's grounding notes this differs
 * from emdash's `pidusage`, which measures one process rather than the
 * whole host; per-target sampling here needs the latter since the
 * throttling concern in §7.16 is host-wide OOM risk, not one process's own
 * footprint), RAM via `os.totalmem()`/`os.freemem()`, and disk via
 * `check-disk-space` (issue #253's grounding — the "novel" part is
 * extending this per-target to `ssh:` hosts, see {@link sampleRemoteResources}).
 */
export async function sampleLocalResources(
  options: LocalResourceProbeOptions = {},
): Promise<ResourceSample> {
  const now = options.now ?? Date.now;
  const osSource = options.osSource ?? os;
  const checkDiskSpaceFn = options.checkDiskSpaceFn ?? checkDiskSpace;

  try {
    const memTotalBytes = osSource.totalmem();
    const memFreeBytes = osSource.freemem();
    const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
    const memPercent = clampPercent((memUsedBytes / memTotalBytes) * 100);

    const cpuCount = osSource.cpus().length || 1;
    const load1 = osSource.loadavg()[0] ?? 0;
    const cpuPercent = clampPercent((load1 / cpuCount) * 100);

    const diskPath = options.diskPath ?? os.homedir();
    const disk = await checkDiskSpaceFn(diskPath);
    const diskTotalBytes = disk.size;
    const diskUsedBytes = Math.max(0, disk.size - disk.free);
    const diskPercent = clampPercent((diskUsedBytes / diskTotalBytes) * 100);

    return {
      cpuPercent,
      memPercent,
      memUsedBytes,
      memTotalBytes,
      diskPercent,
      diskUsedBytes,
      diskTotalBytes,
      healthy: true,
      sampledAt: now(),
    };
  } catch {
    return failedSample(now());
  }
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
 * (`df -Pk`) both work unmodified on either. Written for `dash`/BusyBox
 * `sh` (no bashisms: no `[[`, no `local`, no process substitution) since
 * that's what a typical remote's non-interactive `sh -c` actually runs.
 */
function remoteSampleScript(diskPath: string): string {
  return [
    'NPROC=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)',
    "LOAD=$(uptime | sed -e 's/.*load average[s]*: *//' -e \"s/,.*//\" | tr -d ' ')",
    'UNAME=$(uname -s)',
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

/** Parses {@link remoteSampleScript}'s stdout into a {@link ResourceSample} — split out from {@link sampleRemoteResources} so the parsing logic is unit-testable against crafted stdout without a real (or even fake) transport. Returns a failed sample for any output that doesn't carry every field this needs (a script that errored partway, or ran against an unsupported shell). */
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
  const cpuPercent = clampPercent(((Number.isFinite(load) ? load : 0) / nproc) * 100);
  const memPercent = clampPercent((memUsedBytes / memTotalBytes) * 100);
  const diskTotalBytes = (diskTotalKb ?? 0) * 1024;
  const diskUsedBytes = (Number.isFinite(diskUsedKb) ? (diskUsedKb ?? 0) : 0) * 1024;
  const diskPercent = clampPercent((diskUsedBytes / diskTotalBytes) * 100);

  return {
    cpuPercent,
    memPercent,
    memUsedBytes,
    memTotalBytes,
    diskPercent,
    diskUsedBytes,
    diskTotalBytes,
    healthy: true,
    sampledAt,
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
