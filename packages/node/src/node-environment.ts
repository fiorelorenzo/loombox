/**
 * The one place a local resident-node install (`./local/systemd-local-
 * supervisor-backend.ts`, `./launchd/launchd-supervisor-backend.ts`,
 * `./local/provision-local-node.ts`) turns "which environment is this node
 * for" into the four collision-free defaults issue #867 names: the systemd
 * unit name / launchd label, the install root (`~/.loombox`'s own parent
 * of `versions/`, `current`, and the state dir), and a node id that stays
 * distinguishable in the account's node list. Every default below keeps
 * meaning exactly what it always has for `'production'` — a caller that
 * never mentions `environment` (every existing caller, today) sees no
 * behavior change at all; only a caller that explicitly asks for
 * `'preview'` gets the second, disjoint set of paths/names.
 *
 * Deliberately just four pure functions, not a class or a config object:
 * every call site already has its own `options.unitName`/`options.baseDir`/
 * `options.stateDir` override slot (predating this module) that MUST keep
 * winning over whatever default lands here — an operator who genuinely
 * wants a third, fourth, ... node on one machine still has that escape
 * hatch. This module only narrows what happens when none of those are
 * given, from "silently share production's identity" to "silently land on
 * a second environment's own paths instead."
 */
export type NodeEnvironment = 'production' | 'preview';

/** `systemd-provisioning.ts`'s `DEFAULT_UNIT_NAME` for `'production'`, unchanged (`loombox-node.service` — this devbox's real resident node, per that constant's own callers); a distinct, still-recognizable name per non-production environment otherwise. */
export function defaultUnitName(environment: NodeEnvironment): string {
  return environment === 'production'
    ? 'loombox-node.service'
    : `loombox-node-${environment}.service`;
}

/** `launchd-provisioning.ts`'s `DEFAULT_LAUNCHD_LABEL` for `'production'`, unchanged (`dev.loombox.node`); a distinct, still-recognizable label per non-production environment otherwise — same reverse-DNS convention, an extra path component rather than a second top-level domain. */
export function defaultLaunchdLabel(environment: NodeEnvironment): string {
  return environment === 'production' ? 'dev.loombox.node' : `dev.loombox.node-${environment}`;
}

/**
 * The install root's own directory name under the home dir — `.loombox`
 * for `'production'` (unchanged: every existing local backend's own
 * `baseDir`/`stateDir` default), `.loombox-<environment>` otherwise. A
 * whole separate tree, not a subdirectory of `.loombox` itself: the
 * versioned bundle (`versions/`, `current`) a non-production node stages
 * and activates is exactly as disjoint from production's as its state dir
 * is, so `uninstall()`'s `rm -rf` of one environment's `versions/`/`current`
 * can never reach through to the other's — the same reasoning `deploy/
 * relay-preview/docker-compose.yml` already applies with its own named
 * volume, one level up.
 */
export function defaultBaseDirName(environment: NodeEnvironment): string {
  return environment === 'production' ? '.loombox' : `.loombox-${environment}`;
}

/**
 * Appends `-<environment>` to `nodeId` for a non-production environment,
 * unless the caller already included it — issue #867's "two rows both
 * called devbox-node-1" made collision-free by default: an operator who
 * reuses the exact same node id for both environments (the natural thing
 * to type twice) still ends up with two distinguishable entries in the
 * account's node list, without having to remember to vary it by hand.
 * `'production'` is returned unchanged, so an existing devbox's resident
 * node id never shifts under it.
 */
export function collisionFreeNodeId(nodeId: string, environment: NodeEnvironment): string {
  if (environment === 'production') return nodeId;
  const suffix = `-${environment}`;
  return nodeId.endsWith(suffix) ? nodeId : `${nodeId}${suffix}`;
}
