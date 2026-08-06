/**
 * The composer's `@`-mention pills (issue #742, decisions doc C2-3): a
 * removable reference to a file, a directory, a past session (searched by
 * title), or a tracker item (searched by id or title) — the last two are
 * something Zed has no equivalent of at all, since it has no built-in
 * tracker. Pure, DOM-free types and helpers only — no WebSocket, no crypto,
 * no Svelte — mirroring `$lib/attachments.ts`'s own split: `MentionPicker.svelte`
 * renders these, `+page.svelte` holds the composer's `mentions` list, and
 * `RelayClient.sendPrompt` turns a still-live one into the wire's
 * `PromptMentionRef`.
 *
 * **The wire representation.** Every mention's `resourceLink` is ACP's own
 * baseline `ContentBlock::ResourceLink` (`@loombox/providers-core/browser`'s
 * `AcpResourceLinkContentBlock`: `uri`/`name`/optional `mimeType`/`size`) —
 * not a loombox-invented shape. `uri`'s scheme disambiguates the four
 * sources: `file:<project-relative path>` for a file, the same with a
 * trailing `/` for a directory (both read by the agent's own filesystem
 * access, exactly like the `@path` convention the composer already sent as
 * literal text before this issue), `loombox-session:<sessionId>` for a past
 * session, `loombox-tracker:<nodeId>/<projectPath>/<recordId>` for a
 * tracker item — custom URI schemes are ordinary ACP usage (any agent
 * that already resolves `file:`/`https:` links tolerates an unfamiliar
 * scheme in a `resource_link`), not a second, parallel field bolted onto
 * the content block.
 *
 * **Why session/tracker mentions carry their own `resourceLink` rather than
 * a raw id.** A picked mention outlives the moment it was picked — the
 * session or tracker record it names can be deleted before the prompt is
 * actually sent. `resolveMentionsForSend` below is what makes that honest
 * (issue #742's "a session or tracker item that no longer exists becomes
 * plain text rather than breaking the send") without ever losing the
 * mention's own display name, which is all a degraded mention has left to
 * offer the prompt.
 */

import type { AcpResourceLinkContentBlock } from '@loombox/providers-core/browser';

export type MentionKind = 'file' | 'directory' | 'session' | 'tracker';

interface MentionBase {
  readonly resourceLink: AcpResourceLinkContentBlock;
}

export interface FileMention extends MentionBase {
  readonly kind: 'file';
  /** Project-relative, matching `FileTreePanel`/`RelayClient.fileTreeFor`'s own path convention. */
  readonly path: string;
}

export interface DirectoryMention extends MentionBase {
  readonly kind: 'directory';
  readonly path: string;
}

export interface SessionMention extends MentionBase {
  readonly kind: 'session';
  readonly sessionId: string;
}

export interface TrackerMention extends MentionBase {
  readonly kind: 'tracker';
  /** The record's own project — carried directly rather than re-derived from whichever session happens to be selected when the prompt is finally sent (it may no longer be this one). */
  readonly nodeId: string;
  readonly projectPath: string;
  readonly recordId: string;
}

export type MentionRef = FileMention | DirectoryMention | SessionMention | TrackerMention;

export function fileMention(path: string): FileMention {
  const name = path.split('/').pop() || path;
  return { kind: 'file', path, resourceLink: { type: 'resource_link', uri: `file:${path}`, name } };
}

export function directoryMention(path: string): DirectoryMention {
  return {
    kind: 'directory',
    path,
    resourceLink: { type: 'resource_link', uri: `file:${path}/`, name: path },
  };
}

export function sessionMention(sessionId: string, title: string): SessionMention {
  return {
    kind: 'session',
    sessionId,
    resourceLink: { type: 'resource_link', uri: `loombox-session:${sessionId}`, name: title },
  };
}

export function trackerMention(
  nodeId: string,
  projectPath: string,
  recordId: string,
  label: string,
): TrackerMention {
  return {
    kind: 'tracker',
    nodeId,
    projectPath,
    recordId,
    resourceLink: {
      type: 'resource_link',
      uri: `loombox-tracker:${nodeId}/${encodeURIComponent(projectPath)}/${recordId}`,
      name: label,
    },
  };
}

/** A mention's own `uri` is already unique per (kind, target) — the pill list's dedupe/Svelte-`#each` key, and how `resolveMentionsForSend`'s caller correlates a stale mention back to what to remove. */
export function mentionKey(mention: MentionRef): string {
  return mention.resourceLink.uri;
}

export interface MentionSendResolution {
  /** The prose to actually send: `text` unchanged, plus any degraded mention's own name folded back in as plain `@name` text. */
  text: string;
  /** Mentions still safe to hand the agent as a structured wire reference. */
  liveMentions: MentionRef[];
}

/**
 * Splits `mentions` into what's still safe to send as a structured
 * reference and what has to degrade to plain text instead (issue #742's
 * "a session or tracker item that no longer exists becomes plain text
 * rather than breaking the send"). A file/directory mention is always
 * treated as live here: its target is the agent's own filesystem, resolved
 * only once the agent actually reads it, not something this composer can
 * usefully pre-check — the exact same trust boundary the old plain-text
 * `@path` convention already had. `isLive` is the caller's own
 * still-current check for a session/tracker mention (backed by whatever
 * live store it already holds — `RelayClient.sessions`/`trackerSnapshotFor`
 * in `+page.svelte`), kept out of this module so it stays framework/store
 * free and trivially testable with a fake.
 */
export function resolveMentionsForSend(
  text: string,
  mentions: readonly MentionRef[],
  isLive: (mention: SessionMention | TrackerMention) => boolean,
): MentionSendResolution {
  const liveMentions: MentionRef[] = [];
  const staleNames: string[] = [];
  for (const mention of mentions) {
    if (mention.kind === 'file' || mention.kind === 'directory' || isLive(mention)) {
      liveMentions.push(mention);
    } else {
      staleNames.push(mention.resourceLink.name ?? mention.resourceLink.uri);
    }
  }
  if (staleNames.length === 0) return { text, liveMentions };
  const suffix = staleNames.map((name) => `@${name}`).join(' ');
  return { text: text === '' ? suffix : `${text} ${suffix}`, liveMentions };
}
