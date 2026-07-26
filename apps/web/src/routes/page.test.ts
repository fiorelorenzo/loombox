// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionQueueState } from '@loombox/providers-core';
import type { AcpSessionStatus, PermissionQueueState } from '@loombox/providers-core';
import { APP_NAME } from '$lib/constants';
import { createLocalStorageAmkStorage } from '$lib/amk-store';
import type {
  AttentionInboxItem,
  ClientSessionMeta,
  ConnectionStatus,
  TargetListEntry,
} from '$lib/relay-client';
import type { StoredAuthSession } from '$lib/auth-store';
import type * as AuthStoreModule from '$lib/auth-store';
import type * as RelayClientModule from '$lib/relay-client';

/**
 * `+page.svelte` constructs `AuthStore`/`RelayClient` itself (SPEC §8's
 * real Better Auth + E2E relay session) rather than taking either as a
 * prop, so the only seam for a hermetic render of it is mocking both
 * classes wholesale. `importOriginal` keeps every type/helper each module
 * also exports (`StoredAuthSession`, `ClientSessionMeta`, ...) intact;
 * only the class constructors themselves become bare `vi.fn()`s here,
 * deliberately with NO default implementation, since a `vi.mock` factory
 * is hoisted above every import and top-level `const` in this file, so it
 * cannot reference `makeStore`/`createFakeClient` below without a
 * temporal-dead-zone error. `beforeEach` below gives every test a safe
 * "signed out" default before each one configures what it actually needs.
 */
vi.mock('$lib/auth-store', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthStoreModule>();
  return { ...actual, AuthStore: vi.fn() };
});

vi.mock('$lib/relay-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RelayClientModule>();
  return { ...actual, RelayClient: vi.fn() };
});

import Page from './+page.svelte';
import { AuthStore } from '$lib/auth-store';
import { RelayClient } from '$lib/relay-client';

/** A minimal store (`subscribe`/`set` only, no need for the full Svelte `writable` API), built fresh per fake client/auth-store instance so tests never share state. */
function makeStore<T>(initial: T) {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();
  return {
    subscribe(run: (value: T) => void): () => void {
      run(value);
      subscribers.add(run);
      return () => subscribers.delete(run);
    },
    set(next: T): void {
      value = next;
      for (const run of subscribers) run(value);
    },
  };
}

const ACCOUNT_ID = 'acct_1';

function makeAuthSession(overrides: Partial<StoredAuthSession> = {}): StoredAuthSession {
  return { token: 'token_1', accountId: ACCOUNT_ID, displayName: 'Ada', ...overrides };
}

function makeSession(overrides: Partial<ClientSessionMeta> = {}): ClientSessionMeta {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'local',
    accountId: ACCOUNT_ID,
    provider: 'claude',
    createdAt: Date.now(),
    title: 'Refactor relay routing',
    projectPath: '/home/dev/loombox',
    ...overrides,
  };
}

/** A signed-out `AuthStore` double: never resolves a session, so `cockpitReady` stays false. Every test's safe default (`beforeEach` below) until `mountCockpit` below opts a specific test into a signed-in one. */
function createSignedOutAuthStore() {
  return {
    session: makeStore<StoredAuthSession | undefined>(undefined),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    signInWithGithub: vi.fn(),
    signOut: vi.fn(),
  };
}

interface FakeClientScenario {
  sessions?: ClientSessionMeta[];
  targets?: TargetListEntry[];
  sessionStatuses?: Record<string, AcpSessionStatus>;
}

/**
 * A fake covering every `RelayClient` member `+page.svelte` (or a
 * component it mounts, even closed) touches: see this file's own grep
 * of `client\.` call sites. Per-session stores (`transcriptFor` etc.) are
 * built fresh on every call rather than cached, which is fine here: this
 * file only asserts on structure/navigation, never on a specific
 * per-session store identity surviving a re-subscribe.
 */
function createFakeClient(scenario: FakeClientScenario = {}) {
  const statusStore = makeStore<ConnectionStatus>('idle');
  const sessionsStore = makeStore<ClientSessionMeta[]>(scenario.sessions ?? []);
  return {
    status: statusStore,
    sessions: sessionsStore,
    sessionDecryptFailures: makeStore(0),
    attentionInbox: () => makeStore<AttentionInboxItem[]>([]),
    connect: vi.fn(() => statusStore.set('open')),
    close: vi.fn(),
    listTargets: vi.fn().mockResolvedValue(scenario.targets ?? []),
    createSession: vi.fn().mockResolvedValue('new-session-id'),
    browseDirectory: vi.fn(),
    provisionTarget: vi.fn(),
    discoverSshHosts: vi.fn(),
    decommissionTarget: vi.fn(),
    updateTarget: vi.fn(),
    resolvePermission: vi.fn(),
    expandDirectory: vi.fn(),
    escrowAmk: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn(),
    attachFile: vi.fn(),
    retryAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    interruptTurn: vi.fn(),
    setConfigOption: vi.fn(),
    statusFor: (id: string) =>
      makeStore<AcpSessionStatus | undefined>(scenario.sessionStatuses?.[id]),
    transcriptFor: () => makeStore(undefined),
    permissionQueueFor: () => makeStore<PermissionQueueState>(createPermissionQueueState()),
    configOptionsFor: () => makeStore([]),
    attachmentsFor: () => makeStore([]),
    queuedPromptsFor: () => makeStore([]),
    staleNoticeFor: () => makeStore(undefined),
    fileTreeFor: () => makeStore(new Map()),
  };
}

