import type { TranscriptItem, TranscriptState } from '@loombox/providers-core';

/**
 * Copy & export (SPEC.md §7.24 "Copy & export"; issue #150). `copyToClipboard`
 * is the one path every copy affordance in the transcript ultimately calls:
 * the async Clipboard API when available (every real browser this PWA
 * targets, and jsdom's own `navigator.clipboard` when a test stubs it),
 * falling back to the classic hidden-textarea + `execCommand('copy')` trick
 * for anything older/embedded that lacks it — never silently doing nothing.
 */
export async function copyToClipboard(text: string): Promise<void> {
  const clipboard =
    typeof navigator !== 'undefined'
      ? (navigator as { clipboard?: Clipboard }).clipboard
      : undefined;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  copyViaHiddenTextarea(text);
}

function copyViaHiddenTextarea(text: string): void {
  if (typeof document === 'undefined') {
    throw new Error('copyToClipboard: no Clipboard API and no document to fall back to');
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Plain-text rendering of one transcript item — what a per-item copy affordance puts on the clipboard. */
export function itemCopyText(item: TranscriptItem): string {
  if (item.type === 'message') {
    const label =
      item.kind === 'agent_thought_chunk'
        ? 'Thought'
        : item.kind === 'user_message_chunk'
          ? 'User'
          : 'Agent';
    return `${label}: ${item.text}`;
  }

  const parts: string[] = [`Tool: ${item.title ?? item.toolKind ?? item.id}`];
  if (item.status) parts.push(`Status: ${item.status}`);
  if (item.diff) {
    parts.push(`--- ${item.diff.path}`);
    parts.push(item.diff.newText);
  } else if (item.content !== undefined) {
    parts.push(
      typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2),
    );
  } else if (item.rawInput !== undefined) {
    parts.push(
      typeof item.rawInput === 'string' ? item.rawInput : JSON.stringify(item.rawInput, null, 2),
    );
  }
  return parts.join('\n');
}

/**
 * The full transcript as one plain-text document, in item order — the
 * export affordance's payload (SPEC.md §7.24). One item per block, separated
 * by a blank line, so pasting it elsewhere reads like a plain chat log.
 */
export function exportTranscriptText(state: TranscriptState): string {
  return state.items.map(itemCopyText).join('\n\n');
}
