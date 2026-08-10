# VoiceBackend abstraction (BYO-key, clean-room) — design

Date: 2026-08-08. Issue #277, epic #33, milestone v3. Closes the last open v2 issue;
after this the roadmap moves to v3. This is a design spike: the deliverable is this
document, not a package. `packages/voice` and any vendor SDK dependency land with
#278's implementation PR, built to the shape below.

## Clean-room statement

Per SPEC §13, HAPI (AGPL-3.0) is idea-only provenance for "BYO-key voice exists as a
feature" — no HAPI code, docs, or repo was read, cloned, or referenced while writing
this design, and none of HAPI's actual mechanisms are described or reused below. Every
vendor-specific claim in this document is sourced from that vendor's own public API
reference, fetched and read directly while writing this doc, cited by URL next to the
claim. Everything else (crypto, transport, transcript model, permission queue) is
sourced from this repo's own SPEC.md and code. The checklist at the end of this
document is the recorded clean-room review step #277 asks for; #278/#279/#280 each
re-run it for whatever new vendor surface they touch.

## What this has to serve

Three issues sit downstream of this one, and none of them is a hint at the "real"
shape — they're three different pressure tests the interface has to pass at once:

- **#278 (ElevenLabs backend).** Turn-based TTS narration of agent output and STT
  dictation into the composer, keyed by the operator's own ElevenLabs API key.
- **#279 (relay pipeline for voice audio).** Recorded/synthesized audio is plaintext
  until something encrypts it, and the relay is a blind router that must never see
  that plaintext. #279 already resolves the transport question by reusing SPEC §7.25's
  image-attachment pipeline exactly: client-side encryption under the session's
  derived key, upload to the relay's opaque blob store, the agent-supervisor fetches
  and decrypts locally over the existing node-supervisor channel, no new device class.
  This is a hard constraint on this design, not a detail: whatever `VoiceBackend` looks
  like, the bytes it consumes and produces arrive and leave through that path.
