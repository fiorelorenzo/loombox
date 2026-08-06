// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTabViewerState } from '$lib/tabs.svelte';
import FileViewer from './FileViewer.svelte';

afterEach(() => cleanup());

describe('FileViewer: loading/error states', () => {
  it('shows a loading indicator while the viewer is still loading', () => {
    render(FileViewer, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: { status: 'loading' } satisfies FileTabViewerState,
        onRetry: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-viewer-loading')).toBeTruthy();
    expect(screen.queryByTestId('file-viewer-body')).toBeNull();
  });

  it("renders the node's own error message with a retry action wired to onRetry", async () => {
    const onRetry = vi.fn();
    render(FileViewer, {
      props: {
        path: 'src/missing.ts',
        name: 'missing.ts',
        viewer: { status: 'error', message: 'not found' } satisfies FileTabViewerState,
        onRetry,
      },
    });
    expect(screen.getByText('not found')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('FileViewer: rendering loaded content', () => {
  it('renders the file path and the content as a code block, plain first then highlighted (#600 async highlighter)', async () => {
    const { container } = render(FileViewer, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: {
          status: 'loaded',
          content: 'const x: number = 1;\n',
          truncated: false,
        } satisfies FileTabViewerState,
        onRetry: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-viewer-path').textContent).toBe('src/foo.ts');
    expect(container.querySelector('pre code.language-js')).toBeTruthy();
    expect(container.textContent).toContain('const x: number = 1;');
    expect(container.querySelector('.hljs-keyword')).toBeNull();
    await vi.waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).toBeTruthy();
    });
  });

  it('shows a truncated notice only when the payload reports it', () => {
    const { rerender } = render(FileViewer, {
      props: {
        path: 'huge.txt',
        name: 'huge.txt',
        viewer: { status: 'loaded', content: 'x', truncated: true } satisfies FileTabViewerState,
        onRetry: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-viewer-truncated')).toBeTruthy();

    rerender({
      path: 'huge.txt',
      name: 'huge.txt',
      viewer: { status: 'loaded', content: 'x', truncated: false } satisfies FileTabViewerState,
      onRetry: vi.fn(),
    });
    expect(screen.queryByTestId('file-viewer-truncated')).toBeNull();
  });

  it('never renders content the file itself contains as literal HTML — the same sanitisation boundary transcript markdown gets', () => {
    const { container } = render(FileViewer, {
      props: {
        path: 'notes.txt',
        name: 'notes.txt',
        viewer: {
          status: 'loaded',
          content: '<script>alert(1)</script>',
          truncated: false,
        } satisfies FileTabViewerState,
        onRetry: vi.fn(),
      },
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('offers a copy affordance for the loaded content only, revealed on hover like every other transcript surface', () => {
    render(FileViewer, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: { status: 'loaded', content: 'x', truncated: false } satisfies FileTabViewerState,
        onRetry: vi.fn(),
      },
    });
    const button = screen.getByRole('button', { name: 'Copy foo.ts' });
    expect(button.className).toContain('copy-button-reveal');
  });
});
