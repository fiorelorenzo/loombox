<script lang="ts">
  /**
   * The "New session" flow (SPEC §7.1; issue #385): creates a session via
   * `RelayClient.createSession` and hands the new session id back so the
   * caller can open it.
   *
   * `client` is typed to the narrow `NewSessionClient` interface (not the
   * full `RelayClient`) so a hermetic component test can inject a fake
   * without spinning up a real relay: mirrors `InteractiveTerminal.svelte`'s
   * own narrowed-client pattern elsewhere in this package. `undefined`
   * (not yet connected) disables the submit button but still mounts,
   * matching `open`'s own gate (`+page.svelte` only ever passes a defined
   * `client` once `status === 'open'` in practice).
   *
   * IA v4 rewrite (design spec §3.4; issue #507): every session now belongs
   * to an already-registered `Project` (`$lib/projects`), so this dialog no
   * longer asks for a target or a folder. That used to be `TargetPicker` +
   * `DirectoryPicker` here, re-picked on every single creation; both moved
   * to `AddProjectDialog`, which fixes them ONCE per folder. This dialog
   * now only ever reads them off `project`, shown as a muted read-only
   * context line rather than form fields, and asks what's genuinely
   * per-session: an agent, SPEC §7.1's per-session worktree choice, and a
   * title. That split is also what unblocks the
   * worktree choice at all: it had no `session_create` field to travel in
   * before this change (closed in the same change, `packages/protocol`'s
   * `sessionPrivateMetaV1.worktree`), and it only ever makes sense
   * per-session, never per-project.
   *
   * `project.isGitRepo` decides whether the Workspace control renders at
   * all: only a confirmed `true` shows it. `AddProjectDialog` resolves it
   * once, when the project is registered (`DirectoryPicker`'s own
   * `gitRepo` flag), so it is already a settled fact by the time this
   * dialog can ever open (forms + real providers design spec §1/§3,
   * defect #2) — no probe, no loading state, and no reflow while the user
   * is mid-keystroke, unlike the `browseDirectory` round trip this file
   * used to fire on every open. A project this device has only ever
   * adopted from a session and never actually browsed to simply has no
   * worktree choice to offer, exactly like a confirmed non-repo; per
   * `CreateSessionOptions.worktree`'s own doc comment that just leaves the
   * node's per-target default in charge rather than guessing here.
   *
   * Agent availability is real now too (forms + real providers design spec
   * §2/§3, defect #1): `providers` is `TargetListEntry.providers` for
   * `project`'s own target — the relay's verbatim forward of the node's own
   * PATH probe for each registered `AcpProviderModule.requiredCommand` —
   * never a hardcoded guess. Two or more renders an actual `Select`;
   * exactly one is shown as a fact in the context line instead of a
   * dropdown with nothing to choose (the ticket's most visible defect: a
   * one-option `<select>` as the form's first, most prominent field); zero
   * disables submission with a message naming the target rather than
   * silently offering an agent that would fail at spawn.
   *
   * Field order (issue #563, superseding the earlier design spec §3
   * ordering): what identifies a session on the board is the task, not
   * the first thing the operator happened to say to the agent, so Title
   * now leads and is the field the dialog focuses on open (`Dialog`'s own
   * focus trap always moves focus to the panel's first focusable element -
   * see `Dialog.svelte` - so putting Title first in the DOM is the whole
   * mechanism, no explicit `autofocus` needed). Title itself stays optional
   * (creating a session with nothing typed is a legitimate "open it and talk
   * to the agent from the composer later" flow — issue #761 later made that
   * the ONLY flow, removing the starting-prompt field this paragraph used to
   * also describe), and its "defaults to the project folder" copy stays in
   * `Field`'s persistent `help` slot, since that is still exactly what the
   * node does with an empty title (`packages/node/src/node-daemon.ts:921`).
   *
   * Deck migration (redesign v2 §2 "One button language", issue #464):
   * every hand-rolled `.btn*` gives way to the shared `Button` primitive.
   * Deck v3 restyle (redesign v3 design spec §3.5, issue #502): the Agent
   * field's native `<select>` gives way to the shared `ui/Select` primitive.
   *
   * Coherence v5 migration (design spec §1, issue #508): the Agent,
   * Workspace, and Title fields, and the actions row, now go through the
   * shared `Field`/`Input`/`RadioGroup`/`FormActions` primitives instead of
   * each hand-rolling its own label, input styling, radio-card markup, and
   * action-row layout — see `Field.svelte`'s own doc comment, which cites
   * this file's pre-migration Agent-field-vs-Title-field inconsistency as
   * its motivating example. (The starting-prompt field this migration also
   * touched, via `ui/TextArea`, is gone — issue #761.)
   *
   * Curated agent catalogue (D1-3's second half, `docs/superpowers/specs/
   * 2026-08-05-zed-parity-decisions.md` §4; issue #749): the custom-agent
   * section below also offers a "Quick-add" row over
   * `@loombox/providers-core`'s `AGENT_CATALOGUE` — verified, known-good
   * ACP agents (Gemini CLI, Qwen Code) a user can add in one click instead
   * of typing a command line. Convenience only: `handleQuickAddAgent` does
   * nothing `handleAddCustomAgent` doesn't already do (both end in the
   * same `addCustomAgent` call), and picking a catalogue entry still has
   * to clear the exact same node-side allowlist as a hand-typed one. Right
   * after a quick-add, this dialog also fires `client.probeCustomAgent`
   * (issue #748's provider-availability probe) against `project`'s own
   * target purely so the picker can say, honestly and immediately,
   * whether *this* node has actually allowlisted the command it just
   * pre-filled — never to gate the add itself, which always succeeds
   * client-side regardless of the probe's outcome.
   */
  import type { CreateSessionOptions } from '$lib/relay-client';
  import {
    createLocalStorageMcpServerConfigStorage,
    effectiveMcpServerConfigs,
    type McpServerConfigStorage,
  } from '$lib/mcp-server-store';
  import type { Project } from '$lib/projects';
  import { PROVIDER_LABELS } from '$lib/providers';
  import {
    addCustomAgent,
    addCustomAgentFromCatalogueEntry,
    createLocalStorageCustomAgentStorage,
    CustomAgentStoreError,
    type CustomAgentStorage,
  } from '$lib/custom-agent-store';
  import {
    customAgentRecordV1,
    type CustomAgentProbeResultV1,
    type CustomAgentRecordV1,
  } from '@loombox/protocol';
  import {
    AGENT_CATALOGUE,
    isAgentCatalogueEntryStale,
    StaleAgentCatalogueEntryError,
    type AgentCatalogueEntry,
  } from '@loombox/providers-core/browser';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Dialog from './ui/Dialog.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import FormActions from './ui/FormActions.svelte';
  import Input from './ui/Input.svelte';
  import RadioGroup, { type RadioOption } from './ui/RadioGroup.svelte';
  import Select, { type SelectOption } from './ui/Select.svelte';
  import TextArea from './ui/TextArea.svelte';

  export interface NewSessionClient {
    createSession: (options: CreateSessionOptions) => Promise<string>;
    /**
     * D1-3's provider-availability probe for a custom agent (issue #748) —
     * optional so a fake client exercising only `createSession` (most of
     * this suite's existing fixtures) still satisfies this interface. When
     * present, the quick-add catalogue flow (issue #749) calls it right
     * after adding a picked entry to surface, immediately and honestly,
     * whether this specific node has actually allowlisted the command it
     * just pre-filled — never to gate the add itself.
     */
    probeCustomAgent?: (options: {
      nodeId: string;
      targetId: string;
      command: string;
    }) => Promise<CustomAgentProbeResultV1>;
  }

  interface Props {
    open: boolean;
    project: Project;
    client: NewSessionClient | undefined;
    /**
     * The provider ids `project`'s own target can actually spawn right now
     * (`TargetListEntry.providers`, forwarded verbatim from the node's own
     * probe of each registered `AcpProviderModule.requiredCommand` against
     * that target's PATH — design spec §2). An empty array is a real,
     * meaningful answer ("reachable, nothing installed"), not "still
     * loading": the caller only ever renders this dialog once its own
     * target list has resolved at least once.
     */
    providers: string[];
    /** `project`'s own target, named for a human where possible — used only to name it in the zero-providers message below. Mirrors `+page.svelte`'s own `sessionTargetLabel` label-with-id-fallback idiom. */
    targetLabel: string;
    onClose: () => void;
    /** The provider id (agent) the session was actually created with — the caller uses this to resolve which agent's remembered config-option defaults/overrides apply (issue #753, D4-2/D4-3); it is not surfaced back any other way once the dialog closes. `'custom'` when a custom agent (issue #748) was picked, exactly like `session_create`'s own `provider` field. */
    onCreated: (sessionId: string, provider: string) => void;
    /**
     * D1-3's per-project custom-agent list (`docs/superpowers/specs/
     * 2026-08-05-zed-parity-decisions.md` §4; issue #748) — defaults to a
     * real `localStorage`-backed store scoped to `project.path`
     * (`custom-agent-store.ts`, mirrors `McpServerConfigPanel`'s identical
     * default-storage pattern); overridable for a hermetic component test.
     */
    customAgentStorage?: CustomAgentStorage;
    /**
     * The Config panel's per-project MCP server list (issue #750, D2-2;
     * #794's own "a server added in the Config panel is launched for the
     * next session" acceptance line) — defaults to the exact same real
     * `localStorage`-backed store `McpServerConfigPanel` itself defaults
     * to (`mcp-server-store.ts`'s `createLocalStorageMcpServerConfigStorage`,
     * scoped to `project.path`), so a server added there is read from the
     * SAME record this dialog forwards, not a second copy; overridable
     * for a hermetic component test, mirroring `customAgentStorage` above.
     */
    mcpStorage?: McpServerConfigStorage;
  }

  const {
    open,
    project,
    client,
    providers,
    targetLabel,
    onClose,
    onCreated,
    customAgentStorage: customAgentStorageProp,
    mcpStorage: mcpStorageProp,
  }: Props = $props();

  const agentStorage = $derived(
    customAgentStorageProp ?? createLocalStorageCustomAgentStorage(project.path),
  );
  const mcpStorage = $derived(
    mcpStorageProp ?? createLocalStorageMcpServerConfigStorage(project.path),
  );

  const providerOptions: SelectOption[] = $derived(
    providers.map((id) => ({ id, label: PROVIDER_LABELS[id]?.name ?? id })),
  );
  /** Prefixes a custom agent's `Select` option id so it can never collide with a real, registered provider id — including one a project happens to name its custom agent after. */
  const CUSTOM_AGENT_PREFIX = 'custom-agent:';
  let customAgents = $state<CustomAgentRecordV1[]>([]);
  const customAgentOptions: SelectOption[] = $derived(
    customAgents.map((agent) => ({
      id: `${CUSTOM_AGENT_PREFIX}${agent.name}`,
      label: `${agent.name} (custom)`,
    })),
  );
  /** Every pickable agent for this project: the target's real registered providers, plus this project's own custom agents — one combined list, one `Select`, exactly like the issue's "next to the existing agent picker" asks for. */
  const agentOptions: SelectOption[] = $derived([...providerOptions, ...customAgentOptions]);
  let selectedProvider = $state('');
  let showCustomAgentForm = $state(false);
  let newAgentName = $state('');
  let newAgentCommand = $state('');
  let newAgentArgs = $state('');
  let newAgentEnv = $state('');
  let customAgentError = $state<string | undefined>(undefined);
  /**
   * The most recent quick-add allowlist probe (issue #749), keyed by
   * `command` so a probe for one entry is never mistakenly shown against a
   * different one picked afterwards. `undefined` before any quick-add has
   * run in this dialog-open, or whenever `client.probeCustomAgent` isn't
   * implemented (see `NewSessionClient.probeCustomAgent`'s own doc
   * comment) — the row simply renders no probe result in that case.
   */
  interface CatalogueProbeState {
    command: string;
    status: 'checking' | 'result' | 'error';
    result?: CustomAgentProbeResultV1;
    errorMessage?: string;
  }
  let catalogueProbe = $state<CatalogueProbeState | undefined>(undefined);
  type WorkspaceChoice = 'worktree' | 'in-place';
  let workspaceChoice = $state<WorkspaceChoice>('worktree');

  /** SPEC §7.1's two per-session choices — see `RadioGroup.svelte`'s own doc comment for why these render as description-bearing cards, not bare native radios. */
  const WORKSPACE_OPTIONS: RadioOption[] = [
    {
      value: 'worktree',
      label: 'Isolated worktree',
      description:
        'A fresh branch under .loombox/worktrees/, so several agents can work on this project at once.',
    },
    {
      value: 'in-place',
      label: 'In place',
      description: 'Directly in the project folder. Only one session at a time can do this.',
    },
  ];

  let title = $state('');
  let creating = $state(false);
  let createError = $state<string | undefined>(undefined);

  /**
   * Tracks the previous `open` so the reset below fires on the closed -> open
   * TRANSITION only. A plain `let`, deliberately not `$state`: it is bookkeeping
   * for the effect, and making it reactive would feed the effect its own writes.
   */
  let wasOpen = false;

  // Resets the per-session fields when the dialog actually opens - the
  // transition, not merely "this effect ran while `open` was true". That
  // distinction is the whole fix, and it was measured rather than reasoned:
  //
  // `resetForm()` reads `providers` (for the default `selectedProvider`), and a
  // Svelte 5 `$effect` tracks reads made inside the functions it calls, so this
  // effect used to depend on `providers` too. That prop's identity churns
  // constantly in production - `+page.svelte` derives it from issue #269's
  // polled target list - so the reset re-ran on ordinary re-renders. Driving the
  // built app against the deployed relay, text typed into the open dialog
  // was wiped within one second, repeatedly, which made the field unusable.
  //
  // Gating on the transition fixes that at the root, and covers the sibling case
  // an `untrack` around `resetForm` would miss: `open` being re-assigned the
  // same `true` (any parent handing down a fresh props object, and
  // `@testing-library/svelte`'s `rerender`) re-runs the effect just the same.
  // One guard, both causes; an operator's half-typed sentence now survives
  // everything except genuinely reopening the dialog.
  $effect(() => {
    const isOpen = open;
    if (isOpen && !wasOpen) resetForm();
    wasOpen = isOpen;
  });

  const canSubmit = $derived(!creating && client !== undefined && agentOptions.length > 0);

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!client || !canSubmit) return;
    creating = true;
    createError = undefined;
    try {
      const customAgent = customAgentFor(selectedProvider);
      // Same omit-rather-than-send-empty discipline `worktree`/`customAgent`
      // below already follow — `RelayClient.createSession` treats omitted
      // and `[]` identically anyway, this just keeps the common "nothing
      // configured" call shape unchanged from before this field existed.
      const mcpServerConfigs = effectiveMcpServerConfigs(mcpStorage);
      const sessionId = await client.createSession({
        targetId: project.targetId,
        // A custom agent always travels as the `'custom'` wire sentinel
        // (`sessionPrivateMetaV1.customAgent`'s doc comment) — the node
        // gates on the presence of `customAgent` itself, never on this
        // string, but it's what lets a human reading `session_list` tell
        // the two kinds of session apart.
        provider: customAgent ? 'custom' : selectedProvider,
        projectPath: project.path,
        // Only a CONFIRMED git repo ever gets a `worktree` value at all:
        // when the folder isn't a repo, there is no genuine per-session
        // choice to send (see the file doc comment).
        ...(project.isGitRepo === true ? { worktree: workspaceChoice === 'worktree' } : {}),
        title: title.trim() || undefined,
        ...(customAgent ? { customAgent } : {}),
        // The Config panel's own currently-enabled server list for this
        // project (issue #750, D2-2; #794) — forwarded on every creation,
        // not just when the panel itself is open, since that panel writes
        // straight to `mcpStorage` and this dialog never re-reads it after
        // mount otherwise.
        ...(mcpServerConfigs.length > 0 ? { mcpServerConfigs } : {}),
      });
      onCreated(sessionId, customAgent ? 'custom' : selectedProvider);
      onClose();
    } catch (error) {
      // Same wire-identifier leak issue #505 fixed in `DirectoryPicker` and
      // `ArchiveSessionDialog`: every error `RelayClient.createSession` can
      // reject with today is already written for a human (or, before this
      // ever reaches a user, a loud "not connected" thrown synchronously),
      // so this shows it verbatim; the real error still reaches a developer
      // via `console.warn`. (Issue #761 removed the only case that needed
      // rephrasing here: `createSession` used to wait for the node's own
      // announce purely to time the starting prompt it also sent, and could
      // time out doing so — that wait is gone along with the prompt.)
      console.warn('NewSessionDialog: createSession failed', error);
      createError = error instanceof Error ? error.message : String(error);
    } finally {
      creating = false;
    }
  }

  /** Resolves a `Select` value back to its `CustomAgentRecordV1`, or `undefined` for an ordinary registered-provider id — the one place that decides which kind of session `handleSubmit` builds. */
  function customAgentFor(id: string): CustomAgentRecordV1 | undefined {
    if (!id.startsWith(CUSTOM_AGENT_PREFIX)) return undefined;
    const name = id.slice(CUSTOM_AGENT_PREFIX.length);
    return customAgents.find((agent) => agent.name === name);
  }

  /** `KEY=VALUE`, one per line — blank lines and lines with no `=` are skipped rather than rejected, so a stray trailing newline never blocks the whole form. `undefined` (not `{}`) when nothing parsed, matching `customAgentRecordV1.env`'s own "no overrides" contract. */
  function parseEnvLines(text: string): Record<string, string> | undefined {
    const entries: Array<[string, string]> = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      entries.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /**
   * The "+ Define a custom agent" form's own submit (issue #748) — validates
   * through the exact same `customAgentRecordV1` schema the wire itself
   * parses against, then `addCustomAgent` (which adds the one extra rule
   * beyond that schema: no two agents sharing this project sharing a
   * name). Never touches the node's allowlist — that's a separate,
   * later decision (`RelayClient.probeCustomAgent`), not this form's job.
   */
  function handleAddCustomAgent(): void {
    const parsed = customAgentRecordV1.safeParse({
      name: newAgentName.trim(),
      command: newAgentCommand.trim(),
      args: newAgentArgs.split(/\s+/).filter((arg) => arg.length > 0),
      env: parseEnvLines(newAgentEnv),
    });
    if (!parsed.success) {
      customAgentError = 'Name and command are required.';
      return;
    }
    try {
      customAgents = addCustomAgent(agentStorage, parsed.data);
      selectedProvider = `${CUSTOM_AGENT_PREFIX}${parsed.data.name}`;
      newAgentName = '';
      newAgentCommand = '';
      newAgentArgs = '';
      newAgentEnv = '';
      customAgentError = undefined;
      showCustomAgentForm = false;
    } catch (err) {
      customAgentError = err instanceof CustomAgentStoreError ? err.message : String(err);
    }
  }

  /**
   * The curated-catalogue quick-add row's own click handler (issue #749) —
   * calls `addCustomAgentFromCatalogueEntry` (the same `addCustomAgent`
   * call `handleAddCustomAgent` above makes, just fed a catalogue entry
   * instead of the manual form's fields), selects the freshly added
   * agent, then fires an allowlist probe against `project`'s own target
   * so the row can say, right away, whether this node has actually
   * allowlisted the command it just pre-filled. A `StaleAgentCatalogueEntryError`
   * (the entry's own verified-against window has lapsed) and a
   * `CustomAgentStoreError` (duplicate name) both surface through the
   * same `customAgentError` notice `handleAddCustomAgent` already uses.
   */
  function handleQuickAddAgent(entry: AgentCatalogueEntry): void {
    try {
      customAgents = addCustomAgentFromCatalogueEntry(agentStorage, entry);
    } catch (err) {
      customAgentError =
        err instanceof StaleAgentCatalogueEntryError || err instanceof CustomAgentStoreError
          ? err.message
          : String(err);
      return;
    }
    customAgentError = undefined;
    selectedProvider = `${CUSTOM_AGENT_PREFIX}${entry.config.name}`;
    void runCatalogueProbe(entry.config.command);
  }

  /**
   * Fires `client.probeCustomAgent` for `command` against `project`'s own
   * `(nodeId, targetId)` and records the outcome in `catalogueProbe` — the
   * "still refuses cleanly when the node has not allowlisted it" half of
   * issue #749's acceptance. A no-op when the injected `client` doesn't
   * implement the probe at all (`NewSessionClient.probeCustomAgent`'s own
   * doc comment); a rejection (no open connection, timeout) is shown the
   * same way a failed probe result would be, never thrown into the void.
   */
  async function runCatalogueProbe(command: string): Promise<void> {
    if (!client?.probeCustomAgent) {
      catalogueProbe = undefined;
      return;
    }
    catalogueProbe = { command, status: 'checking' };
    try {
      const result = await client.probeCustomAgent({
        nodeId: project.nodeId,
        targetId: project.targetId,
        command,
      });
      catalogueProbe = { command, status: 'result', result };
    } catch (err) {
      catalogueProbe = {
        command,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function resetForm(): void {
    customAgents = agentStorage.get();
    selectedProvider = agentOptions[0]?.id ?? '';
    workspaceChoice = 'worktree';
    title = '';
    creating = false;
    createError = undefined;
    showCustomAgentForm = false;
    newAgentName = '';
    newAgentCommand = '';
    newAgentArgs = '';
    newAgentEnv = '';
    customAgentError = undefined;
    catalogueProbe = undefined;
  }

  function handleClose(): void {
    onClose();
  }
</script>

{#snippet dialogBody()}
  <p class="project-context" data-testid="new-session-project-context">
    <span class="project-context-name">{project.name}</span>
    <span class="project-context-path font-mono">{project.path}</span>
    {#if agentOptions.length === 1}
      <span class="project-context-agent" data-testid="new-session-agent-fact">
        {agentOptions[0]?.label}
      </span>
    {/if}
  </p>

  <form class="session-form" onsubmit={handleSubmit}>
    <Field label="Title" help="Defaults to the project folder">
      {#snippet children({ id, describedBy, errorId, invalid, required })}
        <Input
          {id}
          {describedBy}
          {errorId}
          {invalid}
          {required}
          bind:value={title}
          placeholder="What is this task?"
          dataTestId="new-session-title"
        />
      {/snippet}
    </Field>

    {#if agentOptions.length >= 2}
      <Field label="Agent" grouped>
        <Select
          value={selectedProvider}
          options={agentOptions}
          onChange={(id) => (selectedProvider = id)}
          label="Agent"
          dataTestId="new-session-provider"
        />
      </Field>
    {:else if agentOptions.length === 0}
      <ErrorNotice
        message={`No agent CLI was found on ${targetLabel}. Install claude, codex, or omp there and try again.`}
      />
    {/if}

    <div class="custom-agent-section">
      <div class="agent-catalogue" data-testid="agent-catalogue">
        <p class="agent-catalogue-heading">Quick-add from the curated catalogue</p>
        <ul class="agent-catalogue-list">
          {#each AGENT_CATALOGUE as entry (entry.id)}
            {@const stale = isAgentCatalogueEntryStale(entry)}
            <li class="agent-catalogue-row">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onclick={() => handleQuickAddAgent(entry)}
                dataTestId={`agent-catalogue-add-${entry.id}`}
              >
                {entry.config.name}
              </Button>
              <span class="agent-catalogue-description">{entry.description}</span>
              <Badge
                tone={stale ? 'danger' : 'neutral'}
                dataTestId={`agent-catalogue-verified-${entry.id}`}
              >
                {stale
                  ? 'Stale — re-verify before use'
                  : `Verified: ${entry.verification.against} (${entry.verification.verifiedOn})`}
              </Badge>
            </li>
          {/each}
        </ul>
        <p class="agent-catalogue-note">
          Convenience only: picking one still has to clear this node's own allowlist before it can
          launch.
        </p>
      </div>

      {#if customAgentError}
        <ErrorNotice message={customAgentError} />
      {/if}

      {#if catalogueProbe}
        <div data-testid="agent-catalogue-probe-result">
          {#if catalogueProbe.status === 'checking'}
            <p class="probe-checking">
              Checking &quot;{catalogueProbe.command}&quot; against this node…
            </p>
          {:else if catalogueProbe.status === 'error'}
            <ErrorNotice
              message={`Could not check this node's allowlist: ${catalogueProbe.errorMessage}`}
            />
          {:else if catalogueProbe.result?.outcome === 'error'}
            <ErrorNotice message={catalogueProbe.result.message} />
          {:else if catalogueProbe.result?.outcome === 'ok' && !catalogueProbe.result.allowed}
            <ErrorNotice
              message={`"${catalogueProbe.command}" is not on this node's allowlist yet — an operator must add it (LOOMBOX_CUSTOM_AGENT_ALLOWLIST or the config file's "customAgentAllowlist") before this session can launch.`}
            />
          {:else if catalogueProbe.result?.outcome === 'ok' && !catalogueProbe.result.available}
            <ErrorNotice
              message={`"${catalogueProbe.command}" is allowlisted, but wasn't found on this target's PATH.`}
            />
          {:else if catalogueProbe.result?.outcome === 'ok'}
            <Badge tone="success" dataTestId="agent-catalogue-probe-ok">
              Ready: allowlisted and found on this target.
            </Badge>
          {/if}
        </div>
      {/if}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={() => (showCustomAgentForm = !showCustomAgentForm)}
        dataTestId="new-session-custom-agent-toggle"
      >
        {showCustomAgentForm ? 'Cancel custom agent' : '+ Define a custom agent'}
      </Button>
      {#if showCustomAgentForm}
        <div class="custom-agent-form">
          <Field label="Name">
            {#snippet children({ id, describedBy, errorId, invalid, required })}
              <Input
                {id}
                {describedBy}
                {errorId}
                {invalid}
                {required}
                bind:value={newAgentName}
                placeholder="e.g. My internal agent"
                dataTestId="new-session-custom-agent-name"
              />
            {/snippet}
          </Field>
          <Field
            label="Command"
            help="Checked against the node's own allowlist before it ever runs"
          >
            {#snippet children({ id, describedBy, errorId, invalid, required })}
              <Input
                {id}
                {describedBy}
                {errorId}
                {invalid}
                {required}
                monospace
                bind:value={newAgentCommand}
                placeholder="e.g. omp"
                dataTestId="new-session-custom-agent-command"
              />
            {/snippet}
          </Field>
          <Field label="Arguments (space separated)" help="e.g. acp">
            {#snippet children({ id, describedBy, errorId, invalid, required })}
              <Input
                {id}
                {describedBy}
                {errorId}
                {invalid}
                {required}
                monospace
                bind:value={newAgentArgs}
                placeholder="acp"
                dataTestId="new-session-custom-agent-args"
              />
            {/snippet}
          </Field>
          <Field label="Environment variables (optional)" help="One KEY=VALUE per line">
            {#snippet children({ id, describedBy, errorId, invalid })}
              <TextArea
                {id}
                {describedBy}
                {errorId}
                {invalid}
                monospace
                rows={3}
                bind:value={newAgentEnv}
                placeholder="FOO=bar"
                dataTestId="new-session-custom-agent-env"
              />
            {/snippet}
          </Field>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onclick={handleAddCustomAgent}
            dataTestId="new-session-custom-agent-submit"
          >
            Add custom agent
          </Button>
        </div>
      {/if}
    </div>

    {#if project.isGitRepo === true}
      <Field label="Workspace" grouped>
        {#snippet children({ labelId })}
          <RadioGroup
            value={workspaceChoice}
            options={WORKSPACE_OPTIONS}
            onChange={(v) => (workspaceChoice = v as WorkspaceChoice)}
            labelledBy={labelId}
            dataTestId="new-session-workspace"
          />
        {/snippet}
      </Field>
    {/if}

    {#if createError}
      <ErrorNotice message={createError} />
    {/if}

    <FormActions>
      <Button variant="secondary" onclick={handleClose}>Cancel</Button>
      <Button
        type="submit"
        variant="primary"
        disabled={!canSubmit}
        loading={creating}
        dataTestId="new-session-submit"
      >
        Create session
      </Button>
    </FormActions>
  </form>
{/snippet}

<Dialog {open} label="New session" onClose={handleClose} size="md" children={dialogBody}>
  {#snippet header()}
    <h2>New session</h2>
  {/snippet}
</Dialog>

<style>
  /* Context, not a field (forms + real providers design spec §3/§5,
     defect #9): no control fill, no input radius — just a quiet hairline
     under the summary so it still reads as one block, distinct from the
     real controls below it. */
  .project-context {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2xs) var(--space-sm);
    margin: 0;
    padding-bottom: var(--space-sm);
    border-bottom: 1px solid var(--color-border-subtle);
    font-size: var(--text-small-size);
  }

  .project-context-name {
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .project-context-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .project-context-agent {
    color: var(--color-text-secondary);
  }

  .session-form {
    display: flex;
    flex-direction: column;
    /* Comfortably above `Field`'s own internal label-to-control gap, so each
       label reads as belonging to the box beneath it rather than floating
       between two of them. See `ui/Field.svelte`'s note on that contract. */
    gap: var(--space-md);
  }

  .custom-agent-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .agent-catalogue {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-sm);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
  }

  .agent-catalogue-heading {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .agent-catalogue-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .agent-catalogue-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .agent-catalogue-description {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .agent-catalogue-note {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .probe-checking {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .custom-agent-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-sm);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
  }
</style>
