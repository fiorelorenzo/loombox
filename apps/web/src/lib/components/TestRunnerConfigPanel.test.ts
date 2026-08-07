// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestRunnerCommandsV1 } from '@loombox/protocol';
import TestRunnerConfigPanel, { type TestRunnerConfigClient } from './TestRunnerConfigPanel.svelte';

afterEach(() => cleanup());

function fakeClient(overrides: Partial<TestRunnerConfigClient> = {}): TestRunnerConfigClient {
  return {
    getTestRunnerConfig: vi.fn().mockResolvedValue({}),
    setTestRunnerConfig: vi.fn().mockResolvedValue({}),
    detectTestRunnerConfig: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('TestRunnerConfigPanel (issue #245)', () => {
  it('shows an empty state instead of fetching anything when there is no active session', () => {
    const client = fakeClient();
    render(TestRunnerConfigPanel, { props: { projectPath: '/proj-a', client } });

    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
    expect(client.getTestRunnerConfig).not.toHaveBeenCalled();
  });

  it('loads and displays the saved commands for the active session', async () => {
    const saved: TestRunnerCommandsV1 = { test: 'pnpm test', lint: 'pnpm lint' };
    const client = fakeClient({ getTestRunnerConfig: vi.fn().mockResolvedValue(saved) });
    render(TestRunnerConfigPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() => expect(client.getTestRunnerConfig).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => {
      expect((screen.getByTestId('test-runner-test-input') as HTMLInputElement).value).toBe(
        'pnpm test',
      );
      expect((screen.getByTestId('test-runner-lint-input') as HTMLInputElement).value).toBe(
        'pnpm lint',
      );
    });
  });

  it('saving a field calls setTestRunnerConfig with only that key and shows the merged result back', async () => {
    const client = fakeClient({
      setTestRunnerConfig: vi.fn().mockResolvedValue({ build: 'pnpm build' }),
    });
    render(TestRunnerConfigPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    const input = (await screen.findByTestId('test-runner-build-input')) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'pnpm build' } });
    await fireEvent.click(screen.getByTestId('test-runner-build-save'));

    await waitFor(() =>
      expect(client.setTestRunnerConfig).toHaveBeenCalledWith('sess-1', { build: 'pnpm build' }),
    );
  });

  it('never saves silently: a detected suggestion is shown but not persisted until Accept is clicked', async () => {
    const client = fakeClient({
      detectTestRunnerConfig: vi.fn().mockResolvedValue({ test: 'pnpm test' }),
    });
    render(TestRunnerConfigPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await fireEvent.click(screen.getByTestId('test-runner-detect'));

    await waitFor(() => expect(screen.getByTestId('test-runner-test-suggestion')).toBeTruthy());
    expect(client.setTestRunnerConfig).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('test-runner-test-accept'));

    await waitFor(() =>
      expect(client.setTestRunnerConfig).toHaveBeenCalledWith('sess-1', { test: 'pnpm test' }),
    );
  });

  it('surfaces a load failure through ErrorNotice rather than hanging or throwing', async () => {
    const client = fakeClient({
      getTestRunnerConfig: vi.fn().mockRejectedValue(new Error('node unreachable')),
    });
    render(TestRunnerConfigPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    await waitFor(() =>
      expect(screen.getByTestId('ui-error-notice').textContent).toContain('node unreachable'),
    );
  });

  it('a node that never answers reads as "The runner config didn\'t answer in time...", never the raw wire message (issue #650)', async () => {
    const client = fakeClient({
      getTestRunnerConfig: vi
        .fn()
        .mockRejectedValue(
          new Error('RelayClient: timed out waiting for test_runner_config_result'),
        ),
    });
    render(TestRunnerConfigPanel, {
      props: { projectPath: '/proj-a', sessionId: 'sess-1', client },
    });

    const notice = await waitFor(() => screen.getByTestId('ui-error-notice'));
    expect(notice.textContent).not.toContain('test_runner_config_result');
    expect(notice.textContent).toContain("The runner config didn't answer in time.");
  });
});
