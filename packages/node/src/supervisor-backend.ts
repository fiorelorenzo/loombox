/**
 * The supervisor-backend seam (issue #654, epic #653; decision B1-1: "the
 * seam is designed against the platform whose vocabulary is furthest from
 * systemd's" — so this file is written against launchd, not retrofitted
 * onto it). One vocabulary — install / start / stop / status / uninstall /
 * survivesReboot — and nothing below this line ever spells "unit",
 * "plist", "systemctl", or "launchctl". A caller driving a resident node's
 * lifecycle (`./local/provision-local-node.ts`, a future decommission flow)
 * codes against exactly this interface and never branches on platform.
 *
 * **Two implementations wired today:**
 * - `./ssh/systemd-supervisor-backend.ts` — an `ssh:` target, over a
 *   `RemoteTransport`. Wraps `./ssh/systemd-provisioning.ts` (unchanged,
 *   still the mechanism `./ssh/provision-target.ts`'s own `provision()`
 *   uses directly) rather than reimplementing unit generation.
 * - `./launchd/launchd-supervisor-backend.ts` — a macOS-local node, over a
 *   `LaunchdIo`. Wraps `./launchd/launchd-provisioning.ts` (unchanged) the
 *   same way.
 *
 * **#658 (Linux local) and #659 (Windows local) each add ONE new file**
 * implementing this same interface — never a change to this file, and
 * never a change to either implementation above. That is the whole point
 * of naming the seam now, against two real platforms, instead of guessing
 * at it from one (decision B1-1's "bought").
 *
 * **What this seam deliberately does NOT own:**
 * - **What bytes to install.** `SupervisorBackendInstallConfig.fetchArchive`
 *   is an injected fetch, exactly like `./ssh/supervisor-artifact.ts`'s own
 *   `SupervisorArtifactSource` — this file has no opinion on GitHub
 *   Releases vs. a local directory tree vs. anything else.
 * - **Minting a device token, wrapping the AMK, or revoking a device on the
 *   relay.** Those need a relay HTTP client and an unlocked AMK, neither of
 *   which a platform supervisor has any business touching. A backend's
 *   `uninstall()` tears down everything *local* it owns (the installed
 *   bundle, the service registration, and — unless `keepData` is set —
 *   this node's own state dir); the caller is responsible for revoking the
 *   device on the relay before or after, exactly the same split
 *   `./ssh/decommission.ts` already draws between "stop/disable the unit"
 *   (this seam's job) and "remove the target from the trusted store" (the
 *   caller's). Decision E1-3 ("an uninstalled node must never stay
 *   pairable") is enforced at that caller layer, not here — a backend that
 *   *couldn't* fully remove its own local footprint would make E1-3
 *   impossible to implement correctly, which is why `uninstall()` is part
 *   of this interface's first version rather than a later addition.
 */

/** The normalized outcome of a plan/execute cycle any backend runs internally — mirrors `./ssh/systemd-provisioning.ts`'s `SystemdProvisionAction`/`./launchd/launchd-provisioning.ts`'s `LaunchdProvisionAction` one level up: `'noop'` (already at the desired version and already running), `'install'` (nothing was there before), `'update'` (something older was there), `'unsupported'` (this host/target can't run this backend's mechanism at all — declining leaves it fully usable, never a failure). */
export type SupervisorBackendAction = 'noop' | 'install' | 'update' | 'unsupported';

