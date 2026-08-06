---
'@loombox/web': patch
'@loombox/node': patch
---

The `@` composer picker becomes the real thing: removable pills over four sources — files, directories, past sessions (searched by title) and tracker items (searched by id or title), the last two something Zed has no equivalent of at all (issue #742, decisions doc C2-3).

- `@loombox/web`: new `$lib/mentions.ts` models a picked reference as ACP's own baseline `ContentBlock::ResourceLink` (`AcpResourceLinkContentBlock`'s `uri`/`name`), disambiguated by `uri` scheme (`file:`, `loombox-session:`, `loombox-tracker:`) rather than inventing a loombox-only field. `MentionPicker.svelte` supersedes the files-only `FileReferencePicker.svelte`: a `Dialog`-based picker with a Files/Sessions/Tracker tab strip, fuzzy-filtered (`$lib/fuzzy.ts`), fully keyboard-driven (arrows navigate, Enter picks, Tab/Shift+Tab cycles source, Esc closes). Picking a result never inserts text — `+page.svelte` renders it as a removable pill in a new row above the composer textarea, so editing the surrounding prose can never corrupt or silently drop a reference. `RelayClient.sendPrompt` gains a `mentions` parameter; `resolveMentionsForSend` degrades a session/tracker mention that no longer exists (checked against `RelayClient.sessions`/`trackerSnapshotFor` at send time) back into plain `@name` text rather than breaking the send — a file/directory mention is never checked, since its target is the agent's own filesystem. `PromptPayload` (the `prompt_inject` envelope's plaintext) gains an optional `mentions: {uri, name}[]`, mirrored field-for-field on both ends exactly like `attachments` already is.
- `@loombox/node`: new `prompt-mentions.ts`'s `renderPromptTextWithMentions` folds `PromptPayload.mentions` into the text `AgentSession.prompt()` takes (still text-only in v1 — see `ResolvedAttachment`'s doc comment) as a "Referenced:" block, one `name — uri` line per mention, appended after the prompt's own prose. A prompt with no mentions is unchanged.

The existing attachment bar and image paste path are untouched — the pill row is a sibling element inside the composer field, not a change to `AttachmentBar.svelte`.
