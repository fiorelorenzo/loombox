/**
 * Renders a `PromptPayload`'s structured `mentions` (issue #742's `@`-mention
 * pills, decisions doc C2-3) into the plain text `AgentSession.prompt()`
 * actually takes. `AgentSession.prompt()` is text-only in v1 — handing a
 * mention to the agent as a real ACP content block is a separate,
 * provider-adapted concern out of this issue's scope (see
 * `ResolvedAttachment`'s doc comment in `node-daemon.ts`, which already
 * carries this exact caveat for image attachments) — so a mention's
 * resolved reference reaches the agent by being appended to the prompt
 * text, not by growing a second content-block argument nothing downstream
 * of this node consumes yet.
 *
 * Each mention already carries the exact ACP baseline `ContentBlock::
 * ResourceLink` shape it was picked as on the client
 * (`apps/web/src/lib/mentions.ts`'s `MentionRef.resourceLink`: `uri`/
 * `name`) — this just formats that pair, kind-agnostically (it never
 * branches on what the uri scheme means), one per line, under a
 * "Referenced:" heading the agent reads as plain prose. A prompt with no
 * mentions is returned completely unchanged — the common case, `text`
 * alone, exactly what every prompt before this issue already sent.
 */

/** Mirrors `apps/web/src/lib/relay-client.ts`'s private `PromptMentionRef` field-for-field — the same shape a `prompt_inject` envelope's plaintext carries. */
export interface PromptMentionRef {
  uri: string;
  name: string;
}

export function renderPromptTextWithMentions(
  text: string,
  mentions: PromptMentionRef[] | undefined,
): string {
  if (!mentions || mentions.length === 0) return text;
  const lines = mentions.map((mention) => `- ${mention.name} — ${mention.uri}`);
  const block = `Referenced:\n${lines.join('\n')}`;
  return text === '' ? block : `${text}\n\n${block}`;
}
