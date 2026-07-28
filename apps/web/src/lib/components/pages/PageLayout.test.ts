// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PageLayout from './PageLayout.svelte';

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('PageLayout (design spec v4 §3.3, coherence v5 §2, issue #507)', () => {
  it('renders the title as a real h1, the testid on the page root, and the wrapped children', () => {
    render(PageLayout, {
      props: { title: 'Inbox', testid: 'inbox-page', children: textSnippet('panel content') },
    });

    expect(screen.getByRole('heading', { name: 'Inbox', level: 1 })).toBeTruthy();
    expect(screen.getByTestId('inbox-page')).toBeTruthy();
    expect(screen.getByText('panel content')).toBeTruthy();
  });

  it('omits the actions cluster entirely when none is passed', () => {
    const { container } = render(PageLayout, {
      props: { title: 'Inbox', testid: 'inbox-page', children: textSnippet('panel content') },
    });

    expect(container.querySelector('.page-header-actions')).toBeNull();
  });

  it('renders a caller-supplied actions snippet beside the title', () => {
    render(PageLayout, {
      props: {
        title: 'Nodes',
        testid: 'nodes-page',
        actions: textSnippet('Add target'),
        children: textSnippet('panel content'),
      },
    });

    expect(screen.getByText('Add target')).toBeTruthy();
  });

  it('has no close affordance: design spec v4 §3.3 leaves a page by navigating elsewhere', () => {
    render(PageLayout, {
      props: { title: 'Settings', testid: 'settings-page', children: textSnippet('panel content') },
    });

    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });
});
