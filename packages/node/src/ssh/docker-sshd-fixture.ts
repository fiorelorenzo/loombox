import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A throwaway, checked-in SSH keypair for this fixture only (issue #70):
 * baked into the Docker image at build time as `loombox`'s
 * `authorized_keys`, so no runtime key generation or injection step is
 * needed before a container is usable. Not a secret — it only ever unlocks a
 * disposable local container with nothing of value in it, never a real host.
 */
const FIXTURE_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAAYAP0+IyzMBDiQ7dfOtYy/zV6IdU6vo5zSBApcHmKugAAAKAd8F/JHfBf
yQAAAAtzc2gtZWQyNTUxOQAAACAAYAP0+IyzMBDiQ7dfOtYy/zV6IdU6vo5zSBApcHmKug
AAAEDpUv/Ifu9HfAV435LINyrrc0hco5ilWcwHqLZvXqvYqgBgA/T4jLMwEOJDt1861jL/
NXoh1Tq+jnNIEClweYq6AAAAGWxvb21ib3gtdGVzdC1zc2hkLWZpeHR1cmUBAgME
-----END OPENSSH PRIVATE KEY-----
`;

const FIXTURE_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABgA/T4jLMwEOJDt1861jL/NXoh1Tq+jnNIEClweYq6 loombox-test-sshd-fixture';

export const DOCKER_SSHD_FIXTURE_USER = 'loombox';
/** Port the fixture's baked-in `socat` TCP echo server listens on inside the container (issue #92's "simple TCP echo server on the remote side"). */
export const DOCKER_SSHD_FIXTURE_ECHO_PORT = 9999;

const IMAGE_TAG = 'loombox-test-sshd-fixture:latest';

/**
 * The fixture image (issue #70's acceptance criteria):
 *
 * - Alpine + `openssh-server` + `git` + `socat`, `loombox`'s pubkey baked in
 *   as `authorized_keys` (key-based auth, no password).
 * - A **fake but structurally faithful** `mise` at `~/.local/bin/mise`
 *   (responds to `activate bash` the same way the real CLI does) whose
 *   `activate` output is the only thing that puts a `node` shim on `PATH` —
 *   reproducing SPEC §9's non-interactive-shell PATH gap on purpose, exactly
 *   as `wrapForLoginShell` (`./login-shell.ts`) exists to fix: a plain
 *   `ssh host 'node --version'` cannot see it, `bash -lc` (this fixture's own
 *   login shell, sourcing `~/.profile`) can. A real `mise`+Node install was
 *   deliberately not used here — it would make this fixture's build depend
 *   on `mise.run`/Node's own download mirror being reachable from CI, for a
 *   gap this stand-in reproduces just as faithfully.
 * - `socat` starts a TCP echo server on `DOCKER_SSHD_FIXTURE_ECHO_PORT`
 *   before `sshd` execs into PID 1, for issue #92's tunnel test.
 */
const DOCKERFILE = `
FROM alpine:3.20
RUN apk add --no-cache openssh bash git socat \\
    && ssh-keygen -A \\
    && adduser -D -s /bin/bash ${DOCKER_SSHD_FIXTURE_USER} \\
    && passwd -u ${DOCKER_SSHD_FIXTURE_USER} \\
    && mkdir -p /home/${DOCKER_SSHD_FIXTURE_USER}/.ssh /home/${DOCKER_SSHD_FIXTURE_USER}/.local/bin /home/${DOCKER_SSHD_FIXTURE_USER}/.mise-shims /home/${DOCKER_SSHD_FIXTURE_USER}/repo \\
    && echo "${FIXTURE_PUBLIC_KEY}" > /home/${DOCKER_SSHD_FIXTURE_USER}/.ssh/authorized_keys \\
    && printf '%s\\n' \\
      '#!/bin/sh' \\
      'if [ "$1" = "activate" ]; then' \\
      '  echo "export PATH=\\"\\$HOME/.mise-shims:\\$PATH\\""' \\
      'fi' \\
      > /home/${DOCKER_SSHD_FIXTURE_USER}/.local/bin/mise \\
    && chmod +x /home/${DOCKER_SSHD_FIXTURE_USER}/.local/bin/mise \\
    && printf '%s\\n' '#!/bin/sh' 'echo "v22.99.0-mise-fixture"' > /home/${DOCKER_SSHD_FIXTURE_USER}/.mise-shims/node \\
    && chmod +x /home/${DOCKER_SSHD_FIXTURE_USER}/.mise-shims/node \\
    && cd /home/${DOCKER_SSHD_FIXTURE_USER}/repo \\
    && git init -q -b main \\
    && git config user.email fixture@loombox.dev \\
    && git config user.name loombox-fixture \\
    && git commit -q --allow-empty -m init \\
    && chmod 700 /home/${DOCKER_SSHD_FIXTURE_USER}/.ssh \\
    && chmod 600 /home/${DOCKER_SSHD_FIXTURE_USER}/.ssh/authorized_keys \\
    && chown -R ${DOCKER_SSHD_FIXTURE_USER}:${DOCKER_SSHD_FIXTURE_USER} /home/${DOCKER_SSHD_FIXTURE_USER} \\
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \\
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \\
    && sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config \\
    && printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -e' \\
      'su ${DOCKER_SSHD_FIXTURE_USER} -c "socat TCP-LISTEN:${DOCKER_SSHD_FIXTURE_ECHO_PORT},reuseaddr,fork EXEC:cat" &' \\
      'exec /usr/sbin/sshd -D -e' \\
      > /entrypoint.sh \\
    && chmod +x /entrypoint.sh
EXPOSE 22 ${DOCKER_SSHD_FIXTURE_ECHO_PORT}
CMD ["/entrypoint.sh"]
`;

/**
 * Runs `docker build ... -` and feeds `dockerfile` on stdin, then closes it
 * (execFile's `options` has no `input` — that's an `execFileSync`-only
 * feature — so a plain spawn is what actually delivers the Dockerfile
 * without the process hanging forever waiting on a stdin that never
 * closes).
 */
function dockerBuildFromStdin(dockerfile: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['build', '-q', '-t', tag, '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker build failed (exit ${code}): ${stderr.trim()}`));
      }
    });
    child.stdin.write(dockerfile);
    child.stdin.end();
  });
}

