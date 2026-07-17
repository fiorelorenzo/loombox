<script lang="ts">
  /**
   * A message/thought transcript item (SPEC.md §7.24's append-by-id reducer
   * output). Thoughts render muted and collapsed by default, expandable on
   * tap (§7.24 "Thinking/reasoning" — the live "Thinking Ns" ticking-timer
   * header itself needs a turn-completion signal `TranscriptState` doesn't
   * carry yet, so it's out of this wave's assigned issues; this component
   * only does the static muted/collapsible part). Every message/thought
   * gets the shared copy affordance (issue #150).
   */
  import type { TranscriptMessageItem } from '@loombox/providers-core';
  import { itemCopyText } from '$lib/copy';
  import CopyButton from './CopyButton.svelte';

  interface Props {
    item: TranscriptMessageItem;
  }

  const { item }: Props = $props();

  const role = $derived(
    item.kind === 'user_message_chunk'
      ? 'user'
      : item.kind === 'agent_thought_chunk'
        ? 'thought'
        : 'agent',
  );

  let expanded = $state(false);
</script>

<div
  class="message-item"
  class:user={role === 'user'}
  class:thought={role === 'thought'}
  data-testid="message-item"
>
  <div class="row">
    <span class="role">{role}</span>
    {#if role === 'thought' && !expanded}
      <button type="button" class="expand" onclick={() => (expanded = true)}>Show thought</button>
    {:else}
      <p class="text">{item.text}</p>
    {/if}
    <CopyButton text={itemCopyText(item)} label={`Copy ${role} message`} />
  </div>
</div>

<style>
  .message-item {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: rgba(127, 127, 127, 0.1);
  }

  .message-item.user {
    align-self: flex-end;
    background: rgba(79, 70, 229, 0.15);
  }

  .message-item.thought {
    opacity: 0.65;
    font-style: italic;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
  }

  .role {
    flex-shrink: 0;
    font-size: 0.7rem;
    text-transform: uppercase;
    opacity: 0.6;
    padding-top: 0.15rem;
  }

  .text {
    flex: 1;
    margin: 0;
    white-space: pre-wrap;
  }

  .expand {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    padding: 0;
  }
</style>
