import { discoverSshTargets } from '@loombox/node';

import type { ListSshHostCandidatesResult } from '../shared/bridge';

/**
 * Real implementation (issue #475 follow-up to the #403 TODO this replaces):
 * `@loombox/node`'s `discoverSshTargets` is now exported from that package's
 * public `index.ts`, so this bridge method drives it directly for the
 * desktop-machine case (autodetecting from ITS OWN `~/.ssh/config` +
 * ssh-agent) instead of always reporting "nothing discovered". The wizard's
 * "falls back to manual entry when nothing is discoverable" contract still
 * holds — `discoverSshTargets` never throws (see its own doc comment), so
 * an empty `~/.ssh/config` still resolves to `{ candidates: [],
 * requiresManualEntry: true }`, exactly the stub's old fixed result, just
 * for a real reason now rather than unconditionally.
 */
export async function listSshHostCandidates(): Promise<ListSshHostCandidatesResult> {
  const { candidates, requiresManualEntry } = await discoverSshTargets();
  return { candidates, requiresManualEntry };
}