/**
 * Whether a usable Docker CLI + daemon is reachable from this process
 * (issue #70's "gate the docker-backed integration test so it runs when
 * Docker is available and skips cleanly otherwise"). A short timeout and a
 * blanket catch: anything from "no `docker` binary" (`ENOENT`) to "daemon not
 * running" to "permission denied talking to the socket" all mean the same
 * thing to a caller deciding whether to skip — not available here.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface DockerSshdFixture {
  host: string;
  port: number;
  username: string;
  /** Path to the fixture's private key on this machine, suitable for `Ssh2TransportConfig.privateKeyPath`. */
  privateKeyPath: string;
  /** Absolute path, inside the container, to a small git repository already committed on `main` — a ready-made target for worktree tests. */
  remoteRepoPath: string;
  /** The container-local port the baked-in TCP echo server listens on (see {@link DOCKER_SSHD_FIXTURE_ECHO_PORT}). */
  echoPort: number;
  /** Removes the container and this fixture's temp key directory. Safe to call once; idempotent thereafter. */
  stop(): Promise<void>;
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = netConnect({ host, port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(
    `docker-sshd-fixture: ${host}:${port} never became reachable within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

/**
 * Builds (once — cached by tag, subsequent calls are a fast no-op layer-cache
 * hit) the fixture image and boots a fresh container from it, bound to a
 * random free host port on loopback only. Callers MUST call the returned
 * fixture's {@link DockerSshdFixture.stop} (typically from `afterAll`/
 * `afterEach`) to remove the container.
 */
export async function startDockerSshdFixture(): Promise<DockerSshdFixture> {
  await dockerBuildFromStdin(DOCKERFILE, IMAGE_TAG);

  const keyDir = await mkdtemp(join(tmpdir(), 'loombox-ssh-fixture-key-'));
  const privateKeyPath = join(keyDir, 'id_ed25519');
  await writeFile(privateKeyPath, FIXTURE_PRIVATE_KEY, { mode: 0o600 });

  const containerName = `loombox-test-sshd-${randomUUID()}`;
  await execFileAsync('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-p',
    '127.0.0.1::22',
    IMAGE_TAG,
  ]);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => {
      /* best-effort teardown */
    });
    await rm(keyDir, { recursive: true, force: true }).catch(() => {
      /* best-effort teardown */
    });
  };

  try {
    const { stdout } = await execFileAsync('docker', ['port', containerName, '22/tcp']);
    // e.g. "0.0.0.0:54321\n" (docker always reports the IPv4 mapping first).
    const match = /:(\d+)\s*$/.exec(stdout.trim().split('\n')[0] ?? '');
    if (!match) {
      throw new Error(`docker-sshd-fixture: could not parse published port from: ${stdout}`);
    }
    const port = Number(match[1]);

    await waitForPort('127.0.0.1', port, 15_000);

    return {
      host: '127.0.0.1',
      port,
      username: DOCKER_SSHD_FIXTURE_USER,
      privateKeyPath,
      remoteRepoPath: `/home/${DOCKER_SSHD_FIXTURE_USER}/repo`,
      echoPort: DOCKER_SSHD_FIXTURE_ECHO_PORT,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
