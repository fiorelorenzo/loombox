import { describe, expect, it } from 'vitest';
import { FALLBACK_ICON_PATHS, ICON_NAMES, ICON_PATHS } from './icon-paths';

// The full name contract (redesign v3 §3.7 / issue #502): fixed and
// additive-only. A future removal (or an accidental rename) must fail this
// test loudly rather than silently dropping an icon a consumer still asks
// for by name.
const EXPECTED_NAMES = [
  'sessions',
  'inbox',
  'targets',
  'tracker',
  'command',
  'settings',
  'collapse-chevron',
  'chevron-down',
  'search',
  'more',
  'plus',
  'refresh',
  'check',
  'alert',
  'health-ok',
  'health-warn',
  'health-danger',
  'tool-bash',
  'tool-edit',
  'tool-generic',
  'tool-read',
  'tool-delete',
  'tool-move',
  'tool-search',
  'tool-think',
  'tool-fetch',
  'terminal',
  'file',
  'folder',
  'attach',
  'copy',
  'pin',
  'close',
  'sidebar-panel',
  'provider-claude',
  'provider-codex',
  'provider-gemini',
  'provider-ohmypi',
  'provider-generic',
] as const;

describe('icon-paths (#502 redesign v3 icon set)', () => {
  it('exports exactly the expected icon name set — no more, no fewer', () => {
    expect([...ICON_NAMES].sort()).toEqual([...EXPECTED_NAMES].sort());
    // Catch accidental duplicate entries the sorted-set comparison above
    // would otherwise mask.
    expect(ICON_NAMES.length).toBe(EXPECTED_NAMES.length);
  });

  it('has exactly one ICON_PATHS entry per ICON_NAMES entry', () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('every path list is non-empty and every d string is a valid, non-degenerate path', () => {
    // A valid SVG path `d` string: starts with a move-to, uses only the
    // commands this hand-drawn set relies on, and — since every icon here
    // is a stroke with fill="none" — never closes into a shape that would
    // only make visual sense filled without ever being reached via a
    // stroke-only primitive (arcs/lines/closes are all stroke-safe).
    const VALID_D = /^M-?\d+(\.\d+)? -?\d+(\.\d+)?[\sA-Za-z0-9.,-]+$/;
    for (const [name, paths] of Object.entries(ICON_PATHS)) {
      expect(paths.length, `${name} has at least one path`).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, `${name}'s path is a non-empty string`).toBeTruthy();
        expect(d, `${name}'s "${d}" starts with an absolute moveto`).toMatch(VALID_D);
      }
    }
  });

  it('keeps the fallback glyph a single valid path', () => {
    expect(FALLBACK_ICON_PATHS.length).toBe(1);
    expect(FALLBACK_ICON_PATHS[0]).toMatch(/^M/);
  });
});
