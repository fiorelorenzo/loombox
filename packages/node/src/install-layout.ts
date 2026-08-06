import { spawn } from 'node:child_process';
import { mkdir, readdir, readlink, rm, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

import { shQuote } from './ssh/remote-transport';
import type { RemoteTransport } from './ssh/remote-transport';

/**
 * Resolve/stage/activate/rollback for the `~/.loombox/versions/<version>/`
 * + `current` install layout (issue #817, decision A1-2). Mirrors
 * `scripts/deploy-prod.sh`'s own proven `releases/<sha>` + `releases/current`
 * shape exactly, symlink flip included (`ln -sfn "$SHA" "$RELEASES_DIR/current"`
 * — this module's `activateVersion` does the same unlink-then-symlink, not a
 * temp-link-plus-rename dance, on purpose: that script's own comments call
 * it "atomically flip" and it has shipped prod deploys under that name for
 * a while, so there's no reason to invent a different, unproven mechanism
 * here).
 *
 * One driver interface, two implementations: {@link createLocalInstallLayoutDriver}
 * (real `node:fs`, for a machine installing its own node — the future local
 * backends, #654/#658/#659) and {@link createRemoteInstallLayoutDriver} (a
 * {@link RemoteTransport}, for staging an artifact on an `ssh:` target).
 * Both speak the exact same four verbs, so neither caller has to know which
 * one it's driving.
 *
 * `rollback` is deliberately not a fifth verb: {@link activateVersion} run
 * again against an older, still-staged version *is* rollback (same
 * `deploy-prod.sh` precedent — its own `rollback()` just re-flips
 * `releases/current`, no separate mechanism). {@link rollbackVersion} exists
 * purely to name that intent at a call site.
 */
export interface InstallLayoutDriver {
  /** Every version directory name currently staged under `<baseDir>/versions/`, in no particular order. Empty when `versions/` doesn't exist yet (a fresh, never-installed `baseDir`). */
  listStagedVersions(baseDir: string): Promise<string[]>;
  /**
   * Extracts `archiveTarGz` (a gzipped tar of the version's whole flat
   * bundle layout — `node.mjs`, its trimmed `package.json`,
   * `node_modules/{node-pty,@napi-rs/keyring}`) into
   * `<baseDir>/versions/<version>/`, replacing any partial previous attempt
   * at that exact version. Never touches `current` — a caller decides
   * separately, via {@link activateVersion}, whether/when a freshly staged
   * version goes live.
   */
  stageVersion(baseDir: string, version: string, archiveTarGz: Uint8Array): Promise<void>;
  /**
   * Points `<baseDir>/current` at `versions/<version>` — a relative symlink
   * target, exactly like `deploy-prod.sh`'s own `releases/current -> $SHA`
   * (never an absolute path baked to wherever `baseDir` happened to live
   * when this ran, so the whole install tree stays relocatable). Throws if
   * `version` isn't staged: activating a version that was never
   * (successfully) unpacked is a caller bug, not something to paper over
   * with a partially-live symlink.
   */
  activateVersion(baseDir: string, version: string): Promise<void>;
  /** The version `current` points at, or `undefined` if `current` doesn't exist yet (a fresh `baseDir`, nothing activated). */
  currentVersion(baseDir: string): Promise<string | undefined>;
  /** Deletes a staged version's directory. Refuses (throws) when `version` is the one `current` points at — this never removes what's live, only old/unused staged versions. */
  removeVersion(baseDir: string, version: string): Promise<void>;
}

/** {@link InstallLayoutDriver.activateVersion} run against an older, already-staged version — same mechanism, named for the caller's actual intent ("go back to what was running before"). Still requires `version` to be staged; rollback is never "reconstruct a version that was pruned". */
export async function rollbackVersion(
  driver: InstallLayoutDriver,
  baseDir: string,
  version: string,
): Promise<void> {
  await driver.activateVersion(baseDir, version);
}

/** True for a `node:fs` `ENOENT` error — the one error code every driver method below treats as "not there" rather than a real failure. Narrows without an inline cast: `error.code` is read only after `'code' in error` proves the property exists. */
function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Runs `command` with `args`, piping `input` (if given) to stdin and collecting stdout; rejects on a non-zero exit with stderr in the message. Used for `tar` only — this module's one external-process dependency, mirroring `deploy-prod.sh`/`copy-native-module.mjs`'s own preference for the real platform tool over an npm reimplementation. */
async function runCapture(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve(Buffer.concat(stdoutChunks));
    } else {
      reject(
        new Error(
          `${command} ${args.join(' ')} exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`,
        ),
      );
    }
  });
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  return promise;
}

/** Creates a gzipped tar of `sourceDir`'s contents (not `sourceDir` itself as a nested entry) — the counterpart {@link createLocalInstallLayoutDriver}'s `stageVersion` extracts. Exported for release packaging (`scripts/package-node-release.mjs`) and tests to build fixture archives with, without duplicating the `tar` invocation. */
export async function createTarGzArchive(sourceDir: string): Promise<Uint8Array> {
  return runCapture('tar', ['czf', '-', '-C', sourceDir, '.']);
}

/**
 * `node:fs`-backed {@link InstallLayoutDriver} for a machine installing its
 * own node (the future local platform backends, #654/#658/#659) or staging
 * a version to hand to a remote driver later. Requires the `tar` binary on
 * `PATH` (present by default on Linux, macOS, and Windows 10+ — the same
 * assumption `copy-native-module.mjs` already makes about `cp`).
 */
