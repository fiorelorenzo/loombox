// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Field, { type FieldControlProps } from './Field.svelte';

afterEach(() => cleanup());

/** A minimal `<input>` child snippet that echoes the render-prop values onto the DOM as attributes, so assertions can read them straight off the rendered element. */
function inputSnippet() {
  return createRawSnippet<[FieldControlProps]>((getProps) => ({
    render: () => {
      const p = getProps();
      return `<input
        id="${p.id}"
        data-testid="field-child-input"
        data-described-by="${p.describedBy ?? ''}"
        data-error-id="${p.errorId ?? ''}"
        data-invalid="${p.invalid}"
        data-required="${p.required}"
      />`;
    },
  }));
}

describe('Field (coherence v5 design spec §1, issue #508)', () => {
  it('renders a real label[for] wired to a generated id, by default', () => {
    render(Field, { props: { label: 'Title', children: inputSnippet() } });
    const label = screen.getByText('Title');
    expect(label.tagName).toBe('LABEL');
    const input = screen.getByTestId('field-child-input');
    expect(label.getAttribute('for')).toBe(input.id);
  });

  it('renders help text wired via aria-describedby, with no error paragraph', () => {
    render(Field, {
      props: { label: 'Title', help: 'Defaults to the folder name', children: inputSnippet() },
    });
    const input = screen.getByTestId('field-child-input');
    const help = screen.getByText('Defaults to the folder name');
    expect(help.tagName).toBe('P');
    expect(input.dataset.describedBy).toBe(help.id);
    expect(input.dataset.invalid).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('wires an error via aria-invalid/aria-errormessage, distinct from aria-describedby', () => {
    render(Field, {
      props: { label: 'Title', error: 'Required', children: inputSnippet() },
    });
    const input = screen.getByTestId('field-child-input');
    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('Required');
    expect(input.dataset.errorId).toBe(error.id);
    expect(input.dataset.invalid).toBe('true');
    // Help and error are two distinct ARIA mechanisms per the file doc
    // comment — an error must never get folded into describedBy.
    expect(input.dataset.describedBy).toBe('');
  });

  it('passes required through to the child as a plain boolean', () => {
    render(Field, { props: { label: 'Title', required: true, children: inputSnippet() } });
    expect(screen.getByTestId('field-child-input').dataset.required).toBe('true');
  });

  it('grouped mode renders a plain caption (no for) and exposes labelId instead', () => {
    render(Field, { props: { label: 'Workspace', grouped: true, children: inputSnippet() } });
    const label = screen.getByText('Workspace');
    expect(label.tagName).toBe('SPAN');
    expect(label.hasAttribute('for')).toBe(false);
    expect(label.id).toBeTruthy();
  });
});
