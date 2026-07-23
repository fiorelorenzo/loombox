import type {
  ProvisionOptions,
  ProvisionResult,
  ProvisionStep,
  SshTargetConfig,
} from '@loombox/node';

import type { ProvisionProgressStep, ProvisionTargetResult } from '../../shared/bridge';

// `@loombox/node`'s barrel eagerly loads native modules (@napi-rs/keyring,
// node-pty) whose prebuilt binaries match Node's ABI, not Electron's, which
// would crash the main process at startup. We only need `provision` when the
// user actually provisions a target, so load it lazily via a dynamic import
// to keep app launch free of any native-module load (issue #403 follow-up).

/**
 * Everything {@link runProvisionTarget} needs to actually drive
 * `@loombox/node`'s `provision()` (issue #400) end to end, beyond the
 * target itself: a signed supervisor-release artifact source + pinned
 * public key (SPEC §16 "Signed supervisor binary" — not built yet), and the
 * resident node's relay/identity config (the mint-token #398 + AMK-handoff
 * #399 flows this bridge is meant to eventually carry). This scaffold has
 * no real source for either, so {@link resolveProvisionTargetDeps} always
 * returns `undefined` — a caller (a future add-target wizard) supplies real
 * deps once those issues land; `runProvisionTarget` itself is real and
 * fully wired today, exercised in `provision-target-bridge.test.ts` against
 * `@loombox/node`'s own `FakeTransport`.
 */
export type ProvisionTargetDeps = Pick<
  ProvisionOptions,
  | 'transportFactory'
  | 'store'
  | 'transportPool'
  | 'runtime'
  | 'supervisor'
  | 'residentNode'
  | 'onProgress'
>;

/** TODO(#403 follow-up, tracked with #398/#399): no signed-release artifact source or resident-node identity config is wired into the desktop app yet — see this module's doc comment. */
export function resolveProvisionTargetDeps(): ProvisionTargetDeps | undefined {
  return undefined;
}

/**
 * Runs the real `@loombox/node` `provision()` sequence against `target` and
 * projects its result onto the bridge's plain-data {@link
 * ProvisionTargetResult} shape (issue #403). `deps` is required here (not
 * defaulted to {@link resolveProvisionTargetDeps}'s `undefined`) so this
 * function has no "silently does nothing" mode of its own — the caller
 * (`../ipc/handlers.ts`) is the one place that decides what to do when deps
 * aren't configured yet.
 */
export async function runProvisionTarget(
  target: SshTargetConfig,
  deps: ProvisionTargetDeps,
): Promise<ProvisionTargetResult> {
  const { provision } = await import('@loombox/node');
  const result: ProvisionResult = await provision(target, deps);
  return {
    ok: result.ok,
    targetId: result.targetId,
    steps: result.steps.map(toProgressStep),
    failedStep: result.failedStep,
  };
}

function toProgressStep(step: ProvisionStep): ProvisionProgressStep {
  return { step: step.step, ok: step.ok, message: step.message };
}
