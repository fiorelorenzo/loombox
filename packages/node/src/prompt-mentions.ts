/**
 * Renders a `PromptPayload`'s structured `mentions` (issue #742's `@`-mention
 * pills, decisions doc C2-3) into the plain text `AgentSession.prompt()`
 * takes as its `text` argument. `AgentSession.prompt()` grew a second,
 * content-block argument for the inline base64 image hand-off (SPEC.md
 * §7.25 "Hand off to the agent"; issue #158, `node-daemon.ts`'s
 * `deliverPrompt`) — but a mention is deliberately NOT folded into that
 * array: unlike an attachment's bytes, a mention's `ResourceLink` needs no
 * fetch/decrypt/re-sniff step of its own (see below), so there's nothing
 * gained by routing it through the same capability-gated content-block
 * path; it still reaches the agent by being appended to the prompt text.
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