export function createLocalInstallLayoutDriver(): InstallLayoutDriver {
  const currentVersion = async (baseDir: string): Promise<string | undefined> => {
    try {
      const target = await readlink(path.join(baseDir, 'current'));
      return path.basename(target);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  };

  return {
    async listStagedVersions(baseDir) {
      try {
        const entries = await readdir(path.join(baseDir, 'versions'), { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (error) {
        if (isEnoent(error)) return [];
        throw error;
      }
    },

    async stageVersion(baseDir, version, archiveTarGz) {
      const versionDir = path.join(baseDir, 'versions', version);
      await rm(versionDir, { recursive: true, force: true });
      await mkdir(versionDir, { recursive: true });
      await runCapture('tar', ['xzf', '-', '-C', versionDir], Buffer.from(archiveTarGz));
    },

    async activateVersion(baseDir, version) {
      const versionDir = path.join(baseDir, 'versions', version);
      try {
        await stat(versionDir);
      } catch (error) {
        if (isEnoent(error)) {
          throw new Error(`install-layout: version ${version} is not staged at ${versionDir}`);
        }
        throw error;
      }
      const currentLink = path.join(baseDir, 'current');
      await unlink(currentLink).catch((error: unknown) => {
        if (!isEnoent(error)) throw error;
      });
      await symlink(path.posix.join('versions', version), currentLink);
    },

    currentVersion,

    async removeVersion(baseDir, version) {
      if ((await currentVersion(baseDir)) === version) {
        throw new Error(
          `install-layout: refusing to remove version ${version} — it's what "current" points at`,
        );
      }
      await rm(path.join(baseDir, 'versions', version), { recursive: true, force: true });
    },
  };
}

// --- remote (ssh) driver -----------------------------------------------------

/**
 * {@link RemoteTransport}-backed {@link InstallLayoutDriver}, for staging a
 * version on an `ssh:` target. Every write goes through `transport.exec`,
 * following the exact same conventions already proven in this directory —
 * `shQuote` for interpolation, base64-over-stdin for binary payloads
 * (`supervisor-provisioning.ts`'s own `executeSupervisorProvisioning`), and
 * `ln -sfn` for the symlink flip (`deploy-prod.sh`).
 */
export function createRemoteInstallLayoutDriver(transport: RemoteTransport): InstallLayoutDriver {
  const versionDir = (baseDir: string, version: string): string =>
    path.posix.join(baseDir, 'versions', version);
  const currentLink = (baseDir: string): string => path.posix.join(baseDir, 'current');

  const currentVersion = async (baseDir: string): Promise<string | undefined> => {
    const result = await transport.exec(`readlink ${shQuote(currentLink(baseDir))} 2>/dev/null`);
    const target = result.stdout.trim();
    return target.length > 0 ? path.posix.basename(target) : undefined;
  };

  return {
    async listStagedVersions(baseDir) {
      // `ls -1`, not `find -printf` (a GNU-only extension BSD/macOS `find`
      // lacks) — portable across every `RemoteOsArch` this codebase
      // supports. Redirecting stderr makes "versions/ doesn't exist yet"
      // indistinguishable from "empty", exactly the local driver's own
      // ENOENT-means-`[]` behavior.
      const result = await transport.exec(
        `ls -1 ${shQuote(path.posix.join(baseDir, 'versions'))} 2>/dev/null`,
      );
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    async stageVersion(baseDir, version, archiveTarGz) {
      const dir = versionDir(baseDir, version);
      const rmResult = await transport.exec(`rm -rf ${shQuote(dir)} && mkdir -p ${shQuote(dir)}`);
      if (rmResult.exitCode !== 0) {
        throw new Error(
          `install-layout: preparing ${dir} failed (exit ${rmResult.exitCode}): ${rmResult.stderr}`,
        );
      }
      const base64Payload = Buffer.from(archiveTarGz).toString('base64');
      const extractResult = await transport.exec(`base64 -d | tar xzf - -C ${shQuote(dir)}`, {
        input: base64Payload,
      });
      if (extractResult.exitCode !== 0) {
        throw new Error(
          `install-layout: staging ${dir} failed (exit ${extractResult.exitCode}): ${extractResult.stderr}`,
        );
      }
    },

    async activateVersion(baseDir, version) {
      const dir = versionDir(baseDir, version);
      const testResult = await transport.exec(`test -d ${shQuote(dir)}`);
      if (testResult.exitCode !== 0) {
        throw new Error(`install-layout: version ${version} is not staged at ${dir}`);
      }
      const linkResult = await transport.exec(
        `ln -sfn ${shQuote(path.posix.join('versions', version))} ${shQuote(currentLink(baseDir))}`,
      );
      if (linkResult.exitCode !== 0) {
        throw new Error(
          `install-layout: activating ${version} failed (exit ${linkResult.exitCode}): ${linkResult.stderr}`,
        );
      }
    },

    currentVersion,

    async removeVersion(baseDir, version) {
      if ((await currentVersion(baseDir)) === version) {
        throw new Error(
          `install-layout: refusing to remove version ${version} — it's what "current" points at`,
        );
      }
      const result = await transport.exec(`rm -rf ${shQuote(versionDir(baseDir, version))}`);
      if (result.exitCode !== 0) {
        throw new Error(
          `install-layout: removing ${version} failed (exit ${result.exitCode}): ${result.stderr}`,
        );
      }
    },
  };
}
