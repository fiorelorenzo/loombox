# loombox Zed-parity — the 25 decisions Lorenzo took

Status: **settled** (2026-08-05). This is not a proposal. Lorenzo reviewed
`docs/design/zed-parity-2026-08-05/index.html` (25 decisions in six sections, built
from a source read of zed-industries/zed plus a live measurement of loombox v0.5.0)
and picked one option per decision, except where he named two, and except E2 where he
rejected all four options and gave a fifth answer.

Numbering matches the artifact: each decision opens with an unnumbered **Today** card,
then options are numbered from 1. Quotes are the artifact's own trade sentences, so an
implementer can see what was bought without reopening the HTML.

Everything settled in v6, v7 and v8 still holds. Where a pick here touches one of
those, it is called out; nothing here reverses them.

---

## 0. The one thing that is not an option id

**E2: the pacer goes away entirely.** Lorenzo: *"e2 togliamo completamente il
pacing"*. None of E2-1..E2-4 was picked; all four kept the pacer in some form. The
decision is to delete it: `text-pacer.ts` and every call site, so streamed text renders
on arrival.

That is only safe because of the two picks around it. E1-3 removes the cost of a long
transcript by mounting only what is visible, and E3-4 takes decryption off the main
thread. **Order matters: E1-3 and E3-4 land before the pacer is removed**, otherwise a
fast agent's burst hits an unwindowed list on the same thread that is decrypting it,
which is the exact thrash the pacer was built for. Removing it first would be measuring
the wrong thing and would look like a regression.

Also settled outside the artifact, from the same message: **the New session dialog
loses its Starting prompt field.** Lorenzo: *"non serve avere lo starting prompt quando
si crea una nuova sessione, mi va bene avere una sessione sempre vuota e scrivere il
primo prompt dopo averla creata"*. The field, its plumbing and its tests go. This also
removes the trigger for half of #730 (the prompt that is silently dropped in the window
between announce and bridge); the other half of #730, a session with no agent rendering
as "Awaiting you", stands on its own and is still P0.

---

## 1. The look (A)

### A1-2 — Blue-grey layered ground, content darkest, real chroma

> Four new values in loombox's own register (not Zed's exact hex), roughly 7 L* apart,
> content darkest, chrome lightest, with an actual hue instead of grey. This is the
> change that would visibly move the "does this look like a dev tool" needle. Cost:
> every screenshot in every doc goes stale at once, the four status colors need their
> contrast re-checked against a lighter, more saturated ground, and the existing
> alpha-white hairlines will read differently sitting on a mid-tone instead of
> near-black, which pulls A3 into scope whether or not A3 is picked separately.

The dark theme's ground inverts: chrome lightest, content well darkest, with hue. Four
values in `deck.css`, plus the light theme's own re-check.

**A1-2 and A3-1 were both picked, and they pull against each other.** A3-1 keeps the
alpha hairlines and the shadow ladder; A1-2's own text says those hairlines read
differently on a mid-tone ground. The resolution is not to reopen A3: keep the hairline
and shadow *model*, and re-tune the alpha values so the ladder reads as intended on the
new ground. Same mechanism, different numbers. If after re-tuning the ladder still does
not read, that is a new A3 question for a later review, not a licence to switch to
opaque borders now.

Acceptance includes the two named costs: status colours re-checked for contrast against
the new ground in both themes, and the docs' screenshots regenerated rather than left
stale.

### A2-1 — One tightened default, no setting

> Nav row 40→30px, topbar 48→36px, buttons ~39/26→26/20px, body 15.2→14.4px, code
> 13.6→12.8px. One diff, nothing to explain in Settings. What breaks: `.destination-row`
> has no coarse-pointer floor today, unlike Button/IconButton/Input, so shrinking it by
> 10px shrinks a real tap target on the tablet session sheet with nothing to catch it.

Those numbers are the decision, not a suggestion. The named break is part of the work:
`.destination-row` gets the same `@media (pointer: coarse)` floor the controls already
have (`Button.svelte:328-337`), or the tightening stops at the row and says so.

No density setting. If one is ever wanted, that is A2-2 and A2-2 was not picked.

### A3-1 — Keep the hairlines and the shadow ladder

> Zero migration risk, and it doesn't reopen v7's A1-3: the composer and PermissionCard
> keep exactly the lift they were given on purpose.

