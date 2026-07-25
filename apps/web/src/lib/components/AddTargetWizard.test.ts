// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProvisionTargetResult,
  SshDiscoveryResultV1,
  TargetListEntry,
} from '$lib/relay-client';
import AddTargetWizard, { type AddTargetClient } from './AddTargetWizard.svelte';

afterEach(() => {
  cleanup();
  delete (window as { loombox?: unknown }).loombox;
});

const NODES: TargetListEntry[] = [
  { nodeId: 'node_1', targetId: 'local', label: 'This machine', kind: 'local', reachable: true },
];

function provisionResult(overrides: Partial<ProvisionTargetResult> = {}): ProvisionTargetResult {
  return {
    type: 'provision_target_result',
    protocolVersion: 1,
    requestId: 'req-1',
    nodeId: 'node_1',
    targetId: 'ssh:devbox-1',
    ok: true,
    message: 'paired',
    ...overrides,
  };
}

/** No candidates by default — every pre-existing test in this file exercises the manual-entry form exactly as before #475 added the candidate picker. */
const NO_CANDIDATES: SshDiscoveryResultV1 = {
  outcome: 'ok',
  candidates: [],
  agent: { available: false, identities: [] },
  requiresManualEntry: true,
};

function fakeClient(overrides: Partial<AddTargetClient> = {}): AddTargetClient {
  return {
    listTargets: vi.fn().mockResolvedValue(NODES),
    provisionTarget: vi.fn().mockResolvedValue(provisionResult()),
    discoverSshHosts: vi.fn().mockResolvedValue(NO_CANDIDATES),
    ...overrides,
  };
}

async function fillHostAndReview(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('add-target-host')).toBeTruthy());
  await fireEvent.input(screen.getByTestId('add-target-host'), {
    target: { value: '10.0.0.5' },
  });
  await fireEvent.click(screen.getByTestId('add-target-next'));
  await waitFor(() => expect(screen.getByTestId('add-target-review')).toBeTruthy());
}

