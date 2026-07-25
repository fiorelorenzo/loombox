<script lang="ts">
  /**
   * The bespoke TodoWrite widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's TodoWrite tool call, keyed structurally on `rawInput.todos`
   * (`$lib/tool-widgets.ts`'s `isTodoInput`) since ACP carries no tool-name
   * field to match on directly.
   *
   * Warp Deck restyle (docs/design/redesign.md, issue #432): adopts the
   * elevation ladder's "raised" tier, hand-styled to match `Card`'s recipe
   * so the todo-widget testid stays on this component's own root element.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): the header draws a shared glyph next to the title, same
   * convention as `BashWidget`/`EditWriteWidget`. There is no dedicated
   * "todo" glyph in `icon-paths.ts` yet (its `IconName` union only has
   * `tool-bash`/`tool-edit`/`tool-generic`), so this borrows `tool-generic`
   * as an interim stand-in — a purpose-built checklist glyph is a natural
   * follow-up for whoever next touches the icon set. The per-entry ☑/☐
   * marks below are unaffected (out of this issue's scope, matching
   * `PlanCard`'s identical, untouched marker convention).
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { isTodoInput } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';
  import Icon from '../icons/Icon.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();
  // resolveToolWidgetKind only routes here when isTodoInput(item.rawInput) is true.
  const todos = $derived(isTodoInput(item.rawInput) ? item.rawInput.todos : []);
  const copyText = $derived(todos.map((todo) => `[${todo.status}] ${todo.content}`).join('\n'));
</script>

<div class="todo-widget" data-testid="todo-widget">
  <div class="header">
    <Icon name="tool-generic" class="type-icon" />
    <span class="title">Todo list</span>
    <CopyButton text={copyText} label="Copy todo list" />
  </div>
  <ul class="todos">
    {#each todos as todo, index (index)}
      <li class={todo.status}>
        <span class="checkbox" aria-hidden="true">{todo.status === 'completed' ? '☑' : '☐'}</span>
        <span class="content">{todo.content}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  /* raised tier (elevation ladder §3). */
  .todo-widget {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-sm) 0.7rem;
    font-size: var(--text-small-size);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  :global(.type-icon) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .title {
    flex: 1;
    font-weight: 600;
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

  .todos li.completed .content {
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

  .todos li.in_progress .content {
    font-weight: 600;
  }
</style>
