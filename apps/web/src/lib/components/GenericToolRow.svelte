<script lang="ts">
  /**
   * The generic `ToolKind`-driven fallback row (SPEC.md §7.24 tier-2, issue
   * #140) — the guaranteed baseline for any tool call without a bespoke
   * widget (the generic ACP adapter tier has no per-tool-name knowledge at
   * all). `ToolCallRow` is the one place that decides bespoke-vs-generic
   * (`$lib/tool-widgets.ts`'s `resolveToolWidgetKind`), so this component
   * itself never needs to know about the bespoke tier.
   *
   * One line vs. a block (design spec `2026-08-03-cockpit-v6-design.md`
   * §3.4, issue #576): a payload that is a single line — a lone path, a
   * short command, one key/value pair — folds directly onto the header
   * line instead of opening a second row underneath it, and `ToolCard`
   * renders `surface={false}` so there is no card at all, just the row.
   * `resolvePayload` below is the one place that decides "one line or a
   * block", from the payload's own shape (does it contain a newline, does
   * it carry more than one entry) — every render path funnels through it
   * rather than each branch reinventing the boundary. A path payload that
   * merely repeats what the title already says (`Read apps/web/foo.ts`
   * whose `rawInput.file_path` is that exact same string) is dropped
   * entirely rather than rendered a second time — the title already said
   * it once. A payload that genuinely needs more than one line (multi-line
   * command output, a multi-key `rawInput`) still gets the one surviving
   * level of card chrome, via `ToolCard`'s own `surface={true}`.
   *
   * Collapsing the row always drops back to a single line regardless of
   * which shape the payload is: the header (icon, title, status) is the
   * one thing that's never optional.
   *
   * Status is a `StatusDot` + short label via the shared `ToolCallStatus`
   * (a failed call is louder than a completed one; see that component's
   * own doc comment) rather than the raw enum as grey body text.
   *
   * `rawInput`/`content` never render as a raw `JSON.stringify` blob
   * (defect C7 / acceptance #4): when the call has already produced
   * `content`, that renders as text (`toolCallOutputText`); before it has
   * (the common "still just an argument object" case, e.g. `read`/
   * `search`), `rawInput` goes through `$lib/tool-widgets.ts`'s shared
   * `classifyRawInput` — the same registry `PermissionCard` uses for its
   * own rawInput fallback — which renders a command line, a lone path, or
   * a formatted key/value list (keys in `--font-mono`, muted; values
   * readable), never braces/quotes.
   *
   * Tool output is deliberately NOT routed through `$lib/markdown.ts`
   * (issue #574): that pipeline renders prose, and stdout/grep-hit/file
   * text is not prose — a log line starting `# ` or `- ` is not a heading
   * or a list item, and parsing it as one would corrupt exactly the
   * content this row exists to show verbatim. It stays plain, pre-
   * formatted text, same as before.
   *
   * Deck icon migration (redesign v2 design spec §2 "Icon system", issue
   * #468), extended per-`ToolKind` for issue #744: `ToolCallGutter` draws
   * `$lib/tool-widgets.ts`'s `toolKindIcon(item.toolKind)` — a distinct
   * glyph per ACP tool kind (search/read/fetch/delete/move used to all
   * share the generic wrench; `edit`/`execute` reuse the exact glyph their
   * own bespoke widgets draw, so there's no icon swap at the bespoke
   * hand-off) — decorative, the kind is carried by the `sr-only` label
   * right beside it. `ToolCallMeta` draws elapsed time and an attributed
   * cost figure next to `ToolCallStatus`, both `undefined`-means-"nothing
   * to show" per their own doc comments on `TranscriptToolCallItem`
   * (`packages/providers/core/src/transcript.ts`), never a fabricated
   * zero.
   *
   * Resting state and its one override (v7 decisions §3, issue #668):
   * C1-1 — a completed call rests collapsed to this header's single line
   * (title/command plus `ToolCallStatus`'s outcome), the block body waits
   * behind the disclosure chevron rather than opening by default. C2-1 —
   * a failed call always renders its body in full, uncapped, and the
   * disclosure is locked open (no button at all, just static text) so it
   * cannot be collapsed by accident; this is a rule scoped to `failed`
   * that overrides whichever resting default C1-1 picked, never a second
   * competing default. A still-running call (`pending`/`in_progress`)
   * keeps the old always-open behaviour, since there's live output worth
   * watching.
   */
  import type { TranscriptToolCallItem } from '@loombox/providers-core/browser';
  import {
    classifyRawInput,
    toolCallOutputText,
    toolKindIcon,
    type RawInputEntry,
    type RawInputRender,
  } from '$lib/tool-widgets';
  import CopyButton from './CopyButton.svelte';
  import Icon from './icons/Icon.svelte';
  import ToolCallGutter from './ToolCallGutter.svelte';
  import ToolCallMeta from './ToolCallMeta.svelte';
  import ToolCallStatus from './ToolCallStatus.svelte';
  import ToolCard from './tool-widgets/ToolCard.svelte';

  interface Props {
    item: TranscriptToolCallItem;
  }

  const { item }: Props = $props();

  // See the file doc comment's "Resting state and its one override" note.
  // Only the mount-time status matters here (a live status change never
  // auto-collapses/-expands an already-rendered row): `locked` picks up
  // `failed` reactively regardless.
  // svelte-ignore state_referenced_locally
  let expandedState = $state(item.status !== 'completed');
  const locked = $derived(item.status === 'failed');
  const expanded = $derived(locked || expandedState);
  function toggleExpanded() {
    if (locked) return;
    expandedState = !expandedState;
  }

  const titleText = $derived(item.title ?? item.id);
  const hasContent = $derived(item.content !== undefined);
  const outputText = $derived(hasContent ? toolCallOutputText(item.content) : '');
  const rawInputPreview = $derived(hasContent ? undefined : classifyRawInput(item.rawInput));

  type Payload =
    | { kind: 'none' }
    | { kind: 'text'; text: string; block: boolean }
    | { kind: 'command'; command: string; block: boolean }
    | { kind: 'path'; path: string; block: false }
    | { kind: 'kv'; entries: RawInputEntry[]; block: boolean };

  /** The one place that decides "one line or a block" (see the file doc comment). */
  function resolvePayload(
    hasOutput: boolean,
    output: string,
    preview: RawInputRender | undefined,
    title: string,
  ): Payload {
    if (hasOutput) {
      if (!output) return { kind: 'none' };
      return { kind: 'text', text: output, block: output.includes('\n') };
    }
    if (!preview) return { kind: 'none' };
    if (preview.kind === 'command') {
      const { command } = preview;
      const block = command.includes('\n');
      if (!block && title.endsWith(command)) return { kind: 'none' };
      return { kind: 'command', command, block };
    }
    if (preview.kind === 'path') {
      const { path } = preview;
      return title.endsWith(path) ? { kind: 'none' } : { kind: 'path', path, block: false };
    }
    if (preview.entries.length === 0) return { kind: 'none' };
    return { kind: 'kv', entries: preview.entries, block: preview.entries.length > 1 };
  }

  const payload = $derived(resolvePayload(hasContent, outputText, rawInputPreview, titleText));
  const isBlock = $derived(payload.kind !== 'none' && payload.block);
  const showInline = $derived(expanded && payload.kind !== 'none' && !isBlock);
  const showBlock = $derived(expanded && isBlock);

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
  <ToolCallGutter icon={toolKindIcon(item.toolKind)} />
  <ToolCard surface={showBlock}>
    <div class="header-line">
      {#snippet headerContent()}
        <span class="sr-only">{item.toolKind ?? 'other'}</span>
        <span class="title-line">
          <span class="title">{item.title ?? item.id}</span>
          {#if showInline}
            <span class="inline-payload">
              {#if payload.kind === 'text'}
                <code>{payload.text}</code>
              {:else if payload.kind === 'command'}
                <code>$ {payload.command}</code>
              {:else if payload.kind === 'path'}
                <code>{payload.path}</code>
              {:else if payload.kind === 'kv'}
                {#each payload.entries as entry (entry.key)}
                  <span class="inline-entry">
                    <span class="inline-key">{entry.key}</span>
                    <span class="inline-value">{entry.value}</span>
                  </span>
                {/each}
              {/if}
            </span>
          {/if}
        </span>
        <ToolCallMeta elapsedMs={item.elapsedMs} attributedCostUsd={item.attributedCostUsd} />
        <ToolCallStatus status={item.status} />
      {/snippet}
      {#if locked}
        <div class="row-header row-header-static" data-testid="row-header">
          {@render headerContent()}
        </div>
      {:else}
        <button
          type="button"
          class="row-header"
          onclick={toggleExpanded}
          aria-expanded={expanded}
          data-testid="row-header"
        >
          <Icon name="collapse-chevron" size="0.7em" class="disclosure-icon" />
          {@render headerContent()}
        </button>
      {/if}
      <div class="copy-row">
        <CopyButton
          text={copyText}
          label={`Copy ${item.title ?? 'tool call'} output`}
          revealOnHover
        />
      </div>
    </div>
    {#if showBlock}
      <div class="body">
        {#if payload.kind === 'text'}
          <pre class="output">{payload.text}</pre>
        {:else if payload.kind === 'command'}
          <code class="command-line">$ {payload.command}</code>
        {:else if payload.kind === 'kv'}
          <dl class="entries">
            {#each payload.entries as entry (entry.key)}
              <div class="entry">
                <dt class="entry-key font-mono">{entry.key}</dt>
                <dd class="entry-value">{entry.value}</dd>
              </div>
            {/each}
          </dl>
        {/if}
      </div>
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

  /* `flex-shrink: 0` used to sit here too, but `Icon`'s own
     `.icon { flex-shrink: 0; }` scoped root rule already provides the
     identical value (issue #665's guard-test scan) — redundant dead CSS,
     dropped rather than kept. */
  :global(.disclosure-icon) {
    color: var(--color-text-muted);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  .row-header[aria-expanded='false'] :global(.disclosure-icon) {
    transform: rotate(-90deg);
  }

  /* C2-1 (issue #668): the locked/failed header renders as plain text,
     not a button — there is nothing to disclose, so no click affordance
     (and no misleading focus outline) should suggest otherwise. */
  .row-header-static {
    cursor: default;
  }

  /* Holds the title and, when the payload is a single line, that payload
     right beside it — the pair that must fit on one line together, so this
     is the flex-growing element, not `.title` alone (issue #576). */
  .title-line {
    display: flex;
    align-items: baseline;
    gap: var(--space-xs);
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inline-payload {
    display: flex;
    gap: var(--space-sm);
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .inline-payload code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inline-entry {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2xs);
    overflow: hidden;
    white-space: nowrap;
  }

  .inline-key {
    flex-shrink: 0;
    font-family: var(--font-mono);
  }

  .inline-value {
    overflow: hidden;
    text-overflow: ellipsis;
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

  /* No separate inset surface here (issue #576): `ToolCard`'s own border
     is the block's one level of chrome now, so this is plain text laid
     directly inside its padding rather than a second `--color-fill-subtle`
     box. */
  .output {
    margin: 0;
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: var(--text-small-size);
  }

  .command-line {
    display: block;
    margin: 0;
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
