<script lang="ts">
  /**
   * The bespoke TodoWrite widget (SPEC.md §7.24 tier-1, issue #139):
   * Claude's TodoWrite tool call, keyed structurally on `rawInput.todos`
   * (`$lib/tool-widgets.ts`'s `isTodoInput`) since ACP carries no tool-name
   * field to match on directly.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core';
  import { isTodoInput } from '$lib/tool-widgets';
  import CopyButton from '../CopyButton.svelte';

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
  .todo-widget {
    border: 1px solid rgba(127, 127, 127, 0.2);
    border-radius: 0.5rem;
    padding: 0.5rem 0.7rem;
    font-size: 0.85rem;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .title {
    flex: 1;
    font-weight: 600;
  }

  .todos {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .todos li {
    display: flex;
    gap: 0.4rem;
  }

  .todos li.completed .content {
    opacity: 0.55;
    text-decoration: line-through;
  }
</style>
