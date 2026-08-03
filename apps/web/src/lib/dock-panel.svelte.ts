/**
 * The shared behaviour behind every dock v6 wants — the left sidebar, the
 * right sidebar (#571) and the bottom terminal (#572) — per the design spec
 * (`docs/superpowers/specs/2026-08-03-cockpit-v6-design.md` §3.2) and issue
 * #570: open/closed, a size in px the user can drag, a min and a max, and
 * persistence. Before this module, exactly one of the three had it, hand-
 * written directly in `+page.svelte`. This module IS that behaviour,
 * extracted once so the other two docks are call sites, not rewrites.
 *
 * Deliberately a plain reactive class, not a component: the three docks
 * share no markup at all (the sidebar's brand+toggle header, a future right
 * sidebar's tab strip, a terminal's own toolbar have nothing visually in
 * common), so this owns only the state a call site's own template reads
 * (`open`, `size`, `dragging`, `effectiveSize`) and the pure mutators it
 * wires onto its own handle element (`startDrag`, `handleKeydown`, plus a
 * plain `toggle()`/`open =`/`size =` for whatever else opens or resizes the
 * dock). It never renders anything and never touches CSS beyond the one
 * value (`dragging`) a call site needs to suppress its own width/height
 * `transition` while a drag is in flight.
 */

/** Which edge of the viewport a dock is anchored to — decides the drag axis (`left`/`right` resize horizontally off `clientX`, `bottom` resizes vertically off `clientY`) and which arrow keys grow it. */
export type DockEdge = 'left' | 'right' | 'bottom';

export interface DockPanelState {
  open: boolean;
  size: number;
}

/**
 * Where one `DockPanel` instance's `{ open, size }` persists between
 * reloads. Injectable, the same convention as `notification-preferences.ts`/
 * `auth-store.ts`/`amk-store.ts`: a real call site supplies its own
 * `localStorage`-backed adapter (the left sidebar's own keeps the exact
 * `loombox:sessions-width`/`loombox:sessions-collapsed` keys the hand-
 * written version used, so an existing user's sidebar is not silently
 * reset), and a test supplies an in-memory one.
 *
 * `load()` returns a PARTIAL state — `open` and `size` restore
 * independently, exactly like the hand-written version did (a device that
 * has only ever persisted one of the two, e.g. from an older build, leaves
 * the other at this instance's constructor default rather than at some
 * arbitrary fallback) — and `undefined` for "nothing stored yet".
 */
export interface DockPanelPersistence {
  load(): Partial<DockPanelState> | undefined;
  save(state: DockPanelState): void;
}

export interface DockPanelOptions {
  edge: DockEdge;
  /** Initial open state, used until/unless `restore()` finds a persisted one. */
  open: boolean;
  /** Initial size in px, clamped to `[min, max]` immediately, used until/unless `restore()` finds a persisted one. */
  size: number;
  min: number;
  max: number;
  /** The size rendered while `open` is `false` — a rail (the sidebar's 56px selvage), not necessarily a fully hidden panel; a call site that wants "closed" to mean "gone" passes `0`. */
  collapsedSize: number;
  /** Arrow-key resize increment, in px. Defaults to 16 — the sidebar's own existing step. */
  keyboardStep?: number;
  persistence?: DockPanelPersistence;
  /**
   * Live gate mirroring `+page.svelte`'s own `preferencesRestored`: every
   * write this instance makes is suppressed until this returns `true`, so a
   * dock that mounts and gets its default state before its host has
   * finished restoring every persisted preference can never clobber a
   * not-yet-read value with that compile-time default. Read fresh on every
   * write (never snapshotted), since the flag flips once, well after
   * construction — call `restore()` before flipping it, same order the
   * hand-written version's `onMount` used. Defaults to `() => true`, for a
   * call site with nothing else in flight to race.
   */
  restored?: () => boolean;
}

export class DockPanel {
  readonly edge: DockEdge;
  readonly min: number;
  readonly max: number;
  readonly collapsedSize: number;

  #open = $state(false);
  #size = $state(0);
  /** True only while a drag is in flight — a call site binds this (mirrors the sidebar's own former `sessionsResizing`) to suppress its size `transition` so the panel tracks the pointer instead of visibly lagging behind it. */
  #dragging = $state(false);

  private readonly keyboardStep: number;
  private readonly persistence: DockPanelPersistence | undefined;
  private readonly restoredGate: () => boolean;
  /** The arrow keys that grow/shrink this edge's size — always the key that visually points AWAY from the panel, toward where dragging its own handle would grow it: `ArrowRight` for `left`, `ArrowLeft` for `right`, `ArrowUp` for `bottom`. */
  private readonly growKey: string;
  private readonly shrinkKey: string;

