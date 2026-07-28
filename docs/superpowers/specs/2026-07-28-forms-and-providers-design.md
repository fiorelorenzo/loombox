# loombox forms + real providers — design spec

Status: agreed with Lorenzo (2026-07-28). Follows `2026-07-28-coherence-v5-design.md`,
which built the six form primitives. That wave gave the app one form *language*; this
one fixes what the biggest form actually *asks*, and makes the agent picker honest.

Trigger: "il form nella dialog per la nuova sessione ancora non mi convince molto,
controlla quello e gli altri."

## 0. What is actually wrong (verified, not guessed)

Each of these was confirmed by looking at the built app in a real browser, or by
following the code path to its source. Ordered by severity.

1. **The dialog's first and most prominent field is a dropdown with one option.**
   `NewSessionDialog`'s `PROVIDER_OPTIONS` is a hardcoded one-element literal. The
   root cause is deeper than the web: `AgentSupervisor` defaults to `[claudeProvider]`
   and `packages/supervisor/package.json` does not even depend on
   `@loombox/providers-codex`, so a fully conformance-tested codex adapter is dead
   code in production.
2. **The form changes shape up to 10 seconds after opening.** The Workspace field
   renders one of three things — a "Checking the project folder…" status line, a
   ~130px two-card `RadioGroup`, or nothing — depending on a `browseDirectory` probe
   with a 10s timeout. The cards appear in the MIDDLE of the form, pushing Title and
   Starting prompt down while the user is typing in them.
3. **The one field that matters is last and smallest.** Of four fields, three have
   good defaults. The starting prompt is the only thing the user must supply, and it
   carries the same caption weight as "TITLE (OPTIONAL)".
4. **`help` is used by zero of the 19 `Field` call sites**, while nine placeholders
   carry help text across five files. Placeholder-as-help vanishes on the first
   keystroke. The smuggled copy is not even self-consistent: `Defaults to the host`
   vs `defaults to root`.
5. **`AddTargetWizard`'s stepper is stacked vertically.** `.wizard-steps` is
   `display:flex; flex-direction:column` while its `<li>`s are `display:inline-block;
   margin-right:…` — child CSS written for a row, dead under a column parent.
6. **Invalid HTML in the same component**: `<div class="wizard-steps-track">` is a
   direct child of `<ol>`.
7. **Prose is passed where a control belongs.** `AddProjectDialog`'s PROJECT FOLDER
   field renders the sentence "Pick a target to browse its folders." as its control,
   so its three fields have three different shapes: an unlabelled giant picker box, a
   label with prose, and a label with an input.
8. **Settings uses one card per single field**, and the card caption (THEME) is styled
   almost identically to the section heading (APPEARANCE), so hierarchy is carried by
   position alone. "Push notifications" then has no card at all.
9. The project-context chip uses `--color-fill-subtle` with an input's radius, so it
   reads as a disabled text field sitting above the real controls.

## 1. Decisions (Lorenzo, 2026-07-28)

- **Agent field: add real providers.** Not "hide the control while there is one" —
  wire up **codex** and **Oh My Pi** so the choice is genuine.
- **Workspace: no backward compatibility.** There are no users yet, so the
  unknown-`isGitRepo` path is deleted outright rather than accommodated. No probe, no
  reflow, no three-shaped field.
- **Help text: move only the "Defaults to X" ones** into `Field`'s `help` slot.
  Format examples (`e.g. npx …`) stay placeholders, which is their correct use.
- **Settings: one card per section**, not per field.

## 2. Provider availability is per TARGET, not per node

`omp acp` was verified to be a real ACP agent before any of this was designed:

    $ omp acp   <- {"protocolVersion":1,"agentInfo":{"name":"oh-my-pi","version":"17.1.7"},
                    "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true}}}

All three bridges exist: `@agentclientprotocol/claude-agent-acp` 0.63.0,
`@agentclientprotocol/codex-acp` 1.1.7, and `omp acp` built into omp itself.

**But on the devbox `codex` is not installed.** That is precisely why a hardcoded
three-item dropdown would be a new lie in place of the old one: it would offer Codex
and fail at spawn. So the node advertises what each target can really run.

Per-**target**, not per-node, because an `ssh:` target spawns the agent on the REMOTE
host: what matters is the CLI on that machine's PATH, not the node's.

### The contract

`AcpProviderModule` gains one field:

```ts
/** The vendor CLI this provider's bridge drives, which must exist on the execution
 *  target's PATH. An `npx` bridge names the CLI it wraps, never `npx`. */
requiredCommand: string;
```

| provider id | label       | requiredCommand | spawn |
|-------------|-------------|-----------------|-------|
| `claude`    | Claude Code | `claude`        | `npx -y @agentclientprotocol/claude-agent-acp` |
| `codex`     | Codex       | `codex`         | `npx -y @agentclientprotocol/codex-acp` |
| `ohmypi`    | Oh My Pi    | `omp`           | `omp acp` |

`generic` is deliberately NOT advertised: it is the fallback tier for an unknown
provider, not a thing a user picks.

Protocol (already landed on `main`'s working tree by the time the slices start):

```ts
targetDescriptor.providers: z.array(z.string().min(1))   // node -> relay
targetListEntry.providers:  z.array(z.string().min(1))   // relay -> client
```

An empty array is meaningful: a reachable target with no agent CLI. Clients render
"nothing to run here", never a hardcoded fallback.

**The #521 trap applies.** Zod strips keys a schema does not know, so a relay built
before this field silently forwards targets without it and the client cannot tell a
never-sent field from a removed one. The relay slice therefore ships a test that pins
`providers` through parse-and-forward, exactly like `test/relay-carries-target-health`.

## 3. The new-session dialog

What it asks, after:

- **Context line** (not a field): project name, path. Restyled so it stops looking
  like a disabled input — no control fill, no input radius.
- **Starting prompt** — promoted to the primary field, first and largest. This is the
  one thing the user came to type.
- **Agent** — a real `Select` over the target's advertised providers. Exactly one
  available renders as a fact in the context line instead of a one-option control;
  zero disables submission with a reason that names the target.
- **Workspace** — always present, never probed. `isGitRepo` is resolved once when the
  project is added and persisted, so the field's shape is known before the dialog
  opens. Non-repo projects simply omit it, decided at open time, not 10s later.
- **Title** — last, with its default in `help` instead of the placeholder.

## 4. Out of scope

Gemini stays reserved (`packages/providers/gemini` has no spawn recipe). No new
protocol messages beyond the two `providers` fields. No change to the crypto boundary:
provider ids are routing metadata, the same class as a target label, and travel
unencrypted exactly as `kind`/`label` already do.
