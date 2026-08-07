// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTabViewerState } from '$lib/tabs.svelte';
import FileEditor from './FileEditor.svelte';

afterEach(() => cleanup());

describe('FileEditor: loading/error states', () => {
  it('shows a loading indicator while the viewer is still loading', () => {
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: { status: 'loading' } satisfies FileTabViewerState,
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-editor-loading')).toBeTruthy();
    expect(screen.queryByTestId('file-editor-body')).toBeNull();
  });

  it("renders the node's own error message with a retry action wired to onRetry", async () => {
    const onRetry = vi.fn();
    render(FileEditor, {
      props: {
        path: 'src/missing.ts',
        name: 'missing.ts',
        viewer: { status: 'error', message: 'not found' } satisfies FileTabViewerState,
        onRetry,
        stale: false,
        onSave: vi.fn(),
      },
    });
    expect(screen.getByText('not found')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('FileEditor: rendering loaded content (view mode, unchanged from issue #737)', () => {
  it('renders the file path and the content as a code block, plain first then highlighted (#600 async highlighter)', async () => {
    const { container } = render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: {
          status: 'loaded',
          content: 'const x: number = 1;\n',
          truncated: false,
          hash: 'h1',
        } satisfies FileTabViewerState,
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-editor-path').textContent).toBe('src/foo.ts');
    expect(container.querySelector('pre code.language-js')).toBeTruthy();
    expect(container.textContent).toContain('const x: number = 1;');
    expect(container.querySelector('.hljs-keyword')).toBeNull();
    await vi.waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).toBeTruthy();
    });
  });

  it('shows a truncated notice, and no Edit button, only when the payload reports it', () => {
    const { rerender } = render(FileEditor, {
      props: {
        path: 'huge.txt',
        name: 'huge.txt',
        viewer: {
          status: 'loaded',
          content: 'x',
          truncated: true,
          hash: 'h1',
        } satisfies FileTabViewerState,
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    expect(screen.getByTestId('file-editor-truncated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    rerender({
      path: 'huge.txt',
      name: 'huge.txt',
      viewer: {
        status: 'loaded',
        content: 'x',
        truncated: false,
        hash: 'h1',
      } satisfies FileTabViewerState,
      onRetry: vi.fn(),
      stale: false,
      onSave: vi.fn(),
    });
    expect(screen.queryByTestId('file-editor-truncated')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('never renders content the file itself contains as literal HTML — the same sanitisation boundary transcript markdown gets', () => {
    const { container } = render(FileEditor, {
      props: {
        path: 'notes.txt',
        name: 'notes.txt',
        viewer: {
          status: 'loaded',
          content: '<script>alert(1)</script>',
          truncated: false,
          hash: 'h1',
        } satisfies FileTabViewerState,
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('offers a copy affordance for the loaded content only, revealed on hover like every other transcript surface', () => {
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: {
          status: 'loaded',
          content: 'x',
          truncated: false,
          hash: 'h1',
        } satisfies FileTabViewerState,
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    const button = screen.getByRole('button', { name: 'Copy foo.ts' });
    expect(button.className).toContain('copy-button-reveal');
  });
});

describe('FileEditor: light quick-edit and conflict-safe save (issue #205)', () => {
  function loaded(content: string, hash: string, truncated = false): FileTabViewerState {
    return { status: 'loaded', content, truncated, hash };
  }

  it('Edit swaps the highlighted view for a plain textarea seeded with the current content', async () => {
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    expect(screen.queryByTestId('file-editor-textarea')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByTestId('file-editor-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('original\n');
    expect(screen.queryByTestId('file-editor-body')).toBeNull();
  });

  it('Save calls onSave with the edited draft and the hash the file was opened at, then returns to view mode on ok', async () => {
    const onSave = vi.fn().mockResolvedValue({ outcome: 'ok', path: 'src/foo.ts', hash: 'h2' });
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry: vi.fn(),
        stale: false,
        onSave,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByTestId('file-editor-textarea') as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'edited\n' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('src/foo.ts', 'edited\n', 'h1');
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('file-editor-textarea')).toBeNull();
    });
    expect(screen.getByTestId('file-editor-body')).toBeTruthy();
  });

  it('a conflict outcome never overwrites: the draft stays in the textarea, unsaved, with a reload action — never a silent clobber', async () => {
    const onRetry = vi.fn();
    const onSave = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      path: 'src/foo.ts',
      current: { content: 'changed underneath\n', hash: 'h-real', truncated: false },
    });
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry,
        stale: false,
        onSave,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByTestId('file-editor-textarea') as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'my stale edit\n' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => {
      expect(screen.getByText(/changed on disk since you started editing/)).toBeTruthy();
    });
    // The draft is untouched — never silently replaced by what's on disk.
    expect((screen.getByTestId('file-editor-textarea') as HTMLTextAreaElement).value).toBe(
      'my stale edit\n',
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Reload latest version' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a conflict where the file was deleted underneath reports that distinctly (current: null)', async () => {
    const onSave = vi.fn().mockResolvedValue({
      outcome: 'conflict',
      path: 'src/foo.ts',
      current: null,
    });
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry: vi.fn(),
        stale: false,
        onSave,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => {
      expect(screen.getByText(/was deleted on disk since you started editing/)).toBeTruthy();
    });
  });

  it('an error outcome shows the message and never leaves edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue({
      outcome: 'error',
      path: 'src/foo.ts',
      message: 'permission denied',
    });
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry: vi.fn(),
        stale: false,
        onSave,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => {
      expect(screen.getByText(/Could not save foo.ts: permission denied/)).toBeTruthy();
    });
    expect(screen.getByTestId('file-editor-textarea')).toBeTruthy();
  });

  it('Cancel discards the draft and returns to the highlighted view, without calling onSave', async () => {
    const onSave = vi.fn();
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry: vi.fn(),
        stale: false,
        onSave,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByTestId('file-editor-textarea') as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'thrown away\n' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('file-editor-textarea')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('file-editor-body').textContent).toContain('original');
  });

  it('warns (but does not block) when the agent has edited this file since it was opened — the dirty tracking issue #737 already computes, reused not reinvented', async () => {
    render(FileEditor, {
      props: {
        path: 'src/foo.ts',
        name: 'foo.ts',
        viewer: loaded('original\n', 'h1'),
        onRetry: vi.fn(),
        stale: true,
        onSave: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/changed since you opened it/)).toBeTruthy();
    // Still editable and saveable — the warning is advisory, not a lock.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('switching to a different open tab (same mounted instance, new path/hash) discards any unsaved draft', async () => {
    const { rerender } = render(FileEditor, {
      props: {
        path: 'src/a.ts',
        name: 'a.ts',
        viewer: loaded('a content\n', 'h-a'),
        onRetry: vi.fn(),
        stale: false,
        onSave: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByTestId('file-editor-textarea') as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'unsaved a edit\n' } });

    rerender({
      path: 'src/b.ts',
      name: 'b.ts',
      viewer: loaded('b content\n', 'h-b'),
      onRetry: vi.fn(),
      stale: false,
      onSave: vi.fn(),
    });

    expect(screen.queryByTestId('file-editor-textarea')).toBeNull();
    expect(screen.getByTestId('file-editor-path').textContent).toBe('src/b.ts');
    expect(screen.getByTestId('file-editor-body').textContent).toContain('b content');
  });
});