- **#280 (voice tool-call approval).** Resolving a pending permission request by
  speech has to be at least as deliberate as clicking it, using the exact same
  decision model (SPEC §7.24's FIFO queue, `PermissionResponse.decision`) — no
  separate permission system for voice.

A vendor-shaped interface (built to look like ElevenLabs' own request/response shapes)
would fit #278 well and then need reshaping for #279's transport constraint and #280's
approval semantics. The interface below is built the other way: audio in, audio/text
out, no vendor concept leaks past the backend boundary.

## Two secrets, never the same one

Voice touches two completely different keys, and the biggest risk in this design is
conflating them:

1. **The transport key** — the AES-256-GCM key SPEC §8 already derives per session from
   the Account Master Key (`@loombox/crypto`'s `deriveSessionKey(amk, accountId,
   sessionId)`, `packages/crypto/src/session-keys.ts`). This is what encrypts the
   recorded clip and the synthesized reply for their trip through the relay's blob
   store (§7.25's `blob_upload`/`blob_ref`/`blob_download`,
   `packages/protocol/src/v1/attachments.ts`), bound to the blob's `ref` as AAD exactly
   like an image attachment. **Nothing new is needed here.** Voice audio is just
   another attachment payload shape riding an already-built, already-tested pipeline —
   this is exactly what #279 already scopes.
2. **The vendor key** — the operator's own ElevenLabs (or other backend) API key. This
   is not an E2E key at all; it's a bearer credential for a third-party HTTP/WebSocket
   API, the same class of secret as an SSH key or a GitHub PAT. It must never be
   encrypted *into* an envelope and shipped anywhere — it must never leave the node
   that holds it, full stop.

The transport key answers "how does the relay stay blind." The vendor key answers "how
does BYO-key work." They don't interact, and #278/#279/#280's authors should never find
themselves passing one where the other belongs.

### Where the vendor key lives

SPEC §8's rule for this class of secret is already built and already has a working
implementation: `@napi-rs/keyring`-backed storage on the node (macOS Keychain /
libsecret, with a 0600-file fallback where no keyring session exists), the same rule
SSH keys, provider tokens, and connected accounts (§7.26) already follow. Concretely,
`packages/node/src/connected-account-keyring.ts` is the existing shared keyring binding
every credential of this shape (GitHub, Jira, more providers later) reads and writes
through, keyed by an opaque `secretRef` that syncs as plaintext metadata while the
value behind it never does (`connectedAccountSecretRef`,
`packages/protocol/src/v1/connected-accounts.ts`).

**Recommendation: give a voice backend's key the same treatment, through a parallel
type, not by widening `ConnectedAccount` itself.** The pattern (keyring binding +
opaque `secretRef` + plaintext-synced metadata row + lazy per-node presence check) is
exactly right for a BYO voice key. The concrete `ConnectedAccount` schema is not: its
`providerAccountId` field is refined specifically for GitHub/Jira's shape (must resolve
from a provider identity call, must not look like an email, must be all-digits for
`provider: 'github'`) and its `scopes: string[] | null` field models OAuth scope
introspection. ElevenLabs' key model has no such identity call baked into an obvious
place — a workspace API key is the unit of access, not an OAuth-scoped per-user
identity (unverified beyond what `POST /v1/text-to-speech` and `POST
/v1/speech-to-text`'s docs show, since this design doesn't need an identity call;
`GET /v1/user`, if implementers need one for a "connected as ___" label, needs its own
doc check before #278 assumes its shape). Bending `ConnectedAccount`'s validation to
fit would either weaken a check that exists for a good reason or leave a
GitHub/Jira-shaped field meaningless for voice. A sibling type —
`VoiceBackendConfig { id, backend: 'elevenlabs' | 'realtime' | 'local' | string,
label, capabilities: VoiceBackendCapabilities, connectedAt, updatedAt, secretRef }` —
reuses the keyring module and the node-locality story (§7.26's "connecting a
credential on one node does not make it usable from another node," resolved lazily
at point of use rather than synced) without inheriting fields that don't apply.

Trade-off: a second type next to `ConnectedAccount` instead of one growing type. Worth
it here because the two schemas would otherwise diverge into "half the fields don't
apply" for one side or the other — the same reasoning SPEC §7.26 itself gives for why
`ConnectedAccount` is its own type and not, say, a login session.

## Who talks to the vendor: the node, always

This is the question that decides everything else, and SPEC §8's existing rule already
answers it: a credential of this class is "held per node/target, not shared through the
relay" (§8's "Provider credentials" bullet), the same rule that already governs Claude
Code/Codex tokens and connected accounts. A client (browser, phone) never holds the raw
vendor key, so **the node is the only thing that ever calls the vendor's API directly.**
Concretely: the agent-supervisor (already the thing #279 has fetching and decrypting
the audio blob over the node-supervisor control channel) is where a `VoiceBackend`
instance runs, symmetric with how it already owns MCP secret injection (§7.17) and
provider-CLI credentials.

Consequences this buys:

- **A mobile client works with zero extra design.** It already talks to the relay for
  everything else; voice is just another blob upload/download plus the ordinary
  session-update/prompt-inject wire path. There's no separate "can this device reach
  the vendor's API" question, because it never needs to.
- **Consistent trust model.** The vendor sees exactly one network peer per operator —
  the node — never a client's IP, never a relay-issued anything. This matches the
  "SSH credentials never leave the node" framing in §8 precisely.
- **Latency cost.** For a turn-based flow (#278/#279's actual scope: record a complete
  utterance, or synthesize a complete response) this is one extra hop
  (client → relay → node → vendor → node → relay → client) hidden behind the recording
  and encryption round trip that's already happening — not a new latency class.

### The harder case: a genuinely realtime (duplex) backend

SPEC §7.12 names "a realtime API" as a second backend shape alongside ElevenLabs, and
the `VoiceBackend` interface needs to be honest that such a backend is a persistent,
bidirectional, low-latency audio session, not a request/response call. Both reference
vendors checked for this design expose the same pattern for exactly this problem:
ElevenLabs' TTS WebSocket accepts either the real `xi-api-key` header *or* a
`single_use_token` query parameter obtained from a separate token-issuing endpoint,
explicitly "recommended for client-side access to avoid exposing your API key"
(<https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input>,
`single_use_token` in the connection query schema); its Scribe realtime STT endpoint
takes the same `token` query parameter, "an alternative to API key or bearer token
authentication for frontend clients," minted from `POST
/v1/single-use-token/batch_scribe` and expiring after 15 minutes
(<https://elevenlabs.io/docs/api-reference/speech-to-text/convert>, `token` query
parameter). OpenAI's Realtime API takes the mirror shape: a standard `Authorization:
Bearer` API key for a server-to-server WebSocket connection, or a short-lived
ephemeral client token when the connection needs to originate from a browser/mobile
device directly
(<https://developers.openai.com/api/docs/guides/realtime-websocket>, "Connect via
WebSocket" and the ephemeral-token paragraph). Every realtime-shaped vendor checked
here builds the escape hatch in: mint a scoped, time-boxed credential from the real
key, hand only that to whoever actually opens the audio socket.

That gives two real options for where a *duplex* session's socket lives, and this is
the first decision that should stay Lorenzo's rather than be picked in this design doc:

- **Option A — always proxied through the node (default of this design).** The node
  opens and holds the vendor's realtime WebSocket itself, relaying audio frames to/from
  the client over the existing relay/session channel (as further blob-shaped chunks or
  a new bounded-fanout event, not decided here since no v3 issue actually asks for
  this backend shape yet). Bought: one trust model for every backend, no new "does this
  vendor's socket ever touch a client device" exception. Paid: real added latency per
  audio frame for a backend whose entire value proposition is sub-200ms turnaround,
  and it makes loombox's own relay/session fan-out the bottleneck for a feature that
  exists specifically to avoid bottlenecks.
- **Option B — node mints a vendor ephemeral token, hands it to the client, client
  connects to the vendor directly for the live audio duplex only.** Bought: the
  latency a realtime backend is actually for. Paid: for the lifetime of that one
  session, the vendor sees the client device's real IP and can correlate its own
  metadata (timing, volume) with it directly — a new category of exception to "no
  third party ever sees anything about the user except through the node," scoped
  tightly (this one vendor, this one live session, time-boxed by the token) but real.
  The raw BYO key itself still never leaves the node under this option — only a
  vendor-minted, single-purpose, short-lived token does.

Neither #278 nor #279 needs this decision: both are turn-based (record a complete
clip, synthesize a complete reply), which is Option A's exact shape with no realtime
socket involved at all. **Recommendation: ship Option A as the only path for v3,
covering ElevenLabs and any turn-based backend, and leave a genuinely low-latency
duplex backend (and this option choice) for whenever a v3+ issue actually proposes
one** — the interface below is typed so a `connect()` method can express either shape
later without a breaking change, but nothing currently in the epic calls it.

## Streaming and the transcript model

Two different "streaming" show up here and the transcript model (SPEC §7.24) already
has opinions about the boundary between them.

**Dictation (STT) input.** A live partial transcript while the user is still talking is
not a message and must never become one. §7.24's reducer is explicit that ACP content
is appended by `messageId`/turn — there is no ACP concept for "a user message that
keeps being retyped as more audio arrives," and inventing one here would be a
transcript-model change, not a voice one. Recommendation: a live partial transcript is
purely local UI state on whichever side is running STT (see below), rendered as a
"listening…" affordance in the composer exactly like any other unsent composer draft —
discarded whenever the user cancels, and replaced by the plain, final transcribed text
the instant the utterance is committed. That final text is not a new wire concept
either: it becomes an ordinary prompt through the existing send path, indistinguishable
from something the user typed. This also means dictation input is symmetric with
mid-turn composer queuing (§7.24's "a submitted prompt queues as the next turn"): a
dictated prompt that lands mid-turn queues exactly the same way a typed one does.

*Where does STT actually run, mechanically?* Since the node is the only thing holding
the vendor key (previous section), a client cannot call ElevenLabs' STT endpoint
directly even for local partial-preview purposes without either (a) the node proxying
every partial audio chunk in real time — likely too slow to feel "live" for a
partial-preview affordance that exists purely for UX polish, not correctness — or (b)
accepting that the *final* commit's accuracy is all that matters and skipping a live
partial preview entirely for v3, sending the complete recorded utterance once (through
#279's existing blob pipeline) and showing only a spinner, not a live transcript, while
it resolves. **Recommendation: (b) for v3.** #278's own acceptance criterion is "speech-
to-text transcribes a recorded utterance into a prompt" — a spinner-then-result flow
satisfies that exactly and matches ElevenLabs' own batch `POST /v1/speech-to-text`
shape (`model_id` + `file` in, one committed `text` + word-level `words[]` out,
<https://elevenlabs.io/docs/api-reference/speech-to-text/convert>) with no realtime
component at all. A live partial-preview affordance is a real, separate future
enhancement, not something #278 needs to build to meet its own bar.

**Narration (TTS) output.** This is the reverse direction: already-committed
`agent_message_chunk`/`agent_thought_chunk` text (§7.24's reducer output) becoming
speech. The naive approach — synthesize each chunk the instant it arrives — produces
audio for sentence fragments and mispronounces anything that depends on later context
(a number followed by a unit, a word split across two chunks). Recommendation: buffer
narration text to a sentence/clause boundary (or the turn's own completion, whichever
comes first) before handing it to `synthesize()`, mirroring how §7.24 already treats a
thought's "Thinking Ns" header as distinct from the settled content underneath it —
reasoning text and speakable text both need a "is this actually done enough to commit
to" boundary, and voice's is coarser (a clause) than the transcript's own
(append-per-chunk). This is exactly the scenario ElevenLabs' own streaming TTS
WebSocket is built for — "generate audio from partial text input while ensuring
consistency throughout the generated audio," explicitly contrasted against their own
plain HTTP endpoint being the better fit "when the entire input text is available
upfront"
(<https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input>)
— so a backend that has real partial-text streaming support has a real place to plug
that in: `synthesize()`'s optional `onChunk` callback below exists for exactly this,
letting a backend stream partial audio out as sentence-buffered text streams in,
without forcing every backend (a local engine, a plain-HTTP vendor) to fake streaming
it doesn't have.

**The revival boundary (#706) applies to voice with no new rule needed.** A session
revived after a node restart has no memory of turns before the gap (#706/#911's own
scoping: the client is told plainly that the revived agent does not remember earlier
turns). Voice inherits that for free rather than needing its own case: there is no
audio to resume narrating (the turn that was mid-narration is gone, not paused), and a
dictated prompt caught mid-disconnect follows the exact same "queued, or rejected with
a stated reason" contract `promptInjectResult`/`promptInjectSendResult` already define
(`packages/protocol/src/v1/steering.ts`) — voice input is just another way a prompt
reaches that same path, not a parallel one with its own error semantics.

**#202's burst grouping is the same principle from the other direction.** The
transcript model already distinguishes "a real ACP-shaped event" from "ephemeral
local/live state that never becomes one" — a burst/group card's own collapsed state,
the "Thinking Ns" ticking timer, and the streaming smoothing buffer are all live
UI state that never appears as a persisted transcript item in its own right. A live STT
partial is the same category, not a new one: it's local state that either resolves into
a real event (the final prompt) or evaporates (cancelled), and it never needs the
tier-1/2/3 rendering pipeline to learn about it at all.

## Tool-call approval by voice (#280): a security surface, not a convenience feature

#280's own acceptance criteria already draw the right boundary — voice resolves the
*same* `PermissionResponse`/`decision` that a keyboard shortcut or a tap does (SPEC
§7.24's FIFO queue, `packages/protocol/src/v1/steering.ts`'s `permissionResponse`), and
an unrecognized utterance leaves the request queued rather than guessing. This design
adds three things underneath that boundary, without designing #280's actual UI:

1. **Match against the request's own `options[]`, never a hardcoded vocabulary.** A
   pending request's real options (`AcpPermissionOption { optionId, name, kind }`,
   `packages/providers/core/src/types.ts`) differ by provider on purpose — Claude's
   set includes "Allow once" / "Allow all edits" / "Bypass everything" / "Allow for
   this session" / "Deny"; Codex's is "Allow Once" / "Allow for Session" / "Reject"
   (both verified live against real adapter fixtures in this repo's own test suite,
   `providers/claude/src/permissions.test.ts`, `providers/codex/src/permissions.test.ts`).
   A voice layer that only understands "allow"/"deny" would silently fail to resolve
   half of Claude's own option set. STT output should be matched against the *specific*
   focused card's own `options[].name` (fuzzy/synonym matching is an implementation
   concern for #280, not a design one) and resolved via that option's own `optionId` —
   never a re-derived guess at intent.
2. **Confidence gates toward "leave it queued," never toward a guess.** Both an STT
   confidence score (ElevenLabs' batch STT already returns per-word `logprob`,
   <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>) and a
   name-matching confidence should have a floor below which the request stays queued —
   this is #280's own acceptance criterion, stated here as the concrete mechanism: no
   partial match resolves anything.
3. **A destructive-shaped decision earns an audible confirmation, not just a visual
   one.** Since the operator may not be looking at the screen when approving by voice
   (that's the entire point of the feature), the same `VoiceBackend.synthesize()` this
   design already defines should read back what was just resolved ("Approved: allow
   once" or similar, sourced from the chosen option's own `name`) before or immediately
   after committing the decision — cheap to build once TTS exists at all, and it closes
   the one failure mode unique to voice approval: committing to the wrong thing with no
   visual confirmation loop.

**Second decision that should stay Lorenzo's: does voice ever resolve an
`allow_always`/`reject_always`-kind option, or only the `*_once` kinds?** An
`allow_always`/`bypass`-kind decision grants standing access beyond the current tool
call — a misheard "always" (a plausible STT failure mode, not a hypothetical one) has a
materially worse blast radius than a misheard "once," which only affects a single
already-surfaced, already-visible tool call.

- **Restrict voice to `*_once` kinds only.** An `allow_always`/`reject_always`-shaped
  option, if present in the request's own `options[]`, is never voice-resolvable —
  falls through to "unrecognized," leaving it queued for a tap/keystroke. Bought: the
  single highest-consequence class of permission decision can never be granted by a
  misheard word. Paid: a genuinely deliberate, correctly-recognized "always" spoken
  command still has to be tapped instead, which is friction #280 didn't ask for.
- **Allow every kind the request offers, gated only by the confidence floor above.**
  Bought: full parity with the keyboard-shortcut path #280 explicitly asks to match
  ("exactly as the existing `1`..`n` keyboard-shortcut path does"). Paid: the
  confidence floor is now the only thing standing between a misheard word and a
  standing grant, and a floor tuned from STT accuracy data is a v3+ maturity level
  this spike has no data to set.

This document does not pick one — it's a real security/UX trade-off #280's
implementer should raise with Lorenzo directly with #280's own recognition-accuracy
numbers in hand, not one to bake into the abstraction now. The `VoiceBackend` interface
below stays agnostic to whichever way it's resolved: it just returns a transcript and a
confidence, and #280's own approval logic decides what to do with them.

## The `VoiceBackend` interface (types only, illustrative)

No implementation, no vendor SDK import — the interface only, sketched to make the
recommendations above concrete enough for #278 to build against. Runs exclusively on
the node/agent-supervisor (never in `apps/web`'s browser bundle, never on the relay),
mirroring `packages/shared/src/tracker-backend.ts`'s existing per-provider abstraction
shape (`TrackerBackend`/`TrackerBackendCapabilities`) rather than inventing a new
abstraction style.

```ts
/** Capability flags, not a string array — the vocabulary is small, fixed, and known
 * up front (unlike TrackerBackend's open-ended comments/transitions/boards/sprints
 * set), so a typed object catches a typo a string array wouldn't. */
export interface VoiceBackendCapabilities {
  textToSpeech: boolean;
  speechToText: boolean;
  /** True only for a backend whose `connect()` below is actually implemented. */
  realtime: boolean;
}

export interface SynthesizeInput {
  text: string;
  /** Backend-specific voice selector (an ElevenLabs voice_id, a local engine's voice
   * name); opaque to every caller above this interface. */
  voiceId?: string;
  /** Playback container the caller expects back — every reference backend checked for
   * this design supports at least one of these. */
  format: 'mp3' | 'wav' | 'pcm16';
}

export interface SynthesizeResult {
  audio: Uint8Array;
  format: SynthesizeInput['format'];
  durationMs?: number;
}

export interface TranscribeInput {
  audio: Uint8Array;
  mimeType: string;
  /** ISO 639-1/639-3 hint, never required — every reference backend checked
   * auto-detects when omitted. */
  languageHint?: string;
}

export interface TranscribeResult {
  text: string;
  /** 0-1 if the backend exposes one (e.g. ElevenLabs' per-word logprob, rolled up);
   * undefined for a backend that doesn't. #280's confidence gate treats undefined as
   * "not confident enough for voice approval," never as 1.0. */
  confidence?: number;
  languageCode?: string;
}

/** A vendor-minted, time-boxed, single-purpose credential (SPEC "who talks to the
 * vendor" section above) — never the raw BYO key itself. Only meaningful for a
 * realtime-shaped backend choosing Option B of that section; a turn-based backend
 * never produces one. */
export interface VoiceBackendEphemeralCredential {
  token: string;
  expiresAt: number;
}

export interface VoiceRealtimeSession {
  sendAudioChunk(chunk: Uint8Array): void;
  onPartialTranscript?(handler: (text: string) => void): void;
  onCommittedTranscript?(handler: (result: TranscribeResult) => void): void;
  onAudioChunk?(handler: (chunk: Uint8Array) => void): void;
  close(): Promise<void>;
}

/**
 * One instance per configured `VoiceBackendConfig`, constructed with the real BYO key
 * already resolved from the node's keyring — this interface never sees a `secretRef`,
 * only the resolved credential, exactly like `GithubTrackerBackend`'s injected
 * `resolveCredential` pattern (never importing the keyring module itself).
 */
export interface VoiceBackend {
  readonly id: string;
  readonly capabilities: VoiceBackendCapabilities;

  /** One call, one result — no partial output crosses this boundary as a return value.
   * `onChunk`, if given, receives whatever partial audio the backend can stream as
   * sentence-buffered text streams in (see "Narration (TTS) output)" above); a backend
   * with no native streaming just calls it once with the whole result. */
  synthesize(input: SynthesizeInput, onChunk?: (chunk: Uint8Array) => void): Promise<SynthesizeResult>;

  /** One recorded utterance in, one committed transcript out — #278's dictation shape
   * exactly (record until released, transcribe once). No partial-result callback here
   * on purpose: a live partial preview is out of v3's scope (see "Dictation (STT)
   * input" above), and a backend that only supports realtime STT still implements this
   * by recording internally against its own realtime endpoint and returning the final
   * committed result. */
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;

  /** Optional: only a backend whose vendor API is inherently a persistent duplex
   * connection implements this. Undefined for ElevenLabs' batch/streaming-but-still-
   * turn-based shape and for a local engine. Never called with the raw BYO key in any
   * form the caller could forward to a client — if the backend's implementation needs
   * to hand a client a live audio socket at all (this design's Option B), it mints a
   * `VoiceBackendEphemeralCredential` internally and the caller relays only that. */
  connect?(): Promise<VoiceRealtimeSession>;
}
```

## Candidate backend mapping

Per #277's own acceptance: at least two real backends plus a local stub, mapped onto
the interface above.

| | ElevenLabs (#278) | a realtime API (generic; OpenAI's Realtime API used as the reference vendor for this design, per SPEC §7.12's own wording — no vendor is committed to here beyond #278) | local (stub) |
|---|---|---|---|
| `capabilities` | `{ textToSpeech: true, speechToText: true, realtime: false }` for v3 (batch/turn-based only, per the "Option A only for v3" recommendation above) | `{ textToSpeech: true, speechToText: true, realtime: true }` — the only backend shape where `realtime: true` is honest | `{ textToSpeech: true, speechToText: true, realtime: false }`, or a subset if only one direction is implemented |
| `synthesize()` | `POST /v1/text-to-speech/{voice_id}` (`xi-api-key` header, `text`/`model_id`/`voice_settings` body, returns an audio file — <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>); a real implementation may instead use the `stream-input` WebSocket for the sentence-buffered streaming case above | Vendor's realtime session accepts synthesis instructions and streams audio back over the same duplex session `connect()` opens — no separate one-shot call the way a batch vendor has one | A bundled or system TTS engine invoked as a local process/library call, no network egress at all |
| `transcribe()` | `POST /v1/speech-to-text` (multipart `file` + `model_id`, returns `text` + `words[]` with per-word `logprob` — <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>) | Same duplex session, fed the complete recorded clip and awaited for its final committed result, per this design's "no live partial preview in v3" call | A local STT engine (e.g. a bundled small model) invoked as a local process/library call |
| `connect()` | `undefined` for v3 (Option A only) | Implemented: opens the vendor's realtime WebSocket, mediated per this design's "who talks to the vendor" section (proxied per Option A by default; Option B is Lorenzo's call, not exercised until a v3+ issue asks for it) | `undefined` — a local engine has no network session to hold open |
| Key custody | ElevenLabs API key, `VoiceBackendConfig.secretRef` into the node keyring | Vendor API key, same keyring pattern | None — no BYO key exists for a fully local engine |

## Clean-room checklist (SPEC §13 gate)

Run once for this design doc; #278/#279/#280 each re-run the vendor-specific rows for
whatever new surface they touch before their implementation PR lands.

- [x] No HAPI source, documentation, or derived material was read, cloned, or
      referenced at any point while writing this design.
- [x] Every vendor-specific claim above cites a URL under `elevenlabs.io/docs` or
      `developers.openai.com/api/docs`, fetched directly while writing this document,
      not reconstructed from memory or from a third party's description of the vendor.
- [x] No code was copied from any vendor's SDK, sample repository, or blog post; the
      interface above was designed against the documented HTTP/WebSocket contracts
      only, not against any vendor or community client library's implementation.
- [x] No other project in this workstation's checkouts (emdash, Nimbalyst, Happy, or
      any other repo present on this box) was read for this design — SPEC §13 already
      scopes those as reference material for other areas, not voice.
- [ ] (#278) ElevenLabs SDK/dependency choice: confirm the chosen npm package (official
      `@elevenlabs/elevenlabs-js` or a direct `fetch` implementation) is checked against
      its own license before it's added to `package.json`.
- [ ] (#280) Confirm live provider option sets (Claude/Codex, and any provider added
      before #280 lands) against this repo's own adapter fixtures, the way this
      document already did for the two shipped providers — a new provider's `options[]`
      vocabulary might not fit "match by name" cleanly and would need its own check.

## Decisions Lorenzo has to take

Both already laid out in full above with their trade-offs; summarized here so neither
gets lost before #279/#280 pick them up:

1. **Realtime backend transport** ("Who talks to the vendor" section): always proxy a
   future duplex backend's audio through the node (Option A, this design's default and
   the only path v3 actually needs), or let the node mint a vendor ephemeral token and
   have the client connect to the vendor directly for lower latency (Option B, a new
   category of "a third party sees the client's IP" exception). Not urgent — no v3
   issue calls `connect()` yet.
2. **Voice-approval scope** ("Tool-call approval by voice" section): restrict voice
   resolution to `*_once`-kind options only (safer, some friction), or allow every kind
   the request offers gated by a confidence floor (full keyboard parity, floor-tuning
   risk). This one is urgent for #280 specifically and should be settled before that
   issue's implementation, not after.

## Out of scope

No `packages/voice` created by this issue — the interface above is illustrative, typed
enough for #278 to build against, not a compiling package. No wire-protocol change: v3
as scoped (#278/#279/#280) needs no new `WireMessageV1` member — audio travels as an
ordinary blob attachment (§7.25's existing `blob_upload`/`blob_ref`/`blob_download`) and
approval travels as an ordinary `permission_response`; only a future realtime backend
(Decision 1 above) might need one, and this design doesn't propose its shape since
nothing calls for it yet. No ElevenLabs (or any vendor) SDK dependency added. No
`VoiceBackendConfig` zod schema added to `@loombox/protocol` — the sketch above names
the shape #278 should give it, not a landed schema.

## Verification

This is a design document; there is no code to run. Verification here is a direct
line-by-line check against #277's acceptance criteria as scoped for this spike (per
the wave assignment: a written, dated design in `docs/superpowers/specs/` matching the
format of the specs already there; every open question either answered with a
recommendation and its trade-off, or named as Lorenzo's own call with the options laid
out; no code beyond illustrative types) — both open questions #277 itself flags
(backend mapping, key custody) and the three raised by #278/#279/#280's own shape
(vendor transport, streaming/transcript boundary, voice-approval security) are each
addressed above with that exact structure.
