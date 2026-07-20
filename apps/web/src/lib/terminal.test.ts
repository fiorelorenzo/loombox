import { describe, expect, it } from 'vitest';
import { TerminalChunkDecoder, decodeTerminalChunks } from './terminal';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('TerminalChunkDecoder (#142)', () => {
  it('decodes a plain single chunk as-is', () => {
    const decoder = new TerminalChunkDecoder();
    expect(decoder.appendChunk(bytes('hello world'))).toBe('hello world');
  });

  it('buffers a multi-byte UTF-8 sequence split across two chunks instead of rendering mojibake', () => {
    const full = bytes('café 😀 done'); // "café 😀 done"
    // Split the buffer in the middle of the emoji's 4-byte UTF-8 sequence.
    const emojiStart = bytes('café ').length;
    const splitPoint = emojiStart + 2; // 2 of the emoji's 4 bytes
    const chunk1 = full.slice(0, splitPoint);
    const chunk2 = full.slice(splitPoint);

    const decoder = new TerminalChunkDecoder();
    const afterFirst = decoder.appendChunk(chunk1);
    // The dangling partial byte sequence never renders as replacement/garbage mid-stream.
    expect(afterFirst).not.toMatch(/�/);

    const afterSecond = decoder.appendChunk(chunk2);
    expect(afterSecond).toBe('café 😀 done');
  });

  it('buffers an ANSI escape sequence split across chunk boundaries — never shows raw escape bytes for either chunk', () => {
    const chunk1 = bytes('before \x1b[3'); // split mid-CSI-parameter
    const chunk2 = bytes('1mHello\x1b[0m after');

    const decoder = new TerminalChunkDecoder();
    const afterFirst = decoder.appendChunk(chunk1);
    expect(afterFirst).toBe('before ');
    expect(afterFirst).not.toContain('\x1b');

    const afterSecond = decoder.appendChunk(chunk2);
    expect(afterSecond).toBe('before Hello after');
    expect(afterSecond).not.toContain('\x1b');
  });

  it('strips a complete ANSI sequence within a single chunk', () => {
    const decoder = new TerminalChunkDecoder();
    expect(decoder.appendChunk(bytes('\x1b[32mgreen\x1b[0m text'))).toBe('green text');
  });

  it('flush() resolves any trailing incomplete sequence rather than leaving it stuck forever', () => {
    const decoder = new TerminalChunkDecoder();
    decoder.appendChunk(bytes('tail \x1b[1'));
    expect(decoder.flush()).toBe('tail ');
  });
});

describe('decodeTerminalChunks', () => {
  it('decodes a full chunk list to plain text through the same chunk-boundary-safe path', () => {
    expect(decodeTerminalChunks([bytes('a\x1b[31m'), bytes('b\x1b[0mc')])).toBe('abc');
  });
});