No work of its own. Recorded so nobody "improves" the elevation model while doing A1-2.
See the A1-2 note above for the one thing this does imply: re-tuned alphas, same model.

### A4-1 — Extend mono to every structural identifier

> Precisely: project paths, branch names, target and node names, session ids, tool
> names, file names in tool rows, and all numeric figures (counts, durations, token and
> cost numbers) go mono, everywhere, including inside prose.

The option's own caveat is inherited with it: "all numbers" reaches further than Zed's
habit, and a relative timestamp has nothing to align against. The pick is the full list
anyway. Implement it as a typography rule, not per-call-site guesswork, so the set is
enumerable and testable.

---

## 2. Chrome and layout (B)

### B1-1 — Add a real status bar, and name what goes left and right

> Left: relay connection, target health, build identity's Behind badge. Right: this
> session's own state, the context/cost meter (moved out of ConfigBar), a queued-session
> count. The bar earns its permanent 24-ish px band by retiring the conditional topbar
> chip and the avatar's boolean dot outright. The cost is that a status bar is chrome
> for the whole window in Zed, not just the session view: it has to render (mostly
> quiet) on the inbox, settings and tracker pages too.

Three things this decision includes and that are easy to skip: the context/cost meter
**moves out of** `ConfigBar`, the conditional topbar connection chip and the avatar's
health dot are **removed**, and the bar renders on every page, not only the session
view.

### B2-2 — A tab strip for opened files and diffs, transcript pinned leftmost and non-closable

> The session transcript keeps its permanent front-row seat; a file you open gets a real
> tab next to it, closable, with a dirty indicator when the agent's own edit touched it
> since you last looked. Below the 768px tablet breakpoint a horizontal strip has
> nowhere to go: it would have to become a single active tab plus a picker, which is a
> different, unbuilt design wearing this one's name.

The narrow behaviour is not optional and it is not this option: below
`TABLET_VIEWPORT_BREAKPOINT_PX` (`viewport.ts:17`) the strip must have a defined,
tested behaviour, decided and written down as part of the work rather than discovered
at implementation time.

This is the largest single piece of the whole wave and it implies a file viewer, which
loombox does not have today (#205 is the editor, still Todo). Scope it as: tabs plus a
read-only viewer with syntax highlighting, editing stays out.

### B3-3 — Branch stays left, target chip moves to the status bar

> Lighter than B3-2 in the topbar, project / branch only, because the target moved down
> into B1's left zone instead. This option only exists if B1 lands a real status bar.

Consistent with B1-1, so it stands. Depends on B1-1 shipping first. The git branch is
not on the wire today for the topbar's purposes; that plumbing is part of this issue,
not an assumption.

### B4-2 — A real zero state: recent sessions, the last transcript's tail, the bindings that matter

> Recent sessions for this project reuse the sidebar's own derivation, no new data
> source. The bindings are real, not invented. The cost: a brand new project with no
> prior sessions has nothing "recent" to show, and it has to stay honest when a session
> truly has zero turns yet.

The bindings shown must be read from F1's registry once that exists, not hardcoded a
second time. If B4 lands first, it hardcodes them and F1 replaces that read.

---

## 3. The thread (C)

### C1-3 — Turn summary plus a stacked Review Changes surface

> Same read-only bar, plus a second surface that stacks every file the turn changed with
> its diff in place, so reading the whole turn stops meaning scroll-and-remember across
> separate cards. Still nothing to click that touches a file: this is a second reading
> of the same diffs, not a new capability over them.

Read-only is the decision, and C1-4 (keep/reject per file and per hunk) was **not**
picked. No button in this work may revert, restore or discard anything on disk. When
#603 lands, keep/reject becomes a separate proposal, not a follow-up that sneaks in.

### C2-3 and C2-4 — Pills over files, directories, past sessions and tracker items, plus agent-declared slash commands

Lorenzo picked both, and C2-4 stacks on C2-3, so the target state is the union: the
`@` picker covers files, directories, past sessions (searched by title) and tracker
items (searched by id or title), all as removable pills; `/` lists exactly what the
connected agent declared.

> Depends on wiring `available_commands_update` into the reducer first, since today
> `mapToTranscriptUpdate` drops it on the floor (`client.ts:409-461`).

That plumbing is its own issue and lands first. It is also what D5-2 needs, so it is
shared, not duplicated.

### C3-3 — Plus token or cost, where the agent reports it

> Since `usage_update` carries no `toolCallId` at all (`SPEC.md:1656`), any per-call
> number is a client-side attribution heuristic on top of a session-level total, not a
> real per-tool value the agent sent, and a call with nothing to attribute shows nothing
> rather than a fabricated zero.

Inherits the icon and duration from C3-2. Duration has no wire field either: it is
measured client-side between the `tool_call` and its terminal `tool_call_update`, and a
call whose start was never seen (a resumed session) shows no duration rather than a
wrong one.

### C4-2 — Three states, automatic as the default

> Always collapsed, always expanded, and automatic, which is expanded while a thought is
> producing text and collapses to one line the moment real content starts.

This extends v8's B2-1 rather than reversing it: still one preference, still global,
now with three values instead of two. #661 (the thinking block forgets whether you
opened it) is fixed by this work, not separately.

