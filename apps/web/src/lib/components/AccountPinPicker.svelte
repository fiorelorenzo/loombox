<script lang="ts">
  /**
   * The per-project, per-capability account pin picker (SPEC §7.26/#227,
   * issue #230's acceptance) — drives `RelayClient.getAccountPins`/
   * `setAccountPin`/`unsetAccountPin`/`resolveAccountPin` (issue #643's
   * already-shipped client methods). Two capabilities only, `github` and
   * `jira` — `account-pin.ts`'s own doc comment names these as the map's
   * real keys, not an open-ended list this UI has to invent a picker for.
   *
   * The tri-state is rendered as a real three-way choice, not a checkbox
   * plus a text field: a `RadioGroup` per capability whose options are
   * "Unconfigured" (the key is absent — `unsetAccountPin`), "Opted out"
   * (the key is explicit `null` — `setAccountPin(..., null)`), and one
   * option per connected account for that provider (`setAccountPin(...,
   * accountId)`) — the exact three states `AccountPinMapV1`'s own doc
   * comment describes, each independently selectable and visibly distinct
   * (`account-pin.ts`: "absent key is unconfigured..., null is an explicit
   * opt-out, a string is the pinned account id"). Absent and explicit-null
   * never collapse onto the same control state: `currentRadioValue` below
   * checks `capability in pins` before ever reading the value, so a key
   * that is present-but-null (`'__none__'`) is never confused with a key
   * that was never written at all (`'__unset__'`).
   *
   * "Preview resolution" runs `resolveAccountPin` against an
   * operator-supplied check host — there is no real per-project target
   * (provider/host) to read yet (`account_pin_resolve_request`'s own doc
   * comment: "pending #631's full `TrackerMode` composition"), so this
   * picker is explicit about supplying its own rather than pretending to
   * read one, and defaults it to the first connected account's host for
   * that provider (or `github.com` for GitHub) as a reasonable starting
   * point. The five named resolution failures each render as their own
   * distinct state with a concrete next step, never a raw error string in
   * an alert (this issue's acceptance).
   */
  import type {
    AccountPinMapV1,
    AccountPinResolveOutcome,
    ConnectedAccount,
  } from '@loombox/protocol';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import RadioGroup, { type RadioOption } from './ui/RadioGroup.svelte';
  import Select from './ui/Select.svelte';
  import { loadErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  export interface AccountPinClient {
    getAccountPins: (
      nodeId: string,
      projectPath: string,
      timeoutMs?: number,
    ) => Promise<AccountPinMapV1>;
    setAccountPin: (
      nodeId: string,
      projectPath: string,
      capability: string,
      accountId: string | null,
      timeoutMs?: number,
    ) => Promise<AccountPinMapV1>;
    unsetAccountPin: (
      nodeId: string,
      projectPath: string,
      capability: string,
      timeoutMs?: number,
    ) => Promise<AccountPinMapV1>;
    resolveAccountPin: (
      nodeId: string,
      params: {
        projectPath: string;
        capability: string;
        mode: 'read' | 'write';
        target: { provider: string; host: string };
        accounts: ConnectedAccount[];
      },
      timeoutMs?: number,
    ) => Promise<AccountPinResolveOutcome>;
  }

  interface Props {
    client: AccountPinClient;
    accounts: ConnectedAccount[];
    projectPaths: string[];
    /** The acting node every pin/resolve call routes through — pin storage is node-local (`account-pin-store.ts`'s own doc comment). */
    nodeId: string | undefined;
  }

  const { client, accounts, projectPaths, nodeId }: Props = $props();

  const CAPABILITIES = ['github', 'jira'] as const;
  type Capability = (typeof CAPABILITIES)[number];

  function providerLabel(capability: string): string {
    if (capability === 'github') return 'GitHub';
    if (capability === 'jira') return 'Jira';
    return capability;
  }

  let chosenProjectPath = $state<string | undefined>(undefined);
  const activeProjectPath = $derived(
    chosenProjectPath && projectPaths.includes(chosenProjectPath)
      ? chosenProjectPath
      : projectPaths[0],
  );
  let pins = $state<AccountPinMapV1 | undefined>(undefined);
  let loadingPins = $state(false);
  let loadError = $state<string | undefined>(undefined);

  let previewMode = $state<Record<string, 'read' | 'write'>>({});
  let previewHost = $state<Record<string, string>>({});
  let previewOutcome = $state<Record<string, AccountPinResolveOutcome | undefined>>({});
  let previewLoading = $state<Record<string, boolean>>({});
  let previewError = $state<Record<string, string | undefined>>({});

  function defaultHost(capability: Capability): string {
    const match = accounts.find((account) => account.provider === capability);
    if (match) return match.host;
    return capability === 'github' ? 'github.com' : '';
  }

  async function loadPins(): Promise<void> {
    if (!nodeId || !activeProjectPath) {
      pins = undefined;
      return;
    }
    loadingPins = true;
    loadError = undefined;
    try {
      pins = await client.getAccountPins(nodeId, activeProjectPath);
    } catch (error) {
      loadError = loadErrorMessage('The pin list', error);
      pins = undefined;
    } finally {
      loadingPins = false;
    }
  }

  /** One tagged value, not the three independent flags above — `loading`/`loadError`/`pins` are only ever read here, never separately from the template (issue #650). */
  const pinsState = $derived<AsyncPanelState<AccountPinMapV1>>(
    loadingPins
      ? { status: 'loading' }
      : loadError
        ? { status: 'error', message: loadError, retryable: true }
        : pins
          ? { status: 'loaded', data: pins }
          : { status: 'loading' },
  );

  $effect(() => {
    // Re-fetch whenever the acting node or selected project changes —
    // both are read here so the effect re-runs on either.
    void nodeId;
    void activeProjectPath;
    void loadPins();
  });

  /** Absent key -> `'__unset__'`, explicit `null` -> `'__none__'`, a string -> itself — see the file doc comment on why the presence check runs before the value read. */
  function currentRadioValue(capability: Capability): string {
    if (!pins || !(capability in pins)) return '__unset__';
    const value = pins[capability];
    return value === null ? '__none__' : value;
  }

  function radioOptions(capability: Capability): RadioOption[] {
    const providerAccounts = accounts.filter((account) => account.provider === capability);
    return [
      { value: '__unset__', label: 'Unconfigured', description: 'No pin set for this project.' },
      {
        value: '__none__',
        label: 'Opted out',
        description: 'Never use a connected account for this capability.',
      },
      ...providerAccounts.map((account) => ({
        value: account.id,
        label: account.label,
        description: account.host,
      })),
    ];
  }

  let pinBusy = $state<Record<string, boolean>>({});
  let pinError = $state<Record<string, string | undefined>>({});

  async function updatePin(capability: Capability, value: string): Promise<void> {
    const projectPath = activeProjectPath;
    if (!nodeId || !projectPath) return;
    pinBusy = { ...pinBusy, [capability]: true };
    pinError = { ...pinError, [capability]: undefined };
    try {
      const result =
        value === '__unset__'
          ? await client.unsetAccountPin(nodeId, projectPath, capability)
          : await client.setAccountPin(
              nodeId,
              projectPath,
              capability,
              value === '__none__' ? null : value,
            );
      pins = result;
    } catch (error) {
      pinError = {
        ...pinError,
        [capability]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      pinBusy = { ...pinBusy, [capability]: false };
    }
  }

  async function preview(capability: Capability): Promise<void> {
    const projectPath = activeProjectPath;
    if (!nodeId || !projectPath) return;
    const host = previewHost[capability] ?? defaultHost(capability);
    if (!host) {
      previewError = { ...previewError, [capability]: 'Enter a host to check against first.' };
      return;
    }
    previewLoading = { ...previewLoading, [capability]: true };
    previewError = { ...previewError, [capability]: undefined };
    try {
      const outcome = await client.resolveAccountPin(nodeId, {
        projectPath,
        capability,
        mode: previewMode[capability] ?? 'read',
        target: { provider: capability, host },
        accounts,
      });
      previewOutcome = { ...previewOutcome, [capability]: outcome };
    } catch (error) {
      previewError = {
        ...previewError,
        [capability]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      previewLoading = { ...previewLoading, [capability]: false };
    }
  }

  function accountLabel(accountId: string): string {
    return accounts.find((account) => account.id === accountId)?.label ?? accountId;
  }
</script>

{#if projectPaths.length === 0}
  <p class="pin-picker-empty" data-testid="account-pin-picker-no-projects">
    No projects yet — open a project first to pin an account to it.
  </p>
{:else}
  <div class="pin-picker" data-testid="account-pin-picker">
    <Field label="Project" grouped>
      <Select
        value={activeProjectPath ?? ''}
        options={projectPaths.map((path) => ({ id: path, label: path }))}
        onChange={(id) => (chosenProjectPath = id)}
        label="Project"
        dataTestId="account-pin-project-select"
      />
    </Field>

    {#if !nodeId}
      <p class="pin-picker-empty">Select a node above to manage this project's pins.</p>
    {:else if loadingPins || loadError || pins}
      <AsyncPanel
        state={pinsState}
        loadingLabel="Loading pins"
        loadingTestId="account-pin-picker-loading"
        loadingText="Loading pins…"
        onRetry={loadPins}
      >
        {#snippet content()}
          {#each CAPABILITIES as capability (capability)}
            <Card elevation="raised" padding="md" class="pin-capability-card">
              <h3>{providerLabel(capability)} pin</h3>
              <RadioGroup
                value={currentRadioValue(capability)}
                options={radioOptions(capability)}
                onChange={(value) => updatePin(capability, value)}
                label={`${providerLabel(capability)} pin`}
                disabled={pinBusy[capability]}
                dataTestId={`account-pin-radio-${capability}`}
              />
              {#if pinError[capability]}
                <ErrorNotice message={pinError[capability]!} />
              {/if}

              <div class="pin-preview" data-testid={`account-pin-preview-${capability}`}>
                <div class="pin-preview-controls">
                  <Select
                    value={previewMode[capability] ?? 'read'}
                    options={[
                      { id: 'read', label: 'Read' },
                      { id: 'write', label: 'Write' },
                    ]}
                    onChange={(id) =>
                      (previewMode = { ...previewMode, [capability]: id as 'read' | 'write' })}
                    label="Resolution mode"
                    size="sm"
                    dataTestId={`account-pin-preview-mode-${capability}`}
                  />
                  <Field label="Check host" grouped class="pin-preview-host-field">
                    {#snippet children({ id, describedBy, errorId, invalid, required })}
                      <Input
                        {id}
                        {describedBy}
                        {errorId}
                        {invalid}
                        {required}
                        monospace
                        value={previewHost[capability] ?? defaultHost(capability)}
                        oninput={(event) =>
                          (previewHost = {
                            ...previewHost,
                            [capability]: event.currentTarget.value,
                          })}
                        dataTestId={`account-pin-preview-host-${capability}`}
                      />
                    {/snippet}
                  </Field>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={previewLoading[capability]}
                    onclick={() => preview(capability)}
                    dataTestId={`account-pin-preview-run-${capability}`}
                  >
                    Preview
                  </Button>
                </div>

                {#if previewError[capability]}
                  <ErrorNotice message={previewError[capability]!} />
                {:else if previewOutcome[capability]}
                  {@const outcome = previewOutcome[capability]!}
                  {#if outcome.outcome === 'resolved'}
                    <p
                      class="pin-preview-result"
                      data-testid={`account-pin-preview-resolved-${capability}`}
                    >
                      <Badge tone="success">Resolves</Badge>
                      {outcome.account.label} ({outcome.account.host})
                    </p>
                  {:else if outcome.outcome === 'none'}
                    <p
                      class="pin-preview-result"
                      data-testid={`account-pin-preview-none-${capability}`}
                    >
                      <Badge tone="neutral">Nothing to use</Badge>
                      No account will be used for this capability.
                    </p>
                  {:else if outcome.outcome === 'error'}
                    <div
                      class="pin-preview-error"
                      data-testid={`account-pin-preview-error-${capability}`}
                      data-error-type={outcome.errorType}
                    >
                      {#if outcome.errorType === 'AccountPinRequiredError'}
                        <Badge tone="danger">Pin required</Badge>
                        <p>
                          Write actions never guess an account. Pick one above instead of
                          "Unconfigured".
                        </p>
                      {:else if outcome.errorType === 'AccountPinMalformedError'}
                        <Badge tone="danger">Malformed pin</Badge>
                        <p>
                          The saved pin ("{outcome.pinnedAccountId}") isn't a valid account id.
                        </p>
                        <Button
                          size="sm"
                          variant="secondary"
                          onclick={() => updatePin(capability, '__unset__')}
                        >
                          Clear this pin
                        </Button>
                      {:else if outcome.errorType === 'AccountHostMismatchError'}
                        <Badge tone="danger">Host mismatch</Badge>
                        <p>
                          The pinned account is on {outcome.actualHost}, but this check is for {outcome.expectedHost}.
                          Update the check host above, or pin a matching account.
                        </p>
                      {:else if outcome.errorType === 'AccountPinDanglingError'}
                        <Badge tone="danger">Dangling pin</Badge>
                        <p>
                          The pinned account ("{outcome.pinnedAccountId}") no longer exists — it was
                          probably disconnected.
                        </p>
                        <Button
                          size="sm"
                          variant="secondary"
                          onclick={() => updatePin(capability, '__unset__')}
                        >
                          Clear this pin
                        </Button>
                      {:else if outcome.errorType === 'AmbiguousAccountError'}
                        <Badge tone="danger">Ambiguous</Badge>
                        <p>Multiple connected accounts could apply and none is pinned. Pick one:</p>
                        <div class="pin-ambiguous-candidates">
                          {#each outcome.candidateAccountIds ?? [] as candidateId (candidateId)}
                            <Button
                              size="sm"
                              variant="secondary"
                              onclick={() => updatePin(capability, candidateId)}
                            >
                              Pin {accountLabel(candidateId)}
                            </Button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            </Card>
          {/each}
        {/snippet}
      </AsyncPanel>
    {/if}
  </div>
{/if}

<style>
  .pin-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .pin-picker-empty {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text-secondary);
    margin: 0;
  }

  :global(.pin-capability-card) {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  :global(.pin-capability-card h3) {
    margin: 0;
    font-size: var(--text-caption-size);
    text-transform: uppercase;
    letter-spacing: var(--text-caption-tracking);
    color: var(--color-text-secondary);
  }

  .pin-preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding-top: var(--space-sm);
    border-top: 1px solid var(--color-border-subtle);
  }

  .pin-preview-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-sm);
  }

  :global(.pin-preview-host-field) {
    min-width: 12rem;
  }

  .pin-preview-result {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    font-size: var(--text-small-size);
  }

  .pin-preview-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2xs);
    font-size: var(--text-small-size);
  }

  .pin-preview-error p {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .pin-ambiguous-candidates {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2xs);
  }
</style>
