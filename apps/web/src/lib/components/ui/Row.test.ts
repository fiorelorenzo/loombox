// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Row, { type RowElement } from './Row.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

function leadingDot() {
  return createRawSnippet(() => ({
    render: () => `<span data-testid="leading-dot"></span>`,
  }));
}

function trailingActionSnippet() {
  return createRawSnippet(() => ({
    render: () => `<span role="button" tabindex="0" data-testid="trailing-action">Dismiss</span>`,
  }));
}

describe('Row (issue #579 Warp Deck shared UI primitives)', () => {
  it('defaults to a plain div and renders leading/content/trailing regions', () => {
    render(Row, {
      props: {
        children: textSnippet('Title'),
        leading: leadingDot(),
        trailing: textSnippet('Trailing'),
      },
    });
    const row = screen.getByTestId('ui-row');
    expect(row.tagName).toBe('DIV');
    expect(row.querySelector('.ui-row-leading [data-testid="leading-dot"]')).toBeTruthy();
    expect(row.querySelector('.ui-row-content')?.textContent).toContain('Title');
    expect(row.querySelector('.ui-row-trailing')?.textContent).toContain('Trailing');
  });

  it('switches its root element via `as`: div, li, button, a', () => {
    const cases: Array<[RowElement, string]> = [
      ['div', 'DIV'],
      ['li', 'LI'],
      ['button', 'BUTTON'],
      ['a', 'A'],
    ];
    for (const [as, tag] of cases) {
      cleanup();
      render(Row, {
        props: { children: textSnippet('x'), as, href: as === 'a' ? '#dest' : undefined },
      });
      expect(screen.getByTestId('ui-row').tagName).toBe(tag);
    }
  });

  it('a div/li row with an onclick gets synthesized button semantics and Enter/Space activation', async () => {
    const onclick = vi.fn();
    render(Row, { props: { children: textSnippet('Session'), as: 'li', onclick } });
    const row = screen.getByTestId('ui-row');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.tabIndex).toBe(0);

    await fireEvent.click(row);
    expect(onclick).toHaveBeenCalledTimes(1);

    await fireEvent.keyDown(row, { key: 'Enter' });
    expect(onclick).toHaveBeenCalledTimes(2);

    await fireEvent.keyDown(row, { key: ' ' });
    expect(onclick).toHaveBeenCalledTimes(3);
  });

  it('a native button/a row does not get a synthesized role/tabindex — it already owns keyboard activation', () => {
    const onclick = vi.fn();
    render(Row, { props: { children: textSnippet('x'), as: 'button', onclick } });
    const row = screen.getByTestId('ui-row');
    expect(row.hasAttribute('role')).toBe(false);
    expect(row.hasAttribute('tabindex')).toBe(false);
  });

  it("a trailing slot's own click never bubbles into the row's onclick (does not swallow it)", async () => {
    const rowOnclick = vi.fn();
    const trailingOnclick = vi.fn();

    render(Row, {
      props: {
        children: textSnippet('Session title'),
        as: 'li',
        onclick: rowOnclick,
        trailing: trailingActionSnippet(),
      },
    });

    const trailingEl = screen.getByTestId('trailing-action');
    trailingEl.addEventListener('click', trailingOnclick);

    await fireEvent.click(trailingEl);
    expect(trailingOnclick).toHaveBeenCalledTimes(1);
    expect(rowOnclick).not.toHaveBeenCalled();

    // Clicking the row itself, outside the trailing slot, still works.
    await fireEvent.click(screen.getByTestId('ui-row'));
    expect(rowOnclick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onclick, and marks itself disabled, when disabled', async () => {
    const onclick = vi.fn();
    render(Row, { props: { children: textSnippet('x'), as: 'button', onclick, disabled: true } });
    const row = screen.getByTestId('ui-row') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    await fireEvent.click(row);
    expect(onclick).not.toHaveBeenCalled();
  });

  it('applies the active/selected treatment', () => {
    render(Row, { props: { children: textSnippet('x'), active: true } });
    expect(screen.getByTestId('ui-row').classList.contains('ui-row-active')).toBe(true);
  });

  it('merges a caller-provided class, lets a caller override the data-testid, and passes through arbitrary data-*/aria-* attributes', () => {
    render(Row, {
      props: {
        children: textSnippet('x'),
        class: 'item',
        dataTestId: 'attention-inbox-item',
        'data-kind': 'permission',
      },
    });
    expect(screen.queryByTestId('ui-row')).toBeNull();
    const row = screen.getByTestId('attention-inbox-item');
    expect(row.classList.contains('item')).toBe(true);
    expect(row.getAttribute('data-kind')).toBe('permission');
  });
});
