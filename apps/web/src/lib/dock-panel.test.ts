import { describe, expect, it, vi } from 'vitest';
import {
  DockPanel,
  type DockPanelOptions,
  type DockPanelPersistence,
  type DockPanelState,
} from './dock-panel.svelte';

/** A bare-minimum fake of the handle element `startDrag` calls `setPointerCapture`/`addEventListener` on — no jsdom needed, since this module never touches the DOM itself. */
function createFakeHandle() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    fire(type: string, event: unknown) {
      listeners.get(type)?.(event);
    },
  };
}

function fakePointerDown(
  handle: ReturnType<typeof createFakeHandle>,
  over: Partial<PointerEvent> = {},
) {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    currentTarget: handle,
    preventDefault: vi.fn(),
    ...over,
  } as unknown as PointerEvent;
}

function fakeKeydown(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

/** An in-memory `DockPanelPersistence`, plus the `restored` closure `preferencesRestored`-style gates take — flip `.restored` to simulate the host finishing its own restore sequence. */
function createFakePersistence() {
  let stored: Partial<DockPanelState> | undefined;
  const save = vi.fn((state: DockPanelState) => {
    stored = state;
  });
  const persistence: DockPanelPersistence = {
    load: () => stored,
    save,
  };
  return { persistence, save, seed: (state: Partial<DockPanelState>) => (stored = state) };
}

function makePanel(overrides: Partial<DockPanelOptions> = {}) {
  return new DockPanel({
    edge: 'left',
    open: true,
    size: 288,
    min: 200,
    max: 440,
    collapsedSize: 56,
    ...overrides,
  });
}

describe('DockPanel clamping', () => {
  it('clamps a size below min up to min', () => {
    const panel = makePanel();
    panel.size = 50;
    expect(panel.size).toBe(200);
  });

  it('clamps a size above max down to max', () => {
    const panel = makePanel();
    panel.size = 9999;
    expect(panel.size).toBe(440);
  });

  it('clamps the constructor size too, for a caller that passes an already out-of-range default', () => {
    const panel = makePanel({ size: 1000 });
    expect(panel.size).toBe(440);
  });

  it('keyboard resize clamps at both ends', () => {
    const panel = makePanel({ size: 430 });
    for (let i = 0; i < 5; i++) panel.handleKeydown(fakeKeydown('ArrowRight'));
    expect(panel.size).toBe(440);

    const shrinking = makePanel({ size: 210 });
    for (let i = 0; i < 5; i++) shrinking.handleKeydown(fakeKeydown('ArrowLeft'));
    expect(shrinking.size).toBe(200);
  });

  it('drag resize clamps at both ends', () => {
    const panel = makePanel({ size: 288 });
    const handle = createFakeHandle();
    panel.startDrag(fakePointerDown(handle, { clientX: 100 }));
    handle.fire('pointermove', { clientX: 100 + 10_000 });
    expect(panel.size).toBe(440);
    handle.fire('pointermove', { clientX: 100 - 10_000 });
    expect(panel.size).toBe(200);
  });
});

describe('DockPanel persistence', () => {
  it('writes through open and size once restored is true', () => {
    const { persistence, save } = createFakePersistence();
    const panel = makePanel({ persistence, restored: () => true });

    panel.size = 320;
    expect(save).toHaveBeenLastCalledWith({ open: true, size: 320 });

    panel.open = false;
    expect(save).toHaveBeenLastCalledWith({ open: false, size: 320 });
  });

  it('restores a previously persisted open/size pair', () => {
    const { persistence, seed } = createFakePersistence();
    seed({ open: false, size: 260 });
    const panel = makePanel({ persistence });

    panel.restore();

    expect(panel.open).toBe(false);
    expect(panel.size).toBe(260);
  });

  it('restores a clamped size, and each field independently when only one was ever persisted', () => {
    const { persistence, seed } = createFakePersistence();
    seed({ size: 9999 }); // no `open` in the stored value at all
    const panel = makePanel({ persistence, open: true });

    panel.restore();

    expect(panel.size).toBe(440); // clamped
    expect(panel.open).toBe(true); // untouched, still the constructor default
  });

  it('is a no-op when nothing has ever been persisted', () => {
    const { persistence, save } = createFakePersistence();
    const panel = makePanel({ persistence, open: true, size: 288 });

    panel.restore();

    expect(panel.open).toBe(true);
    expect(panel.size).toBe(288);
    expect(save).not.toHaveBeenCalled();
  });

  it('never races: a write before the host finishes restoring is dropped, restore() itself never persists, and every later write persists normally', () => {
    let hostRestored = false;
    const { persistence, save, seed } = createFakePersistence();
    seed({ open: false, size: 260 });
    const panel = makePanel({ persistence, restored: () => hostRestored });

    // A mutation that lands before the host's own restore sequence finishes
    // (e.g. some other reactive default assignment racing this instance)
    // must never overwrite the persisted value with it.
    panel.size = 999;
    expect(save).not.toHaveBeenCalled();

    // The host's own restore step, run before it flips its gate — must not
    // write back the value it just read either.
    panel.restore();
    expect(save).not.toHaveBeenCalled();
    expect(panel.open).toBe(false);
    expect(panel.size).toBe(260);

    // Only once the host flips its gate does this instance start persisting.
    hostRestored = true;
    panel.size = 300;
    expect(save).toHaveBeenCalledExactlyOnceWith({ open: false, size: 300 });
  });
});

describe('DockPanel collapsed/expanded transition', () => {
  it('toggle() flips open, and effectiveSize follows it between size and collapsedSize', () => {
    const panel = makePanel({ open: true, size: 300, collapsedSize: 56 });
    expect(panel.effectiveSize).toBe(300);

    panel.toggle();
    expect(panel.open).toBe(false);
    expect(panel.effectiveSize).toBe(56);

    panel.toggle();
    expect(panel.open).toBe(true);
    expect(panel.effectiveSize).toBe(300);
  });

  it('collapsing does not forget the last dragged-to size', () => {
    const panel = makePanel({ open: true, size: 288 });
    panel.size = 400;
    panel.toggle(); // collapse
    expect(panel.effectiveSize).toBe(56);
    panel.toggle(); // expand
    expect(panel.effectiveSize).toBe(400);
  });

  it('dragging is true only while a drag is in flight', () => {
    const panel = makePanel();
    const handle = createFakeHandle();
    expect(panel.dragging).toBe(false);

    panel.startDrag(fakePointerDown(handle));
    expect(panel.dragging).toBe(true);

    handle.fire('pointerup', { pointerId: 1 });
    expect(panel.dragging).toBe(false);
  });

  it('a closed panel ignores a drag start on its own handle', () => {
    const panel = makePanel({ open: false, size: 288 });
    const handle = createFakeHandle();
    panel.startDrag(fakePointerDown(handle));
    expect(panel.dragging).toBe(false);
  });

  it('a non-primary pointer button never starts a drag', () => {
    const panel = makePanel();
    const handle = createFakeHandle();
    panel.startDrag(fakePointerDown(handle, { button: 2 }));
    expect(panel.dragging).toBe(false);
  });
});

describe('DockPanel edge-aware drag and keyboard direction', () => {
  it('left edge: dragging right grows it, ArrowRight grows it', () => {
    const panel = makePanel({ edge: 'left', size: 288 });
    const handle = createFakeHandle();
    panel.startDrag(fakePointerDown(handle, { clientX: 100 }));
    handle.fire('pointermove', { clientX: 140 });
    expect(panel.size).toBe(328);

    const kb = makePanel({ edge: 'left', size: 288 });
    kb.handleKeydown(fakeKeydown('ArrowRight'));
    expect(kb.size).toBe(304);
    kb.handleKeydown(fakeKeydown('ArrowLeft'));
    expect(kb.size).toBe(288);
  });

  it('right edge: dragging left grows it (handle sits on its own left edge), ArrowLeft grows it', () => {
    const panel = makePanel({ edge: 'right', min: 200, max: 440, size: 288 });
    const handle = createFakeHandle();
    panel.startDrag(fakePointerDown(handle, { clientX: 100 }));
    handle.fire('pointermove', { clientX: 60 }); // moved left by 40
    expect(panel.size).toBe(328);

    const kb = makePanel({ edge: 'right', min: 200, max: 440, size: 288 });
    kb.handleKeydown(fakeKeydown('ArrowLeft'));
    expect(kb.size).toBe(304);
    kb.handleKeydown(fakeKeydown('ArrowRight'));
    expect(kb.size).toBe(288);
  });

  it('bottom edge: dragging up grows it (handle sits on its own top edge), ArrowUp grows it', () => {
    const panel = makePanel({ edge: 'bottom', min: 120, max: 480, size: 240, collapsedSize: 0 });
    const handle = createFakeHandle();
    panel.startDrag(fakePointerDown(handle, { clientY: 500 }));
    handle.fire('pointermove', { clientY: 460 }); // moved up by 40
    expect(panel.size).toBe(280);

    const kb = makePanel({ edge: 'bottom', min: 120, max: 480, size: 240, collapsedSize: 0 });
    kb.handleKeydown(fakeKeydown('ArrowUp'));
    expect(kb.size).toBe(256);
    kb.handleKeydown(fakeKeydown('ArrowDown'));
    expect(kb.size).toBe(240);
  });

  it('aria-orientation is vertical for left/right docks, horizontal for a bottom one', () => {
    expect(makePanel({ edge: 'left' }).ariaOrientation).toBe('vertical');
    expect(makePanel({ edge: 'right' }).ariaOrientation).toBe('vertical');
    expect(makePanel({ edge: 'bottom' }).ariaOrientation).toBe('horizontal');
  });
});

describe('DockPanel keyboard path ignores unrelated keys', () => {
  it('does not resize or call preventDefault on an unrelated key', () => {
    const panel = makePanel({ size: 288 });
    const event = fakeKeydown('Enter');
    panel.handleKeydown(event);
    expect(panel.size).toBe(288);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
