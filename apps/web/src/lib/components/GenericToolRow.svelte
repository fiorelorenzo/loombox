<script lang="ts">
  /**
   * The generic `ToolKind`-driven fallback row (SPEC.md §7.24 tier-2, issue
   * #140) — the guaranteed baseline for any tool call without a bespoke
   * widget (the generic ACP adapter tier has no per-tool-name knowledge at
   * all). `ToolCallRow` is the one place that decides bespoke-vs-generic
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`), so this component
   * itself never needs to know about the bespoke tier.
   *
   * Redesign v3 (`docs/superpowers/specs/2026-07-25-redesign-v3-design.md`
   * §3.4 "One tool-call anatomy"), converged onto the shared card language
   * by design spec v5 §4: `[ToolCallGutter] ToolCard[ title … status ]`,
   * the same shape every tool-call widget uses now (`BashWidget` /
   * `EditWriteWidget` / `TodoWidget`) — no visible kind chip (the old
   * uppercase `toolKind` badge is gone; the kind lives as the gutter icon
   * plus an `sr-only` label, same discipline as `MessageItem`'s role), and
   * status is a `StatusDot` + short human label (`$lib/tool-widgets.ts`'s
   * `TOOL_CALL_STATUS_TONES`/`_LABELS`) rather than the raw enum as grey
   * body text. The row header toggles an expand/collapse of its own body
   * (defaulting open, so replayed history reads exactly as before).
   *
   * `rawInput`/`content` never render as a raw `JSON.stringify` blob
   * (defect C7 / acceptance #4): when the call has already produced
   * `content`, that renders as preformatted text as before
   * (`toolCallOutputText`); before it has (the common "still just an
   * argument object" case, e.g. `read`/`search`), `rawInput` goes through
   * `$lib/tool-widgets.ts`'s shared `classifyRawInput` — the same
   * registry `PermissionCard` uses for its own rawInput fallback — which
   * renders a command line, a lone path, or a formatted key/value list
   * (keys in `--font-mono`, muted; values readable), never braces/quotes.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468): every tool call that lands here (tier-2, no bespoke widget) is by
   * definition the "any other tool" case, so it always draws the shared
   * `tool-generic` glyph via `ToolCallGutter` — decorative, the kind is
   * carried by the `sr-only` label right beside it.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import {
    classifyRawInput,
    toolCallOutputText,
    TOOL_CALL_STATUS_LABELS,
    TOOL_CALL_STATUS_TONES,
    type RawInputRender,
  } from '$lib/tool-widgets';
  import CopyButton from './CopyButton.svelte';
  import Icon from './icons/Icon.svelte';
  import ToolCallGutter from './ToolCallGutter.svelte';
  import ToolCard from './tool-widgets/ToolCard.svelte';
  import StatusDot from './ui/StatusDot.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();

  let expanded = $state(true);

  const hasContent = $derived(item.content !== undefined);
  const outputText = $derived(hasContent ? toolCallOutputText(item.content) : '');
  const rawInputPreview = $derived(hasContent ? undefined : classifyRawInput(item.rawInput));

  const statusTone = $derived(item.status ? TOOL_CALL_STATUS_TONES[item.status] : undefined);
  const statusLabel = $derived(item.status ? TOOL_CALL_STATUS_LABELS[item.status] : undefined);

  function rawInputCopyText(preview: RawInputRender | undefined): string {
    if (!preview) return '';
    if (preview.kind === 'command') return `$ ${preview.command}`;
    if (preview.kind === 'path') return preview.path;
    return preview.entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n');
  }

  const copyText = $derived(
    `${item.title ?? item.toolKind ?? item.id}\n${
      hasContent ? outputText : rawInputCopyText(rawInputPreview)
    }`.trim(),
  );
</script>

<div
  class="generic-tool-row"
  data-tool-kind={item.toolKind ?? 'other'}
  data-testid="generic-tool-row"
>
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
        <span class="sr-only">{item.toolKind ?? 'other'}</span>
        <span class="title">{item.title ?? item.id}</span>
        {#if statusTone && statusLabel}
          <span class="status">
            <StatusDot tone={statusTone} label={statusLabel} size="sm" />
            <span class="status-label" aria-hidden="true">{statusLabel}</span>
          </span>
        {/if}
      </button>
      <div class="copy-row">
        <CopyButton
          text={copyText}
          label={`Copy ${item.title ?? 'tool call'} output`}
          revealOnHover
        />
      </div>
    </div>
    {#if expanded}
      {#if hasContent && outputText}
        <div class="body">
          <pre class="output">{outputText}</pre>
        </div>
      {:else if !hasContent && rawInputPreview}
        <div class="body">
          {#if rawInputPreview.kind === 'command'}
            <code class="command-line">$ {rawInputPreview.command}</code>
          {:else if rawInputPreview.kind === 'path'}
            <code class="path">{rawInputPreview.path}</code>
          {:else}
            <dl class="entries">
              {#each rawInputPreview.entries as entry (entry.key)}
                <div class="entry">
                  <dt class="entry-key font-mono">{entry.key}</dt>
                  <dd class="entry-value">{entry.value}</dd>
                </div>
              {/each}
            </dl>
          {/if}
        </div>
      {/if}
    {/if}
  </ToolCard>
</div>

<style>
  .generic-tool-row {
    display: flex;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
    font-size: var(--text-small-size);
  }

  /* Layout-in-row and padding both live in `ToolCard` itself now (see its
     own doc comment on why a class handed through here would be pruned as
     unused CSS). */
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
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
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
  .generic-tool-row:hover :global(.copy-button-reveal),
  .generic-tool-row:focus-within :global(.copy-button-reveal) {
    opacity: 1;
  }

  .body {
    margin-top: var(--space-xs);
    min-width: 0;
  }

  .output {
    margin: 0;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: var(--text-small-size);
  }

  .command-line,
  .path {
    display: block;
    margin: 0;
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-fill-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
    white-space: pre;
  }

  .entries {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .entry {
    display: flex;
    gap: var(--space-sm);
    align-items: baseline;
  }

  .entry-key {
    flex: 0 0 auto;
    min-width: 6rem;
    margin: 0;
    color: var(--color-text-muted);
  }

  .entry-value {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Below `--bp-mobile` the role column collapses, so this row stacks its
     `ToolCallGutter` caption above the card — see that component's own copy
     of this block, and `MessageItem`'s for the measurement. */
  @media (max-width: 479px) {
    .generic-tool-row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
