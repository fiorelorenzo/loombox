// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isModShortcut, isTypingTarget } from './keyboard';

describe('isModShortcut (#132)', () => {
  it('matches Ctrl+key', () => {
    expect(isModShortcut({ key: 'k', metaKey: false, ctrlKey: true }, 'k')).toBe(true);
  });

  it('matches Cmd (metaKey)+key', () => {
    expect(isModShortcut({ key: 'K', metaKey: true, ctrlKey: false }, 'k')).toBe(true);
  });

  it('does not match without Mod held', () => {
    expect(isModShortcut({ key: 'k', metaKey: false, ctrlKey: false }, 'k')).toBe(false);
  });

  it('does not match a different key', () => {
    expect(isModShortcut({ key: 'j', metaKey: true, ctrlKey: false }, 'k')).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('is true for an input element', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
  });

  it('is true for a textarea element', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
  });

  it('is false for a plain button', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });

  it('is false for null', () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});