### C5-1 — Nothing

> The Files panel stays a browsing tool, deliberately not a live view of the agent.

No follow mode. No work. Recorded so it is not added incidentally while doing B2-2,
which will make it tempting.

### C6-2 and C6-3 — Fork now, real rewind once #603 exists

Both picked, and they are two different capabilities, so both ship.

> **C6-2**: Copies the transcript up to that turn into a brand-new session and lets it
> diverge from there; the original session and its worktree are untouched. No checkpoint
> engine needed.

> **C6-3**: Depends on #603 landing first. The same session, the transcript and the
> files on disk both roll back together, destructive, and confirmed before it runs.

C6-2 is unblocked and goes first. C6-3 is blocked on #603 and must not be started
before it, since there is nothing to revert against.

---

## 4. Agents, MCP and policy (D)

### D1-3 — Custom agents client-side per project with a node allowlist, plus a curated registry

D1-3 includes D1-2, so the trust model is D1-2's:

> Custom agents defined client-side per project, pushed over the wire, node holds an
> allowlist.

and the registry on top is convenience only:

> loombox ships and updates a catalogue of known-good agents (the way the six MCP
> quick-add presets already work, `mcp-presets.ts:56-119`) so picking "Gemini CLI" is
> one click instead of typing a command line. Convenience only, trust still rests
> entirely on the node's allowlist.

Two issues: the allowlist-backed custom agent path first, the curated catalogue after.
The allowlist is the security boundary and its acceptance must say so explicitly: a
client that asks the node to run a binary outside the allowlist gets a refusal the user
can see, not a silent drop.

### D2-2 — On the execution target: an `ssh:` server runs on that host

> A filesystem server pointed at an `ssh:` worktree runs next to the files it reads,
> over the deploy-and-detach machinery `target.ts:9-11` already documents for the agent
> binary itself. Solves exactly the case Zed's own SSH story can't. Secret material
> still resolves node-side and is injected at launch, never sent to the relay. Costs a
> second thing that can be absent on a remote host: the MCP server binary itself.