describe('AddTargetWizard (issue #408)', () => {
  it('is not rendered while closed', () => {
    render(AddTargetWizard, { props: { open: false, client: fakeClient(), onClose: vi.fn() } });
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('shows the no-nodes empty state with clear guidance when listTargets resolves empty', async () => {
    const client = fakeClient({ listTargets: vi.fn().mockResolvedValue([]) });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });

    await waitFor(() => expect(screen.getByTestId('add-target-no-nodes')).toBeTruthy());
    expect(screen.getByTestId('add-target-no-nodes').textContent).toMatch(
      /you need at least one node first/i,
    );
    expect(screen.getByTestId('add-target-no-nodes').textContent).toMatch(/mac app|local node/i);
  });

  it('starts on the host-picker step once at least one node is found', async () => {
    render(AddTargetWizard, { props: { open: true, client: fakeClient(), onClose: vi.fn() } });
    await waitFor(() => expect(screen.getByTestId('add-target-host')).toBeTruthy());
  });

  it('Next is disabled until a host is entered, then moves to the review step', async () => {
    render(AddTargetWizard, { props: { open: true, client: fakeClient(), onClose: vi.fn() } });
    await waitFor(() => expect(screen.getByTestId('add-target-host')).toBeTruthy());

    const next = screen.getByTestId('add-target-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    await fireEvent.input(screen.getByTestId('add-target-host'), {
      target: { value: '10.0.0.5' },
    });
    expect(next.disabled).toBe(false);

    await fireEvent.click(next);
    await waitFor(() => expect(screen.getByTestId('add-target-review')).toBeTruthy());
    expect(screen.getByTestId('add-target-review').textContent).toContain('10.0.0.5');
  });

  it('the review step shows the single explicit confirmation before anything runs', async () => {
    const client = fakeClient();
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });
    await fillHostAndReview();

    expect(screen.getByTestId('add-target-review').textContent).toMatch(
      /this will install a loombox node on/i,
    );
    expect(client.provisionTarget).not.toHaveBeenCalled();
  });

  it('Back from review returns to the host-picker step without provisioning', async () => {
    const client = fakeClient();
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });
    await fillHostAndReview();

    await fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(screen.getByTestId('add-target-host')).toBeTruthy());
    expect(client.provisionTarget).not.toHaveBeenCalled();
  });

  it('confirming calls provisionTarget with the acting nodeId and host, and streams progress via WovenLoader', async () => {
    let resolveProvision: (result: ProvisionTargetResult) => void = () => {};
    const client = fakeClient({
      provisionTarget: vi.fn(
        () =>
          new Promise<ProvisionTargetResult>((resolve) => {
            resolveProvision = resolve;
          }),
      ),
    });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });
    await fillHostAndReview();

    await fireEvent.click(screen.getByTestId('add-target-confirm'));

    await waitFor(() => expect(screen.getByTestId('add-target-progress')).toBeTruthy());
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
    expect(client.provisionTarget).toHaveBeenCalledTimes(1);
    const call = (client.provisionTarget as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.nodeId).toBe('node_1');
    expect(call.host).toEqual({
      host: '10.0.0.5',
      user: undefined,
      port: undefined,
      alias: undefined,
      label: undefined,
    });
    expect(typeof call.targetId).toBe('string');
    expect(call.targetId.length).toBeGreaterThan(0);

    resolveProvision(provisionResult({ targetId: call.targetId }));
    await waitFor(() => expect(screen.getByTestId('add-target-success')).toBeTruthy());
  });

  it('renders each provision_progress step as it streams in', async () => {
    let capturedOnProgress: ((progress: unknown) => void) | undefined;
    let resolveProvision: (result: ProvisionTargetResult) => void = () => {};
    const client = fakeClient({
      provisionTarget: vi.fn((options) => {
        capturedOnProgress = options.onProgress;
        return new Promise<ProvisionTargetResult>((resolve) => {
          resolveProvision = resolve;
        });
      }),
    });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });
    await fillHostAndReview();
    await fireEvent.click(screen.getByTestId('add-target-confirm'));
    await waitFor(() => expect(capturedOnProgress).toBeDefined());

    capturedOnProgress?.({
      step: 'verify_and_persist',
      status: 'started',
      message: 'verifying',
    });
    await waitFor(() =>
      expect(screen.getByTestId('add-target-progress').textContent).toContain('started'),
    );

    resolveProvision(provisionResult());
  });

  it('a successful result shows the done state and fires onProvisioned with the new targetId', async () => {
    const onProvisioned = vi.fn();
    const client = fakeClient();
    render(AddTargetWizard, {
      props: { open: true, client, onClose: vi.fn(), onProvisioned },
    });
    await fillHostAndReview();
    await fireEvent.click(screen.getByTestId('add-target-confirm'));

    await waitFor(() => expect(screen.getByTestId('add-target-success')).toBeTruthy());
    expect(onProvisioned).toHaveBeenCalledWith('ssh:devbox-1');
  });

  it('a failed result (ok: false) shows the step it stopped at, without calling onProvisioned', async () => {
    const onProvisioned = vi.fn();
    const client = fakeClient({
      provisionTarget: vi
        .fn()
        .mockResolvedValue(
          provisionResult({ ok: false, failedStep: 'mint_node_token', message: 'mint failed' }),
        ),
    });
    render(AddTargetWizard, {
      props: { open: true, client, onClose: vi.fn(), onProvisioned },
    });
    await fillHostAndReview();
    await fireEvent.click(screen.getByTestId('add-target-confirm'));

    await waitFor(() => expect(screen.getByTestId('add-target-failure')).toBeTruthy());
    expect(screen.getByTestId('add-target-failure').textContent).toMatch(/mint failed/);
    expect(screen.getByTestId('add-target-failure').textContent).toMatch(/mint node token/i);
    expect(onProvisioned).not.toHaveBeenCalled();
  });

  it('a rejected provisionTarget call (e.g. a timeout) surfaces as an error in the done state', async () => {
    const client = fakeClient({
      provisionTarget: vi.fn().mockRejectedValue(new Error('timed out waiting for a result')),
    });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });
    await fillHostAndReview();
    await fireEvent.click(screen.getByTestId('add-target-confirm'));

    await waitFor(() => expect(screen.getByTestId('add-target-error')).toBeTruthy());
    expect(screen.getByTestId('add-target-error').textContent).toContain(
      'timed out waiting for a result',
    );
  });

  it('Close from the done state calls onClose', async () => {
    const onClose = vi.fn();
    const client = fakeClient();
    render(AddTargetWizard, { props: { open: true, client, onClose } });
    await fillHostAndReview();
    await fireEvent.click(screen.getByTestId('add-target-confirm'));

    await waitFor(() => expect(screen.getByTestId('add-target-done-close')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-target-done-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AddTargetWizard candidate-card picker (redesign v2 §3.2; issue #475)', () => {
  const CANDIDATES: SshDiscoveryResultV1 = {
    outcome: 'ok',
    candidates: [
      {
        alias: 'devbox',
        hostName: '100.87.202.117',
        user: 'lorenzo',
        port: 22,
        identityFiles: ['/home/lorenzo/.ssh/id_ed25519'],
      },
      { alias: 'staging', hostName: 'staging.example.com', identityFiles: [] },
    ],
    agent: { available: false, identities: [] },
    requiresManualEntry: false,
  };

  it('asks the acting node to discover SSH hosts over the relay when there is no desktop bridge, and renders a card per candidate', async () => {
    const discoverSshHosts = vi.fn().mockResolvedValue(CANDIDATES);
    const client = fakeClient({ discoverSshHosts });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });

    await waitFor(() => expect(screen.getByTestId('add-target-candidates')).toBeTruthy());
    expect(discoverSshHosts).toHaveBeenCalledWith('node_1');
    expect(screen.getByTestId('add-target-candidate-devbox')).toBeTruthy();
    expect(screen.getByTestId('add-target-candidate-staging')).toBeTruthy();
    expect(screen.getByTestId('add-target-candidate-devbox').textContent).toContain(
      'lorenzo@100.87.202.117',
    );
    // The plain host-form fields are not shown while the candidate picker is.
    expect(screen.queryByTestId('add-target-host')).toBeNull();
  });

  it('selecting a candidate card prefills the host form and jumps straight to the review step', async () => {
    const client = fakeClient({ discoverSshHosts: vi.fn().mockResolvedValue(CANDIDATES) });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });

    await waitFor(() => expect(screen.getByTestId('add-target-candidate-devbox')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-target-candidate-devbox'));

    await waitFor(() => expect(screen.getByTestId('add-target-review')).toBeTruthy());
    expect(screen.getByTestId('add-target-review').textContent).toContain('100.87.202.117');
    expect(screen.getByTestId('add-target-review').textContent).toContain('lorenzo');

    await fireEvent.click(screen.getByTestId('add-target-confirm'));
    await waitFor(() => expect(client.provisionTarget).toHaveBeenCalledTimes(1));
    const call = (client.provisionTarget as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.host).toEqual({
      host: '100.87.202.117',
      user: 'lorenzo',
      port: 22,
      alias: 'devbox',
      label: 'devbox',
    });
  });

  it("'Enter manually' always works even with candidates present, falling back to the plain host form", async () => {
    const client = fakeClient({ discoverSshHosts: vi.fn().mockResolvedValue(CANDIDATES) });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });

    await waitFor(() => expect(screen.getByTestId('add-target-candidates')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('add-target-enter-manually'));

    await waitFor(() => expect(screen.getByTestId('add-target-host')).toBeTruthy());
    await fireEvent.input(screen.getByTestId('add-target-host'), {
      target: { value: '10.0.0.9' },
    });
    await fireEvent.click(screen.getByTestId('add-target-next'));
    await waitFor(() => expect(screen.getByTestId('add-target-review')).toBeTruthy());
    expect(screen.getByTestId('add-target-review').textContent).toContain('10.0.0.9');
  });

  it('renders the plain manual form directly (no card list) when discovery reports zero candidates — the fallback always works', async () => {
    const client = fakeClient(); // default discoverSshHosts resolves to zero candidates
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });

    await waitFor(() => expect(screen.getByTestId('add-target-host')).toBeTruthy());
    expect(screen.queryByTestId('add-target-candidates')).toBeNull();
  });

  it('prefers the desktop IPC bridge over the relay round trip when both are present', async () => {
    const listSshHostCandidates = vi.fn().mockResolvedValue({
      candidates: [{ alias: 'mac', hostName: 'mac.local', identityFiles: [] }],
      requiresManualEntry: false,
    });
    (window as { loombox?: unknown }).loombox = { listSshHostCandidates };
    const discoverSshHosts = vi.fn().mockResolvedValue(CANDIDATES);
    const client = fakeClient({ discoverSshHosts });
    render(AddTargetWizard, { props: { open: true, client, onClose: vi.fn() } });

    await waitFor(() => expect(screen.getByTestId('add-target-candidate-mac')).toBeTruthy());
    expect(listSshHostCandidates).toHaveBeenCalledTimes(1);
    expect(discoverSshHosts).not.toHaveBeenCalled();
  });
});
