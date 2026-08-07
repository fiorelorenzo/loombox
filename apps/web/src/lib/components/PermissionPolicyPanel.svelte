<script lang="ts">
  /**
   * A project's permission policy surface (SPEC §7.17; issue #751, D3-4's
   * "rules" half): view, add and remove the command/network allow/deny
   * glob rules `@loombox/node`'s `PermissionPolicyStore` already persists
   * and `PolicyEnforcedExecutionTarget`/`PolicyEnforcedPty` already
   * enforce — this panel is the first thing under `apps/web/src` that
   * reads or writes it at all. Sits beside `TestRunnerConfigPanel` in
   * `ProjectConfigPanel`'s right-workbench Config tab (per-project
   * config, not global Settings, since the policy is per project) and
   * shares its exact DI/session-gating shape: `client` is narrowed to
   * just the three calls this panel needs, `sessionId` stays optional so
   * this panel degrades to an explanatory empty state instead of crashing
   * on the one render frame before a session exists.
   *
   * **No "default approval mode" field on the wire.** `permission-policy.ts`
   * (`@loombox/node`) already defines the default per dimension from the
   * very same `allow`/`deny` lists this panel edits — empty `allow` means
   * allow-all, a non-empty `allow` means "only these run" — so
   * {@link defaultMode} only reads what's already there rather than a
   * second, independently-settable value that could drift from what the
   * node actually enforces.
   *
   * **Every add/remove sends the FULL policy.** `PermissionPolicyStore.save()`
   * replaces a project's policy in full, never a partial patch (mirrors an
   * operator hand-editing the whole allow/deny form) — so this panel always
   * builds the next complete `PermissionPolicyV1` client-side off its own
   * `policy` state and calls {@link PermissionPolicyClient.setPermissionPolicy}
   * with that. `saving` is one shared in-flight guard across every
   * add/remove control (not per-list), since two concurrent writes would
   * race on the very same whole-object read-modify-write.
   *
   * **Invalid-glob rejection happens here, at entry** (issue #751's own
   * acceptance line): a blank (or all-whitespace) pattern never reaches
   * {@link PermissionPolicyClient.setPermissionPolicy} at all — this
   * panel's own `addRule` trims and rejects it with a message shown right
   * on the field, mirroring `@loombox/protocol`'s `permissionRuleSetV1`
   * schema doing the identical trim+`min(1)` check wire-side (defense in
   * depth, not a duplicate source of truth: the pattern LANGUAGE itself
   * has no other invalid shape — `permission-policy.ts`'s own doc comment
   * — so "blank" is the one real footgun worth catching before it can
   * silently turn an allow list into an unsatisfiable strict allowlist).
   *
   * **Refusal attribution (D3-4).** {@link PermissionPolicyClient.onPermissionPolicyViolation}
   * feeds a live "Recent policy blocks" list, each line naming the exact
   * rule that fired — the seam issue #752's profiles half extends:
   * {@link ATTRIBUTION_LABEL} is a `Record` keyed by
   * `ToolRefusalReasonV1['kind']` (mirrors `TrackerPage.svelte`'s
   * identical `RESOLUTION_ERROR_BADGE` convention), so adding a
   * `kind: 'profile'` member to that union is a compile error here until
   * this map grows a matching entry — never a second, parallel "why"
   * concept invented from scratch.
   */
  import type {
    PermissionPolicyV1,
    PermissionPolicyViolationPayloadV1,
    ToolRefusalReasonV1,
  } from '@loombox/protocol';
  import AsyncPanel from './ui/AsyncPanel.svelte';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';
  import { loadErrorMessage, type AsyncPanelState } from '$lib/async-panel';

  /** The three calls this panel needs off `RelayClient` — see the file doc comment's DI note. */
  export interface PermissionPolicyClient {
    getPermissionPolicy(sessionId: string): Promise<PermissionPolicyV1>;
    setPermissionPolicy(sessionId: string, policy: PermissionPolicyV1): Promise<PermissionPolicyV1>;
    onPermissionPolicyViolation(
      sessionId: string,
      listener: (violation: PermissionPolicyViolationPayloadV1) => void,
    ): () => void;
  }

  type Dimension = 'command' | 'network';
  type RuleKind = 'deny' | 'allow';
  type SectionKey = `${Dimension}-${RuleKind}`;

  function sectionKey(dimension: Dimension, kind: RuleKind): SectionKey {
    return `${dimension}-${kind}`;
  }

  const DIMENSIONS: ReadonlyArray<{ key: Dimension; label: string }> = [
    { key: 'command', label: 'Command policy' },
    { key: 'network', label: 'Network policy' },
  ];

  /** Deny listed before allow — deny always wins (`permission-policy.ts`'s own doc comment), so this is the rule an operator reads first. */
  const KINDS: ReadonlyArray<{ key: RuleKind; label: string; placeholder: string }> = [
    { key: 'deny', label: 'Deny rules', placeholder: 'e.g. rm -rf *' },
    { key: 'allow', label: 'Allow rules', placeholder: 'e.g. pnpm *' },
  ];

  /** See the file doc comment's "Refusal attribution (D3-4)" note — issue #752's `kind: 'profile'` member forced this map to grow, exactly as designed. */
  const ATTRIBUTION_LABEL: Record<ToolRefusalReasonV1['kind'], string> = {
    permission_policy: 'Policy',
    profile: 'Profile',
  };

  /** One human-readable line naming which rule a refusal names — `permission_policy` (dimension + candidate) and `profile` (which named profile, and whether it matched by tool-kind or tool-name) each render their own shape. */
  function violationDetail(reason: ToolRefusalReasonV1): string {
    if (reason.kind === 'profile') {
      const matchedByLabel = reason.matchedBy === 'tool-kind' ? 'tool kind' : 'tool name';
      return `profile "${reason.profileName}" denied ${matchedByLabel} "${reason.rule}"`;
    }
    return `${reason.dimension} deny rule "${reason.rule}" matched "${reason.matched}"`;
  }

  function emptyPolicy(): PermissionPolicyV1 {
    return {
      command: { allow: [], deny: [] },
      network: { allow: [], deny: [] },
    };
  }

  interface Props {
    projectPath: string;
    sessionId?: string;
    client?: PermissionPolicyClient;
  }

  const { sessionId, client }: Props = $props();

  let policy = $state<PermissionPolicyV1>(emptyPolicy());
  let loading = $state(false);
  let loadError = $state<string | undefined>(undefined);
  let saving = $state(false);
  let saveError = $state<string | undefined>(undefined);
  let drafts = $state<Record<SectionKey, string>>({
    'command-deny': '',
    'command-allow': '',
    'network-deny': '',
    'network-allow': '',
  });
  let draftErrors = $state<Record<SectionKey, string | undefined>>({
    'command-deny': undefined,
    'command-allow': undefined,
    'network-deny': undefined,
    'network-allow': undefined,
  });
  /** Newest-first, capped at 10 (SPEC §7.17's "logged and surfaced to the user" — this is the surfaced half). */
  let recentViolations = $state<PermissionPolicyViolationPayloadV1[]>([]);

  /** `'allow-all'` when this dimension's allow list is empty, `'allow-listed-only'` once it isn't — mirrors `evaluateTokens`'s own branch (`permission-policy.ts`) exactly, never a guess. */
  function defaultMode(dimension: Dimension): 'allow-all' | 'allow-listed-only' {
    return policy[dimension].allow.length > 0 ? 'allow-listed-only' : 'allow-all';
  }

  async function load(
    currentSessionId: string,
    currentClient: PermissionPolicyClient,
  ): Promise<void> {
    loading = true;
    loadError = undefined;
    try {
      policy = await currentClient.getPermissionPolicy(currentSessionId);
    } catch (err) {
      loadError = loadErrorMessage('The saved policy', err);
    } finally {
      loading = false;
    }
  }

  /** One tagged value, not two independent flags — issue #650. */
  const policyState = $derived<AsyncPanelState<PermissionPolicyV1>>(
    loading
      ? { status: 'loading' }
      : loadError
        ? { status: 'error', message: loadError, retryable: true }
        : { status: 'loaded', data: policy },
  );

  // Reloads whenever the selected session (or, in a test, the injected
  // client) changes — `ProjectConfigPanel`'s "config" tab stays mounted
  // across a session switch, so this effect, not a one-shot `onMount`,
  // keeps the shown policy in sync with whichever project is actually
  // selected (mirrors `TestRunnerConfigPanel`'s identical effect).
  $effect(() => {
    if (!sessionId || !client) {
      policy = emptyPolicy();
      return;
    }
    void load(sessionId, client);
  });

  // Subscribes to this session's live policy denials for as long as this
  // panel is mounted against it — re-subscribes on every session switch,
  // and the returned cleanup unsubscribes both on switch and on unmount
  // (Svelte 5's `$effect` teardown contract).
  $effect(() => {
    recentViolations = [];
    if (!sessionId || !client) return;
    const unsubscribe = client.onPermissionPolicyViolation(sessionId, (violation) => {
      recentViolations = [violation, ...recentViolations].slice(0, 10);
    });
    return unsubscribe;
  });

  async function save(nextPolicy: PermissionPolicyV1): Promise<boolean> {
    if (!sessionId || !client) return false;
    saving = true;
    saveError = undefined;
    try {
      policy = await client.setPermissionPolicy(sessionId, nextPolicy);
      return true;
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      saving = false;
    }
  }

  /** Validates, then saves a rule added to `dimension`'s `kind` list — see the file doc comment's "Invalid-glob rejection" note for what "validates" means here. */
  async function addRule(dimension: Dimension, kind: RuleKind): Promise<void> {
    const key = sectionKey(dimension, kind);
    const trimmed = drafts[key].trim();
    if (!trimmed) {
      draftErrors = { ...draftErrors, [key]: 'Enter a pattern to add.' };
      return;
    }
    draftErrors = { ...draftErrors, [key]: undefined };

    const nextPolicy: PermissionPolicyV1 = {
      ...policy,
      [dimension]: {
        ...policy[dimension],
        [kind]: [...policy[dimension][kind], trimmed],
      },
    };
    const ok = await save(nextPolicy);
    if (ok) drafts = { ...drafts, [key]: '' };
  }

  async function removeRule(dimension: Dimension, kind: RuleKind, index: number): Promise<void> {
    const nextPolicy: PermissionPolicyV1 = {
      ...policy,
      [dimension]: {
        ...policy[dimension],
        [kind]: policy[dimension][kind].filter((_, i) => i !== index),
      },
    };
    await save(nextPolicy);
  }

  function handleAddSubmit(dimension: Dimension, kind: RuleKind, event: SubmitEvent): void {
    event.preventDefault();
    void addRule(dimension, kind);
  }