This is the single largest capability in the wave and the one place where loombox is
structurally better positioned than Zed. It closes the two-year-old gap where MCP config
exists in two places and launches nothing (#211, #627). The absent-binary case is part
of the acceptance: a server that cannot start on the target reports that to the client,
by name, rather than producing a session with quietly fewer tools.

### D3-4 — Both: profiles plus rules

> Profiles gate existence, the glob policy (surfaced, per D3-2) gates approval mode,
> request-time `allow_always` stays the fast path. Closest to Zed's own mental model,
> which means the most surface to design and explain: three systems that all shape the
> same "can this tool run" question, and a user has to understand which one answered no
> before they can fix it.

The named cost is the acceptance criterion: when a tool call is refused, the UI must say
**which** of the three layers refused it. A refusal with no attribution is not this
decision implemented, it is this decision's failure mode.

Two issues: surface the existing node-side glob policy (it exists, `permission-policy.ts`,
with no UI at all), then profiles that gate the tool set.

### D4-3 — Per project as well, project wins over account

> A project-scoped override beats the account-wide last-used value when both exist. Two
> places to look when a default seems wrong, and whichever surface ships this has to
> show which one is currently winning.

Session templates (D4-4, issue #259) were **not** picked and stay out of scope. Note that
templates were partly defined by a starting prompt, which no longer exists.

### D5-2 — Tools plus prompts as slash commands

> Matches Zed's own scope exactly, and pairs with a composer slash-command system if one
> ships. Needs a real composer integration point that doesn't exist yet.

Resources (D5-3) are out. Depends on D2-2 (there is no MCP client to get prompts from
until servers actually launch) and on C2-4's composer surface.

---

## 5. Speed (E)

### E1-3 — Real windowing

> Mount only the visible range: the fastest of the four, since an unmounted item costs
> nothing at all. Scroll-to-bottom-while-streaming stops being one line: the
> virtualizer's estimated total height shifts every time an off-screen item's real
> height gets measured, so "stay pinned to the bottom while streaming" needs active
> anchoring. It also breaks native browser find and any anchor link into one item. Read
> #203 and #263 before citing this against search: the planned transcript search runs
> against the event model, not the DOM.

Two acceptance criteria come straight out of that paragraph: streaming stays pinned to
the bottom with no jump, and the loss of native browser find is either accepted in
writing or replaced by the in-app search #203/#263 already plan.

### E2 — Remove the pacer entirely

See §0. Lands after E1-3 and E3-4.

### E3-4 — Worker plus batching

> Both changes stacked: `Promise.all` inside the worker's own message handler. Costs the
> worker's audit surface from E3-3 and the burst-timing dependency from E3-2, for the
> one option that actually earns "fastest" of the four.

The worker does not cross a privilege boundary against a same-origin attacker (SPEC §8's
boundary is device versus relay), but it does grow the audit surface: key material now
lives in a second context. The issue must state where the AMK-derived key is imported,
how the worker is loaded (same origin, bundled, no dynamic URL), and that nothing but
ciphertext crosses back.

---

## 6. Keyboard (F)

### F1-3 — Registry plus context

> Each entry also declares when it can run, so the palette hides or dims whatever would
> no-op if picked right now. Costs the most: every action needs its availability
> expressed as a predicate, not just its effect.

One registry, read by the palette and by anything else that offers a command. B4-2's
hint block reads it too.

### F2-3 — The full set, VS Code keys where the two differ

> "VS Code-compatible" changes exactly one thing in this list: next and previous session
> move to Mod+Alt+Right / Mod+Alt+Left. That is a worse pick for loombox specifically:
> on Windows and Linux that same chord is the tab's own back and forward history
> navigation.

Picked with that cost visible. The issue must either use a platform-conditional binding
for those two rows or record that the browser wins on Windows and Linux, and the desktop
shell (where Electron can claim the chord) is the only place they work. It must not
silently ship a binding that does nothing on two platforms out of three.

### F3-3 — A full user keymap, synced

> Two real questions this option has to answer, not gloss over: what happens on a phone,
> where there is no physical keyboard to record a chord against; and what happens when a
> synced binding is free on one device and reserved on another. Cost: parsing and
> validating arbitrary user JSON against a live registry, a hard rule that action ids
> never get renamed once this ships, and a merge story for two tabs editing at once.

The hard rule lands on F1: **action ids are permanent once F3 ships.** Whoever builds
the registry writes that down in the registry's own doc comment, before F3 starts.

---

## 7. What was explicitly not picked

Recorded so nobody builds them by accident: A1-1, A1-3, A2-2, A2-3, A3-2, A3-3, A4-2,
B1-2, B1-3, B2-1, B2-3, B3-1, B3-2, B4-1, B4-3, C1-1, C1-2, C1-4, C2-1, C2-2, C3-1,
C3-2 on its own, C4-1, C4-3, C5-2, C5-3, C6-1, D1-1, D1-2 on its own, D2-1, D2-3, D2-4,
D3-1, D3-2 on its own, D3-3, D4-1, D4-2 on its own, D4-4, D5-1, D5-3, E1-1, E1-2, E1-4,
E2-1, E2-2, E2-3, E2-4, E3-1, E3-2, E3-3, F1-1, F1-2, F2-1, F2-2, F3-1, F3-2.

Where an option was a strict subset of the pick (C3-2 inside C3-3, D1-2 inside D1-3,
D3-2 inside D3-4, D4-2 inside D4-3), it is built as part of the pick, not skipped.
