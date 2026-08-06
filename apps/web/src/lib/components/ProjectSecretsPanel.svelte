<script lang="ts">
  /**
   * A project's declared env-var/secret injection surface (SPEC.md §7.17,
   * §8; issue #258): lists the project's currently declared env vars
   * (remove), and a form to declare a new one — either a literal, non-
   * secret value, or a reference to a node-local secret by name. Sits
   * beside `McpServerConfigPanel` in `ProjectConfigPanel`'s Config tab
   * (this issue's own "the UI belongs with the project's other
   * configuration, next to the MCP servers that already live there").
   *
   * Mirrors `McpServerConfigPanel.svelte`'s exact shape/rationale for the
   * "declare here, resolve node-side" split (§7.17's node-local-secrets
   * rule): this panel never holds, requests, or displays a secret *value*
   * — only the env var name and, for a secret-reference decl, the secret
   * *name* it needs granted downstream. `onSecretRequired` is the same
   * seam `McpServerConfigPanel` exposes: called once per declared secret
   * reference, but this panel stops there (a real grant/value UI is out
   * of this issue's scope, exactly like MCP's own secret grants — see
   * that panel's doc comment for the identical boundary).
   *
   * No quick-add preset catalog here (unlike MCP servers): a secret name
   * is inherently project-specific, so there is nothing generic to
   * pre-fill.
   */
  import { ProjectEnvDeclError, type ProjectEnvVarDecl } from '@loombox/providers-core/browser';
  import {
    addProjectEnvVarDecl,
    createLocalStorageProjectEnvStorage,
    removeProjectEnvVarDecl,
    requiredSecretName,
    type ProjectEnvDeclStorage,
  } from '$lib/project-env-store';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';
  import Field from './ui/Field.svelte';
  import Input from './ui/Input.svelte';

  interface Props {
    projectPath: string;
    storage?: ProjectEnvDeclStorage;
    onChange?: (decls: ProjectEnvVarDecl[]) => void;
    onSecretRequired?: (envVarName: string, secretName: string) => void;
  }

  const {
    projectPath,
    storage = createLocalStorageProjectEnvStorage(projectPath),
    onChange,
    onSecretRequired,
  }: Props = $props();

  // One-shot initial read into a plain local before seeding `$state`, same
  // pattern `McpServerConfigPanel.svelte`'s `readInitialRecords` uses —
  // referencing the `storage` prop directly inside a `$state` initializer
  // triggers Svelte 5's "only captures the initial value" warning.
  function readInitialDecls(): ProjectEnvVarDecl[] {
    return storage.get();
  }

  let decls = $state(readInitialDecls());
  let error = $state<string | undefined>(undefined);

  let manualName = $state('');
  let manualSecretName = $state('');
  let manualValue = $state('');

  function handleAdd(): void {
    const name = manualName.trim();
    const secretName = manualSecretName.trim();
    const value = manualValue.trim();
    if (!name) {
      error = 'Env var name is required.';
      return;
    }
    if (!secretName && !value) {
      error = 'Either a secret name or a literal value is required.';
      return;
    }
    const decl: ProjectEnvVarDecl = secretName ? { name, secret: secretName } : { name, value };
    try {
      decls = addProjectEnvVarDecl(storage, decl);
      error = undefined;
      manualName = '';
      manualSecretName = '';
      manualValue = '';
      const required = requiredSecretName(decl);
      if (required) onSecretRequired?.(decl.name, required);
      onChange?.(decls);
    } catch (err) {
      error = err instanceof ProjectEnvDeclError ? err.message : String(err);
    }
  }

  function handleRemove(name: string): void {
    decls = removeProjectEnvVarDecl(storage, name);
    onChange?.(decls);
  }
</script>

<div class="project-secrets" data-testid="project-secrets-panel">
  {#if error}
    <ErrorNotice message={error} />
  {/if}

  <Card elevation="raised" padding="md" class="config-section">
    <section class="declared">
      <h3>Declared env vars</h3>
      {#if decls.length === 0}
        <EmptyState message="No env vars declared for this project yet." />
      {:else}
        <ul class="decl-list" data-testid="project-secrets-list">
          {#each decls as decl (decl.name)}
            <li class="decl-row" data-testid={`project-secret-${decl.name}`}>
              <span class="decl-name">{decl.name}</span>
              {#if requiredSecretName(decl)}
                <Badge tone="warning" dataTestId={`secret-badge-${decl.name}`}>
                  Needs secret: {requiredSecretName(decl)}
                </Badge>
              {:else}
                <Badge tone="neutral" dataTestId={`literal-badge-${decl.name}`}>
                  Literal value
                </Badge>
              {/if}
              <Button
                variant="danger"
                size="sm"
                class="remove-button"
                onclick={() => handleRemove(decl.name)}
                dataTestId={`decl-remove-${decl.name}`}
              >
                Remove
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </Card>

  <Card elevation="raised" padding="md" class="config-section">
    <section class="manual-add">
      <h3>Declare an env var</h3>
      <div class="manual-form">
        <Field label="Env var name">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              bind:value={manualName}
              placeholder="e.g. DB_PASSWORD"
              dataTestId="env-add-name"
            />
          {/snippet}
        </Field>
        <Field label="Secret name (leave blank to use a literal value instead)">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              monospace
              bind:value={manualSecretName}
              placeholder="e.g. db-password"
              dataTestId="env-add-secret"
            />
          {/snippet}
        </Field>
        <Field label="Literal value (used only when no secret name is set)">
          {#snippet children({ id, describedBy, errorId, invalid, required })}
            <Input
              {id}
              {describedBy}
              {errorId}
              {invalid}
              {required}
              monospace
              bind:value={manualValue}
              placeholder="e.g. test"
              dataTestId="env-add-value"
            />
          {/snippet}
        </Field>
        <Button variant="primary" size="sm" onclick={handleAdd} dataTestId="env-add-submit">
          Add
        </Button>
      </div>
    </section>
  </Card>
</div>

<style>
  .project-secrets {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    font-size: var(--text-small-size);
  }

  :global(.config-section) {
    display: block;
  }

  h3 {
    margin: 0 0 var(--space-sm);
    font-family: var(--font-mono);
    font-size: var(--text-caption-size);
    letter-spacing: var(--text-caption-tracking);
    text-transform: uppercase;
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .decl-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Quiet hairline-divided rows (redesign brief §4 "Rows"), not boxed
     cards, so a long list stays scannable — mirrors `McpServerConfigPanel`'s
     identical `.server-row` convention. */
  .decl-row {
    border-top: 1px solid var(--color-border-subtle);
    padding: var(--space-xs) var(--space-2xs);
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .decl-row:first-child {
    border-top: none;
    padding-top: 0;
  }

  .decl-name {
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
  }

  /* `Button`'s own scope hides this class from the file's hash (same
     `:global()` pattern `McpServerConfigPanel.svelte` already uses) — only
     the row-positioning this list needs on top of `Button`'s `danger`
     variant lives here now. */
  :global(.remove-button) {
    margin-left: auto;
  }

  .manual-form {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }
</style>
