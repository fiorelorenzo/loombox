import {
  AMK_HANDOFF_DEFAULT_EPOCH,
  packAmkHandoffForFile,
  wrapAmkForNodeHandoff,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { shQuote, type RemoteTransport } from './remote-transport';

/**
 * The provisioner (acting) side of issue #399's zero-touch AMK handoff:
 * wraps the unlocked Account Master Key for a freshly-provisioned `ssh:`
 * target's device pubkey and writes it to a one-shot file on the remote over
 * an already-open, already-encrypted `RemoteTransport` (`../ssh/provision-
 * target.ts`, issue #400) — the counterpart to `../amk-handoff-file.ts`'s
 * receiver, which reads, unwraps, adopts, and deletes exactly this file on
 * the resident node's first start.
 *
 * Deliberately does **not** obtain the target's device id/pubkey itself:
 * SPEC #399 splits "the node generates its device identity and reports its
 * device pubkey" (a separate step — e.g. a fresh `NodeIdentityStore.
 * loadOrCreate()` run remotely, or read back off the resident node's own
 * first `initialize` handshake reaching the relay) from "the provisioner
 * wraps and delivers it" (this module). A caller — `provision-target.ts`'s
 * orchestrator, or a future app bridge holding the unlocked AMK — is
 * responsible for obtaining `targetDeviceId`/`targetDevicePublicKeyRaw`
 * first and passing them in here.
 */
export interface AmkHandoffActingIdentity {
  /** The acting (already-unlocked, provisioning) device's own ECDH keypair. */
  readonly keyPair: EcdhKeyPair;
  /** `keyPair.publicKey`, already exported as a raw uncompressed EC point — embedded in the written file so the target can derive the same shared secret back with no other out-of-band exchange. */
  readonly publicKeyRaw: Uint8Array;
}

/** The one-shot handoff file's default bare name, under the resident node's own state dir convention (`identity.ts`'s/`./verify-and-persist.ts`'s `defaultNodeStateDir()`: `$HOME/.loombox/node`). */
export const DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME = 'wrapped-amk-handoff.json';

export interface WriteWrappedAmkHandoffOptions {
  /** The unlocked Account Master Key the acting device already holds. */
  amk: Uint8Array;
  accountId: string;
  /**
   * The AMK epoch `amk` represents (SPEC §8, issue #116). Defaults to
   * `@loombox/crypto`'s `AMK_HANDOFF_DEFAULT_EPOCH` (0, "never rotated").
   * Pass the acting device's own currently-adopted epoch
   * (`NodeDaemon.getAmkEpoch()`) when it's ahead of 0, so the provisioned
   * node starts already caught up rather than needing a rewrapped-epoch
   * round trip immediately after its first connect.
   */
  epoch?: number;
  actingIdentity: AmkHandoffActingIdentity;
  /** The freshly-provisioned target node's own stable device id, reported out of band (see this module's doc comment). */
  targetDeviceId: string;
  /** The freshly-provisioned target node's own raw ECDH public key point, reported out of band the same way. */
  targetDevicePublicKeyRaw: Uint8Array;
  /**
   * Absolute remote path to write the one-shot file to. Defaults to
   * `$HOME/.loombox/node/wrapped-amk-handoff.json` (resolved on the remote
   * via `transport.exec`, since `$HOME` isn't known locally) — point the
   * resident node's own `LOOMBOX_WRAPPED_AMK_FILE` (`../config.ts`, e.g.
   * via `provision-target.ts`'s `ResidentNodeConfig.wrappedAmkFilePath`) at
   * the same path.
   */
  remotePath?: string;
}

export interface WriteWrappedAmkHandoffResult {
  ok: boolean;
  remotePath: string;
  message: string;
}

/**
 * Resolves the default remote handoff-file path
 * (`$HOME/.loombox/node/wrapped-amk-handoff.json`), or returns `override`
 * unchanged if one was given — mirrors `./systemd-provisioning.ts`'s
 * `resolveSystemdUnitDir`.
 */
export async function resolveWrappedAmkHandoffPath(
  transport: RemoteTransport,
  override?: string,
): Promise<string> {
  if (override) return override;
  const result = await transport.exec(
    `printf '%s' "$HOME/.loombox/node/${DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME}"`,
  );
  return result.stdout.trim();
}

/**
 * Wraps `options.amk` for the target node's already-reported device pubkey
 * (`@loombox/crypto`'s `wrapAmkForNodeHandoff`, reusing `amk-rotation.ts`'s
 * revocation wrap primitive — the same ECDH-then-AES-GCM construction, just
 * a different delivery leg — see `@loombox/crypto`'s `amk-handoff.ts` doc
 * comment) and writes the packed envelope to a one-shot file on the remote
 * over `transport`, **chmod 600** immediately after writing — never left
 * group/world-readable even momentarily.
 *
 * **Delivery choice.** A one-shot consumed file (this function) is the
 * default: simplest to reason about over an already-open, already-encrypted
 * SSH channel, and `../amk-handoff-file.ts`'s receiver deletes it the moment
 * it's adopted, so nothing sensitive lingers on disk longer than one restart
 * cycle. A short-lived local Unix socket (the resident node listens briefly
 * on first start, the provisioner connects and pushes the wrapped envelope
 * directly, so the wrapped AMK never touches disk at all) is a real
 * alternative for the stricter "never touch disk" property that Lorenzo may
 * prefer — deliberately not built here. `WriteWrappedAmkHandoffOptions.
 * remotePath` and this function's file-based shape are the extension seam a
 * socket-based sibling (e.g. `writeWrappedAmkHandoffViaSocket`) would sit
 * next to, not modify: `../amk-handoff-file.ts`'s receiver and this
 * module's wrap/pack step are both delivery-mechanism-agnostic already.
 */
export async function writeWrappedAmkHandoff(
  transport: RemoteTransport,
  options: WriteWrappedAmkHandoffOptions,
): Promise<WriteWrappedAmkHandoffResult> {
  const epoch = options.epoch ?? AMK_HANDOFF_DEFAULT_EPOCH;

  const envelope = await wrapAmkForNodeHandoff({
    amk: options.amk,
    epoch,
    accountId: options.accountId,
    targetDeviceId: options.targetDeviceId,
    actingPrivateKey: options.actingIdentity.keyPair.privateKey,
    targetDevicePublicKeyRaw: options.targetDevicePublicKeyRaw,
  });
  const content = packAmkHandoffForFile({
    epoch,
    actingDevicePublicKeyRaw: options.actingIdentity.publicKeyRaw,
    envelope,
  });

  const remotePath = await resolveWrappedAmkHandoffPath(transport, options.remotePath);
  const lastSlash = remotePath.lastIndexOf('/');
  const dir = lastSlash > 0 ? remotePath.slice(0, lastSlash) : undefined;
  const script = [
    dir ? `mkdir -p ${shQuote(dir)}` : ':',
    `printf '%s' ${shQuote(content)} > ${shQuote(remotePath)}`,
    `chmod 600 ${shQuote(remotePath)}`,
  ].join(' && ');

  const result = await transport.exec(script);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      remotePath,
      message:
        `failed to write wrapped-AMK handoff file to ${remotePath}: ` +
        (result.stderr.trim() || `command exited ${result.exitCode}`),
    };
  }

  return {
    ok: true,
    remotePath,
    message: `wrapped-AMK handoff file written to ${remotePath} (chmod 600); the resident node consumes and deletes it on first successful start`,
  };
}
