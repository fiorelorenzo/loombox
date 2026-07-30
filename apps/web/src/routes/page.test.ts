// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionQueueState } from '@loombox/providers-core/browser';
import type { AcpSessionStatus, PermissionQueueState } from '@loombox/providers-core/browser';
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
  it('renders the primary destinations before the PROJECTS section (spec §3.1)', async () => {
    mountCockpit();

    const destinations = await screen.findByTestId('sidebar-destinations');
    expect(screen.getByTestId('destination-inbox')).toBeTruthy();
    expect(screen.getByTestId('destination-nodes')).toBeTruthy();

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

  it('the page title renders exactly once for each destination, never duplicated in the topbar (coherence v5 §2)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('destination-inbox');

    await fireEvent.click(screen.getByTestId('destination-inbox'));
    expect(await screen.findAllByRole('heading', { name: 'Inbox', level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId('cockpit-page-title')).toBeNull();

    await fireEvent.click(screen.getByTestId('destination-nodes'));
    expect(await screen.findAllByRole('heading', { name: 'Nodes', level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId('cockpit-page-title')).toBeNull();

    await fireEvent.click(screen.getByTestId('account-menu-toggle'));
    await fireEvent.click(screen.getByRole('menuitem', { name: /appearance.*settings/i }));
    expect(await screen.findAllByRole('heading', { name: 'Settings', level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId('cockpit-page-title')).toBeNull();
  });

  it('Settings is reachable only from the account menu, not the sidebar or the mobile tabbar (coherence v5 §2)', async () => {
    mountCockpit({ sessions: [makeSession()] });
    await screen.findByTestId('destination-inbox');

    // The tabbar's own `<nav>` renders unconditionally in this jsdom
    // render (it's hidden by a `@media` query below `--bp-desktop`, not an
    // `{#if}`), so its absence here is unconditional too, same as the
    // sidebar's.
    expect(screen.queryByTestId('destination-settings')).toBeNull();
    expect(screen.queryByTestId('tabbar-settings')).toBeNull();

    await fireEvent.click(screen.getByTestId('account-menu-toggle'));
    await fireEvent.click(screen.getByRole('menuitem', { name: /appearance.*settings/i }));
    expect(await screen.findByTestId('settings-page')).toBeTruthy();
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
