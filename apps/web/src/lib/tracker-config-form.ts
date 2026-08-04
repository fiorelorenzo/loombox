/**
 * Pure form-state helpers for the per-project `TrackerMode` picker (SPEC
 * §7.10; issue #220). Kept out of `TrackerConfigPanel.svelte` so "does this
 * draft add up to a valid `TrackerMode`" is testable with plain vitest, no
 * component mount — the same split `mcp-server-store.ts` draws between its
 * own CRUD/validation logic and `McpServerConfigPanel.svelte`'s rendering.
 *
 * {@link buildTrackerMode} builds straight off `@loombox/protocol`'s own
 * `trackerMode`/`githubTarget`/`jiraTarget` schemas (`safeParseTrackerMode`)
 * rather than hand-rolling a parallel set of field checks: the two must
 * never drift, which is issue #220's own "the form's shape must follow
 * those types exactly, not a parallel invention".
 */

import { safeParseTrackerMode, type TrackerMode } from '@loombox/protocol';

export type TrackerModeKind = 'native' | 'live';
export type LiveProvider = 'github' | 'jira';

/**
 * The live-config form's raw field values, still strings (an `<Input>`'s
 * natural shape, including the ones that are conceptually numeric —
 * `projectNumber`) — {@link buildTrackerMode} is what turns this into a
 * real `TrackerMode` or rejects it with a message a `Field`'s `error` prop
 * can show directly.
 */
export interface LiveTrackerDraft {
  provider: LiveProvider;
  connectionId: string;
  owner: string;
  repo: string;
  projectNumber: string;
  cloudId: string;
  projectKey: string;
}

/** A blank live-mode draft, defaulted to `github` (the default `TrackerBackend` slice, per SPEC §7.10). */
export function emptyLiveTrackerDraft(provider: LiveProvider = 'github'): LiveTrackerDraft {
  return {
    provider,
    connectionId: '',
    owner: '',
    repo: '',
    projectNumber: '',
    cloudId: '',
    projectKey: '',
  };
}

/**
 * Reconstructs a form-editable {@link LiveTrackerDraft} from an already-
 * saved `live` `TrackerMode` — the "switch mode" editor opens pre-filled
 * with the project's current config, never blank, when one already exists.
 * A `native` mode has no live fields to recover, so this returns a blank
 * draft for it (the caller only reaches for this once it already knows
 * `mode.kind === 'live'`, but it stays total rather than partial).
 */
export function liveTrackerDraftFrom(mode: TrackerMode): LiveTrackerDraft {
  if (mode.kind !== 'live') return emptyLiveTrackerDraft();
  const draft = emptyLiveTrackerDraft(mode.provider);
  draft.connectionId = mode.connectionId;
  if (mode.provider === 'github') {
    const target = mode.target as { owner: string; repo: string; projectNumber?: number };
    draft.owner = target.owner;
    draft.repo = target.repo;
    draft.projectNumber = target.projectNumber === undefined ? '' : String(target.projectNumber);
  } else {
    const target = mode.target as { cloudId: string; projectKey: string };
    draft.cloudId = target.cloudId;
    draft.projectKey = target.projectKey;
  }
  return draft;
}

export interface BuildTrackerModeResult {
  mode?: TrackerMode;
  error?: string;
}

/**
 * Validates a draft and returns either the parsed `TrackerMode` or a
 * human-readable error — never throws. `kind === 'native'` always
 * succeeds (there is nothing else to fill in); `kind === 'live'` needs a
 * connected account plus a provider-shaped target, checked against the
 * real `@loombox/protocol` schema so this never accepts something the rest
 * of the app's `safeParseTrackerMode` re-validation would then reject.
 */
export function buildTrackerMode(
  kind: TrackerModeKind,
  live: LiveTrackerDraft,
): BuildTrackerModeResult {
  if (kind === 'native') return { mode: { kind: 'native' } };

  if (live.connectionId.trim() === '') {
    return { error: 'Pick a connected account before saving.' };
  }

  if (live.provider === 'github') {
    const owner = live.owner.trim();
    const repo = live.repo.trim();
    const projectNumberRaw = live.projectNumber.trim();
    let projectNumber: number | undefined;
    if (projectNumberRaw !== '') {
      const parsed = Number(projectNumberRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { error: 'Project number must be a positive whole number.' };
      }
      projectNumber = parsed;
    }
    return finishBuild({
      kind: 'live',
      provider: 'github',
      connectionId: live.connectionId.trim(),
      target: { owner, repo, ...(projectNumber === undefined ? {} : { projectNumber }) },
    });
  }

  return finishBuild({
    kind: 'live',
    provider: 'jira',
    connectionId: live.connectionId.trim(),
    target: { cloudId: live.cloudId.trim(), projectKey: live.projectKey.trim() },
  });
}

function finishBuild(candidate: unknown): BuildTrackerModeResult {
  const result = safeParseTrackerMode(candidate);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'Invalid tracker configuration.';
    return { error: message };
  }
  return { mode: result.data };
}

/** A one-line human summary of a saved `TrackerMode` — backs the "current mode" card `TrackerConfigPanel.svelte` shows once a project has one, so switching it stays an explicit, informed choice rather than a silent flip. */
export function describeTrackerMode(mode: TrackerMode): string {
  if (mode.kind === 'native') return "Native — loombox's own local tracker";
  if (mode.provider === 'github') {
    const target = mode.target as { owner: string; repo: string; projectNumber?: number };
    const board = target.projectNumber === undefined ? '' : `, board #${target.projectNumber}`;
    return `Live — GitHub: ${target.owner}/${target.repo}${board}`;
  }
  const target = mode.target as { cloudId: string; projectKey: string };
  return `Live — Jira: ${target.projectKey} (${target.cloudId})`;
}