/** jsdom implements neither `matchMedia` (viewport/reduced-motion reads), same stub `viewport.test.ts`/`accent.test.ts` already use. `matches: false` throughout means "wide viewport, no reduced motion", the desktop cockpit this suite exercises. */
function stubMatchMedia(matches = false): void {
  const mql = {
    matches,
    media: '',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
}

beforeEach(() => {
  localStorage.clear();
  stubMatchMedia(false);
  // jsdom implements no layout, so `Element.prototype.scrollIntoView` (the
  // drawer tab strip's `revealActiveTab` attachment) is simply absent, a
  // bare no-op stub is enough, this suite never asserts on scroll position.
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(AuthStore).mockImplementation(
    () => createSignedOutAuthStore() as unknown as AuthStoreModule.AuthStore,
  );
  vi.mocked(RelayClient).mockImplementation(
    () => createFakeClient() as unknown as RelayClientModule.RelayClient,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shell +page.svelte', () => {
  it('renders the loombox heading as the brand lockup (issue #194)', () => {
    render(Page);
    expect(screen.getByTestId('brand-lockup')).toBeTruthy();
    expect(screen.getByTestId('brand-mark')).toBeTruthy();
    // The wordmark's "oo" is split into its own styled span (BrandLockup.svelte),
    // so read the whole lockup's text content to check the brand name reads intact.
    expect(screen.getByTestId('brand-lockup').textContent).toContain(APP_NAME);
  });

  it('shows the woven-thread loading motif (#274) while checking the session, pre-hydration', () => {
    render(Page);
    // `restoreSession()` is async and hasn't resolved yet at this
    // synchronous point right after mount, so `authChecked` is still
    // false and the "checking session" state renders (mirrors
    // routes/device's own SSR-era test, adapted from `svelte/server`'s
    // `render` to a real jsdom mount now that this file also covers the
    // authenticated cockpit below, which needs real DOM interaction).
    expect(screen.getByText('Checking session…')).toBeTruthy();
    expect(screen.getByTestId('woven-loader')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------
// The authenticated cockpit (design spec v4, issue #507): a hermetic
// render exercising real `onMount` wiring against the fake
// `AuthStore`/`RelayClient` above, so the sidebar/main-area/drawer
// markup this issue rewrote is actually exercised.
// ---------------------------------------------------------------------

/**
 * Seeds this device's AMK (so `beginSessionFor` skips onboarding), wires
 * a signed-in `AuthStore` and a `RelayClient` scenario, then renders the
 * real component: `onMount` runs for real against both fakes. The fakes
 * only implement the public surface `+page.svelte` actually calls (see
 * `createFakeClient`'s own doc comment), not every private field the
 * real classes carry, so `as unknown as X` is the honest cast here: a
 * structural `as X` would demand fields this test double deliberately
 * never touches.
 */
function mountCockpit(scenario: FakeClientScenario = {}) {
  createLocalStorageAmkStorage().set(ACCOUNT_ID, new Uint8Array(32));
  vi.mocked(AuthStore).mockImplementation(
    () =>
      ({
        session: makeStore<StoredAuthSession | undefined>(makeAuthSession()),
        restoreSession: vi.fn().mockResolvedValue(undefined),
        signInWithGithub: vi.fn(),
        signOut: vi.fn(),
      }) as unknown as AuthStoreModule.AuthStore,
  );
  vi.mocked(RelayClient).mockImplementation(
    () => createFakeClient(scenario) as unknown as RelayClientModule.RelayClient,
  );
  return render(Page);
}

describe('cockpit shell (design spec v4, issue #507)', () => {
  it('renders the primary destinations before the PROJECTS section (spec §3.1)', async () => {
    mountCockpit();

    const destinations = await screen.findByTestId('sidebar-destinations');
    expect(screen.getByTestId('destination-inbox')).toBeTruthy();
    expect(screen.getByTestId('destination-nodes')).toBeTruthy();
    expect(screen.getByTestId('destination-settings')).toBeTruthy();

    const projectsHeading = screen.getByText('Projects');
    const order = destinations.compareDocumentPosition(projectsHeading);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a project group with its sessions nested inside it (spec §3.2)', async () => {
    mountCockpit({
      sessions: [
        makeSession({ id: 'sess_1', title: 'Refactor relay routing' }),
        makeSession({ id: 'sess_2', title: 'Fix the crypto base64' }),
      ],
    });

    const groups = await screen.findAllByTestId('project-group');
    expect(groups).toHaveLength(1);
    // The project's default name is its path's basename ('/home/dev/loombox' -> 'loombox').
    expect(within(groups[0]).getByText('loombox')).toBeTruthy();
    const rows = within(groups[0]).getAllByTestId('session-row-item');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Refactor relay routing')).toBeTruthy();
    expect(within(rows[1]).getByText('Fix the crypto base64')).toBeTruthy();
  });

  it('a destination click switches the main area instead of opening the drawer (spec §3.3)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('destination-inbox');
    expect(screen.queryByTestId('drawer')).toBeNull();

    await fireEvent.click(screen.getByTestId('destination-inbox'));

    expect(await screen.findByTestId('inbox-page')).toBeTruthy();
    expect(screen.getByTestId('destination-inbox').className).toContain('active');
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('the drawer exposes only Files/Terminal/Config now that Inbox/Nodes/Settings are pages (spec §3.5)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('file-tree-toggle');

    await fireEvent.click(screen.getByTestId('file-tree-toggle'));

    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(screen.getByTestId('drawer-tab-files')).toBeTruthy();
    expect(screen.getByTestId('drawer-tab-terminal')).toBeTruthy();
    expect(screen.getByTestId('drawer-tab-config')).toBeTruthy();
    expect(screen.queryByTestId('drawer-tab-inbox')).toBeNull();
    expect(screen.queryByTestId('drawer-tab-targets')).toBeNull();
    expect(screen.queryByTestId('drawer-tab-settings')).toBeNull();
  });
});
