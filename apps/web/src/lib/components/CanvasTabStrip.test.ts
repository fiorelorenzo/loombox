// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasTab } from '$lib/tabs.svelte';
import CanvasTabStrip from './CanvasTabStrip.svelte';

afterEach(() => cleanup());

const threeTabs: CanvasTab[] = [
  { kind: 'transcript', id: 'transcript' },
  { kind: 'file', id: 'src/a.ts', path: 'src/a.ts', name: 'a.ts' },
  { kind: 'file', id: 'src/b.ts', path: 'src/b.ts', name: 'b.ts' },
];

describe('CanvasTabStrip: wide layout', () => {
  it('renders the transcript tab first, permanently, alongside every open file tab', () => {
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: false,
      },
    });
    const tabs = screen.getAllByTestId('canvas-tab');
    expect(tabs).toHaveLength(3);
    expect(within(tabs[0]).getByText('Session')).toBeTruthy();
    expect(within(tabs[1]).getByText('a.ts')).toBeTruthy();
    expect(within(tabs[2]).getByText('b.ts')).toBeTruthy();
  });

  it('the transcript tab renders no close button; every file tab does', () => {
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: false,
      },
    });
    const tabs = screen.getAllByTestId('canvas-tab');
    expect(within(tabs[0]).queryByTestId('canvas-tab-close')).toBeNull();
    expect(within(tabs[1]).getByTestId('canvas-tab-close')).toBeTruthy();
    expect(within(tabs[2]).getByTestId('canvas-tab-close')).toBeTruthy();
  });

  it('clicking a tab activates it via onActivate, not onClose', async () => {
    const onActivate = vi.fn();
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate,
        onClose: vi.fn(),
        narrow: false,
      },
    });
    const tabs = screen.getAllByTestId('canvas-tab');
    await fireEvent.click(within(tabs[1]).getByTestId('canvas-tab-activate'));
    expect(onActivate).toHaveBeenCalledWith('src/a.ts');
  });

  it("clicking a file tab's close button calls onClose with that tab's id, not onActivate", async () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate,
        onClose,
        narrow: false,
      },
    });
    const tabs = screen.getAllByTestId('canvas-tab');
    await fireEvent.click(within(tabs[1]).getByTestId('canvas-tab-close'));
    expect(onClose).toHaveBeenCalledWith('src/a.ts');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('marks the active tab distinctly from the rest', () => {
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'src/a.ts',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: false,
      },
    });
    const tabs = screen.getAllByTestId('canvas-tab');
    expect(tabs[0].className).not.toContain('active');
    expect(tabs[1].className).toContain('active');
  });

  it('shows a dirty indicator only for a file tab the caller reports dirty', () => {
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: (path: string) => path === 'src/b.ts',
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: false,
      },
    });
    const tabs = screen.getAllByTestId('canvas-tab');
    expect(within(tabs[1]).queryByTestId('canvas-tab-dirty-dot')).toBeNull();
    expect(within(tabs[2]).getByTestId('canvas-tab-dirty-dot')).toBeTruthy();
  });
});

describe('CanvasTabStrip: narrow layout (issue #737 — below TABLET_VIEWPORT_BREAKPOINT_PX)', () => {
  it('shows only the active tab inline, never the full strip', () => {
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'src/a.ts',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: true,
      },
    });
    expect(screen.queryAllByTestId('canvas-tab')).toHaveLength(0);
    expect(screen.getByTestId('canvas-tab-strip-picker-trigger').textContent).toContain('a.ts');
  });

  it('the picker trigger opens a dialog listing every open tab', async () => {
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: true,
        reducedMotion: true,
      },
    });
    expect(screen.queryByTestId('canvas-tab-picker-list')).toBeNull();
    await fireEvent.click(screen.getByTestId('canvas-tab-strip-picker-trigger'));
    const items = screen.getAllByTestId('canvas-tab-picker-item');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Session');
    expect(items[1].textContent).toContain('a.ts');
    expect(items[2].textContent).toContain('b.ts');
  });

  it('picking a tab in the picker activates it and closes the picker', async () => {
    const onActivate = vi.fn();
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate,
        onClose: vi.fn(),
        narrow: true,
        reducedMotion: true,
      },
    });
    await fireEvent.click(screen.getByTestId('canvas-tab-strip-picker-trigger'));
    const items = screen.getAllByTestId('canvas-tab-picker-item');
    await fireEvent.click(items[2]);
    expect(onActivate).toHaveBeenCalledWith('src/b.ts');
    expect(screen.queryByTestId('canvas-tab-picker-list')).toBeNull();
  });

  it('renders an inline close button for the active tab only when it is a file, never for the transcript', () => {
    const { rerender } = render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'transcript',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose: vi.fn(),
        narrow: true,
      },
    });
    expect(screen.queryByTestId('canvas-tab-strip-close-active')).toBeNull();

    rerender({
      tabs: threeTabs,
      activeId: 'src/a.ts',
      isDirty: () => false,
      onActivate: vi.fn(),
      onClose: vi.fn(),
      narrow: true,
    });
    expect(screen.getByTestId('canvas-tab-strip-close-active')).toBeTruthy();
  });

  it("the active file tab's inline close button calls onClose with its id", async () => {
    const onClose = vi.fn();
    render(CanvasTabStrip, {
      props: {
        tabs: threeTabs,
        activeId: 'src/a.ts',
        isDirty: () => false,
        onActivate: vi.fn(),
        onClose,
        narrow: true,
      },
    });
    await fireEvent.click(screen.getByTestId('canvas-tab-strip-close-active'));
    expect(onClose).toHaveBeenCalledWith('src/a.ts');
  });
});