</script>

<div class="permission-policy" data-testid="permission-policy-panel">
  {#if !sessionId || !client}
    <EmptyState message="Select a session to configure this project's permission policy." />
  {:else}
    {#if saveError}
      <ErrorNotice message={`Could not save: ${saveError}`} />
    {/if}
    <AsyncPanel
      state={policyState}
      loadingLabel="Loading"
      loadingTestId="permission-policy-loading"
      loadingText="Loading saved policy…"
      onRetry={() => void (sessionId && client && load(sessionId, client))}
    >
      {#snippet content(loadedPolicy)}
        {#each DIMENSIONS as dim (dim.key)}
          <Card elevation="raised" padding="md" class="config-section">
            <div class="dimension-header">
              <h4>{dim.label}</h4>
              <Badge
                tone={defaultMode(dim.key) === 'allow-all' ? 'neutral' : 'warning'}
                dataTestId={`permission-policy-${dim.key}-mode`}
              >
                {defaultMode(dim.key) === 'allow-all'
                  ? 'Default: allow'
                  : 'Default: only listed commands run'}
              </Badge>
            </div>
            {#each KINDS as kind (kind.key)}
              {@const key = sectionKey(dim.key, kind.key)}
              {@const rules = loadedPolicy[dim.key][kind.key]}
              <section class="rule-kind">
                <h5>{kind.label}</h5>
                {#if rules.length === 0}
                  <p class="no-rules">No {kind.key} rules.</p>
                {:else}
                  <ul class="rule-list" data-testid={`permission-policy-${key}-list`}>
                    {#each rules as rule, index (`${rule}-${index}`)}
                      <li class="rule-row">
                        <code>{rule}</code>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={saving}
                          onclick={() => void removeRule(dim.key, kind.key, index)}
                          dataTestId={`permission-policy-${key}-remove-${index}`}
                        >
                          Remove
                        </Button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <form
                  class="add-rule-form"
                  onsubmit={(event) => handleAddSubmit(dim.key, kind.key, event)}
                >
                  <Field label={`Add a ${kind.key} pattern`} error={draftErrors[key]}>
                    {#snippet children({ id, describedBy, errorId, invalid, required })}
                      <div class="add-rule-row">
                        <Input
                          {id}
                          {describedBy}
                          {errorId}
                          {invalid}
                          {required}
                          monospace
                          placeholder={kind.placeholder}
                          bind:value={drafts[key]}
                          dataTestId={`permission-policy-${key}-input`}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          loading={saving}
                          dataTestId={`permission-policy-${key}-add`}
                        >
                          Add
                        </Button>
                      </div>
                    {/snippet}
                  </Field>
                </form>
              </section>
            {/each}
          </Card>
        {/each}

        <Card elevation="raised" padding="md" class="config-section">
          <h4>Recent policy blocks</h4>
          {#if recentViolations.length === 0}
            <p class="no-violations">No commands have been blocked by this policy yet.</p>
          {:else}
            <ul class="violation-list" data-testid="permission-policy-violations">
              {#each recentViolations as violation, index (index)}
                <li class="violation-row" data-testid={`permission-policy-violation-${index}`}>
                  <Badge tone="danger" size="sm">{ATTRIBUTION_LABEL[violation.reason.kind]}</Badge>
                  <span class="violation-text">{violationDetail(violation.reason)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </Card>
      {/snippet}
    </AsyncPanel>
  {/if}
</div>

<style>
  .permission-policy {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .dimension-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  h4 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  h5 {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .rule-kind {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    margin-top: var(--space-sm);
  }

  .no-rules,
  .no-violations {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .rule-list,
  .violation-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .rule-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .rule-row code {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }

  .violation-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-xs);
  }

  .violation-text {
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  .add-rule-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .add-rule-row {
    display: flex;
    gap: var(--space-xs);
    align-items: flex-start;
  }

  .add-rule-row :global(.ui-input) {
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
