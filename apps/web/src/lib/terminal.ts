import type { Readable } from 'svelte/store';
import type { TerminalClientState } from './relay-client';

/**
 * Chunk-boundary-safe decoding for a display-only terminal stream (SPEC.md
 * §7.24 "Display-only terminals": "buffering partial UTF-8/ANSI escape
 * sequences across output chunks rather than decoding chunk-by-chunk";
 * issue #142). A raw tool-call/PTY byte stream can split a multi-byte UTF-8
 * code point or an ANSI escape sequence across two separate chunks — naive
 * per-chunk decoding would render mojibake or literal escape bytes for one
 * frame before the next chunk "fixes" it. `TerminalChunkDecoder` buffers
 * across `appendChunk` calls so that never happens.
 */

/**
 * The narrow slice of `RelayClient` (SPEC §7.5; issues #172/#173/#174)
 * `InteractiveTerminal.svelte` actually needs — its own interface, not a
 * direct dependency on `RelayClient` itself, so a component test can inject
 * a plain fake with none of the real client's crypto/WebSocket machinery
 * (mirrors this file's own `TerminalChunkDecoder` being a shared primitive
 * `TerminalOutput.svelte` consumes rather than owning). Every method here
 * mirrors `RelayClient`'s own method of the same name and signature.
 */
export interface TerminalClient {
  terminalsFor(sessionId: string): Readable<Map<string, TerminalClientState>>;
  openTerminal(sessionId: string, cols: number, rows: number): string;
  sendTerminalInput(sessionId: string, terminalId: string, data: Uint8Array | string): void;
  resizeTerminal(sessionId: string, terminalId: string, cols: number, rows: number): void;
  closeTerminal(sessionId: string, terminalId: string): void;
  onTerminalOutput(
    sessionId: string,
    terminalId: string,
    listener: (chunk: Uint8Array) => void,
  ): () => void;
}

const ESC = '\x1b';

// Built via `new RegExp(...)` from the `ESC` string constant rather than as
// control-character regex literals (`eslint`'s `no-control-regex` flags a
// literal `\x1b` inside a `/.../` pattern, on the theory that it's usually
// an accidental paste; here it's the deliberate, documented ANSI escape
// byte, so a dynamically-built pattern says exactly what it means without
// fighting the linter).

/** Every *complete* ANSI CSI sequence (`ESC [ params final-byte`) found in `text`, stripped — v1's display-only terminal renders plain monospace text, matching `BashWidget`'s existing style, rather than interpreting SGR color codes. */
const COMPLETE_CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g');

/** Matches a CSI sequence that has only parameter bytes so far (digits/semicolons), no final byte yet. */
const INCOMPLETE_CSI_TAIL = new RegExp(`^${ESC}\\[[0-9;]*$`);

/** True when `tail` (the text from the last ESC to the end of what's been decoded so far) looks like the start of a CSI sequence that hasn't seen its final byte yet — the exact case that must be held back rather than rendered as raw escape-code garbage. */
function isIncompleteAnsiTail(tail: string): boolean {
  if (tail === ESC) return true;
  if (tail.length >= 2 && tail[1] === '[') return INCOMPLETE_CSI_TAIL.test(tail);
  return false;
}

export class TerminalChunkDecoder {
  // `{stream: true}` is exactly the platform-native answer to "buffer a
  // partial UTF-8 sequence across chunks" — no hand-rolled byte-buffering
  // needed for that half of the problem.
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  private pendingAnsi = '';
  private text = '';

  /** Appends one raw chunk and returns the full accumulated, decoded, ANSI-stripped text so far. */
  appendChunk(chunk: Uint8Array): string {
    const decoded = this.utf8Decoder.decode(chunk, { stream: true });
    const combined = this.pendingAnsi + decoded;
    this.pendingAnsi = '';

    const lastEsc = combined.lastIndexOf(ESC);
    let toProcess = combined;
    if (lastEsc !== -1) {
      const tail = combined.slice(lastEsc);
      if (isIncompleteAnsiTail(tail)) {
        toProcess = combined.slice(0, lastEsc);
        this.pendingAnsi = tail;
      }
    }

    this.text += toProcess.replace(COMPLETE_CSI_SEQUENCE, '');
    return this.text;
  }

  /**
   * Call once the stream is known to be done. Flushes the UTF-8 decoder's
   * own tail (an incomplete byte sequence at true end-of-stream decodes to
   * U+FFFD, `TextDecoder`'s own documented behavior for a real truncated
   * stream) and drops any still-incomplete ANSI tail entirely — it was
   * never going to be completed now, so rendering it raw would be exactly
   * the escape-code garbage this class exists to avoid.
   */
  flush(): string {
    this.pendingAnsi = '';
    const decoded = this.utf8Decoder.decode();
    this.text += decoded.replace(COMPLETE_CSI_SEQUENCE, '');
    return this.text;
  }
}

/** One-shot convenience over {@link TerminalChunkDecoder} for a caller that already has every chunk in hand (no live stream to buffer against) — still goes through the same chunk-boundary-safe path, so a test exercising split chunks and a caller with pre-buffered `content` share one decode path. */
export function decodeTerminalChunks(chunks: readonly Uint8Array[]): string {
  const decoder = new TerminalChunkDecoder();
  for (const chunk of chunks) decoder.appendChunk(chunk);
  return decoder.flush();
}
