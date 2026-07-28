// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import FormActions from './FormActions.svelte';

afterEach(() => cleanup());

function buttonsSnippet() {
  return createRawSnippet(() => ({
    render: () => '<button data-testid="fa-child">Go</button>',
  }));
}

describe('FormActions (coherence v5 design spec §1, issue #508)', () => {
  it('renders its children and defaults to right-aligned', () => {
    render(FormActions, { props: { children: buttonsSnippet() } });
    expect(screen.getByTestId('fa-child')).toBeTruthy();
    expect(screen.getByTestId('ui-form-actions').classList.contains('ui-form-actions-end')).toBe(
      true,
    );
  });

  it('supports a start-aligned variant', () => {
    render(FormActions, { props: { align: 'start', children: buttonsSnippet() } });
    expect(screen.getByTestId('ui-form-actions').classList.contains('ui-form-actions-start')).toBe(
      true,
    );
  });

  it('merges a caller-provided class onto the root element', () => {
    render(FormActions, { props: { class: 'my-extra', children: buttonsSnippet() } });
    expect(screen.getByTestId('ui-form-actions').classList.contains('my-extra')).toBe(true);
  });
});
