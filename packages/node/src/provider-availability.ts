import { shQuote } from './ssh/remote-transport';
import type { ExecutionTarget } from './target';

/**
 * The slice of a registered provider module {@link probeProviderAvailability}
 * actually needs: its id, and the vendor CLI its ACP bridge drives (SPEC
 * §5.5's `AcpProviderModule.requiredCommand` — `packages/providers/core`'s
 * v1 provider-module contract; an `npx` bridge names the CLI it wraps, never
 * `npx` itself). Kept as a small structural type here rather than importing
 * `AcpProviderModule`, so this probe has no compile-time dependency on
 * `@loombox/providers-core`'s module shape: any registered-module list
 * (an `AcpProviderModule[]`, once that package adds the field) is already
 * assignable to `ProviderAvailabilityCandidate[]` with no import needed.
 */
export interface ProviderAvailabilityCandidate {
  readonly id: string;
  readonly requiredCommand: string;
}

/** Builds the single `sh -c` script that checks every candidate's `requiredCommand` in one pass — one line per candidate, each independent so one missing command never short-circuits the rest. */
function buildProbeScript(candidates: readonly ProviderAvailabilityCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `command -v ${shQuote(candidate.requiredCommand)} >/dev/null 2>&1 && printf '%s\\n' ${shQuote(candidate.id)}`,
    )
    .join('\n');
}

/**
 * Probes which of `candidates` are actually runnable on `target` (SPEC
 * §5.5, `@loombox/protocol`'s `targetDescriptor.providers`): a provider's
 * `requiredCommand` must resolve on THAT target's own PATH. `target` already
 * abstracts `local` vs. `ssh:` uniformly behind one `exec()` (`./target.ts`'s
 * `ExecutionTarget`) — an `ssh:` target's `exec` runs over its own pooled
 * transport (`SshExecutionTarget`), so this same implementation genuinely
 * probes the remote host's PATH rather than the node's own.
 *
 * Exactly one `exec` call no matter how many candidates: every `command -v`
 * check is folded into a single `sh -c` script (see {@link buildProbeScript}),
 * so probing N providers on an `ssh:` target costs one round trip, not N.
 *
 * Never throws or rejects: an unreachable target, a nonzero shell exit, or
 * `sh` itself being missing all degrade to `[]` — indistinguishable on the
 * wire from a reachable target that genuinely has no agent CLI installed,
 * which `targetDescriptor.providers`'s own doc comment documents as the
 * correct reading of an empty array.
 */
export async function probeProviderAvailability(
  target: ExecutionTarget,
  candidates: readonly ProviderAvailabilityCandidate[],
  targetId?: string,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const result = await target.exec('sh', ['-c', buildProbeScript(candidates)]);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `probeProviderAvailability: probe failed for target "${targetId ?? target.kind}" (${target.kind}): ${message}`,
    );
    return [];
  }
}
