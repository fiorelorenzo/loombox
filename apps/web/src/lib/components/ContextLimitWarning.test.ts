// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '@loombox/providers-core/browser';
import ContextLimitWarning from './ContextLimitWarning.svelte';

afterEach(() => cleanup());

const usageAt = (tokensUsed: number, attributedToSubagent = false): UsageRecord => ({
  sessionId: 's1',
  tokensUsed,
  contextWindow: 200_000,
  costUsd: 0.5,
  attributedToSubagent,
});

describe('ContextLimitWarning: threshold (SPEC §7.9; issue #250)', () => {
  it('renders nothing one percentage point below the threshold', () => {
    render(ContextLimitWarning, { props: { usage: usageAt(158_000) } });
    expect(screen.queryByTestId('context-limit-warning')).toBeNull();
  });

  it('renders the warning exactly at the threshold, citing the real reported percentage and token figures', () => {
    render(ContextLimitWarning, { props: { usage: usageAt(160_000) } });
    const warning = screen.getByTestId('context-limit-warning');
    expect(warning.textContent).toContain('80%');
    expect(warning.textContent).toContain('160,000');
    expect(warning.textContent).toContain('200,000');
  });
});

describe('ContextLimitWarning: absent data (issue #250 — never guessed)', () => {
  it('renders nothing when no usage_update has ever arrived for this session', () => {
    render(ContextLimitWarning, { props: { usage: undefined } });
    expect(screen.queryByTestId('context-limit-warning')).toBeNull();
  });

  it("renders nothing when the provider reports cost but never a context window (ACP's `size` is genuinely optional-in-practice — see contextFillPercent's own doc comment) — absent, not estimated", () => {
    render(ContextLimitWarning, {
      props: {
        usage: {
          sessionId: 's1',
          tokensUsed: undefined,
          contextWindow: undefined,
          costUsd: 1.2,
          attributedToSubagent: false,
        },
      },
    });
    expect(screen.queryByTestId('context-limit-warning')).toBeNull();
  });
});

describe('ContextLimitWarning: subagent exclusion (SPEC §7.9)', () => {
  it('still reflects the frozen parent figures during a subagent-attributed record — never hidden, never recomputed from the subagent numbers', () => {
    // `attributedToSubagent: true` records already carry the FROZEN parent
    // tokensUsed/contextWindow by the time they reach this component
    // (`transcript.ts`'s `reduceUsage` is where that freezing happens) —
    // this proves the component itself adds no second guess on top.
    render(ContextLimitWarning, { props: { usage: usageAt(170_000, true) } });
    const warning = screen.getByTestId('context-limit-warning');
    expect(warning.textContent).toContain('85%');
  });
});

describe('ContextLimitWarning: dismiss and re-arm (issue #250)', () => {
  it('dismisses on click, and re-arms once a later usage_update reports the session dropping back below the threshold — a later separate crossing shows fresh, not silenced', async () => {
    const { rerender } = render(ContextLimitWarning, { props: { usage: usageAt(170_000) } });
    expect(screen.getByTestId('context-limit-warning')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('context-limit-warning-dismiss'));
    expect(screen.queryByTestId('context-limit-warning')).toBeNull();

    // Still near the limit — dismissal holds through re-renders that don't
    // change the underlying crossing.
    await rerender({ usage: usageAt(171_000) });
    expect(screen.queryByTestId('context-limit-warning')).toBeNull();

    // Context frees up — a genuine later usage_update reporting fewer
    // tokens in context (e.g. after the agent's own auto-compaction).
    await rerender({ usage: usageAt(20_000) });
    expect(screen.queryByTestId('context-limit-warning')).toBeNull();

    // A later, SEPARATE crossing shows fresh rather than staying silenced
    // by the earlier dismissal.
    await rerender({ usage: usageAt(180_000) });
    expect(screen.getByTestId('context-limit-warning')).toBeTruthy();
  });
});