export interface SupervisorBackendInstallConfig {
  /** The version to install and activate (decision A1-2's `~/.loombox/versions/<version>/` + `current` symlink, or a backend's platform-equivalent layout). */
  version: string;
  /** Fetches the gzipped-tar bytes for `version` — the exact shape `InstallLayoutDriver.stageVersion` extracts. Called at most once per `install()`, only when staging is actually needed (a `noop` plan never calls it). */
  fetchArchive: (version: string) => Promise<Uint8Array>;
  /** Absolute path to the system Node interpreter that runs the staged bundle's entry file. Resolved by the caller (typically `command -v node` over whatever transport it already has open for `runtime_bootstrap`) — a backend never assumes or searches `PATH` itself, since a service manager's own `PATH` is frequently not an interactive shell's. */
  nodeExecutable: string;
  /** Every `LOOMBOX_*`/`CLAUDE_CODE_OAUTH_TOKEN` env var the resident node process reads at start — plain data, already flattened by the caller (e.g. `./ssh/provision-target.ts`'s `buildResidentNodeEnvironment`). This seam never interprets a single key in it. */
  environment: Record<string, string>;
  /** Extra argv appended after the resolved entry point; defaults to none — the bundle's own `main.ts` needs no dispatch flag (unlike the older `supervisor-bin --node` scheme this replaces), so most callers never set this. */
  args?: string[];
}

export interface SupervisorBackendInstallResult {
  ok: boolean;
  action: SupervisorBackendAction;
  message: string;
}

/** `'unknown'` covers both "the query itself failed" and "installed but this backend's platform tool can't distinguish running from crashed-but-registered" — never conflated with `'stopped'`, which is a confident negative. */
export type SupervisorRunState = 'running' | 'stopped' | 'unknown';

export interface SupervisorBackendStatus {
  /** Whether this backend's service registration currently exists at all — `false` short-circuits `state` to `'stopped'` and `version` to `undefined`. */
  installed: boolean;
  state: SupervisorRunState;
  /** The version `install()` last activated, or `undefined` when nothing is installed. */
  version?: string;
  message: string;
}

export interface SupervisorBackendActionResult {
  ok: boolean;
  message: string;
}

export interface SupervisorBackendUninstallOptions {
  /**
   * Decision E1-3's explicit opt-out. `false` (the default) removes
   * everything this backend owns locally: the service registration, the
   * installed bundle, and this node's own state dir (identity, session
   * history — irreversible, since the relay only ever holds ciphertext it
   * cannot restore). `true` still stops and fully deregisters the service
   * (an "uninstalled" node is never left running or configured to survive
   * a reboot either way) but leaves the state dir on disk.
   *
   * Device revocation on the relay is **not** this option's concern — see
   * this module's doc comment for why that split exists.
   */
  keepData?: boolean;
}

export interface SupervisorBackend {
  /**
   * Stages `config.version` (if not already staged), activates it, and
   * (re)installs this backend's service registration pointing at it —
   * `noop` when the desired version is already active and the
   * registration already matches, `unsupported` when this host/target
   * can't run this backend's mechanism at all (still `ok: true` — see
   * `SupervisorBackendAction`'s doc comment). A successful `install`/
   * `update` leaves the resident node already running (this backend's own
   * "run at load"/"restart on failure" equivalent), so a caller does not
   * need to also call {@link SupervisorBackend.start} right after.
   */
  install(config: SupervisorBackendInstallConfig): Promise<SupervisorBackendInstallResult>;
  /** Starts the currently-installed service if it isn't already running. `ok: false` with no installed service — this never installs one. */
  start(): Promise<SupervisorBackendActionResult>;
  /** Stops the currently-installed service if it's running. A no-op success if it's already stopped. */
  stop(): Promise<SupervisorBackendActionResult>;
  /** A read-only snapshot — never mutates anything. */
  status(): Promise<SupervisorBackendStatus>;
  /** Tears down what {@link SupervisorBackend.install} put in place — see {@link SupervisorBackendUninstallOptions} for what `keepData` does and does not cover. Idempotent: uninstalling an already-uninstalled backend is `ok: true`, not a failure. */
  uninstall(options?: SupervisorBackendUninstallOptions): Promise<SupervisorBackendActionResult>;
  /** Whether the currently-installed service is genuinely configured to relaunch across a logout/login cycle and a reboot (its platform's own "enabled"/"RunAtLoad" equivalent) — a static configuration check, not a live reboot test. `false` when nothing is installed. */
  survivesReboot(): Promise<boolean>;
}
