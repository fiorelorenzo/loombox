<script lang="ts">
  /**
   * The streaming test/lint/build runner surface (SPEC §7.15; issue #244):
   * one action per configured command (test/lint/build — a subset when
   * only some are configured, none rendered when nothing is), each
   * streaming its combined output live as it runs and settling to a
   * pass/fail/could-not-start state with the real exit code, cancellable
   * while in flight. This is the RUN half; `TestRunnerConfigPanel.svelte`
   * (also reachable from the right sidebar's Config tab) is the separate
   * SET/detect half — this panel only reads the already-saved commands
   * (`client.getTestRunnerConfig`), it never edits them.
   *
   * Lives as its own right-sidebar sub-tab, not folded into Config or the
   * terminal's bottom dock (design spec §3.1/§3.2, issues #571/#572): a
   * run is structured pass/fail/cancellable state tied to one project,
   * exactly like Config already is, not raw interactive bytes — the
   * terminal dock is for an actual shell. Reusing the sidebar's existing
   * Files/Config sub-tab shell needs no new dock primitive, matching design
   * spec item 5's "Files/Config/(later) Git" sub-tab pattern exactly.
   *
   * Output rendering reuses `TerminalOutput.svelte` (SPEC §7.24's
   * display-only terminal, issue #142) rather than a second decode path —
   * a run's combined stdout+stderr is exactly the same
   * chunk-boundary-safe/ANSI-stripped rendering problem a tool call's
   * bash output already solves.
   *
   * `client` is narrowed to just the calls this panel needs (mirrors
   * `TestRunnerConfigPanel`'s identical DI pattern), satisfied structurally
   * by the real `RelayClient` with no adapter needed.
   */
  import { onDestroy, untrack } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { SvelteMap } from 'svelte/reactivity';
  import type { TestRunnerCommandsV1, TestRunnerKindV1 } from '@loombox/protocol';
  import type { RunClientState } from '$lib/relay-client';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import StatusDot, { type StatusTone } from './ui/StatusDot.svelte';
  import TerminalOutput from './TerminalOutput.svelte';
  import { loadErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  /** The calls this panel needs off `RelayClient` — see the file doc comment's DI note. */
  export interface RunnerClient {
    getTestRunnerConfig(sessionId: string): Promise<TestRunnerCommandsV1>;
    startRun(sessionId: string, kind: TestRunnerKindV1): string;
    cancelRun(sessionId: string, runId: string): void;
    onRunOutput(
      sessionId: string,
      runId: string,
      listener: (chunk: Uint8Array) => void,
    ): () => void;
    runsFor(sessionId: string): Readable<Map<string, RunClientState>>;
  }

  const KIND_FIELDS: ReadonlyArray<{ key: TestRunnerKindV1; label: string }> = [
    { key: 'test', label: 'Test' },
    { key: 'lint', label: 'Lint' },
    { key: 'build', label: 'Build' },
  ];

  interface Props {
    sessionId?: string;
    client?: RunnerClient;
  }

  const { sessionId, client }: Props = $props();

  let commands = $state<TestRunnerCommandsV1>({});
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);

  /** The most recent runId started per kind — a fresh click for a kind already starting/running is disabled (see markup), so at most one active id per kind exists at a time. */
  let runIds = $state<Partial<Record<TestRunnerKindV1, string>>>({});
  /** Accumulated raw output chunks per runId, fed by `client.onRunOutput`. A fresh array per run (never appended across two separate runs of the same kind) — `run()` below always starts a clean one. */
  let outputs = $state<Record<string, Uint8Array[]>>({});
  let runsMap = $state<Map<string, RunClientState>>(new Map());

  let unsubscribeRuns: (() => void) | undefined;
  const outputUnsubscribes = new SvelteMap<string, () => void>();

  async function load(currentSessionId: string, currentClient: RunnerClient): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      commands = await currentClient.getTestRunnerConfig(currentSessionId);
    } catch (err) {
      loadError = loadErrorMessage('The runner config', err);
    } finally {
      loading = false;
    }
  }

  /**
   * One tagged value, not three independent flags — issue #650's actual
   * fix for this panel (#244): the old `{#if loadError}...{/if}` sat
   * OUTSIDE the `{#if loading}...{:else if empty}...{/if}` chain below,
   * so a failed load (`loadError` set, `loading` now false, `commands`
   * still `{}`) rendered the timeout error AND "no commands configured"
   * stacked on top of each other — the exact bug the issue was filed
   * over. One `status` makes that unrepresentable.
   */
  const commandsState = $derived<AsyncPanelState<TestRunnerCommandsV1>>(
    loading
      ? { status: 'loading' }
      : loadError
        ? { status: 'error', message: loadError, retryable: true }
        : KIND_FIELDS.every((field) => !commands[field.key])
          ? {
              status: 'empty',
              message: 'No test/lint/build commands configured yet — set them up in Config.',
            }
          : { status: 'loaded', data: commands },
  );

  // Reloads/resubscribes whenever the selected session (or, in a test, the
  // injected client) changes — this panel stays mounted across a session
  // switch (matches `TestRunnerConfigPanel`'s identical effect), so this,
  // not a one-shot `onMount`, is what keeps it pointed at the right session.
  $effect(() => {
    const currentSessionId = sessionId;
    const currentClient = client;

    // `untrack`: this effect must only re-run when `sessionId`/`client`
    // themselves change, never when a run's own bookkeeping below
    // mutates — `outputUnsubscribes` is a `SvelteMap` (deeply reactive,
    // required by lint), and `run()` mutates it every time a run starts;
    // without `untrack` THAT mutation would re-trigger this very effect
    // and wipe `runIds`/`runsMap` (and the just-registered output
    // listener) the instant a run begins.
    untrack(() => {
      unsubscribeRuns?.();
      for (const unsubscribe of outputUnsubscribes.values()) unsubscribe();
      outputUnsubscribes.clear();
      runIds = {};
      outputs = {};
      runsMap = new Map();
    });

    if (!currentSessionId || !currentClient) {
      commands = {};
      return;
    }
    void load(currentSessionId, currentClient);
    unsubscribeRuns = currentClient.runsFor(currentSessionId).subscribe((map) => {
      runsMap = map;
    });
  });

  onDestroy(() => {
    unsubscribeRuns?.();
    for (const unsubscribe of outputUnsubscribes.values()) unsubscribe();
  });

  function run(kind: TestRunnerKindV1): void {
    if (!sessionId || !client) return;
    const runId = client.startRun(sessionId, kind);
    runIds = { ...runIds, [kind]: runId };
    outputs = { ...outputs, [runId]: [] };
    const unsubscribe = client.onRunOutput(sessionId, runId, (chunk) => {
      outputs[runId] = [...(outputs[runId] ?? []), chunk];
    });
    outputUnsubscribes.set(runId, unsubscribe);
  }

  function cancel(kind: TestRunnerKindV1): void {
    if (!sessionId || !client) return;
    const runId = runIds[kind];
    if (!runId) return;
    client.cancelRun(sessionId, runId);
  }

  function statusToneFor(state: RunClientState | undefined): StatusTone {
    if (!state) return 'neutral';
    if (state.status === 'starting' || state.status === 'running') return 'info';
    if (state.status === 'error') return 'danger';
    if (state.status === 'exited') {
      if (state.outcome === 'pass') return 'success';
      if (state.outcome === 'fail') return 'danger';
      return 'warning'; // could_not_start
    }
    return 'neutral';
  }

  function statusLabelFor(state: RunClientState | undefined): string {
    if (!state) return 'Not run yet';
    if (state.status === 'starting') return 'Starting…';
    if (state.status === 'running') return 'Running…';
    if (state.status === 'error') return `Could not start: ${state.error ?? 'unknown error'}`;
    if (state.cancelled) return 'Cancelled';
    if (state.outcome === 'pass') return `Passed (exit ${state.exitCode})`;
    if (state.outcome === 'fail') return `Failed (exit ${state.exitCode})`;
    return `Could not start${state.reason ? `: ${state.reason}` : ''}`;
  }
