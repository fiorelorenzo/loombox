// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import TextArea from './TextArea.svelte';

afterEach(() => cleanup());

describe('TextArea (coherence v5 design spec §1, issue #508)', () => {
  it('defaults to testid "ui-textarea" with a composer-shaped 4 rows, and accepts typed text', async () => {
    render(TextArea, { props: { value: '' } });
    const textarea = screen.getByTestId('ui-textarea') as HTMLTextAreaElement;
    expect(textarea.rows).toBe(4);
    await fireEvent.input(textarea, { target: { value: 'do the thing' } });
    expect(textarea.value).toBe('do the thing');
  });

  it('lets a caller override rows', () => {
    render(TextArea, { props: { value: '', rows: 8 } });
    expect((screen.getByTestId('ui-textarea') as HTMLTextAreaElement).rows).toBe(8);
  });

  it('wires Field-style aria-invalid/aria-errormessage when set', () => {
    render(TextArea, { props: { value: '', invalid: true, errorId: 'err-1' } });
    const textarea = screen.getByTestId('ui-textarea');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-errormessage')).toBe('err-1');
  });

  it('disables the control', () => {
    render(TextArea, { props: { value: '', disabled: true } });
    expect((screen.getByTestId('ui-textarea') as HTMLTextAreaElement).disabled).toBe(true);
  });
});
