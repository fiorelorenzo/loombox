// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPermissionQueueState,
  createTranscriptState,
  enqueuePermissionRequest,
  reduceTranscript,
} from '@loombox/providers-core/browser';
import type {
  AcpSessionStatus,
  PermissionQueueState,
  TranscriptState,
} from '@loombox/providers-core/browser';
import { APP_NAME } from '$lib/constants';
import { exportTranscriptText } from '$lib/copy';
import { createLocalStorageAmkStorage } from '$lib/amk-store';
import type {
  AttentionInboxItem,
  BuildIdentityV1,
  ClientSessionMeta,
  ConnectedAccount,
  ConnectionStatus,
  TargetListEntry,
} from '$lib/relay-client';
import type { StoredAuthSession } from '$lib/auth-store';
import type * as AuthStoreModule from '$lib/auth-store';
import type * as RelayClientModule from '$lib/relay-client';

// jsdom has no Web Animations API, but Svelte 5's `in:`/`out:` transitions
// (ArchiveSessionDialog's `Dialog`/`Overlay`, opened reactively by the
// session row menu's "Archive session…" action below) call
// `element.animate()` under the hood whenever an element actually appears
// AFTER a component's initial mount — see `TargetStatusView.test.ts`'s
// identical stub for the same reason (its own embedded `AddTargetWizard`
// dialog). A minimal no-op stub is enough to let the transition run
// without crashing; it doesn't need to animate anything for these
// assertions to hold.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () =>
    ({
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as Animation;
}

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
  connectedAccounts?: ConnectedAccount[];
  sessionStatuses?: Record<string, AcpSessionStatus>;
  /** Per-session transcript state, keyed by session id — omitted sessions get `transcriptFor`'s existing `undefined` default. */
  transcripts?: Record<string, TranscriptState>;
  /** Per-session permission-queue state, keyed by session id — omitted sessions get the existing empty-queue default. */
  permissionQueues?: Record<string, PermissionQueueState>;
  /** Seeds `attentionInbox()`'s store (issue #167's wiring tests below) — the store itself is memoized on the fake client instance (mirrors `sessions`/`status`), so a test can grab it via `client.attentionInbox()` and `.set()` a new snapshot to simulate the real `RelayClient`'s own live recompute, without re-implementing that recompute here (already covered end to end in `relay-client.test.ts`). */
  attentionInboxItems?: AttentionInboxItem[];
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
  const attentionInboxStore = makeStore<AttentionInboxItem[]>(scenario.attentionInboxItems ?? []);
  return {
    status: statusStore,
    sessions: sessionsStore,
    connectedAccounts: makeStore(scenario.connectedAccounts ?? []),
    sessionDecryptFailures: makeStore(0),
    /** Issue #655: `undefined` (no relay handshake identity opinion) is the correct default here — this file asserts on navigation/structure, never on the build-identity badge (covered in `TargetStatusView.test.ts`/`relay-client.test.ts`). */
    relayBuildIdentity: makeStore<BuildIdentityV1 | undefined>(undefined),
    attentionInbox: () => attentionInboxStore,
    connect: vi.fn(() => statusStore.set('open')),
    close: vi.fn(),
    listTargets: vi.fn().mockResolvedValue(scenario.targets ?? []),
    createSession: vi.fn().mockResolvedValue('new-session-id'),
    browseDirectory: vi.fn(),
    provisionTarget: vi.fn(),
    discoverSshHosts: vi.fn(),
    decommissionTarget: vi.fn(),
    updateTarget: vi.fn(),
    archiveSession: vi.fn().mockResolvedValue(undefined),
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
    transcriptFor: (id: string) =>
      makeStore<TranscriptState | undefined>(scenario.transcripts?.[id]),
    permissionQueueFor: (id: string) =>
      makeStore<PermissionQueueState>(
        scenario.permissionQueues?.[id] ?? createPermissionQueueState(),
      ),
    configOptionsFor: () => makeStore([]),
    attachmentsFor: () => makeStore([]),
    queuedPromptsFor: () => makeStore([]),
    staleNoticeFor: () => makeStore(undefined),
    fileTreeFor: () => makeStore(new Map()),
    getTestRunnerConfig: vi.fn().mockResolvedValue({}),
    runsFor: () => makeStore(new Map()),
    startRun: vi.fn(() => 'run-fake'),
    cancelRun: vi.fn(),
    onRunOutput: vi.fn(() => () => {}),
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

  it('centres that wait in the shared gate composition, drawing the brand once', () => {
    // Both halves of this used to be wrong on the same screen: the lockup was
    // centred by a page header while the "Checking session…" line was a plain
    // block in the top-left corner of an uncentred column, and the signed-out
    // state under it drew a second, dimmed brand mark through `EmptyState`.
    render(Page);

    expect(screen.getByTestId('gate-shell')).toBeTruthy();
    expect(screen.getAllByTestId('brand-mark')).toHaveLength(1);
  });

  it('renders the waiting weave at panel size, not the 1em inline one', () => {
    // `WovenLoader`'s default size is `sm` (1em), which is what this screen
    // used to pass by omission: a 12px speck as the only thing on an otherwise
    // empty window. `md` is the 2.5rem motif /style-reference documents.
    render(Page);

    expect(screen.getByTestId('woven-loader').dataset.size).toBe('md');
  });

  it('posts a structured-cloneable payload to a controlling service worker, and never lets that sync block the session check', () => {
    // This one is a dead-app regression, not a cosmetic one. `onMount` syncs
    // the notification preferences to the worker BEFORE restoring the session,
    // and it used to post the `$state` proxy itself. Structured clone cannot
    // clone a Proxy, so `postMessage` threw `DataCloneError` and took the rest
    // of `onMount` with it: no `/api/auth/get-session` request, "Checking
    // session…" forever. It only bit from the SECOND visit on, when the worker
    // actually controls the page, which is why nothing caught it until
    // production. `tests-e2e/pwa-shell.spec.ts` drives that second visit; this
    // asserts the payload contract directly.
    const posted: unknown[] = [];
    const postMessage = vi.fn((message: unknown) => {
      // Throws exactly as the browser does if anything here is a proxy.
      posted.push(structuredClone(message));
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { controller: { postMessage } },
      configurable: true,
    });

    try {
      render(Page);

      expect(postMessage).toHaveBeenCalled();
      expect(posted[0]).toMatchObject({ type: 'loombox:notification-prefs-sync' });
      // And the screen still got to its "checking the session" state, i.e.
      // `onMount` carried on past the sync.
      expect(screen.getByText('Checking session…')).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
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
  const fakeClient = createFakeClient(scenario);
  vi.mocked(RelayClient).mockImplementation(
    () => fakeClient as unknown as RelayClientModule.RelayClient,
  );
  return { ...render(Page), client: fakeClient };
}

describe('cockpit shell (design spec v4, issue #507)', () => {
  it('renders Inbox as the sole primary destination before the PROJECTS section — Nodes moved into Settings (issue #568)', async () => {
    mountCockpit();

    const destinations = await screen.findByTestId('sidebar-destinations');
    expect(screen.getByTestId('destination-inbox')).toBeTruthy();
    expect(screen.queryByTestId('destination-nodes')).toBeNull();

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

  it('a destination click hides the right sidebar instead of leaving it open over the wrong view (spec §3.3, issue #571)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    // Session-scoped (design spec §3.3): open by default at this suite's
    // stubbed-wide viewport once a session is selected, same as
    // `file-tree-toggle` below being reachable with no prior click.
    await screen.findByTestId('right-sidebar');

    await fireEvent.click(screen.getByTestId('destination-inbox'));

    expect(await screen.findByTestId('inbox-page')).toBeTruthy();
    expect(screen.getByTestId('destination-inbox').className).toContain('active');
    // The sidebar is scoped to the session workbench, not a global overlay:
    // switching to a `mainView` destination hides it, it does not follow.
    expect(screen.queryByTestId('right-sidebar')).toBeNull();
  });

  it('the right sidebar offers Files/Config/Runner as sub-tabs now that Terminal has its own dock and Inbox/Nodes/Settings are pages (issue #571; #244)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    // Open by default (design spec §3.3): a session is selected and this
    // suite's `stubMatchMedia(false)` reads as the wide viewport.
    await screen.findByTestId('right-sidebar');

    // One topbar toggle for the sidebar itself now, not a three-button
    // switch (2026-08-03: two controls for one choice was the defect) —
    // the Files/Config/Runner choice moved onto sub-tabs inside the
    // panel's own header instead.
    const toggle = screen.getByTestId('workbench-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('file-tree-toggle')).toBeTruthy();
    expect(screen.getByTestId('project-config-toggle')).toBeTruthy();
    expect(screen.getByTestId('test-runner-toggle')).toBeTruthy();
    expect(screen.queryByTestId('terminal-toggle')).toBeNull();
    expect(screen.queryByTestId('inbox-toggle')).toBeNull();
    expect(screen.queryByTestId('targets-toggle')).toBeNull();
    expect(screen.queryByTestId('settings-toggle')).toBeNull();

    // The sub-tabs are a real `radiogroup`, not a second `aria-pressed`
    // toggle group: exactly one of Files/Config/Runner is always selected.
    expect(screen.getByRole('radiogroup', { name: 'Workbench panel' })).toBeTruthy();
    expect(screen.getByTestId('file-tree-toggle').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('file-tree-panel-wrapper')).toBeTruthy();

    // Switching tabs keeps the sidebar open and does not remount the other
    // panels — all three stay in the DOM, the inactive ones are merely
    // `hidden` (issue #244's runner surface must not lose a streaming run
    // just because the user glanced at Files).
    await fireEvent.click(screen.getByTestId('project-config-toggle'));
    expect(screen.getByTestId('project-config-toggle').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('right-sidebar')).toBeTruthy();
    expect(screen.getByTestId('file-tree-panel-wrapper').hidden).toBe(true);

    await fireEvent.click(screen.getByTestId('test-runner-toggle'));
    expect(screen.getByTestId('test-runner-toggle').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('test-runner-panel-wrapper')).toBeTruthy();
    expect(screen.getByTestId('test-runner-panel-wrapper').hidden).toBe(false);
    expect(screen.getByTestId('project-config-panel-wrapper').hidden).toBe(true);

    // The topbar toggle closes the whole panel, independent of which tab is active.
    await fireEvent.click(toggle);
    expect(screen.queryByTestId('right-sidebar')).toBeNull();
  });

  it('the page title renders exactly once for each destination, never duplicated in the topbar (coherence v5 §2)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('destination-inbox');

    await fireEvent.click(screen.getByTestId('destination-inbox'));
    expect(await screen.findAllByRole('heading', { name: 'Inbox', level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId('cockpit-page-title')).toBeNull();

    await fireEvent.click(screen.getByTestId('account-menu-toggle'));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(await screen.findAllByRole('heading', { name: 'Settings', level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId('cockpit-page-title')).toBeNull();

    // Nodes is a section inside Settings now (issue #568), not its own
    // `mainView` destination — it gets an `<h2>`, and Settings' own `<h1>`
    // must not be duplicated by it.
    await fireEvent.click(screen.getByTestId('settings-nav-nodes'));
    expect(
      await screen.findAllByRole('heading', { name: 'Nodes and targets', level: 2 }),
    ).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Settings', level: 1 })).toHaveLength(1);
  });

  it('Nodes has no sidebar row or mobile tabbar item; Settings (reading "Settings", not "Appearance & settings") is reachable only from the account menu (issue #568, coherence v5 §2)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('destination-inbox');

    // The tabbar's own `<nav>` renders unconditionally in this jsdom
    // render (it's hidden by a `@media` query below `--bp-desktop`, not an
    // `{#if}`), so its absence here is unconditional too, same as the
    // sidebar's.
    expect(screen.queryByTestId('destination-nodes')).toBeNull();
    expect(screen.queryByTestId('tabbar-targets')).toBeNull();
    expect(screen.queryByTestId('destination-settings')).toBeNull();
    expect(screen.queryByTestId('tabbar-settings')).toBeNull();

    await fireEvent.click(screen.getByTestId('account-menu-toggle'));
    const settingsEntry = screen.getByRole('menuitem', { name: 'Settings' });
    expect(settingsEntry.textContent?.trim()).toBe('Settings');
    await fireEvent.click(settingsEntry);
    expect(await screen.findByTestId('settings-page')).toBeTruthy();
  });

  it('the ⋯ "Target status" action lands on Settings with the Nodes section selected and the target highlighted (issue #568)', async () => {
    mountCockpit({
      sessions: [makeSession()],
      targets: [
        {
          nodeId: 'node_1',
          targetId: 'local',
          label: 'This machine',
          kind: 'local',
          providers: ['claude'],
          reachable: true,
        },
      ],
    });

    await fireEvent.click(await screen.findByTestId('session-row-more'));
    await fireEvent.click(screen.getByTestId('session-target-status-link'));

    expect(await screen.findByTestId('settings-page')).toBeTruthy();
    expect(await screen.findByTestId('settings-section-nodes')).toBeTruthy();
    const row = await screen.findByTestId('target-status-row-node_1:local');
    expect(row.className).toContain('focused');
  });

  it('an unhealthy target is still discoverable without opening Settings: a dot on the account-menu trigger and its Settings entry (issue #568)', async () => {
    mountCockpit({
      targets: [
        {
          nodeId: 'node_1',
          targetId: 'local',
          label: 'This machine',
          kind: 'local',
          providers: ['claude'],
          reachable: false,
        },
      ],
    });

    expect(await screen.findByTestId('account-health-badge')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('account-menu-toggle'));
    expect(screen.getByTestId('settings-menu-health-badge')).toBeTruthy();
  });

  it('the account-menu health dot clears once the target recovers, and is one dot, never one per poll (issue #568)', async () => {
    const target = {
      nodeId: 'node_1',
      targetId: 'local',
      label: 'This machine',
      kind: 'local' as const,
      providers: ['claude'],
      reachable: false,
    };
    const { client } = mountCockpit({ targets: [target] });
    expect(await screen.findByTestId('account-health-badge')).toBeTruthy();
    // Never more than one — the dot is a boolean-gated conditional render,
    // not a list an item gets pushed onto per poll.
    expect(screen.queryAllByTestId('account-health-badge')).toHaveLength(1);

    // The same `listTargets()` poll `startTargetStatusPolling` already
    // drives now reports the target healthy — a boolean derived off the
    // latest snapshot, so recovery clears the one dot rather than leaving a
    // stale alert (or, the failure mode this guards, ever accumulating a
    // second one).
    vi.mocked(client.listTargets).mockResolvedValue([{ ...target, reachable: true }]);
    await fireEvent.click(screen.getByTestId('account-menu-toggle'));
    await fireEvent.click(screen.getByRole('menuitem', { name: /^settings/i }));
    await fireEvent.click(screen.getByTestId('settings-nav-nodes'));

    await vi.waitFor(() => expect(screen.queryByTestId('account-health-badge')).toBeNull());
    expect(screen.queryAllByTestId('account-health-badge')).toHaveLength(0);
  });

  it('the command palette can open Nodes and targets directly (issue #568)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('destination-inbox');

    await fireEvent.click(screen.getByTestId('tabbar-command'));
    await fireEvent.click(await screen.findByRole('option', { name: /open nodes and targets/i }));

    expect(await screen.findByTestId('settings-page')).toBeTruthy();
    expect(await screen.findByTestId('settings-section-nodes')).toBeTruthy();
  });

  it('the sidebar toggle announces which state it is in, since the glyph itself no longer changes', async () => {
    mountCockpit({ sessions: [makeSession()] });
    const toggle = await screen.findByTestId('sidebar-collapse-toggle');

    // The whole point of this assertion: the control used to carry a
    // mirrored glyph as its state indicator, and the mirror was a no-op (the
    // chevron it drew was symmetric about the axis it was flipped on), so
    // for a while the button silently looked identical in both states. The
    // panel glyph is deliberately NOT mirrored now, which makes
    // `aria-pressed` and the label the only things that distinguish the two
    // states — so they are what a regression here has to break.
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar');

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');
  });
});

describe('cockpit shell: attention inbox wiring (issue #167)', () => {
  /**
   * `AttentionInbox.svelte`/`InboxPage.svelte`'s own component tests
   * (`AttentionInbox.test.ts`/`InboxPage.test.ts`) already cover rendering
   * and prop-callback wiring in isolation, and `relay-client.test.ts`
   * already covers `RelayClient.attentionInbox()`'s own live recompute
   * (surfacing/clearing each class as the underlying transcript/queue
   * state changes). What none of those cover — and what regressed once
   * before at this exact seam (`account-health-badge`, issue #568's "one
   * dot, never one per poll") — is `+page.svelte`'s OWN wiring: that the
   * two badges reading `attentionInboxItems.length` stay in lockstep with
   * the one store `client.attentionInbox()` returns, and that its
   * `onResolve`/`onOpenSession` props actually reach the real
   * `resolvePermission`/`selectSession` calls, not just a spy prop.
   */
  function makeInboxPermissionItem(
    overrides: Partial<AttentionInboxItem> = {},
  ): AttentionInboxItem {
    return {
      kind: 'permission',
      sessionId: 'sess_1',
      sessionTitle: 'Refactor relay routing',
      projectPath: '/home/dev/loombox',
      nodeId: 'node_1',
      waitingSince: 1,
      permission: {
        requestId: 'req-inbox-1',
        sessionId: 'sess_1',
        toolCall: { kind: 'tool_call', id: 'tc-1', title: 'Run tests' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
        parentToolCallId: undefined,
        enqueuedAt: 1,
      },
      ...overrides,
    };
  }

  it('shows exactly one badge on the sidebar destination and one on the mobile tabbar, both tracking the live attentionInbox() store, and both clear together when it empties (mirrors the #568 health-dot fix: never one badge per poll)', async () => {
    const { client } = mountCockpit({
      sessions: [makeSession()],
      attentionInboxItems: [makeInboxPermissionItem()],
    });

    expect((await screen.findByTestId('inbox-count')).textContent).toBe('1');
    expect(screen.queryAllByTestId('inbox-count')).toHaveLength(1);
    expect(screen.getByTestId('tabbar-inbox-count').textContent).toBe('1');
    expect(screen.queryAllByTestId('tabbar-inbox-count')).toHaveLength(1);

    // The exact same store `attentionInbox()` returns on every call (the
    // real `RelayClient`'s own contract, mirrored by the fake here) —
    // pushing the empty snapshot the real client would produce once the
    // request resolves clears both badges together in one render, not one
    // lingering while the other clears.
    client.attentionInbox().set([]);

    await vi.waitFor(() => expect(screen.queryByTestId('inbox-count')).toBeNull());
    expect(screen.queryByTestId('tabbar-inbox-count')).toBeNull();
  });

  it("approving a permission item from the inbox calls the same resolvePermission the session's own queue bar uses, once the answer window elapses (E2-1, issue #671)", async () => {
    vi.useFakeTimers();
    const { client } = mountCockpit({
      sessions: [makeSession()],
      attentionInboxItems: [makeInboxPermissionItem()],
    });

    await screen.findByTestId('destination-inbox');
    await fireEvent.click(screen.getByTestId('destination-inbox'));
    const row = await screen.findByTestId('attention-inbox-item');
    await fireEvent.click(within(row).getByRole('button', { name: /Allow/ }));

    expect(client.resolvePermission).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);

    expect(client.resolvePermission).toHaveBeenCalledWith(
      'sess_1',
      'req-inbox-1',
      expect.objectContaining({ optionId: 'allow', kind: 'allow_once' }),
    );
    vi.useRealTimers();
  });

  it('opening a session from an inbox item navigates to it and leaves the Inbox page, exactly like picking it from the sidebar (issue #168)', async () => {
    mountCockpit({
      sessions: [makeSession({ id: 'sess_1', title: 'Refactor relay routing' })],
      attentionInboxItems: [
        {
          kind: 'awaiting_input',
          sessionId: 'sess_1',
          sessionTitle: 'Refactor relay routing',
          projectPath: '/home/dev/loombox',
          nodeId: 'node_1',
          waitingSince: 1,
        },
      ],
    });

    await screen.findByTestId('destination-inbox');
    await fireEvent.click(screen.getByTestId('destination-inbox'));
    const row = await screen.findByTestId('attention-inbox-item');
    await fireEvent.click(within(row).getByTestId('attention-inbox-open'));

    expect(screen.queryByTestId('inbox-page')).toBeNull();
    expect(screen.getByTestId('destination-inbox').className).not.toContain('active');
    expect(await screen.findByTestId('composer-input')).toBeTruthy();
  });
});

describe('new session: real per-target providers (forms + real providers design spec §2/§3)', () => {
  it("keys the dialog's available providers by the project's own (nodeId, targetId) — not just the first target in the list — and shows the sole one as a context-line fact", async () => {
    mountCockpit({
      sessions: [makeSession()],
      targets: [
        // Listed first on purpose: a `providersForProject` regression that
        // grabbed `targetStatusEntries[0]` instead of matching by id would
        // read this unrelated target's providers instead.
        {
          nodeId: 'node_2',
          targetId: 'ssh_build',
          label: 'Build box',
          kind: 'ssh',
          reachable: true,
          providers: ['claude', 'ohmypi'],
        },
        {
          nodeId: 'node_1',
          targetId: 'local',
          label: 'This machine',
          kind: 'local',
          reachable: true,
          providers: ['codex'],
        },
      ],
    });

    await fireEvent.click(await screen.findByTestId('project-new-session-row'));

    expect(screen.queryByTestId('new-session-provider')).toBeNull();
    expect(screen.getByTestId('new-session-agent-fact').textContent).toContain('Codex');
  });

  it("names the target in the zero-providers message using the target list's own label, not the raw target id", async () => {
    mountCockpit({
      sessions: [makeSession()],
      targets: [
        {
          nodeId: 'node_1',
          targetId: 'local',
          label: "Ada's MacBook",
          kind: 'local',
          reachable: true,
          providers: [],
        },
      ],
    });

    await fireEvent.click(await screen.findByTestId('project-new-session-row'));

    expect(screen.getByText(/no agent cli/i).textContent).toContain("Ada's MacBook");
  });
});

describe('session archive (SPEC §7.2 board archive; issue #512)', () => {
  it('the row menu offers "Archive session…" alongside Target status/Copy project path', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await fireEvent.click(await screen.findByTestId('session-row-more'));

    expect(screen.getByTestId('session-archive-link').textContent).toContain('Archive session');
  });

  it('clicking "Archive session…" opens a confirm dialog naming the session and its project', async () => {
    mountCockpit({
      sessions: [
        makeSession({ title: 'Refactor relay routing', projectPath: '/home/dev/loombox' }),
      ],
    });
    await fireEvent.click(await screen.findByTestId('session-row-more'));
    await fireEvent.click(screen.getByTestId('session-archive-link'));

    const context = (await screen.findByTestId('archive-session-context')).textContent ?? '';
    expect(context).toContain('Refactor relay routing');
    expect(context).toContain('/home/dev/loombox');
  });

  it('confirming the dialog calls client.archiveSession with the session id and the checkbox choice', async () => {
    const { client } = mountCockpit({ sessions: [makeSession({ id: 'sess_1' })] });
    await fireEvent.click(await screen.findByTestId('session-row-more'));
    await fireEvent.click(screen.getByTestId('session-archive-link'));
    await screen.findByTestId('archive-session-context');

    await fireEvent.click(screen.getByTestId('archive-session-confirm'));

    expect(client.archiveSession).toHaveBeenCalledWith('sess_1', { removeWorktree: true });
  });

  it('falls back to the next remaining session when the selected one drops out of the sessions list', async () => {
    const { client } = mountCockpit({
      sessions: [
        makeSession({ id: 'sess_1', title: 'First session' }),
        makeSession({ id: 'sess_2', title: 'Second session' }),
      ],
    });
    // The first session is auto-selected on load.
    expect(await screen.findByTestId('cockpit-session-title')).toBeTruthy();
    expect(screen.getByTestId('cockpit-session-title').textContent).toBe('First session');

    // The same store mutation RelayClient.handleSessionArchiveResponse does
    // on outcome: 'ok' (SessionArchiveResponse) — the previously-selected
    // session is simply no longer in the list.
    client.sessions.set([makeSession({ id: 'sess_2', title: 'Second session' })]);

    await vi.waitFor(() => {
      expect(screen.getByTestId('cockpit-session-title').textContent).toBe('Second session');
    });
  });

  it('clears the selection (empty state) when the selected session was the only one and it drops out', async () => {
    const { client } = mountCockpit({
      sessions: [makeSession({ id: 'sess_only', title: 'Only session' })],
    });
    expect(await screen.findByTestId('cockpit-session-title')).toBeTruthy();

    client.sessions.set([]);

    await vi.waitFor(() => {
      expect(screen.getByText('No session selected')).toBeTruthy();
    });
    expect(screen.queryByTestId('cockpit-session-title')).toBeNull();
  });
});

describe('sign-in gate', () => {
  /**
   * Mounts the gate rather than the cockpit: no AMK, no session, so
   * `+page.svelte` renders the front door. `signInWithGithub` never settles,
   * which is what the real one does too — it hands off to a full-page redirect,
   * so the promise is still pending when the browser leaves.
   */
  function mountGate() {
    const signInWithGithub = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(AuthStore).mockImplementation(
      () =>
        ({
          session: makeStore<StoredAuthSession | undefined>(undefined),
          restoreSession: vi.fn().mockResolvedValue(undefined),
          signInWithGithub,
          signOut: vi.fn(),
        }) as unknown as AuthStoreModule.AuthStore,
    );
    return { ...render(Page), signInWithGithub };
  }

  it('marks the sign-in button busy while the OAuth redirect is being set up', async () => {
    // The click costs a round trip to the relay before the browser leaves. With
    // nothing on the button, that gap reads as a dead control.
    const { signInWithGithub } = mountGate();

    const button = (await screen.findByTestId('sign-in-github')) as HTMLButtonElement;
    expect(button.getAttribute('aria-busy')).toBeNull();

    await fireEvent.click(button);

    expect(signInWithGithub).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.getByTestId('sign-in-github').getAttribute('aria-busy')).toBe('true');
    });
    expect((screen.getByTestId('sign-in-github') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('woven-loader')).toBeTruthy();

    // And being busy means it cannot be fired twice by an impatient second click.
    await fireEvent.click(screen.getByTestId('sign-in-github'));
    expect(signInWithGithub).toHaveBeenCalledTimes(1);
  });

  it('drops the busy state and names the failure when the relay rejects the sign-in', async () => {
    // The dev-loop case: a relay with no GitHub provider configured. The button
    // has to come back, or the only way on is a reload.
    vi.mocked(AuthStore).mockImplementation(
      () =>
        ({
          session: makeStore<StoredAuthSession | undefined>(undefined),
          restoreSession: vi.fn().mockResolvedValue(undefined),
          signInWithGithub: vi.fn().mockRejectedValue(new Error('has no GitHub login configured')),
          signOut: vi.fn(),
        }) as unknown as AuthStoreModule.AuthStore,
    );
    render(Page);

    await fireEvent.click(await screen.findByTestId('sign-in-github'));

    await vi.waitFor(() => {
      expect(screen.getByText(/has no GitHub login configured/)).toBeTruthy();
    });
    expect(screen.getByTestId('sign-in-github').getAttribute('aria-busy')).toBeNull();
    expect((screen.getByTestId('sign-in-github') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------
// The transcript's "awaiting permission" outline (issue #548): a tool
// call whose `id` is `undefined` (a malformed `tool_call`/`tool_call_
// update` — the wire cast in `relay-client.ts` never validates the
// decrypted payload against `AcpToolCallUpdate`'s declared `id: string`)
// must never wear the amber outline just because `permissionHead?.
// toolCall.id === item.id` degenerates to `undefined === undefined`.
// Rendered through the real `+page.svelte` transcript loop, not the
// `ToolCallRow` prop directly, since the bug lives in the comparison
// that COMPUTES the prop, not in `ToolCallRow` itself (already covered
// by `ToolCallRow.test.ts`'s "permission awaiting indicator" suite).
// ---------------------------------------------------------------------

describe('transcript: awaiting-permission outline (issue #548)', () => {
  it('a tool_call item with no id and nothing pending never gets the awaiting-permission outline', async () => {
    const transcript = reduceTranscript(createTranscriptState(), {
      kind: 'tool_call',
      id: undefined as unknown as string,
      title: 'Mystery tool call',
      status: 'completed',
    });

    mountCockpit({
      sessions: [makeSession({ id: 'sess_1' })],
      transcripts: { sess_1: transcript },
      permissionQueues: { sess_1: createPermissionQueueState() },
    });

    const row = await screen.findByTestId('tool-call-row');
    expect(row.className).not.toContain('awaiting-permission');
  });

  it('a tool call that IS the FIFO permission head still gets the outline (sanity: the guard is not overly conservative)', async () => {
    const transcript = reduceTranscript(createTranscriptState(), {
      kind: 'tool_call',
      id: 'tc1',
      title: 'Edit src/foo.ts',
      status: 'pending',
    });
    const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }];
    const queue = enqueuePermissionRequest(createPermissionQueueState(), {
      requestId: 'req-1',
      sessionId: 'sess_1',
      toolCall: { kind: 'tool_call', id: 'tc1', title: 'Edit src/foo.ts' },
      options,
    }).state;

    mountCockpit({
      sessions: [makeSession({ id: 'sess_1' })],
      transcripts: { sess_1: transcript },
      permissionQueues: { sess_1: queue },
    });

    const row = await screen.findByTestId('tool-call-row');
    expect(row.className).toContain('awaiting-permission');
  });
});

// ---------------------------------------------------------------------
// D3-3 (design spec §4; issue #670): the bare copy-glyph "Export
// transcript" control leaves the session header entirely and moves into
// the session row's own `⋯` menu, alongside its other session actions,
// drawn as a plain labelled menu item rather than a copy icon.
// ---------------------------------------------------------------------

describe('session export moved into the row menu (D3-3; issue #670)', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('the header carries only the Workbench and Terminal toggles — no export control left behind', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('workbench-toggle');

    expect(screen.getByTestId('terminal-dock-toggle')).toBeTruthy();
    expect(screen.queryByLabelText('Export transcript')).toBeNull();
  });

  it('the open session\'s row menu offers "Export transcript" alongside Target status/Copy project path/Archive session…', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await fireEvent.click(await screen.findByTestId('session-row-more'));

    const exportLink = screen.getByTestId('session-export-link');
    expect(exportLink.textContent).toContain('Export transcript');
    // No copy glyph on this action anywhere (D3-3's fixed verb): unlike
    // `CopyButton`, this menu item renders no `Icon` at all.
    expect(exportLink.querySelector('svg')).toBeNull();
  });

  it("clicking it copies the open session's transcript text — the same exportTranscriptText/copyToClipboard pipeline the old header button used", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const transcript = reduceTranscript(createTranscriptState(), {
      kind: 'agent_message_chunk',
      turnId: 't1',
      messageId: 'm1',
      text: 'Hello there',
    });

    mountCockpit({
      sessions: [makeSession({ id: 'sess_1' })],
      transcripts: { sess_1: transcript },
    });

    await fireEvent.click(await screen.findByTestId('session-row-more'));
    await fireEvent.click(screen.getByTestId('session-export-link'));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(exportTranscriptText(transcript));
    });
  });

  it('does not offer "Export transcript" from a session row that is not the one currently open', async () => {
    mountCockpit({
      sessions: [
        makeSession({ id: 'sess_1', title: 'First session' }),
        makeSession({ id: 'sess_2', title: 'Second session' }),
      ],
    });
    // The first session auto-selects on load; open the SECOND row's menu.
    await screen.findByTestId('cockpit-session-title');
    const secondRow = screen.getByText('Second session').closest('li');
    expect(secondRow).toBeTruthy();

    await fireEvent.click(within(secondRow as HTMLElement).getByTestId('session-row-more'));

    expect(screen.queryByTestId('session-export-link')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// F1-3 (Zed-parity, issue #758): the command palette is a pure view over
// `actionRegistry` (`$lib/action-registry.ts`), and `handleGlobalKeydown`
// dispatches shortcuts through that same registry. `action-registry.
// test.ts` covers the registry module itself in isolation; these tests
// exercise the real wiring end to end — a real fake-client-backed
// cockpit, real `keydown` events on `window` — so a regression in how
// `+page.svelte` builds `actionContext`/`actionHandlers` from live state
// fails here even if the pure module's own tests still pass.
// ---------------------------------------------------------------------

describe('command palette: a view over the action registry (issue #758)', () => {
  async function openPalette(): Promise<void> {
    await fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await screen.findByTestId('dialog');
  }

  it('"Stop current turn" is hidden at rest (no active turn)', async () => {
    mountCockpit({ sessions: [makeSession({ id: 'sess_1' })] });
    await screen.findByTestId('cockpit-session-title');

    await openPalette();
    expect(screen.queryByText('Stop current turn')).toBeNull();
  });

  it('"Stop current turn" appears, with its Mod+. binding shown, once the selected session\'s turn is active', async () => {
    mountCockpit({
      sessions: [makeSession({ id: 'sess_1' })],
      transcripts: { sess_1: { ...createTranscriptState(), turnActive: true } },
    });
    await screen.findByTestId('cockpit-session-title');

    await openPalette();
    const row = screen.getByText('Stop current turn').closest('button');
    expect(row?.textContent).toContain('Mod+.');
  });

  it('"Next session"/"Previous session" are hidden with only one session', async () => {
    mountCockpit({ sessions: [makeSession({ id: 'sess_1' })] });
    await screen.findByTestId('cockpit-session-title');

    await openPalette();
    expect(screen.queryByText('Next session')).toBeNull();
    expect(screen.queryByText('Previous session')).toBeNull();
  });

  it('"Next session"/"Previous session" appear with more than one session, and actually cycle the selection when picked', async () => {
    mountCockpit({
      sessions: [
        makeSession({ id: 'sess_1', title: 'First session' }),
        makeSession({ id: 'sess_2', title: 'Second session' }),
      ],
    });
    await screen.findByTestId('cockpit-session-title');

    await openPalette();
    expect(screen.getByText('Next session')).toBeTruthy();
    expect(screen.getByText('Previous session')).toBeTruthy();

    await fireEvent.click(screen.getByText('Next session'));
    expect((await screen.findByTestId('cockpit-session-title')).textContent?.trim()).toBe(
      'Second session',
    );
  });

  it('Mod+B still toggles the sessions column, unchanged (no regression)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    const column = await screen.findByTestId('sessions-column');
    expect(column.className).not.toContain('collapsed');

    await fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(column.className).toContain('collapsed');
  });

  it('Mod+. still interrupts an active turn (no regression)', async () => {
    const { client } = mountCockpit({
      sessions: [makeSession({ id: 'sess_1' })],
      transcripts: { sess_1: { ...createTranscriptState(), turnActive: true } },
    });
    await screen.findByTestId('cockpit-session-title');

    await fireEvent.keyDown(window, { key: '.', metaKey: true });
    expect(client.interruptTurn).toHaveBeenCalledWith('sess_1');
  });

  it('Mod+. does nothing when no turn is active — the deliberate tightening this migration ships (see action-registry.ts\'s "stop-turn" doc comment)', async () => {
    const { client } = mountCockpit({ sessions: [makeSession({ id: 'sess_1' })] });
    await screen.findByTestId('cockpit-session-title');

    await fireEvent.keyDown(window, { key: '.', metaKey: true });
    expect(client.interruptTurn).not.toHaveBeenCalled();
  });

  it('a chord bound to no registered action does nothing — nothing outside the registry can wire a new global shortcut', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('cockpit-session-title');

    const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
