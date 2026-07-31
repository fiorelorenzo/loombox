<script lang="ts">
  /**
   * The bespoke TodoWrite widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's TodoWrite tool call, keyed structurally on `rawInput.todos`
   * (`$lib/tool-widgets.ts`'s `isTodoInput`) since ACP carries no tool-name
   * field to match on directly.
   *
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "One tool-call anatomy"), converged onto the shared card language
   * by design spec v5 §4: the outer frame is now `ToolCallGutter` plus a
   * `ToolCard`, the same shape every tool-call widget uses (`GenericToolRow`
   * / `BashWidget` / `EditWriteWidget`). Status is a `StatusDot` + short
   * label, never the raw enum. The header toggles the checklist body's
   * expand/collapse, defaulting open. The per-entry ☑/☐ marks are
   * unaffected (out of this pass's scope, matching `PlanCard`'s identical,
   * untouched marker convention).
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the header draws a shared glyph next to the title, same
   * convention as `BashWidget`/`EditWriteWidget`. There is no dedicated
   * "todo" glyph in `icon-paths.ts` yet (its `IconName` union only has
   * `tool-bash`/`tool-edit`/`tool-generic`), so this borrows `tool-generic`
   * as an interim stand-in — a purpose-built checklist glyph is a natural
   * follow-up for whoever next touches the icon set.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import { isTodoInput, TOOL_CALL_STATUS_LABELS, TOOL_CALL_STATUS_TONES } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';
  import ToolCallGutter from '../ToolCallGutter.svelte';
  import Icon from '../icons/Icon.svelte';
  import StatusDot from '../ui/StatusDot.svelte';
  import ToolCard from './ToolCard.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  // resolveToolWidgetKind only routes here when isTodoInput(item.rawInput) is true.
  const todos = $derived(isTodoInput(item.rawInput) ? item.rawInput.todos : []);
  const copyText = $derived(todos.map((todo) => `[${todo.status}] ${todo.content}`).join('\n'));

  let expanded = $state(true);
  const statusTone = $derived(item.status ? TOOL_CALL_STATUS_TONES[item.status] : undefined);
  const statusLabel = $derived(item.status ? TOOL_CALL_STATUS_LABELS[item.status] : undefined);
</script>

<div class="todo-widget" data-testid="todo-widget">
  <ToolCallGutter icon="tool-generic" />
  <ToolCard>
    <div class="header-line">
      <button
        type="button"
        class="row-header"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
      >
        <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
        <span class="title">Todo list</span>
        {#if statusTone && statusLabel}
          <span class="status">
            <StatusDot tone={statusTone} label={statusLabel} size="sm" />
            <span class="status-label" aria-hidden="true">{statusLabel}</span>
          </span>
        {/if}
      </button>
      <div class="copy-row">
        <CopyButton text={copyText} label="Copy todo list" revealOnHover />
      </div>
    </div>
    {#if expanded}
      <ul class="todos">
        {#each todos as todo, index (index)}
          <li class={todo.status}>
            <span class="checkbox" aria-hidden="true"
              >{todo.status === 'completed' ? '☑' : '☐'}</span
            >
            <span class="todo-text">{todo.content}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </ToolCard>
</div>

<style>
  .todo-widget {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
    font-size: var(--text-small-size);
  }

  .header-line {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row-header:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-radius: var(--radius-sm);
  }

  :global(.disclosure-icon) {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  .title {
    flex: 1;
    font-weight: 600;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
    font-weight: 400;
  }

  .status-label {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .copy-row {
    flex-shrink: 0;
  }

  /* Copy affordances reveal on row hover/focus-within (redesign v3 §3.4
     "Copy affordances"); see CopyButton.svelte's `revealOnHover` doc
     comment for why this lives here rather than in the shared button. */
  .todo-widget:hover :global(.copy-button-reveal),
  .todo-widget:focus-within :global(.copy-button-reveal) {
    opacity: 1;
  }

  .todos {
    list-style: none;
    margin: var(--space-xs) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .todos li {
    display: flex;
    gap: var(--space-xs);
  }

  .todos li .checkbox {
    color: var(--color-text-muted);
  }

  .todos li.completed .checkbox {
    color: var(--color-success);
  }

  .todos li.completed .todo-text {
    opacity: 0.55;
    text-decoration: line-through;
  }

  /* Accent-for-meaning, not chrome: the one entry actually in flight gets
     the accent as a left marker, since it's the meaningful "happening
     right now" signal — everything else stays neutral text weight. */
  .todos li.in_progress {
    position: relative;
    padding-left: var(--space-sm);
  }

  .todos li.in_progress::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.2em;
    bottom: 0.2em;
    width: 2px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
  }

  .todos li.in_progress .todo-text {
    font-weight: 600;
  }

  /* Below `--bp-mobile` the role column collapses, so this row stacks its
     `ToolCallGutter` caption above the card — see that component's own copy
     of this block, and `MessageItem`'s for the measurement. */
  @media (max-width: 479px) {
    .todo-widget {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