</script>

<div class="test-runner" data-testid="test-runner-panel">
  {#if !sessionId}
    <EmptyState message="Select a session to run this project's test/lint/build commands." />
  {:else}
    <Card elevation="raised" padding="md" class="runner-section">
      <AsyncPanel
        state={commandsState}
        loadingLabel="Loading"
        loadingTestId="test-runner-loading"
        loadingText="Loading configured commands…"
        onRetry={() => void (sessionId && client && load(sessionId, client))}
      >
        {#snippet content(loadedCommands)}
          <div class="runs">
            {#each KIND_FIELDS as field (field.key)}
              {#if loadedCommands[field.key]}
                {@const runId = runIds[field.key]}
                {@const state = runId ? runsMap.get(runId) : undefined}
                {@const active = state?.status === 'starting' || state?.status === 'running'}
                <section class="run" data-testid={`test-runner-run-${field.key}`}>
                  <div class="run-header">
                    <StatusDot
                      tone={statusToneFor(state)}
                      pulse={active}
                      label={statusLabelFor(state)}
                      size="sm"
                    />
                    <span class="run-label">{field.label}</span>
                    <code class="run-command">{loadedCommands[field.key]}</code>
                    {#if active}
                      <Button
                        variant="secondary"
                        size="sm"
                        onclick={() => cancel(field.key)}
                        dataTestId={`test-runner-cancel-${field.key}`}
                      >
                        Cancel
                      </Button>
                    {:else}
                      <Button
                        size="sm"
                        onclick={() => run(field.key)}
                        dataTestId={`test-runner-run-button-${field.key}`}
                      >
                        Run
                      </Button>
                    {/if}
                  </div>
                  {#if runId}
                    <TerminalOutput content={outputs[runId] ?? []} />
                  {/if}
                </section>
              {/if}
            {/each}
          </div>
        {/snippet}
      </AsyncPanel>
    </Card>
  {/if}
</div>

<style>
  .test-runner {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .runs {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .run {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .run-header {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .run-label {
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .run-command {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }
</style>
