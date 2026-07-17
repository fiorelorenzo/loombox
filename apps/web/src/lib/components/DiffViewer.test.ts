// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import DiffViewer from './DiffViewer.svelte';

afterEach(() => cleanup());

describe('DiffViewer', () => {
  it('renders added and removed lines for a text diff', () => {
    render(DiffViewer, {
      props: { path: 'src/foo.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc' },
    });

    expect(screen.getByText('src/foo.ts')).toBeTruthy();
    const removedRow = screen.getByText('b').closest('li');
    const addedRow = screen.getByText('B').closest('li');
    expect(removedRow?.className).toContain('removed');
    expect(addedRow?.className).toContain('added');
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });

  it('renders a structural-only card, not a blank one, when there is no patch text (binary/symlink change)', () => {
    render(DiffViewer, { props: { path: 'assets/logo.png', oldText: null, newText: '' } });

    expect(screen.getByTestId('structural-diff').textContent).toContain('assets/logo.png');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('treats a null oldText (new file) as every line added', () => {
    render(DiffViewer, { props: { path: 'src/new.ts', oldText: null, newText: 'x\ny' } });
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.className.includes('added'))).toBe(true);
  });
});
