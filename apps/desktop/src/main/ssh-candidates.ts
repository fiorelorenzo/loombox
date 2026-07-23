import type { ListSshHostCandidatesResult } from '../shared/bridge';

/**
 * TODO(#403 follow-up): `@loombox/node`'s `src/ssh/host-candidates.ts`
 * already implements exactly this (`discoverSshTargets`, autodetecting from
 * `~/.ssh/config` + ssh-agent), but it is not part of that package's public
 * `index.ts` export surface this app is scoped to import from (issue #403
 * is `apps/desktop`-only; exporting it is a one-line change to a different
 * package, out of this scaffold's scope). Until that lands, this bridge
 * method always reports "nothing discovered", which is exactly the shape
 * the add-target wizard is meant to treat as "fall back to manual entry"
 * (`requiresManualEntry: true`) — so wiring the real implementation later
 * only replaces this function's body, not the contract.
 */
export async function listSshHostCandidates(): Promise<ListSshHostCandidatesResult> {
  return { candidates: [], requiresManualEntry: true };
}