  private dragStartPos = 0;
  private dragStartSize = 0;

  constructor(options: DockPanelOptions) {
    this.edge = options.edge;
    this.min = options.min;
    this.max = options.max;
    this.collapsedSize = options.collapsedSize;
    this.keyboardStep = options.keyboardStep ?? 16;
    this.persistence = options.persistence;
    this.restoredGate = options.restored ?? (() => true);
    if (this.edge === 'left') {
      this.growKey = 'ArrowRight';
      this.shrinkKey = 'ArrowLeft';
    } else if (this.edge === 'right') {
      this.growKey = 'ArrowLeft';
      this.shrinkKey = 'ArrowRight';
    } else {
      this.growKey = 'ArrowUp';
      this.shrinkKey = 'ArrowDown';
    }

    this.#open = options.open;
    this.#size = this.clamp(options.size);
  }

  get open(): boolean {
    return this.#open;
  }

  set open(value: boolean) {
    this.#open = value;
    this.persist();
  }

  get size(): number {
    return this.#size;
  }

  set size(value: number) {
    this.#size = this.clamp(value);
    this.persist();
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  /** The size a call site should actually render: `size` while `open`, `collapsedSize` while not. */
  get effectiveSize(): number {
    return this.#open ? this.#size : this.collapsedSize;
  }

  /** `vertical` for a `left`/`right` dock (a vertical divider that resizes width), `horizontal` for a `bottom` one (a horizontal divider that resizes height) — the WAI-ARIA APG "Window Splitter" pattern's own `aria-orientation`, for a call site's handle element. */
  get ariaOrientation(): 'vertical' | 'horizontal' {
    return this.edge === 'bottom' ? 'horizontal' : 'vertical';
  }

  toggle(): void {
    this.open = !this.#open;
  }

  /**
   * Applies whatever this instance's `persistence` has stored, if anything.
   * Call once, from the host's own restore sequence, BEFORE it flips the
   * flag its `restored` gate reads to `true` — mirrors the hand-written
   * sidebar's own `onMount` order exactly, so this never writes back the
   * value it just read (the gate is still closed while this runs) and never
   * races a later persisted write with a stale default.
   */
  restore(): void {
    const stored = this.persistence?.load();
    if (!stored) return;
    if (stored.open !== undefined) this.#open = stored.open;
    if (stored.size !== undefined) this.#size = this.clamp(stored.size);
  }

  /**
   * Starts a drag-resize from this dock's own handle. Pointer Events with
   * `setPointerCapture` directly on the handle (same as the sidebar's
   * original `startSessionsResize`), so the temporary move/up listeners
   * live and die with the drag itself — no `window`-level listener to
   * remember to remove. An arrow-function field (not a prototype method) so
   * a call site can wire it directly — `onpointerdown={panel.startDrag}` —
   * without losing `this`.
   */
  startDrag = (event: PointerEvent): void => {
    if (!this.#open || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.#dragging = true;
    this.dragStartPos = this.axisPos(event);
    this.dragStartSize = this.#size;

    const onMove = (moveEvent: PointerEvent): void => {
      this.size = this.dragStartSize + (this.axisPos(moveEvent) - this.dragStartPos);
    };
    const onUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      this.#dragging = false;
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  /**
   * Keyboard-accessible resize (arrow keys, when the handle itself has
   * focus) — the same affordance as `startDrag`, without a pointer. An
   * arrow-function field for the same reason `startDrag` is one.
   */
  handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === this.growKey) {
      event.preventDefault();
      this.size = this.#size + this.keyboardStep;
    } else if (event.key === this.shrinkKey) {
      event.preventDefault();
      this.size = this.#size - this.keyboardStep;
    }
  };

  private clamp(px: number): number {
    return Math.min(this.max, Math.max(this.min, px));
  }

  private persist(): void {
    if (!this.persistence || !this.restoredGate()) return;
    this.persistence.save({ open: this.#open, size: this.#size });
  }

  /** The signed pointer-position delta that GROWS this edge's dock: `left`/`right` read `clientX`, `bottom` reads `clientY`; `right`/`bottom` invert the sign, since their handle sits on the dock's OWN top/left edge, where growing it means dragging the pointer the opposite way a `left` edge's handle does. */
  private axisPos(event: { clientX: number; clientY: number }): number {
    const raw = this.edge === 'bottom' ? event.clientY : event.clientX;
    return this.edge === 'left' ? raw : -raw;
  }
}
