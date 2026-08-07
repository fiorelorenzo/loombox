import { describe, expect, it } from 'vitest';

import {
  CHROME_BADGE_ELEMENT_ID,
  buildChromeBadgeCss,
  buildChromeBadgeScript,
} from './chrome-badge';

describe('buildChromeBadgeCss', () => {
  it('targets the badge element id, fixed to the top and above any page content', () => {
    const css = buildChromeBadgeCss();
    expect(css).toContain(`#${CHROME_BADGE_ELEMENT_ID}`);
    expect(css).toContain('position: fixed');
    expect(css).toContain('top: 0');
  });

  it('is non-interactive, so it never steals a click meant for the PWA underneath', () => {
    expect(buildChromeBadgeCss()).toContain('pointer-events: none');
  });
});

describe('buildChromeBadgeScript', () => {
  it('embeds the given label as the element text', () => {
    const script = buildChromeBadgeScript('PREVIEW BUILD');
    expect(script).toContain(JSON.stringify('PREVIEW BUILD'));
    expect(script).toContain('.textContent =');
  });

  it('creates the element once and reuses it on a later call — no duplicate ribbons across navigations', () => {
    const script = buildChromeBadgeScript('PREVIEW BUILD');
    expect(script).toContain(`getElementById(id)`);
    expect(script).toContain('if (!el)');
  });

  it('safely escapes a label containing quotes and script-breaking characters', () => {
    const script = buildChromeBadgeScript('PREVIEW "</script>" <img onerror=alert(1)>');
    // JSON.stringify produces a single JS string literal — parsing it back
    // out proves nothing breaks out of the intended expression.
    const match = script.match(/el\.textContent = (".*");/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toBe('PREVIEW "</script>" <img onerror=alert(1)>');
  });
});
