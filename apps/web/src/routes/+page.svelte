<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import { env as publicEnv } from '$env/dynamic/public';
  import type {
    AcpConfigOption,
    AcpPermissionOption,
    AcpSessionStatus,
    PermissionQueueState,
    TranscriptState,
  } from '@loombox/providers-core';
  import { createPermissionQueueState, headPermissionRequest } from '@loombox/providers-core';
  import { APP_TAGLINE } from '$lib/constants';
  import { copyToClipboard, exportTranscriptText } from '$lib/copy';
  import {
    RelayClient,
    bootstrapAmkFromRecoveryCode,
    type AttentionInboxItem,
    type BootstrapAmkResult,
    type ClientSessionMeta,
    type ConnectionStatus,
    type FileTreeDirectoryState,
    type TargetListEntry,
  } from '$lib/relay-client';
  import { AuthStore, type StoredAuthSession } from '$lib/auth-store';
  import { createLocalStorageAmkStorage } from '$lib/amk-store';
  import {
    createLocalStorageDeviceIdStorage,
    loadOrCreateDeviceId,
    type DeviceIdStorage,
  } from '$lib/device-id-store';
  import { hasBlockingAttachments, type ComposerAttachment } from '$lib/attachments';
  import { isModShortcut, isTypingTarget } from '$lib/keyboard';
  import type { QueuedPrompt } from '$lib/outbox';
  import { isThoughtStillThinking } from '$lib/thinking';
  import {
    isNarrowViewport,
    TABLET_VIEWPORT_BREAKPOINT_PX,
    WIDE_VIEWPORT_BREAKPOINT_PX,
  } from '$lib/viewport';
  import { resolvePendingPushAction } from '$lib/push-action-routing';
  import {
    SESSION_STATUS_LABELS,
    SESSION_STATUS_TONES,
    SESSION_STATUS_UNKNOWN_LABEL,
  } from '$lib/session-status';
  import { fuzzyFilter, fuzzyMatch } from '$lib/fuzzy';
  import { themeStore, type ThemePreference } from '$lib/theme';
  import {
    createLocalStorageNotificationPreferencesStorage,
    defaultNotificationPreferences,
    type NotificationPreferences as NotificationPreferencesData,
    type NotificationPreferencesStorage,
  } from '$lib/notification-preferences';
  import {
    createProjectStore,
    projectKey,
    projectNameFromPath,
    sessionProjectKey,
    type NewProject,
    type Project,
  } from '$lib/projects';
  import AddProjectDialog from '$lib/components/AddProjectDialog.svelte';
  import AppearanceSettings from '$lib/components/AppearanceSettings.svelte';
  import AttachmentBar from '$lib/components/AttachmentBar.svelte';
  import BrandLockup from '$lib/components/BrandLockup.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import CommandPalette, { type CommandPaletteAction } from '$lib/components/CommandPalette.svelte';
  import ConfigBar from '$lib/components/ConfigBar.svelte';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import FileReferencePicker from '$lib/components/FileReferencePicker.svelte';
  import FileTreePanel from '$lib/components/FileTreePanel.svelte';
  import Icon from '$lib/components/icons/Icon.svelte';
  import type { IconName } from '$lib/components/icons';
  import InteractiveTerminal from '$lib/components/InteractiveTerminal.svelte';
  import MessageItem from '$lib/components/MessageItem.svelte';
  import NewSessionDialog from '$lib/components/NewSessionDialog.svelte';
  import AddTargetWizard from '$lib/components/AddTargetWizard.svelte';
  import type { FocusTarget as TargetStatusFocusTarget } from '$lib/components/TargetStatusView.svelte';
  import OnboardingGate from '$lib/components/OnboardingGate.svelte';
  import InboxPage from '$lib/components/pages/InboxPage.svelte';
  import NodesPage from '$lib/components/pages/NodesPage.svelte';
  import SettingsPage from '$lib/components/pages/SettingsPage.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import ErrorNotice from '$lib/components/ui/ErrorNotice.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Overlay from '$lib/components/ui/Overlay.svelte';
  import StatusDot, { type StatusTone } from '$lib/components/ui/StatusDot.svelte';
  import PermissionQueueBar from '$lib/components/PermissionQueueBar.svelte';
  import PlanCard from '$lib/components/PlanCard.svelte';
  import ProjectConfigPanel from '$lib/components/ProjectConfigPanel.svelte';
  import QueuedPromptBar from '$lib/components/QueuedPromptBar.svelte';
  import RecoveryCodeEntryForm from '$lib/components/RecoveryCodeEntryForm.svelte';
  import ToolCallRow from '$lib/components/ToolCallRow.svelte';
  import TurnStopControl from '$lib/components/TurnStopControl.svelte';
  import WovenLoader from '$lib/components/WovenLoader.svelte';

  // #381: `PUBLIC_LOOMBOX_RELAY_URL` (SvelteKit `$env/dynamic/public`, read
  // from the deployed process's real environment — see deploy/web/README.md
  // — not `$env/static/public`, since that would bake the value into the
  // JS bundle at image-build time and require a rebuild to ever change it)
  // sets the default a fresh visitor lands on, falling back to the hosted
  // relay when the var isn't set at all (e.g. a bare local dev/test run). A
  // self-hoster running their own relay still overrides it via the "Relay
  // URL" field below, persisted client-side to `RELAY_URL_STORAGE_KEY`,
  // which always wins over this default once set. Better Auth's routes
  // (`/api/auth/*`, SPEC §8) live on that same relay, on the http(s)
  // counterpart of this ws(s) URL.
  const DEFAULT_RELAY_URL = publicEnv.PUBLIC_LOOMBOX_RELAY_URL || 'wss://relay.loombox.dev';
  const RELAY_URL_STORAGE_KEY = 'loombox:relay-url';

  /** `ws(s)://host:port/ws` -> `http(s)://host:port` — Better Auth is mounted on the relay's own Fastify server, not a separate host. */
  function relayHttpBaseUrl(wsUrl: string): string {
    return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  }

  let relayUrl = $state(DEFAULT_RELAY_URL);

  // Real Better Auth login (SPEC §8): GitHub OAuth only, no manually-typed
  // account id. `authStore`/`amkStorage` are only ever constructed client-
  // side (onMount below) — this file is also rendered SSR by
  // `routes/page.test.ts`, where `window`/`localStorage` don't exist.
  let authStore: AuthStore | undefined;
  let amkStorage: ReturnType<typeof createLocalStorageAmkStorage> | undefined;
  // This browser's own stable device id (issue #163's presence check needs
  // the push subscription and the live WS connection to agree on one id —
  // see `device-id-store.ts`'s doc comment), loaded once in `onMount` below.
  // `$state` (not a plain `let`) because the template's `PushNotificationToggle`
  // guard reads it reactively.
  let deviceId = $state<string | undefined>(undefined);
  // The handle backing `deviceId` above — kept around (not just the loaded
  // value) so a new-device bootstrap or a mismatched-AMK re-pair (both issue
  // #384) can persist the FRESH device id the relay just registered, so a
  // later reload/reconnect reuses that same identity instead of registering
  // a second device (`BootstrapAmkResult.deviceId`'s own doc comment).
  let deviceIdStorage: DeviceIdStorage | undefined;
  let authSession = $state<StoredAuthSession | undefined>(undefined);
  // Distinguishes "haven't checked yet" from "checked, not signed in" so the
  // sign-in gate doesn't flash before `restoreSession()` resolves.
  let authChecked = $state(false);
  let authError = $state<string | undefined>(undefined);

  // First-run AMK onboarding (SPEC §8; issue #384): `undefined` until this
  // device's AMK presence has actually been checked (avoids a flash of
  // either the gate or the cockpit before that check runs), then `true`
  // while this browser has no local AMK for the signed-in account yet (the
  // `OnboardingGate` renders instead of the cockpit) or `false` once a
  // usable AMK exists and `connect()` can proceed as before.
  let onboardingNeeded = $state<boolean | undefined>(undefined);
  // Set the moment a first-device onboarding hands back a freshly generated
  // AMK + Recovery Code (`handleFirstDeviceOnboarded`); consumed the moment
  // `connect()`'s own `client.status` store reaches `'open'`
  // (`escrowPendingRecoveryCode`) — escrow needs a live connection, which
  // `OnboardingGate` deliberately doesn't own (see its doc comment).
  let pendingEscrowRecoveryCode: string | undefined;
  // Surfaces the first-device escrow round trip as a real, tasteful loading
  // state on the cockpit itself (issue #384's "tasteful loading state for
  // ... escrow in flight") rather than leaving `OnboardingGate` blocking on
  // it — that component's own job already ended once it handed the pair
  // over. `'idle'` covers both "never escrowing" (every path but first-
  // device onboarding) and "already finished" (cleared once escrow settles).
  let escrowStatus = $state<'idle' | 'in-flight' | 'error'>('idle');
  let escrowError = $state<string | undefined>(undefined);

  // The mismatched-AMK re-pair affordance (issue #384's "surface the
  // mismatched-AMK failure" requirement): shown on the sessions list instead
  // of a bare "No sessions yet." whenever `client.sessionDecryptFailures`
  // reports this device's AMK failed to decrypt sessions that do exist.
  let sessionDecryptFailures = $state(0);
  let rePairBusy = $state(false);
  let rePairError = $state<string | undefined>(undefined);

  // The "New session" flow (SPEC §7.1; issue #385).
  let newSessionOpen = $state(false);
  // The "Add target" zero-touch provision-and-pair wizard (SPEC §7.23; issue #408).
  let addTargetOpen = $state(false);
  // The "Add project" flow (design spec v4 §3.1/§3.4; issue #507): registers
  // a folder once, independent of any session. The sidebar's `+` next to
  // "PROJECTS" and the main-area empty state's own CTA both open this.
  let addProjectOpen = $state(false);
  /** Which project a just-opened `NewSessionDialog` creates into (design spec v4 §3.4): every entry point (a project's own `+ New session` row, its `⋯` menu, ⌘K, the empty-state CTA) sets this before flipping `newSessionOpen`, since the dialog no longer picks a target or a folder itself; both are inherited from this project. */
  let newSessionProject = $state<Project | undefined>(undefined);

  /**
   * What the main area shows (design spec v4 §3.3; issue #507). Closes the
   * gap design spec v4 §1.1 names: v3 drew Inbox/Nodes/Settings twice, once
   * as sidebar rows that toggled a Drawer tab of the same name. Two
   * navigations pointed at the same three destinations. They are `mainView`
   * destinations now, not Drawer tabs; the Drawer keeps only what is scoped
   * to the open session (files/terminal/config, `DrawerTab` below).
   * Selecting a session always sets `'session'`; selecting a destination
   * sets that destination and deliberately LEAVES `selectedSessionId`
   * alone, so returning to the transcript is one click and the header
   * breadcrumb (§3.6) is never lost.
   */
  let mainView = $state<'session' | 'inbox' | 'nodes' | 'settings'>('session');

  /** Display titles for the three `mainView` destinations (design spec v4 §3.6's header): matches each page's own `PageLayout` title exactly (`InboxPage`/`NodesPage`/`SettingsPage`), so the topbar and the page body never disagree about what "here" is called. */
  const MAIN_VIEW_TITLES: Record<'inbox' | 'nodes' | 'settings', string> = {
    inbox: 'Inbox',
    nodes: 'Nodes',
    settings: 'Settings',
  };

  /**
   * The Drawer state (redesign brief `docs/design/redesign.md` §1/§7, issue
   * #427; narrowed by design spec v4 §3.5, issue #507). Used to cover six
   * panels; Inbox/Nodes & targets/Settings are `mainView` destinations now
   * (see above), leaving only the session's own workbench: Files,
   * Terminal, Config, plus `'settings'`, kept solely for the
   * pre-authentication sign-in screen's own minimal Appearance-only
   * affordance below, which reuses this exact same state rather than a
   * parallel boolean (that affordance predates the cockpit and is out of
   * this issue's scope). Every remaining panel component (`FileTreePanel`,
   * `InteractiveTerminal`, `ProjectConfigPanel`, `AppearanceSettings`) keeps
   * its own props/logic/tests unchanged; only the container deciding
   * whether it renders changed.
   */
  type DrawerTab = 'files' | 'terminal' | 'config' | 'settings';
  let activeDrawer = $state<DrawerTab | null>(null);

  /**
   * The Drawer's tab strip, as data (v3 design spec §3.6, kept from v3).
   * Design spec v4 §3.5 drops `inbox`/`targets`/`settings` from this array:
   * those three are `mainView` destinations now, not Drawer tabs, leaving
   * only the session's own workbench. All three remaining tabs are
   * session-scoped and drop out when nothing is selected, exactly as
   * before.
   */
  const DRAWER_TABS: { id: DrawerTab; label: string; icon: IconName; sessionScoped: boolean }[] = [
    { id: 'files', label: 'Files', icon: 'file', sessionScoped: true },
    { id: 'terminal', label: 'Terminal', icon: 'terminal', sessionScoped: true },
    { id: 'config', label: 'Config', icon: 'settings', sessionScoped: true },
  ];
  const drawerTabs = $derived(
    DRAWER_TABS.filter((tab) => !tab.sessionScoped || selectedSessionId !== undefined),
  );
  /** The Drawer's persistent-column mode at `--bp-wide`/`WIDE_VIEWPORT_BREAKPOINT_PX` and above (redesign brief §1's "toggle, persisted per-user"); below that width this is ignored and the Drawer is always an overlay/bottom-sheet — see this file's style block. Restored from `localStorage` in `onMount` below. */
  let drawerPinned = $state(false);
  const DRAWER_PINNED_STORAGE_KEY = 'loombox:drawer-pinned';
  /** True at/below `--bp-wide`/`WIDE_VIEWPORT_BREAKPOINT_PX` (1280px), where `drawerPinned` is ignored and the Drawer is always an overlay/bottom-sheet (see `WIDE_VIEWPORT_BREAKPOINT_PX`'s own doc comment) — a live `matchMedia` read, subscribed in `onMount` below, mirroring `sessionsSheetViewport`'s identical pattern for the Sessions column's own breakpoint. Drives `drawerIsOverlay` below, which is what decides whether the Drawer renders through the shared `Overlay` primitive (issue #462's backdrop-click/Escape close). */
  let drawerNarrowViewport = $state(false);
  /** The mobile/tablet sidebar sheet (redesign v3 design spec §3.1): below `--bp-tablet` the sidebar is a dismissible full-height sheet reached from the bottom tab bar; a no-op at wider viewports where it is always an inline column. */
  let sessionsSheetOpen = $state(false);
  /**
   * The sidebar's account menu (redesign v3 design spec §3.1). An ANCHORED
   * popover, not an `Overlay`: a two-item menu has no business dimming the
   * whole app behind a modal scrim, which is what the v2 header menu did.
   * Dismissal is a `pointerdown` listener on `window` plus Escape, both
   * registered only while it is open.
   */
  let accountMenuOpen = $state(false);
  /** Which project group's `⋯` menu is open, if any, keyed by project id, same one-at-a-time treatment as {@link sessionRowMenuFor} (design spec v4 §3.2). */
  let projectMenuFor = $state<string | undefined>(undefined);
  /** Which session row's `⋯` menu is open, if any — keyed by session id so only one row menu exists at a time. */
  let sessionRowMenuFor = $state<string | undefined>(undefined);
  /** The project group currently showing its name as an editable `<input>` instead of a label: the group menu's "Rename" action (design spec v4 §3.2); `undefined` when no group is being renamed. */
  let renamingProjectId = $state<string | undefined>(undefined);
  /** The in-progress edit for {@link renamingProjectId}: a separate field (not read from the `Project` itself) so an Escape-cancelled rename never touches the store. */
  let renameDraft = $state('');
  /** The sidebar's filter query (design spec v4 §3.2), client-side only, over the same `fuzzyFilter`/`fuzzyMatch` the command palette uses. Matches session title/target as well as project name, so it doubles as a project search. */
  let sessionFilter = $state('');

  /**
   * Closes every anchored popover in the sidebar. Called from the shared
   * `pointerdown`/Escape handlers and before opening a different one, so two
   * popovers can never be open at once (they overlap in the same corner).
   */
  function closeSidebarMenus(): void {
    accountMenuOpen = false;
    projectMenuFor = undefined;
    sessionRowMenuFor = undefined;
    renamingProjectId = undefined;
  }

  const anySidebarMenuOpen = $derived(
    accountMenuOpen ||
      projectMenuFor !== undefined ||
      sessionRowMenuFor !== undefined ||
      renamingProjectId !== undefined,
  );

  /**
   * Dismisses an anchored popover on a pointerdown anywhere outside it.
   * Bound on `window` (capture phase off) only while one is open; the menus
   * themselves stop propagation on their own root, and each trigger toggles
   * its own state on `click`, which fires after this `pointerdown` — hence
   * the `data-sidebar-menu` opt-out marker rather than a naive close-all.
   */
  function handleWindowPointerDown(event: PointerEvent): void {
    if (!anySidebarMenuOpen) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-sidebar-menu]')) return;
    closeSidebarMenus();
  }

  /** Sets (or closes, via `null`) the Drawer's one open tab. */
  function setActiveDrawer(tab: DrawerTab | null): void {
    activeDrawer = tab;
  }

  /** Toggles a Drawer tab: closes it if already open, otherwise opens it (and implicitly replaces whatever other tab was open — only one at a time). */
  function toggleDrawer(tab: DrawerTab): void {
    activeDrawer = activeDrawer === tab ? null : tab;
  }

  /**
   * Whether the Drawer is currently rendering as an overlay (true) rather
   * than a persistent pinned column (false) — the shared `Overlay` primitive
   * (issue #462) only wraps the Drawer in the former case, since a pinned
   * column is part of the layout, not a dismissible overlay (no backdrop, no
   * Escape-to-close). Mirrors `drawerPinned`'s own doc comment: pinning only
   * takes effect at/above `--bp-wide`, so a narrow viewport is always an
   * overlay regardless of the pin preference.
   */
  const drawerIsOverlay = $derived(
    activeDrawer !== null && (!drawerPinned || drawerNarrowViewport),
  );

  /**
   * The Sessions column's own drag-resize + collapse-to-selvage (redesign
   * brief `docs/design/redesign.md` §1, issue #438): width and collapsed
   * state both persist to `localStorage` (mirrors `drawerPinned` above),
   * restored in `onMount` below. `sessionsWidthPx` always holds the user's
   * last dragged-to width even while collapsed, so expanding again restores
   * it rather than snapping back to the default.
   */
  const SESSIONS_WIDTH_STORAGE_KEY = 'loombox:sessions-width';
  const SESSIONS_COLLAPSED_STORAGE_KEY = 'loombox:sessions-collapsed';
  /** 18rem, the redesign brief's default column width, at the app's own 16px base root font size. */
  const DEFAULT_SESSIONS_WIDTH_PX = 288;
  const MIN_SESSIONS_WIDTH_PX = 200;
  const MAX_SESSIONS_WIDTH_PX = 440;
  /** 3.5rem — the icon-only "selvage rail" width (redesign brief §1), matching the left `.rail`'s own 3.5rem. */
  const SESSIONS_SELVAGE_WIDTH_PX = 56;

  let sessionsWidthPx = $state(DEFAULT_SESSIONS_WIDTH_PX);
  let sessionsCollapsed = $state(false);
  /** Which project groups are currently collapsed (design spec v4 §3.2), PERSISTED (unlike v3's transient `collapsedGroupKeys` this replaces): "a project you never use should stay shut across reloads." Keyed by {@link projectKey}, not a project's `id`: an `id` is re-minted if a project is removed and later re-adopted (§4.2's `adoptFromSessions`), while the `(nodeId, targetId, path)` triple stays stable across that cycle. Restored in `onMount`, persisted by the `$effect` below alongside the sessions column's own width/collapsed prefs. A `SvelteSet` (not a plain `Set` wrapped in `$state`) so `.add`/`.delete` are reactive in place, mirroring `planCollapsedBySession`'s own `SvelteMap`. */
  const PROJECT_GROUPS_COLLAPSED_STORAGE_KEY = 'loombox:project-groups-collapsed';
  const collapsedProjectKeys = new SvelteSet<string>();
  /** True only while a drag is in flight — suppresses the width `transition` so the column tracks the pointer instead of visibly lagging behind it. */
  let sessionsResizing = $state(false);
  /** True at/below `--bp-tablet`/`TABLET_VIEWPORT_BREAKPOINT_PX` (768px), where Sessions renders as the full-height sheet (redesign brief §1) rather than an inline column — the icon-only selvage rail is a wide-viewport concept only, so it's parked (not cleared) here rather than in `sessionsCollapsed` itself, which stays the user's actual persisted preference for whenever the viewport widens again. */
  let sessionsSheetViewport = $state(false);

  /** The effective collapsed-to-selvage state once the sheet-viewport override above is applied — what the template actually renders on. */
  const sessionsRailCollapsed = $derived(sessionsCollapsed && !sessionsSheetViewport);
  const sessionsColumnWidthPx = $derived(
    sessionsRailCollapsed ? SESSIONS_SELVAGE_WIDTH_PX : sessionsWidthPx,
  );

  function clampSessionsWidth(px: number): number {
    return Math.min(MAX_SESSIONS_WIDTH_PX, Math.max(MIN_SESSIONS_WIDTH_PX, px));
  }

  /** Toggles the Sessions column between its normal width and the icon-only selvage rail — the column's own edge control and the global `Mod+B` shortcut both call this. */
  function toggleSessionsCollapsed(): void {
    sessionsCollapsed = !sessionsCollapsed;
  }

  /** Starts a drag-resize of the Sessions column from its own edge handle. Uses Pointer Events with `setPointerCapture` directly on the handle, so the temporary move/up listeners live and die with the drag itself — no `window`-level listener to remember to remove. */
  function startSessionsResize(event: PointerEvent): void {
    if (sessionsRailCollapsed || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    sessionsResizing = true;
    const startX = event.clientX;
    const startWidth = sessionsWidthPx;

    function onMove(moveEvent: PointerEvent): void {
      sessionsWidthPx = clampSessionsWidth(startWidth + (moveEvent.clientX - startX));
    }

    function onUp(upEvent: PointerEvent): void {
      handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      sessionsResizing = false;
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  /** Keyboard-accessible resize (arrow keys, when the handle itself has focus) — the same drag affordance, without a pointer. */
  function handleSessionsResizeKeydown(event: KeyboardEvent): void {
    const STEP_PX = 16;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      sessionsWidthPx = clampSessionsWidth(sessionsWidthPx - STEP_PX);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      sessionsWidthPx = clampSessionsWidth(sessionsWidthPx + STEP_PX);
    }
  }

  // The node/target status view (SPEC §7.21; issue #269): this page owns
  // fetching/loading/error/polling, `TargetStatusView` itself is purely
  // presentational (mirrors `NewSessionDialog`'s split with `TargetPicker`).
  // Polling itself runs continuously from the moment the client connects
  // (see `connect()`'s status subscription below), not just while the
  // Drawer's "targets" tab happens to be open — the redesign's always-
  // visible header StatusDot cluster (SPEC brief §1/§6) needs live target
  // health regardless of whether the Drawer is open.
  let targetStatusEntries = $state<TargetListEntry[]>([]);
  let targetStatusLoading = $state(false);
  let targetStatusError = $state<string | undefined>(undefined);
  /** Set when opened from a specific session's target link, so `TargetStatusView` can highlight it (issue #269's "a stalled session's view links back to this status view for its target"). */
  let targetStatusFocus = $state<TargetStatusFocusTarget | undefined>(undefined);
  /** Not `$state`: a timer handle, never rendered — only `targetStatusEntries` above drives the UI. */
  let targetStatusPollHandle: ReturnType<typeof setInterval> | undefined;
  /** How often target status re-polls `listTargets()` while connected (issue #269's "refreshed on a regular interval"). */
  const TARGET_STATUS_POLL_MS = 10_000;

  let status = $state<ConnectionStatus>('idle');
  let sessions = $state<ClientSessionMeta[]>([]);
  let selectedSessionId = $state<string | undefined>(undefined);
  /**
   * The client-side project registry (design spec v4 §4.2; SPEC §6's
   * "Project: any folder ... does not have to be a git repository").
   * Created once, for this component's lifetime. `adoptFromSessions`
   * (called from `connect()`'s own `sessions` subscription below, and
   * again after `removeProject` below) is what keeps every session's
   * project registered even before this device has ever opened
   * `AddProjectDialog`, so an upgrade from v3 shows a populated tree on
   * first load rather than an empty one waiting for a manual Add.
   */
  const projectStore = createProjectStore();
  let projects = $state<Project[]>([]);
  let transcript = $state<TranscriptState | undefined>(undefined);
  let permissionQueue = $state<PermissionQueueState>(createPermissionQueueState());
  let configOptions = $state<AcpConfigOption[]>([]);
  let attachments = $state<ComposerAttachment[]>([]);
  let queuedPrompts = $state<QueuedPrompt[]>([]);
  let draft = $state('');
  // The read-only file-tree panel (SPEC §7.4; issue #171) and the @file
  // reference picker it backs (SPEC §7.25; issue #160). `fileTree` mirrors
  // `RelayClient.fileTreeFor(selectedSessionId)`'s live snapshot; the panel
  // itself is now the Drawer's "files" tab (`activeDrawer`), independent of
  // the picker, which opens on typing '@' in the composer.
  let fileTree = $state<Map<string, FileTreeDirectoryState>>(new Map());
  // The interactive PTY terminal panel (SPEC §7.5; issues #172/#173/#174) is
  // now the Drawer's "terminal" tab (`activeDrawer`). Each time it's opened
  // it mounts a fresh `InteractiveTerminal`, which opens its own new
  // terminal on mount and closes it on unmount (its own doc comment) — so
  // closing the Drawer and reopening the terminal tab opens a new terminal
  // each time, rather than this page tracking one itself (issue #173's
  // "multiple terminals" is the node/client's job below this component, not
  // this page's).
  //
  // The project config surface (SPEC §7.7; issue #366) is now the Drawer's
  // "config" tab (`activeDrawer`); mounts the MCP-server quick-add panel
  // (#188) and the plugin/extension panel (#191). See `ProjectConfigPanel.svelte`.
  let filePickerOpen = $state(false);
  // The index in `draft` where the triggering '@' sits, so a picked file
  // reference replaces exactly the '@partial-query' text the user typed,
  // rather than being appended blindly. `undefined` means "no active
  // trigger" (the picker was opened some other way, or was never opened).
  let atTriggerStart = $state<number | undefined>(undefined);
  // The cross-project attention inbox (SPEC §7.13; issues #167/#168/#169):
  // one live list across every session on this account, independent of
  // which session (if any) is currently selected/open — see
  // `RelayClient.attentionInbox`'s doc comment. Now the Drawer's "inbox"
  // tab (`activeDrawer`).
  let attentionInboxItems = $state<AttentionInboxItem[]>([]);
  // Per-project mute + quiet-hours settings panel (SPEC §7.11, issue #166),
  // now a section of the Drawer's "settings" tab (`activeDrawer`), alongside
  // Appearance below. `notificationPreferencesStorage` is only ever
  // constructed client-side (onMount below, same reason `amkStorage` is) —
  // `localStorage` doesn't exist during `routes/page.test.ts`'s SSR render.
  let notificationPreferencesStorage = $state<NotificationPreferencesStorage | undefined>(
    undefined,
  );
  let notificationPreferences = $state<NotificationPreferencesData>(
    defaultNotificationPreferences(),
  );
  // Design tokens' theme toggle (SPEC.md §4/issue #195): mirrors
  // `$lib/theme.ts`'s store so the settings panel's toggle reflects the
  // current preference; the actual `data-theme` DOM effect and
  // localStorage persistence happen in `theme.ts` itself, not here.
  let themePreference = $state<ThemePreference>('system');
  // Appearance settings (SPEC.md §4; issues #194/#376: theme radios and the
  // accent preset/custom picker) are now the other section of the Drawer's
  // "settings" tab post-authentication, and the sign-in screen's own
  // minimal `activeDrawer === 'settings'` affordance pre-authentication.
  // `AppearanceSettings` itself owns all the reading/writing against
  // `theme.ts`/`accent.ts`.

  // The fuzzy command palette (SPEC §7.3; issue #132).
  let paletteOpen = $state(false);
  // Narrow-viewport permission footer (SPEC §7.3; issue #134) — a live
  // `matchMedia` read, client-only (see `viewport.ts`'s doc comment for why
  // it defaults `false` during SSR).
  let narrowViewport = $state(false);
  /**
   * The composer's own mini-toolbar collapse (redesign brief
   * `docs/design/redesign.md` §1: "below 480px, the composer's mini-toolbar
   * (mode/attach/context meter) collapses under a single '···' expand
   * affordance", issue #439). Manual toggle only matters at/below
   * `narrowViewport` (480px) — see `composerToolbarVisible` below, which
   * also force-expands whenever there's a real pending attachment to show,
   * so a file the user already attached never hides behind an unopened
   * "···".
   */
  let composerToolbarExpanded = $state(false);
  /** A live ref to the composer `<textarea>` (auto-grow + programmatic height reset, redesign brief §4 "Inputs", issue #439). */
  let composerTextarea: HTMLTextAreaElement | undefined = $state(undefined);
  // Stale-approve/deny discard note for the selected session (SPEC §7.3;
  // issue #131) — `undefined` until one has happened.
  let staleNotice = $state<{ requestId: string; message: string } | undefined>(undefined);
  // A plan's collapse state persists per session for as long as this tab
  // stays open (SPEC §7.24 "remembers collapse state during the session"),
  // keyed by session id so switching sessions and back preserves it.
  // `SvelteMap` (not a plain `Map` wrapped in `$state`) so `.set()` itself
  // triggers reactivity instead of requiring a clone-and-reassign dance.
  const planCollapsedBySession = new SvelteMap<string, boolean>();

  // Live per-session status badge for the session list (SPEC §7.13/§7.24;
  // issue #126 "list updates live as session status changes"). Every
  // currently-listed session gets its own `RelayClient.statusFor`
  // subscription — not only the selected one, since the badge must be
  // visible for every session in the list, not just the one currently open.
  const sessionStatuses = new SvelteMap<string, AcpSessionStatus | undefined>();
  const sessionStatusUnsubscribers = new SvelteMap<string, () => void>();

  /** (Re)syncs `sessionStatuses`' subscriptions to exactly the currently-listed sessions — called every time `client.sessions` emits. */
  function syncSessionStatusSubscriptions(list: ClientSessionMeta[]): void {
    if (!client) return;
    const activeClient = client;
    const currentIds = new Set(list.map((session) => session.id));
    for (const [id, unsubscribe] of sessionStatusUnsubscribers) {
      if (currentIds.has(id)) continue;
      unsubscribe();
      sessionStatusUnsubscribers.delete(id);
      sessionStatuses.delete(id);
    }
    for (const session of list) {
      if (sessionStatusUnsubscribers.has(session.id)) continue;
      const unsubscribe = activeClient
        .statusFor(session.id)
        .subscribe((value) => sessionStatuses.set(session.id, value));
      sessionStatusUnsubscribers.set(session.id, unsubscribe);
    }
  }

  function clearSessionStatusSubscriptions(): void {
    for (const unsubscribe of sessionStatusUnsubscribers.values()) unsubscribe();
    sessionStatusUnsubscribers.clear();
    sessionStatuses.clear();
  }

  // Persistence for the four client-side UI preferences below (relay URL,
  // Drawer pin, Sessions width/collapsed) is gated on this flag because in
  // Svelte 5 `onMount` is itself just another user effect, scheduled in
  // DECLARATION order alongside `$effect` — these effects are declared
  // above `onMount`, so on a fresh load they used to run FIRST and write
  // each preference's compile-time default over the persisted value before
  // `onMount` ever got to read it back (a self-hoster's relay URL, a pinned
  // Drawer, and a resized/collapsed Sessions column were all silently lost
  // on every reload). `onMount` flips this once it has restored, after
  // which every later change persists exactly as before.
  let preferencesRestored = false;

  // Persists an operator-edited relay URL as soon as it changes (not just on
  // submit) so it survives the full-page reload a real OAuth redirect does —
  // see `onMount`'s restore of the same key. `$effect` is client/DOM-only in
  // Svelte 5 (never runs during `routes/page.test.ts`'s SSR render).
  $effect(() => {
    const value = relayUrl;
    if (!preferencesRestored) return;
    localStorage.setItem(RELAY_URL_STORAGE_KEY, value);
  });

  // Persists the Drawer's pinned-column preference (redesign brief §1)
  // the same way — see `onMount`'s restore of the same key below.
  $effect(() => {
    const value = drawerPinned;
    if (!preferencesRestored) return;
    localStorage.setItem(DRAWER_PINNED_STORAGE_KEY, value ? '1' : '0');
  });

  // Persists the Sessions column's own drag-resized width + collapsed-to-
  // selvage preference (redesign brief §1, issue #438) — see `onMount`'s
  // restore of the same two keys below.
  $effect(() => {
    const value = sessionsWidthPx;
    if (!preferencesRestored) return;
    localStorage.setItem(SESSIONS_WIDTH_STORAGE_KEY, String(value));
  });
  $effect(() => {
    const value = sessionsCollapsed;
    if (!preferencesRestored) return;
    localStorage.setItem(SESSIONS_COLLAPSED_STORAGE_KEY, value ? '1' : '0');
  });
  // Design spec v4 §3.2: persists whichever project groups are currently
  // collapsed. Reads `collapsedProjectKeys` by spreading it, so this
  // effect re-runs on every `.add`/`.delete` (`SvelteSet` mutation is
  // reactive in place, same as every other persisted-Set/Map in this file).
  $effect(() => {
    const keys = Array.from(collapsedProjectKeys);
    if (!preferencesRestored) return;
    localStorage.setItem(PROJECT_GROUPS_COLLAPSED_STORAGE_KEY, JSON.stringify(keys));
  });

  const planCollapsed = $derived(
    selectedSessionId ? (planCollapsedBySession.get(selectedSessionId) ?? false) : false,
  );
  const permissionHead = $derived(
    selectedSessionId ? headPermissionRequest(permissionQueue, selectedSessionId) : undefined,
  );
  // Issue #366: the project config surface is scoped to the selected
  // session's `projectPath` (v1 has no separate project entity yet, same
  // "project" notion `NotificationPreferences`'s `projectPaths` below uses).
  const selectedProjectPath = $derived(
    sessions.find((session) => session.id === selectedSessionId)?.projectPath,
  );
  // Issue #155's send-gate: disabled while any attachment is mid-upload or failed.
  const sendDisabled = $derived(draft.trim() === '' || hasBlockingAttachments(attachments));

  /** See `composerToolbarExpanded`'s own doc comment above — the effective visibility the template renders on. */
  const composerToolbarVisible = $derived(
    !narrowViewport || composerToolbarExpanded || attachments.length > 0,
  );

  /**
   * True once the full four-zone Warp Deck shell (rail/sessions/canvas/
   * drawer, redesign brief §1) should render instead of the plain lockup
   * header used for checking-session/sign-in/onboarding — those three
   * stay exactly as before (the redesign brief reserves the full
   * `BrandLockup` for "sign-in/onboarding, where nothing competes for
   * attention"; only the actual cockpit gets the new compact header).
   */
  const cockpitReady = $derived(!!authSession && onboardingNeeded === false);

  /** The selected session itself — the header's breadcrumb needs its project/target, not just its title. */
  const selectedSession = $derived(sessions.find((session) => session.id === selectedSessionId));

  /**
   * What the sidebar's account row calls the signed-in person (spec §3.1 /
   * defect A2): their name, else their email, else — only when the identity
   * provider gave neither — the raw account id, which is what every build
   * before this one showed unconditionally.
   */
  const accountLabel = $derived(
    authSession?.displayName ?? authSession?.email ?? authSession?.accountId ?? '',
  );
  const accountInitial = $derived(accountLabel.charAt(0).toUpperCase() || '?');

  /**
   * The header's connection state (redesign v3 design spec §3.3). Rendered
   * ONLY when the connection is not healthy: a permanently green dot in the
   * app's highest-attention corner spent those pixels saying nothing, so a
   * healthy connection now shows nothing at all and every other state gets
   * a labelled chip with a retry.
   */
  const connectionNotice = $derived.by(
    (): { tone: StatusTone; label: string; retry: boolean } | undefined => {
      switch (status) {
        case 'open':
          return undefined;
        case 'connecting':
          return { tone: 'warning', label: 'Connecting…', retry: false };
        case 'closed':
          return { tone: 'warning', label: 'Reconnecting…', retry: true };
        case 'error':
          return { tone: 'danger', label: 'Offline', retry: true };
        default:
          return { tone: 'neutral', label: 'Not connected', retry: false };
      }
    },
  );

  // Most logic (the WS connection, the E2E-encrypted session list, the
  // transcript decrypt+reduce, the permission queue, config options, and the
  // composer's send path) lives in $lib/relay-client.ts, unit-tested there
  // against a real in-process relay plus a fake independently-keyed node —
  // no browser. This component renders that module's stores through the
  // Wave D.2 widget set ($lib/components/*): tier-1/tier-2 tool-call
  // widgets, the diff viewer, the inline plan card, the permission FIFO
  // queue bar, and the config bar, each unit-tested on its own against fixed
  // fixtures rather than through this page.
  /**
   * `$state`, not a plain `let`: the template gates the Terminal drawer
   * panel on `client` and hands it to `NewSessionDialog`/`AddTargetWizard`,
   * so a plain assignment in `connect()` left those surfaces looking at a
   * stale `undefined` — the Svelte compiler has been warning about exactly
   * this (`non_reactive_update`) since the runes migration.
   */
  let client = $state<RelayClient | undefined>(undefined);
  let unsubscribeStatus: (() => void) | undefined;
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeSessionDecryptFailures: (() => void) | undefined;
  let unsubscribeTranscript: (() => void) | undefined;
  let unsubscribePermissionQueue: (() => void) | undefined;
  let unsubscribeConfigOptions: (() => void) | undefined;
  let unsubscribeAttachments: (() => void) | undefined;
  let unsubscribeQueuedPrompts: (() => void) | undefined;
  let unsubscribeAttentionInbox: (() => void) | undefined;
  let unsubscribeStaleNotice: (() => void) | undefined;
  let unsubscribeFileTree: (() => void) | undefined;

  // #164: "tapping/clicking a notification opens directly to the relevant
  // session" — the service worker's `notificationclick` handler
  // (`push-payload.ts`'s `sessionUrlFromNotificationData`) opens/focuses
  // this app at `?session=<id>`; this is the other half, read once on
  // mount and consumed as soon as that session actually shows up in the
  // account's session list (which may arrive after this page has already
  // loaded and connected).
  let pendingSessionIdFromUrl: string | undefined;

  // #165: an approve/deny tap on a push notification's action button landed
  // here as `?session=<id>&action=approve|deny` — the other half of
  // `push-action-routing.ts`'s `resolvePendingPushAction`. Consumed as soon
  // as this session's real permission queue arrives (may be empty on the
  // very first emission, if the request itself hasn't reached this device
  // yet — `maybeResolvePendingPushAction` below is re-checked on every
  // subsequent queue update until it resolves or the session changes).
  let pendingPushActionFromUrl: string | undefined;

  /** #165: resolves `pendingPushActionFromUrl` against `sessionId`'s live queue the moment its FIFO head can satisfy it, via the exact same `RelayClient.resolvePermission` call a manual `PermissionCard` tap makes. */
  function maybeResolvePendingPushAction(sessionId: string, queue: PermissionQueueState): void {
    if (!client || !pendingPushActionFromUrl) return;
    const resolution = resolvePendingPushAction(queue, sessionId, pendingPushActionFromUrl);
    if (!resolution) return;
    client.resolvePermission(sessionId, resolution.requestId, resolution.option);
    pendingPushActionFromUrl = undefined;
  }

  function selectSession(id: string): void {
    selectedSessionId = id;
    // Design spec v4 §3.3: picking a session always shows the transcript,
    // even if a destination (Inbox/Nodes/Settings) was showing a moment ago:
    // selecting a session is never a no-op just because you were looking
    // at a page.
    mainView = 'session';
    // Redesign brief §1: picking a session dismisses the mobile Sessions
    // sheet (a no-op at wider viewports, where it's never open).
    sessionsSheetOpen = false;
    unsubscribeTranscript?.();
    unsubscribePermissionQueue?.();
    unsubscribeConfigOptions?.();
    unsubscribeAttachments?.();
    unsubscribeQueuedPrompts?.();
    unsubscribeStaleNotice?.();
    unsubscribeFileTree?.();
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
    attachments = [];
    queuedPrompts = [];
    staleNotice = undefined;
    fileTree = new Map();
    composerToolbarExpanded = false;
    if (!client) return;
    unsubscribeTranscript = client.transcriptFor(id).subscribe((value) => (transcript = value));
    unsubscribePermissionQueue = client.permissionQueueFor(id).subscribe((value) => {
      permissionQueue = value;
      maybeResolvePendingPushAction(id, value);
    });
    unsubscribeConfigOptions = client
      .configOptionsFor(id)
      .subscribe((value) => (configOptions = value));
    unsubscribeAttachments = client.attachmentsFor(id).subscribe((value) => (attachments = value));
    unsubscribeQueuedPrompts = client
      .queuedPromptsFor(id)
      .subscribe((value) => (queuedPrompts = value));
    unsubscribeStaleNotice = client.staleNoticeFor(id).subscribe((value) => (staleNotice = value));
    // SPEC §7.4/issue #171: lazily loads the root directory the moment this
    // session is selected; deeper directories only load on an explicit
    // expand (file-tree panel click) or the @file picker's own bounded
    // opportunistic walk (`FileReferencePicker.svelte`).
    unsubscribeFileTree = client.fileTreeFor(id).subscribe((value) => (fileTree = value));
  }

  /** Wired to both `FileTreePanel`'s and `FileReferencePicker`'s `onExpand` (SPEC §7.4; issue #171). */
  function expandDirectory(path: string): void {
    if (!client || !selectedSessionId) return;
    client.expandDirectory(selectedSessionId, path);
  }

  /**
   * Connects the relay's WS session once this device has both halves of
   * real v1 auth (SPEC §8): a Better Auth bearer token (the WS handshake's
   * `authToken` — no longer a stub) and this device's own persisted AMK.
   * Unlike the old dev-hack this replaces, the AMK is never silently
   * generated here — `beginSessionFor` only ever calls this once
   * `amkStorage` already holds one for this account (real onboarding, issue
   * #384, having produced it via `handleFirstDeviceOnboarded`/
   * `handleNewDeviceOnboarded`/`rePairWithRecoveryCode` below, or a prior
   * visit having already run one of those).
   */
  function connect(session: StoredAuthSession): void {
    if (typeof window === 'undefined' || client || !amkStorage) return;
    const amk = amkStorage.get(session.accountId);
    if (!amk) return; // guarded by beginSessionFor; defensive no-op otherwise
    client = new RelayClient({
      relayUrl,
      amk,
      accountId: session.accountId,
      authToken: session.token,
      // #163: reuse the same persisted device id the push subscription
      // registers under, so the relay's presence check can actually match
      // this connection against that subscription's `deviceId`.
      deviceId,
    });
    unsubscribeStatus = client.status.subscribe((value) => {
      status = value;
      // Issue #384: the first-device onboarding path hands `AMK`/Recovery
      // Code persistence off to this function, but escrowing that code
      // needs a LIVE connection (`RelayClient.escrowAmk`) — the moment this
      // freshly constructed client actually reaches `'open'` is the first
      // point that's true.
      if (value === 'open') {
        if (pendingEscrowRecoveryCode) void escrowPendingRecoveryCode();
        // Redesign brief §1/§6: target status now polls continuously from
        // connect (not only while the Drawer's "targets" tab happens to be
        // open) so the header's always-visible StatusDot cluster has live
        // data regardless of whether the Drawer is open.
        startTargetStatusPolling();
      }
    });
    unsubscribeSessions = client.sessions.subscribe((value) => {
      sessions = value;
      // Design spec v4 §4.2: registers a project for every session's
      // `(nodeId, targetId, projectPath)` triple that has no entry yet.
      // Idempotent and cheap, safe to call on every emission.
      projectStore.adoptFromSessions(value);
      syncSessionStatusSubscriptions(value);
      // #166: the session list is where this device's `sessionId ->
      // projectPath` map comes from — re-sync every time it changes so the
      // service worker's mute check never acts on a stale map.
      syncNotificationPreferencesToServiceWorker();
      if (pendingSessionIdFromUrl && value.some((s) => s.id === pendingSessionIdFromUrl)) {
        selectSession(pendingSessionIdFromUrl);
        pendingSessionIdFromUrl = undefined;
      } else if (!selectedSessionId && value[0]) {
        selectSession(value[0].id);
      }
    });
    // Issue #384's mismatched-AMK state: today's silent decrypt-drop gets a
    // real, distinguishable count instead of just an ever-empty `sessions`.
    unsubscribeSessionDecryptFailures = client.sessionDecryptFailures.subscribe(
      (value) => (sessionDecryptFailures = value),
    );
    unsubscribeAttentionInbox = client
      .attentionInbox()
      .subscribe((value) => (attentionInboxItems = value));
    client.connect();
  }

  /**
   * Decides, once a Better Auth session actually exists, whether this
   * browser can proceed straight to `connect()` (it already holds this
   * account's AMK) or needs real onboarding first (issue #384) — replacing
   * the old unconditional `connect(value)` this subscription used to call,
   * which is exactly what let every browser silently mint its own
   * independent AMK.
   */
  function beginSessionFor(session: StoredAuthSession): void {
    if (!amkStorage) return; // amkStorage is assigned synchronously before this can run (onMount)
    if (amkStorage.get(session.accountId)) {
      onboardingNeeded = false;
      connect(session);
    } else {
      onboardingNeeded = true;
    }
  }

  /**
   * The header connection chip's retry (redesign v3 design spec §3.3). The
   * old header rendered connection state as an unlabelled dot with no way
   * to act on it; a bad state now says what it is and offers the one thing
   * a user can do about it — tear the dead client down and dial again from
   * scratch, exactly what a reload used to be needed for.
   */
  function retryConnection(): void {
    if (!authSession) return;
    disconnect();
    beginSessionFor(authSession);
  }

  /** `OnboardingGate`'s first-device path (issue #384): persists the freshly generated AMK, defers escrowing its Recovery Code until `connect()`'s own client reaches `'open'` (see that function's doc comment), then proceeds into the cockpit. */
  function handleFirstDeviceOnboarded(amk: Uint8Array, recoveryCode: string): void {
    if (!amkStorage || !authSession) return;
    amkStorage.set(authSession.accountId, amk);
    pendingEscrowRecoveryCode = recoveryCode;
    escrowStatus = 'in-flight';
    escrowError = undefined;
    onboardingNeeded = false;
    connect(authSession);
  }

  /** `OnboardingGate`'s new-device path (issue #384): persists the AMK `bootstrapAmkFromRecoveryCode` already recovered from the relay's escrow, adopts the freshly registered device identity (so a later reload/reconnect reuses it rather than registering a second device — `BootstrapAmkResult.deviceId`'s doc comment), and proceeds into the cockpit. No escrow needed here: the account's Recovery Code already has an escrowed AMK, or this bootstrap couldn't have succeeded. */
  function handleNewDeviceOnboarded(result: BootstrapAmkResult): void {
    if (!amkStorage || !authSession) return;
    amkStorage.set(authSession.accountId, result.amk);
    deviceId = result.deviceId;
    deviceIdStorage?.set(result.deviceId);
    onboardingNeeded = false;
    connect(authSession);
  }

  /** Sends this first device's already-confirmed Recovery Code up to the relay the moment its connection opens (see `connect()`'s `client.status` subscription) — a real, tasteful loading state (`escrowStatus`) rather than a silent fire-and-forget. */
  async function escrowPendingRecoveryCode(): Promise<void> {
    const code = pendingEscrowRecoveryCode;
    if (!code || !client) return;
    pendingEscrowRecoveryCode = undefined;
    try {
      await client.escrowAmk(code);
      escrowStatus = 'idle';
    } catch (error) {
      escrowStatus = 'error';
      escrowError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * The mismatched-AMK re-pair affordance (issue #384): reruns the exact
   * same new-device bootstrap `OnboardingGate` uses, then reconnects with
   * the recovered AMK — this browser had SOME AMK already (hence the
   * mismatch, not the onboarding gate), so this replaces it outright rather
   * than layering a second one.
   */
  async function rePairWithRecoveryCode(code: string): Promise<void> {
    if (!amkStorage || !authSession) return;
    rePairBusy = true;
    rePairError = undefined;
    try {
      const result = await bootstrapAmkFromRecoveryCode({
        relayUrl,
        accountId: authSession.accountId,
        authToken: authSession.token,
        recoveryCode: code,
      });
      amkStorage.set(authSession.accountId, result.amk);
      deviceId = result.deviceId;
      deviceIdStorage?.set(result.deviceId);
      disconnect();
      connect(authSession);
    } catch (error) {
      rePairError = error instanceof Error ? error.message : String(error);
    } finally {
      rePairBusy = false;
    }
  }

  /**
   * Every "New session" entry point converges here (design spec v4 §3.4):
   * the tree row's own `+ New session`, a project group's `⋯` menu, and
   * the main-area empty state all just need to say WHICH project: the
   * dialog inherits its target/folder from `project`, it no longer picks
   * either itself.
   */
  function openNewSessionDialogFor(project: Project): void {
    newSessionProject = project;
    newSessionOpen = true;
  }

  /** The "Add project" flow's entry point (design spec v4 §3.1/§3.4), wired to the sidebar's `PROJECTS` header `+` and the main-area empty state's own CTA. */
  function openAddProjectDialog(): void {
    addProjectOpen = true;
  }

  /** `AddProjectDialog`'s success callback (design spec v4 §4.3): the dialog is pure and never touches the registry itself (`ProjectStore.add` is idempotent on an already-known `(nodeId, targetId, path)`, so a re-add of an adopted project just fills in its `isGitRepo`). */
  function handleProjectCreated(project: NewProject): void {
    projectStore.add(project);
    addProjectOpen = false;
  }

  /** The "Add target" zero-touch provision-and-pair wizard's entry point (SPEC §7.23; issue #408), wired to the Nodes page's own two setup actions (design spec v4 §3.1: "Add target" / "Connect a node" both move here from the old sidebar split menu). This codebase has exactly one such flow today: `AddTargetWizard` already covers both "pair a new node" and "provision its first target" in one guided run (SPEC §7.23's steps 1-3), so both actions open the same wizard rather than a second, not-yet-built one. */
  function openAddTargetWizard(): void {
    addTargetOpen = true;
  }

  /** One `listTargets()` round trip for the status view (issue #269). `loading` only flips on for the very first fetch (an empty-so-far list) — a background refresh reusing an already-populated list never re-shows the loading state, so live polling doesn't flicker the whole panel every 10s. */
  async function refreshTargetStatus(): Promise<void> {
    if (!client) return;
    const activeClient = client;
    if (targetStatusEntries.length === 0) targetStatusLoading = true;
    try {
      const targets = await activeClient.listTargets();
      targetStatusEntries = targets;
      targetStatusError = undefined;
    } catch (error) {
      targetStatusError = error instanceof Error ? error.message : String(error);
    } finally {
      targetStatusLoading = false;
    }
  }

  /** Starts (idempotently) the continuous `listTargets()` poll (issue #269's "refreshed on a regular interval") — called once the client connects, not when any particular UI opens; see `connect()`'s status subscription. */
  function startTargetStatusPolling(): void {
    void refreshTargetStatus();
    if (targetStatusPollHandle === undefined) {
      targetStatusPollHandle = setInterval(() => void refreshTargetStatus(), TARGET_STATUS_POLL_MS);
    }
  }

  function stopTargetStatusPolling(): void {
    if (targetStatusPollHandle !== undefined) {
      clearInterval(targetStatusPollHandle);
      targetStatusPollHandle = undefined;
    }
  }

  /** The Nodes destination's entry point (SPEC §7.21; issue #269; design spec v4 §3.1/§3.3): `focus` optionally scopes the highlight to one session's target (wired from the session row's own `⋯` menu below). Polling itself is already running (`startTargetStatusPolling`, connection-scoped); this just switches the main area and requests an immediate refresh so the view isn't stale from the moment it's shown. */
  function openTargetStatus(focus?: TargetStatusFocusTarget): void {
    targetStatusFocus = focus;
    mainView = 'nodes';
    void refreshTargetStatus();
  }

  /** `NewSessionDialog`'s success callback (issue #385): the session already exists by the time this fires (the dialog only closes/reports once `RelayClient.createSession` resolved), so opening it is just the same `selectSession` any other session click uses. */
  function handleSessionCreated(sessionId: string): void {
    selectSession(sessionId);
  }

  function disconnect(): void {
    unsubscribeStatus?.();
    unsubscribeSessions?.();
    unsubscribeSessionDecryptFailures?.();
    unsubscribeTranscript?.();
    unsubscribePermissionQueue?.();
    unsubscribeConfigOptions?.();
    unsubscribeAttachments?.();
    unsubscribeQueuedPrompts?.();
    unsubscribeAttentionInbox?.();
    unsubscribeStaleNotice?.();
    unsubscribeFileTree?.();
    clearSessionStatusSubscriptions();
    client?.close();
    client = undefined;
    status = 'idle';
    sessions = [];
    sessionDecryptFailures = 0;
    selectedSessionId = undefined;
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
    attachments = [];
    queuedPrompts = [];
    attentionInboxItems = [];
    staleNotice = undefined;
    paletteOpen = false;
    fileTree = new Map();
    filePickerOpen = false;
    atTriggerStart = undefined;
    composerToolbarExpanded = false;
    newSessionOpen = false;
    newSessionProject = undefined;
    addProjectOpen = false;
    // Design spec v4 §3.3: back to the transcript/empty-state view, same
    // reasoning as every other per-connection UI reset below: none of
    // Inbox/Nodes/Settings has anything live to show once disconnected.
    mainView = 'session';
    closeSidebarMenus();
    // Closes whatever Drawer tab was open (files/terminal/config); none of
    // them have anything to show once disconnected.
    setActiveDrawer(null);
    stopTargetStatusPolling();
    targetStatusEntries = [];
    targetStatusError = undefined;
    targetStatusFocus = undefined;
  }

  function ensureAuthStore(): AuthStore {
    authStore ??= new AuthStore({ relayBaseUrl: relayHttpBaseUrl(relayUrl) });
    return authStore;
  }

  /** SPEC §8: login is Google/GitHub OAuth only — this starts the real browser redirect to the relay's Better Auth. */
  async function signInWithGithub(): Promise<void> {
    authError = undefined;
    try {
      await ensureAuthStore().signInWithGithub(window.location.href);
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error);
    }
  }

  async function signOut(): Promise<void> {
    disconnect();
    await authStore?.signOut();
  }

  function submitPrompt(event: Event): void {
    event.preventDefault();
    const text = draft.trim();
    if (!client || !selectedSessionId || text === '' || sendDisabled) return;
    const attachmentIds = attachments.map((a) => a.id);
    client.sendPrompt(selectedSessionId, text, attachmentIds);
    draft = '';
  }

  /** Warp Deck composer convention (redesign brief §4 "Inputs", issue #439): Enter sends, Shift+Enter inserts a newline — the same auto-growing `<textarea>` behavior `NewSessionDialog`'s starting-prompt field already brings to parity with. Composition (IME) `Enter` keystrokes confirm the candidate instead of submitting mid-composition. */
  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submitPrompt(event);
  }

  /** Grows the composer textarea with its content, 1–8 rows (redesign brief §4) — this file's own CSS (`max-height`/`overflow-y: auto` on `.composer-row textarea`) caps the visible growth past 8 rows and lets it scroll internally past that point. */
  function autoGrowComposer(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  // Resets the textarea's own inline height back to its single-row default
  // whenever `draft` is cleared *programmatically* (after a send, or on
  // disconnect) — `autoGrowComposer` above only ever runs from a real
  // `oninput` DOM event, which a plain `draft = ''` assignment never fires.
  $effect(() => {
    if (draft === '' && composerTextarea) {
      composerTextarea.style.height = 'auto';
    }
  });

  /** Wired to `AttachmentBar`'s `onFiles` (paste/drop/pick, SPEC §7.25) — attaches each picked file to the current session, starting its encrypt+upload immediately. */
  function attachFiles(files: File[]): void {
    if (!client || !selectedSessionId) return;
    for (const file of files) {
      client.attachFile(selectedSessionId, file);
    }
  }

  function retryAttachment(id: string): void {
    if (!client || !selectedSessionId) return;
    client.retryAttachment(selectedSessionId, id);
  }

  function removeAttachment(id: string): void {
    if (!client || !selectedSessionId) return;
    client.removeAttachment(selectedSessionId, id);
  }

  /**
   * Detects an `@`-trigger in the composer as the user types (SPEC §7.25
   * "@file references"; issue #160): whenever the text immediately before
   * the caret ends with `@` followed by a run of non-whitespace (no space
   * yet typed after the `@`), the picker opens/stays open, scoped to that
   * partial query; typing a space, deleting back past the `@`, or moving
   * the caret elsewhere closes it. `atTriggerStart` records where the `@`
   * itself sits so {@link insertFileReference} replaces exactly the
   * `@partial-query` text rather than guessing.
   */
  function handleComposerInput(event: Event): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    autoGrowComposer(input);
    const caret = input.selectionStart ?? draft.length;
    const beforeCaret = draft.slice(0, caret);
    const match = /(?:^|\s)@(\S*)$/.exec(beforeCaret);
    if (match) {
      atTriggerStart = beforeCaret.length - match[1].length - 1;
      filePickerOpen = true;
    } else {
      filePickerOpen = false;
      atTriggerStart = undefined;
    }
  }

  /**
   * Inserts a `@path` reference into the composer (SPEC §7.25; issue #160)
   * — the actual `ResourceLink`/`EmbeddedResource` hand-off to the agent is
   * the provider adapter's job at prompt-build time (out of this wave's
   * `apps/web`-only scope); here it is plain text in the draft, exactly
   * like every other word the user types, since it costs nothing beyond the
   * reference itself (no upload/encryption round trip). Replaces the
   * triggering `@partial-query` text when opened via `@`-typing; otherwise
   * (e.g. picked directly from the file-tree panel) appends it at the end.
   */
  function insertFileReference(path: string): void {
    if (atTriggerStart !== undefined) {
      const before = draft.slice(0, atTriggerStart);
      const afterTrigger = draft.slice(atTriggerStart);
      const afterQuery = /^@\S*/.exec(afterTrigger)?.[0] ?? '@';
      const rest = draft.slice(atTriggerStart + afterQuery.length).replace(/^\s+/, '');
      draft = `${before}@${path} ${rest}`;
    } else {
      const needsSpace = draft !== '' && !draft.endsWith(' ');
      draft = `${draft}${needsSpace ? ' ' : ''}@${path} `;
    }
    closeFilePicker();
  }

  function closeFilePicker(): void {
    filePickerOpen = false;
    atTriggerStart = undefined;
  }

  function togglePlanCollapsed(): void {
    if (!selectedSessionId) return;
    planCollapsedBySession.set(
      selectedSessionId,
      !(planCollapsedBySession.get(selectedSessionId) ?? false),
    );
  }

  function resolvePermission(requestId: string, option: AcpPermissionOption): void {
    if (!client || !selectedSessionId) return;
    client.resolvePermission(selectedSessionId, requestId, option);
  }

  /** SPEC §7.3/§7.24; issue #129 — the turn-level Stop/interrupt, distinct from any rollback affordance. See `RelayClient.interruptTurn`'s doc comment. */
  function stopSession(): void {
    if (!client || !selectedSessionId) return;
    client.interruptTurn(selectedSessionId);
  }

  /** SPEC §7.3 "Keyboard & command palette" (issue #132) — the palette's action list, rebuilt from current state so it always reflects what's actually doable right now (e.g. Stop only appears while a turn is active). */
  const paletteActions = $derived.by((): CommandPaletteAction[] => {
    const actions: CommandPaletteAction[] = [];
    if (selectedSessionId && transcript?.turnActive) {
      actions.push({
        id: 'stop-turn',
        label: 'Stop current turn',
        shortcut: 'Mod+.',
        run: stopSession,
      });
    }
    actions.push({
      id: 'open-inbox',
      label: 'Open attention inbox',
      run: () => (mainView = 'inbox'),
    });
    return actions;
  });

  const paletteSessions = $derived(
    sessions.map((session) => ({
      id: session.id,
      title: session.title,
      projectPath: session.projectPath,
    })),
  );

  // #166: v1 has no separate project entity yet — the mute list is keyed by
  // this account's currently-known distinct `projectPath`s.
  const projectPaths = $derived(
    Array.from(new Set(sessions.map((session) => session.projectPath))).sort(),
  );

  /** Compact per-target health, for the header's always-visible StatusDot cluster (redesign brief §1/§6) — mirrors `TargetStatusView.svelte`'s own local `healthState()` classification so the header dots and the Drawer's "targets" tab detail never disagree, without either importing internals from the other (that component stays purely presentational and untouched by this issue). */
  const TARGET_OVERLOAD_PERCENT = 90;
  type TargetHealthDotState = 'healthy' | 'overloaded' | 'unreachable' | 'no-data';
  function classifyTargetHealth(target: TargetListEntry): TargetHealthDotState {
    if (!target.reachable) return 'unreachable';
    if (!target.health) return 'no-data';
    if (!target.health.healthy) return 'unreachable';
    const { cpuPercent, memPercent, diskPercent } = target.health;
    if (
      cpuPercent >= TARGET_OVERLOAD_PERCENT ||
      memPercent >= TARGET_OVERLOAD_PERCENT ||
      diskPercent >= TARGET_OVERLOAD_PERCENT
    ) {
      return 'overloaded';
    }
    return 'healthy';
  }
  const targetHealthDots = $derived(
    targetStatusEntries.map((target) => ({
      key: `${target.nodeId}:${target.targetId}`,
      label: target.label ?? target.targetId,
      state: classifyTargetHealth(target),
    })),
  );
  const hasUnhealthyTarget = $derived(
    targetHealthDots.some((dot) => dot.state === 'unreachable' || dot.state === 'overloaded'),
  );

  /**
   * Sessions clustered under their target/node (redesign brief §1/§4, issue
   * #438): shown only when more than one target is currently active among
   * the listed sessions — a single-target account stays a flat list, per
   * the brief's "when more than one target is active" gate. Grouped by
   * `${nodeId}:${targetId}`, the same composite key `targetHealthDots`
   * above already uses (a bare `targetId` is only unique per node).
   */
  /** The group header's label: the live target list's own label when it's arrived, falling back to the bare `targetId` before it has (mirrors `targetHealthDots`' own `label ?? targetId` fallback above). Also what a session row's own meta line shows (design spec v4 §3.2 drops the project name from the row now that the group header carries it). */
  function sessionTargetLabel(session: ClientSessionMeta): string {
    const target = targetStatusEntries.find(
      (entry) => entry.nodeId === session.nodeId && entry.targetId === session.targetId,
    );
    return target?.label ?? session.targetId;
  }

  /** Sessions with a pending item in the cross-project attention inbox (issues #167/#168) — the row's "needs attention" affordance, reusing `attentionInboxItems` already tracked above rather than a new subscription. */
  const sessionsNeedingAttention = $derived(
    new Set(attentionInboxItems.map((item) => item.sessionId)),
  );

  /** The session row's/selvage-rail's first-letter avatar (redesign brief §1's "first-letter avatar") — the session's own title, falling back to its target id for the rare title-less edge case. */
  function sessionInitial(session: ClientSessionMeta): string {
    const trimmed = session.title.trim();
    return (trimmed || session.targetId).charAt(0).toUpperCase();
  }

  /**
   * The registered project's display name for `session` (design spec v4
   * §3.6's header breadcrumb: "the project's registered NAME where there
   * is one"). Reads {@link Project.name} once the registry has an entry
   * for its `(nodeId, targetId, projectPath)` triple, falling back to the
   * path basename for the one tick before `adoptFromSessions` commits it.
   * Unlike v3's `projectName`, this never reads `projectPath` directly
   * once a project is registered, so a rename (`ProjectStore.rename`) is
   * reflected everywhere without re-deriving from the path.
   */
  function projectDisplayName(session: ClientSessionMeta): string {
    const key = sessionProjectKey(session);
    const project = projects.find((entry) => projectKey(entry) === key);
    return project?.name ?? projectNameFromPath(session.projectPath);
  }

  /**
   * A short relative-time string for the row's last-activity detail
   * (redesign brief §1's row content). `ClientSessionMeta.createdAt` is the
   * one timestamp already flowing into this list without adding a new
   * per-session subscription — `syncSessionStatusSubscriptions` above only
   * tracks live `status`, deliberately not the richer `TranscriptState`
   * (that would fire on every transcript update, not just a status
   * transition, well outside this restyle's scope). Mirrors
   * `TargetStatusView.svelte`'s own `formatSampledAt` bucketing.
   */
  function formatSessionActivity(createdAt: number): string {
    const ageMs = Date.now() - createdAt;
    if (ageMs < 5_000) return 'just now';
    if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
    if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
    if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
    return `${Math.round(ageMs / 86_400_000)}d ago`;
  }

  /**
   * The sessions the sidebar actually lists (design spec v4 §3.2's filter
   * row, extending v3's §3.1). Matched over title + target + the session's
   * own registered PROJECT NAME (not the raw path, since a renamed project
   * should stay findable by its new name) through the same `fuzzyFilter`
   * the command palette uses. An empty query returns everything in its
   * original order.
   */
  const visibleSessions = $derived(
    fuzzyFilter(
      sessions,
      sessionFilter,
      (session) => `${session.title} ${sessionTargetLabel(session)} ${projectDisplayName(session)}`,
    ),
  );

  function toggleProjectGroupCollapsed(key: string): void {
    if (collapsedProjectKeys.has(key)) collapsedProjectKeys.delete(key);
    else collapsedProjectKeys.add(key);
  }

  /** One project's row in the sidebar tree (design spec v4 §3.2). */
  interface ProjectGroup {
    key: string;
    project: Project;
    /** This project's sessions to render: every session when the filter is empty or matched the PROJECT itself, otherwise only the sessions that individually matched (see {@link projectGroups}'s own doc comment). */
    sessions: ClientSessionMeta[];
    /** Sessions needing attention, counted over the project's FULL session list: a status summary, independent of the filter narrowing which rows actually render. */
    attentionCount: number;
    /** The worst live status among the project's FULL session list, or `undefined` for a project with no live status yet (including a project with zero sessions). */
    worstStatus: AcpSessionStatus | undefined;
    /** True when this group renders expanded: the filter force-expands every group it keeps (design spec v4 §3.2's "auto-expands every group that has a match"), regardless of {@link collapsedProjectKeys}. */
    expanded: boolean;
  }

  /** Ranks a live session status worst-first, for a project group's single summary `StatusDot` (design spec v4 §3.2). Reuses `$lib/session-status.ts`'s own tone/label maps for the actual dot and its `aria-label`, so this ranking never invents wording of its own. */
  const SESSION_STATUS_SEVERITY: Record<AcpSessionStatus, number> = {
    error: 4,
    permission_required: 3,
    working: 2,
    awaiting_input: 1,
    exited: 0,
  };

  /**
   * The project tree (design spec v4 §3.2), replacing v3's target-based
   * `sessionGroups`. Built from the registry (`projects`, already sorted
   * by name there) rather than purely derived from `sessions`, so a
   * project with zero sessions still renders its own row (§3.3's "a
   * project with zero sessions is normal now"). A defensive fallback
   * covers the one-tick gap between a session arriving and `connect()`'s
   * `adoptFromSessions` call committing it to the registry: any session
   * whose project isn't registered yet still gets a synthetic row rather
   * than silently vanishing from the list.
   */
  const projectGroups = $derived.by((): ProjectGroup[] => {
    const query = sessionFilter.trim();
    const filterActive = query !== '';

    const allByKey = new SvelteMap<string, ClientSessionMeta[]>();
    for (const session of sessions) {
      const key = sessionProjectKey(session);
      const list = allByKey.get(key);
      if (list) list.push(session);
      else allByKey.set(key, [session]);
    }
    const matchedByKey = new SvelteMap<string, ClientSessionMeta[]>();
    for (const session of visibleSessions) {
      const key = sessionProjectKey(session);
      const list = matchedByKey.get(key);
      if (list) list.push(session);
      else matchedByKey.set(key, [session]);
    }

    function buildRow(project: Project): ProjectGroup {
      const key = projectKey(project);
      const allSessions = allByKey.get(key) ?? [];
      const nameMatches = filterActive && fuzzyMatch(query, project.name).matched;
      const sessionsForRow =
        filterActive && !nameMatches ? (matchedByKey.get(key) ?? []) : allSessions;
      let attentionCount = 0;
      let worstStatus: AcpSessionStatus | undefined;
      for (const session of allSessions) {
        if (sessionsNeedingAttention.has(session.id)) attentionCount += 1;
        const status = sessionStatuses.get(session.id);
        if (!status) continue;
        if (
          !worstStatus ||
          SESSION_STATUS_SEVERITY[status] > SESSION_STATUS_SEVERITY[worstStatus]
        ) {
          worstStatus = status;
        }
      }
      return {
        key,
        project,
        sessions: sessionsForRow,
        attentionCount,
        worstStatus,
        expanded: filterActive || !collapsedProjectKeys.has(key),
      };
    }

    const rows = projects.map(buildRow);
    const seenKeys = new Set(rows.map((row) => row.key));
    for (const [key, groupSessions] of allByKey) {
      if (seenKeys.has(key)) continue;
      const [first] = groupSessions;
      if (!first) continue;
      rows.push(
        buildRow({
          id: key,
          name: projectNameFromPath(first.projectPath),
          nodeId: first.nodeId,
          targetId: first.targetId,
          path: first.projectPath,
          createdAt: first.createdAt,
        }),
      );
    }
    if (!filterActive) return rows;
    return rows.filter(
      (row) => fuzzyMatch(query, row.project.name).matched || row.sessions.length > 0,
    );
  });

  /** Focuses+selects a freshly-mounted rename `<input>` (design spec v4 §3.2's inline rename): an `{@attach}`, not the plain `autofocus` HTML attribute, mirroring `revealActiveTab`'s identical use of a DOM lifecycle hook elsewhere in this file. */
  function focusAndSelect(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  /** The project group menu's "Rename" action (design spec v4 §3.2): switches that group's header into the editable `<input>` above, seeded with its current name. */
  function startRenamingProject(project: Project): void {
    renamingProjectId = project.id;
    renameDraft = project.name;
  }

  function commitRename(): void {
    if (!renamingProjectId) return;
    const trimmed = renameDraft.trim();
    if (trimmed !== '') projectStore.rename(renamingProjectId, trimmed);
    renamingProjectId = undefined;
    renameDraft = '';
  }

  function cancelRename(): void {
    renamingProjectId = undefined;
    renameDraft = '';
  }

  /** Enter commits the rename, Escape discards it (blurring the input, e.g. a click elsewhere, also commits, via the input's own `onblur`). */
  function handleRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }

  /**
   * The project group menu's "Reveal path" action (design spec v4 §3.2). A
   * browser tab has no OS-level "reveal in Finder/Explorer" capability:
   * this copies the absolute path instead, the same honest affordance the
   * session row's own "Copy project path" menu item already offers, just
   * scoped to the project rather than one of its sessions.
   */
  async function revealProjectPath(project: Project): Promise<void> {
    await copyToClipboard(project.path);
  }

  /**
   * The project group menu's "Remove project" action (design spec v4
   * §3.2): forgets the registry entry only. `ProjectStore.remove`'s own
   * doc comment guarantees sessions are untouched. Immediately re-runs
   * `adoptFromSessions` so a project that still has live sessions
   * reappears as an adopted entry in the SAME tick, rather than waiting
   * for the next session-list update, matching the spec's "reappears as
   * an adopted entry if any of its sessions still exist."
   */
  function removeProject(id: string): void {
    projectStore.remove(id);
    projectStore.adoptFromSessions(sessions);
  }

  /**
   * Which single CTA the main-area empty state offers (design spec v4
   * §3.3): "always the one that unblocks the next step." Checked in this
   * order because each earlier gap makes every later action meaningless:
   * there is nothing to add a project ONTO without a target, and nothing
   * to start a session IN without a project.
   */
  type EmptyStateCta = 'connect-node' | 'add-project' | 'new-session';
  const emptyStateCta = $derived<EmptyStateCta>(
    targetStatusEntries.length === 0
      ? 'connect-node'
      : projects.length === 0
        ? 'add-project'
        : 'new-session',
  );

  /**
   * Pushes the current mute/quiet-hours preferences, plus this device's
   * `sessionId -> projectPath` map, into the active service worker (#166) —
   * there is no `localStorage` access from a service worker, and the push
   * payload itself never carries a `projectPath` (SPEC §8's blind-relay
   * boundary), so the SW's `push` handler (`push-suppression.ts`'s
   * `shouldSuppressPush`) relies entirely on this sync. A no-op wherever
   * there is no controlling service worker yet (unsupported browser, or the
   * very first load before the SW has taken control).
   */
  function syncNotificationPreferencesToServiceWorker(): void {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return;
    const sessionProjectMap: Record<string, string> = {};
    for (const session of sessions) sessionProjectMap[session.id] = session.projectPath;
    navigator.serviceWorker.controller.postMessage({
      type: 'loombox:notification-prefs-sync',
      preferences: notificationPreferences,
      sessionProjectMap,
    });
  }

  function onNotificationPreferencesChange(preferences: NotificationPreferencesData): void {
    notificationPreferences = preferences;
    syncNotificationPreferencesToServiceWorker();
  }

  /**
   * The active-toggle visual (redesign v2 §2 "shell button consolidation",
   * issue #462): every hand-rolled `.foo-toggle`/`.drawer-tab`/`.active`
   * ruleset this file used to define per button collapses into ONE shared
   * `warp-toggle-active` class (see this file's own stylesheet) layered on
   * top of the shared `Button` primitive via its `class` prop — `Button`
   * itself has no notion of a persisted "pressed" visual (only `IconButton`
   * does, via `pressed`/`aria-pressed`), so a plain text toggle button still
   * needs *some* way to show which tab/panel is currently open.
   */
  function toggleActiveClass(active: boolean): string {
    return active ? 'warp-toggle-active' : '';
  }

  /**
   * Keeps the Drawer's active tab visible (redesign v3 design spec §3.6).
   * The tab strip is one horizontally-scrolling row rather than two wrapped
   * ones, so with six tabs in a 26rem panel the selected one can start off
   * screen — reachable, but invisible, which is worse than the wrapping it
   * replaced. Re-runs whenever `active` flips, because an attachment's
   * argument is part of its reactive dependency set.
   */
  function revealActiveTab(active: boolean) {
    return (node: Element) => {
      if (!active) return;
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
  }

  /**
   * The Drawer's own enter/exit motion (redesign brief §1: "drawer/sheet
   * slide", `tokens.css`'s `--duration-base`/`--ease-shuttle`) — needed now
   * that the overlay-mode Drawer mounts/unmounts through the shared
   * `Overlay` primitive (issue #462) rather than staying permanently mounted
   * and CSS-transform-toggled, mirroring `Dialog.svelte`'s own `panelLift`
   * (a JS-driven transition is the only way to animate an element's
   * disappearance from a `{#if}` block). Slides along the same axis the
   * Drawer's own CSS breakpoint uses — vertical (`translateY`, bottom sheet)
   * below `--bp-tablet`, horizontal (`translateX`, right-edge column)
   * otherwise — reusing `sessionsSheetViewport` (the Sessions column's own
   * subscription to that exact breakpoint) rather than a second one.
   * `cubicOut` approximates `--ease-shuttle`'s fast-out-settles for this
   * JS-driven transition, same convention/caveat as `Dialog.svelte`'s
   * `panelLift` doc comment. Reduced motion is read live via `matchMedia` at
   * the moment the transition starts (jsdom never evaluates the media query,
   * so this is a no-op — and never invoked at all — under SSR/vitest).
   */
  function drawerSlide(_node: Element): TransitionConfig {
    // Pinned-column mode has no motion at all (it's part of the layout, not
    // a dismissible overlay) — only the overlay-mode mount/unmount animates.
    if (!drawerIsOverlay) return { duration: 0, css: () => '' };
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : 220; // tokens.css --duration-base
    const axis = sessionsSheetViewport ? 'Y' : 'X';
    return {
      duration,
      easing: cubicOut,
      css: (t: number) => `transform: translate${axis}(${100 * (1 - t)}%); opacity: ${t};`,
    };
  }

  /** The global shortcut dispatcher (issue #132): Mod+K opens the palette from anywhere except while the user is already typing somewhere else; Mod+. stops the current turn; Mod+B (issue #438) toggles the Sessions column's collapsed-to-selvage state. The palette itself owns Esc/Arrow/Enter once open (`CommandPalette.svelte`). */
  function handleGlobalKeydown(event: KeyboardEvent): void {
    // The sidebar's anchored popovers are not `Overlay`s (spec §3.1 — a
    // menu has no business dimming the app), so Escape is handled here
    // rather than by `Overlay`'s own window handler.
    if (event.key === 'Escape' && anySidebarMenuOpen) {
      event.preventDefault();
      closeSidebarMenus();
      return;
    }
    if (paletteOpen) return;
    if (isModShortcut(event, 'k')) {
      event.preventDefault();
      paletteOpen = true;
      return;
    }
    if (isModShortcut(event, '.') && !isTypingTarget(event.target)) {
      event.preventDefault();
      stopSession();
      return;
    }
    if (isModShortcut(event, 'b') && !isTypingTarget(event.target)) {
      event.preventDefault();
      toggleSessionsCollapsed();
    }
  }

  /** The attention inbox's approve/deny action (issue #168) — the exact same `RelayClient.resolvePermission` call the session's own `PermissionQueueBar` makes, so both resolve the one shared queue store (issue #169). */
  function resolveInboxPermission(
    sessionId: string,
    requestId: string,
    option: AcpPermissionOption,
  ): void {
    if (!client) return;
    client.resolvePermission(sessionId, requestId, option);
  }

  /** The attention inbox's "Open" action (issue #168) — jumps to the item's originating session and closes the inbox panel. */
  function openSessionFromInbox(sessionId: string): void {
    selectSession(sessionId);
    setActiveDrawer(null);
  }

  /** The attention inbox's inline reply action (issue #168) — the exact same `RelayClient.sendPrompt` call the session's own composer form makes, so a reply sent from the inbox is not a second, divergent send path; it works for any listed session, not only the currently selected one. */
  function replyFromInbox(sessionId: string, text: string): void {
    if (!client) return;
    client.sendPrompt(sessionId, text);
  }

  function changeConfigOption(category: string, optionId: string): void {
    if (!client || !selectedSessionId) return;
    client.setConfigOption(selectedSessionId, category, optionId);
  }

  async function exportTranscript(): Promise<void> {
    if (!transcript) return;
    await copyToClipboard(exportTranscriptText(transcript));
  }

  onMount(() => {
    // Design tokens' theme toggle (issue #195): `+layout.svelte` already
    // called `themeStore.init()` (the DOM/localStorage side effect); this
    // subscription only mirrors the resulting value into local state so
    // the toggle button below can render the right label/icon.
    const unsubscribeTheme = themeStore.preference.subscribe((value) => {
      themePreference = value;
    });

    // Design spec v4 §4.2: mirrors the project registry's store into
    // `projects`, created eagerly at module scope above (its default
    // storage is SSR-safe), but the subscription itself lives here so
    // every subscription in this component starts/stops in the same
    // place, matching `themeStore`'s identical pattern right above.
    const unsubscribeProjects = projectStore.subscribe((value) => {
      projects = value;
    });

    amkStorage = createLocalStorageAmkStorage();
    deviceIdStorage = createLocalStorageDeviceIdStorage();
    deviceId = loadOrCreateDeviceId(deviceIdStorage);

    // #166: load this device's mute/quiet-hours preferences and hand the
    // service worker its first sync (before any session list has even
    // arrived, so the SW's cache is never worse than "no mutes, no quiet
    // hours" — never left with nothing at all).
    notificationPreferencesStorage = createLocalStorageNotificationPreferencesStorage();
    notificationPreferences = notificationPreferencesStorage.get();
    syncNotificationPreferencesToServiceWorker();

    // #164/#165: a notification click (or an approve/deny action tap)
    // landed here with `?session=<id>` (and, for an action tap,
    // `&action=approve|deny`) — see `pendingSessionIdFromUrl`'s and
    // `pendingPushActionFromUrl`'s doc comments above.
    const urlParams = new URLSearchParams(window.location.search);
    const sessionIdFromUrl = urlParams.get('session');
    if (sessionIdFromUrl) pendingSessionIdFromUrl = sessionIdFromUrl;
    const actionFromUrl = urlParams.get('action');
    if (actionFromUrl) pendingPushActionFromUrl = actionFromUrl;

    // Narrow-viewport permission footer (SPEC §7.3; issue #134).
    const unsubscribeNarrow = isNarrowViewport().subscribe((value) => (narrowViewport = value));

    // The Sessions column's own sheet-viewport override (redesign brief §1,
    // issue #438) — see `sessionsSheetViewport`'s own doc comment above.
    const unsubscribeSessionsSheetViewport = isNarrowViewport(
      TABLET_VIEWPORT_BREAKPOINT_PX,
    ).subscribe((value) => (sessionsSheetViewport = value));

    // The Drawer's own pin-eligibility breakpoint (redesign brief §1, issue
    // #462) — see `drawerNarrowViewport`'s own doc comment.
    const unsubscribeDrawerNarrowViewport = isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX).subscribe(
      (value) => (drawerNarrowViewport = value),
    );

    // Restores an operator-customized relay URL before constructing
    // `authStore` against it, so a self-hoster who edits this field, then
    // signs in (a full-page OAuth redirect that reloads this component from
    // scratch on return), lands back on the SAME relay's session rather than
    // silently falling back to `DEFAULT_RELAY_URL`.
    const persistedRelayUrl = localStorage.getItem(RELAY_URL_STORAGE_KEY);
    if (persistedRelayUrl) relayUrl = persistedRelayUrl;

    // Redesign brief §1: restores the Drawer's pinned-column preference.
    const persistedDrawerPinned = localStorage.getItem(DRAWER_PINNED_STORAGE_KEY);
    if (persistedDrawerPinned) drawerPinned = persistedDrawerPinned === '1';

    // Redesign brief §1, issue #438: restores the Sessions column's own
    // drag-resized width + collapsed-to-selvage preference.
    const persistedSessionsWidth = localStorage.getItem(SESSIONS_WIDTH_STORAGE_KEY);
    if (persistedSessionsWidth) {
      const parsedSessionsWidth = Number(persistedSessionsWidth);
      if (Number.isFinite(parsedSessionsWidth)) {
        sessionsWidthPx = clampSessionsWidth(parsedSessionsWidth);
      }
    }
    const persistedSessionsCollapsed = localStorage.getItem(SESSIONS_COLLAPSED_STORAGE_KEY);
    if (persistedSessionsCollapsed) sessionsCollapsed = persistedSessionsCollapsed === '1';

    // Every preference above is now the persisted one, so the four
    // persistence effects declared near the top of this component may
    // start writing (see `preferencesRestored`'s own doc comment).
    preferencesRestored = true;

    const store = ensureAuthStore();

    const unsubscribeAuthSession = store.session.subscribe((value) => {
      authSession = value;
      if (value) {
        // Issue #384: decides onboarding-vs-straight-to-cockpit instead of
        // unconditionally connecting (which used to silently mint a fresh
        // AMK per browser via the old `loadOrCreateAmk` call here).
        beginSessionFor(value);
      } else {
        onboardingNeeded = undefined;
        disconnect();
      }
    });

    // Picks up a session this device already had (a stored bearer token) or
    // just received (this is the page Better Auth's OAuth callback
    // redirected back to) before showing the sign-in gate.
    store
      .restoreSession()
      .catch((error: unknown) => {
        authError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        authChecked = true;
      });

    return () => {
      unsubscribeTheme();
      unsubscribeProjects();
      unsubscribeAuthSession();
      unsubscribeNarrow();
      unsubscribeSessionsSheetViewport();
      unsubscribeDrawerNarrowViewport();
      disconnect();
    };
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} onpointerdown={handleWindowPointerDown} />

<main class:cockpit={cockpitReady}>
  {#if !cockpitReady}
    <!-- Checking session / sign-in / onboarding: the redesign brief reserves
         the full `BrandLockup` for these screens ("where nothing competes
         for attention", §1) — only the cockpit below gets the new compact
         3-zone header. -->
    <header class="header-lockup">
      <h1 class="brand-heading"><BrandLockup /></h1>
      <p>{APP_TAGLINE}</p>
      <div class="header-actions">
        <!-- SPEC.md §4 "Tone of voice ... No emoji in product chrome" — a text
             label, not an icon glyph, states the toggle's current mode. -->
        <Button
          variant="secondary"
          size="sm"
          onclick={() => themeStore.toggleTheme()}
          ariaLabel={`Switch theme (currently ${themePreference})`}
          dataTestId="theme-toggle"
        >
          {themePreference}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class={toggleActiveClass(activeDrawer === 'settings')}
          onclick={() => toggleDrawer('settings')}
          dataTestId="appearance-settings-toggle"
        >
          Appearance
        </Button>
      </div>
    </header>

    {#if activeDrawer === 'settings'}
      <section class="appearance-settings-panel">
        <h2>Appearance</h2>
        <AppearanceSettings />
      </section>
    {/if}
  {/if}

  {#if !authChecked}
    <section class="connection">
      <p class="empty loading-line">
        <WovenLoader label="Checking session" />
        Checking session…
      </p>
    </section>
  {:else if !authSession}
    <!-- Signed-out sign-in gate (redesign brief §4/§6, issue #430): the
         other half of "the first impression" alongside the header's full
         `BrandLockup` above — an `EmptyState` (its dimmed-`BrandMark`
         language) carrying the one primary `Button` CTA, with the
         self-hoster's Relay URL override de-emphasized below it. -->
    <section class="connection sign-in">
      <EmptyState message="Sign in to load your sessions and connect to your nodes.">
        {#snippet cta()}
          <Button variant="primary" onclick={signInWithGithub}>Sign in with GitHub</Button>
        {/snippet}
      </EmptyState>
      <div class="relay-url-row">
        <label for="relay-url">Relay URL</label>
        <input id="relay-url" type="text" bind:value={relayUrl} />
      </div>
      {#if authError}
        <ErrorNotice message={authError} />
      {/if}
    </section>
  {:else if onboardingNeeded}
    <!-- Onboarding (redesign v3 design spec §3.1): the cockpit's own chrome
         used to be duplicated here as a row of ghost buttons — Inbox, Nodes
         & targets, Jump to…, Mute & quiet hours — none of which has anything
         to act on before this device even holds the account key. What is
         left is identity, live connection state, and the way out. -->
    <section class="connection">
      <span class="account">{authSession.accountId}</span>
      <span class="status" data-status={status}>
        {#if status === 'connecting'}
          <WovenLoader label="Connecting to the relay" />
        {/if}
        {connectionNotice?.label ?? 'Connected'}
      </span>
      <Button variant="ghost" size="sm" onclick={signOut}>Sign out</Button>
    </section>
    {#if authError}
      <ErrorNotice message={authError} />
    {/if}

    <OnboardingGate
      accountId={authSession.accountId}
      {relayUrl}
      authToken={authSession.token}
      onFirstDevice={handleFirstDeviceOnboarded}
      onNewDevice={handleNewDeviceOnboarded}
    />
  {:else}
    <!-- The cockpit (redesign v3 design spec §3.1-§3.4): ONE sidebar (brand,
         primary action, filter, sessions, secondary nav, account) beside a
         workspace (context header + canvas), with the Drawer as the only
         other content surface. This replaces v2's icon rail + Sessions
         column + three-zone header, which was two navigations and a dead
         "Sessions" rail item that did nothing above 1024px. -->

    <!-- One row's markup, shared between the flat list and the grouped list
         below so neither copy can drift from the other. -->
    {#snippet sessionRow(session: ClientSessionMeta)}
      {@const sessionStatus = sessionStatuses.get(session.id)}
      {@const needsAttention = sessionsNeedingAttention.has(session.id)}
      {@const statusLabel = sessionStatus
        ? SESSION_STATUS_LABELS[sessionStatus]
        : SESSION_STATUS_UNKNOWN_LABEL}
      <li
        class="session-row"
        class:menu-open={sessionRowMenuFor === session.id}
        data-testid="session-row-item"
      >
        <button
          type="button"
          class="session"
          class:selected={session.id === selectedSessionId}
          onclick={() => selectSession(session.id)}
          title={`${session.title}\n${session.projectPath} · ${session.targetId}\n${statusLabel}`}
        >
          <span class="session-status" data-testid="session-status-badge">
            <StatusDot
              tone={sessionStatus ? SESSION_STATUS_TONES[sessionStatus] : 'neutral'}
              pulse={sessionStatus === 'working'}
              label={statusLabel}
              size="sm"
            />
          </span>
          <span class="session-main">
            <span class="session-title-row">
              <strong>{session.title}</strong>
              {#if needsAttention}
                <span
                  class="session-attention-dot"
                  data-testid="session-attention-dot"
                  aria-hidden="true"
                ></span>
                <span class="sr-only">Needs attention</span>
              {/if}
            </span>
            <!-- Design spec v4 §3.2: the meta line drops the project name
                 (the group header now carries it) and picks up the
                 relative activity time that used to sit in its own grid
                 column on the right. -->
            <span class="session-meta" data-testid="session-activity">
              {sessionTargetLabel(session)}
              <span aria-hidden="true">·</span>
              {formatSessionActivity(session.createdAt)}
            </span>
          </span>
        </button>
        <!-- The row's actions used to be one permanently visible "Target
             status" button, wide enough to squeeze the title down to a
             single character. They live behind a hover/focus-revealed `⋯`
             now (spec §3.2). `data-sidebar-menu` opts this subtree out of
             the window-level dismiss handler. -->
        <div class="session-row-actions" data-sidebar-menu>
          <IconButton
            label={`More actions for ${session.title}`}
            class="session-row-more"
            dataTestId="session-row-more"
            onclick={() => {
              const wasOpen = sessionRowMenuFor === session.id;
              closeSidebarMenus();
              sessionRowMenuFor = wasOpen ? undefined : session.id;
            }}
          >
            <Icon name="more" />
          </IconButton>
          {#if sessionRowMenuFor === session.id}
            <div class="popover-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                data-testid="session-target-status-link"
                onclick={() => {
                  closeSidebarMenus();
                  openTargetStatus({ nodeId: session.nodeId, targetId: session.targetId });
                }}
              >
                Target status
              </button>
              <button
                type="button"
                role="menuitem"
                onclick={() => {
                  closeSidebarMenus();
                  void copyToClipboard(session.projectPath);
                }}
              >
                Copy project path
              </button>
            </div>
          {/if}
        </div>
      </li>
    {/snippet}

    <!-- The collapsed sidebar's icon-only row: avatar + status dot only. -->
    {#snippet selvageSessionRow(session: ClientSessionMeta)}
      {@const sessionStatus = sessionStatuses.get(session.id)}
      {@const statusLabel = sessionStatus
        ? SESSION_STATUS_LABELS[sessionStatus]
        : SESSION_STATUS_UNKNOWN_LABEL}
      <li>
        <button
          type="button"
          class="selvage-session"
          class:selected={session.id === selectedSessionId}
          class:needs-attention={sessionsNeedingAttention.has(session.id)}
          onclick={() => selectSession(session.id)}
          title={`${session.title} — ${statusLabel}`}
          aria-label={`${session.title} — ${statusLabel}`}
          data-testid="selvage-session"
        >
          <span class="selvage-avatar" aria-hidden="true">{sessionInitial(session)}</span>
          <StatusDot
            tone={sessionStatus ? SESSION_STATUS_TONES[sessionStatus] : 'neutral'}
            pulse={sessionStatus === 'working'}
            label={statusLabel}
            size="sm"
            class="selvage-status-dot"
          />
        </button>
      </li>
    {/snippet}

    <div class="shell">
      {#if sessionsSheetOpen}
        <button
          type="button"
          class="sidebar-backdrop"
          aria-label="Close sessions"
          onclick={() => (sessionsSheetOpen = false)}
        ></button>
      {/if}

      <aside
        class="sidebar"
        class:sheet-open={sessionsSheetOpen}
        class:collapsed={sessionsRailCollapsed}
        class:resizing={sessionsResizing}
        style={sessionsSheetViewport ? undefined : `width: ${sessionsColumnWidthPx}px`}
        data-testid="sessions-column"
      >
        <div class="sidebar-brand">
          <h1 class="sidebar-brand-mark">
            {#if sessionsRailCollapsed}
              <BrandMark decorative={false} label="loombox" />
            {:else}
              <BrandLockup />
            {/if}
          </h1>
          <IconButton
            label={sessionsCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            pressed={sessionsCollapsed}
            onclick={toggleSessionsCollapsed}
            class="sidebar-collapse-toggle"
            dataTestId="sidebar-collapse-toggle"
          >
            <Icon name="collapse-chevron" class={sessionsCollapsed ? 'flip' : ''} />
          </IconButton>
        </div>

        <!-- Primary destinations (design spec v4 §3.1): heavier than v3's
             muted secondary nav they replace, and moved to the TOP: they
             now indicate what the main area is showing, not a panel to
             toggle. Selecting one leaves `selectedSessionId` untouched
             (§3.3), so returning to the transcript is one click. -->
        <nav
          class="sidebar-destinations"
          aria-label="Primary destinations"
          data-testid="sidebar-destinations"
        >
          <button
            type="button"
            class="destination-row"
            class:active={mainView === 'inbox'}
            onclick={() => (mainView = 'inbox')}
            data-testid="destination-inbox"
          >
            <span class="destination-icon"><Icon name="inbox" size="100%" /></span>
            <span class="destination-label">Inbox</span>
            {#if attentionInboxItems.length > 0}
              <span class="destination-badge" data-testid="inbox-count"
                >{attentionInboxItems.length}</span
              >
            {/if}
          </button>
          <button
            type="button"
            class="destination-row"
            class:active={mainView === 'nodes'}
            onclick={() => openTargetStatus()}
            data-testid="destination-nodes"
          >
            <span class="destination-icon"><Icon name="targets" size="100%" /></span>
            <span class="destination-label">Nodes</span>
            {#if hasUnhealthyTarget}
              <span
                class="destination-badge destination-badge-dot"
                data-testid="targets-health-badge"
                aria-hidden="true"
              ></span>
              <span class="sr-only">Some targets need attention</span>
            {/if}
          </button>
          <button
            type="button"
            class="destination-row"
            class:active={mainView === 'settings'}
            onclick={() => (mainView = 'settings')}
            data-testid="destination-settings"
          >
            <span class="destination-icon"><Icon name="settings" size="100%" /></span>
            <span class="destination-label">Settings</span>
          </button>
        </nav>

        <div class="sidebar-divider" role="separator" aria-orientation="horizontal"></div>

        {#if !sessionsRailCollapsed}
          <div class="sidebar-section-header">
            <span class="sidebar-section-title">Projects</span>
            <IconButton
              label="Add project"
              onclick={openAddProjectDialog}
              dataTestId="add-project-button"
            >
              <Icon name="plus" />
            </IconButton>
          </div>

          {#if projects.length > 0}
            <div class="sidebar-filter">
              <Icon name="search" class="sidebar-filter-icon" />
              <input
                type="search"
                bind:value={sessionFilter}
                placeholder="Filter projects and sessions…"
                aria-label="Filter projects and sessions"
                data-testid="session-filter"
              />
            </div>
          {/if}
        {/if}

        <div class="sidebar-sessions">
          {#if sessionsRailCollapsed}
            <ul class="selvage-list" data-testid="selvage-session-list">
              {#each sessions as session (session.id)}
                {@render selvageSessionRow(session)}
              {/each}
            </ul>
          {:else if status === 'connecting' || status === 'idle'}
            <p class="empty loading-line">
              <WovenLoader label="Loading sessions" />
              Loading sessions…
            </p>
          {:else if sessions.length === 0 && sessionDecryptFailures > 0}
            <div class="key-mismatch" role="alert" data-testid="session-decrypt-mismatch">
              <p class="key-mismatch-title">This device's key can't read these sessions.</p>
              <p class="hint">Re-pair this device with your Recovery Code to restore access.</p>
              <RecoveryCodeEntryForm
                busy={rePairBusy}
                error={rePairError}
                submitLabel="Re-pair this device"
                onSubmit={rePairWithRecoveryCode}
              />
            </div>
          {:else if projects.length === 0}
            <EmptyState message="No projects yet. Add one to start a session in it.">
              {#snippet cta()}
                <Button
                  variant="primary"
                  onclick={openAddProjectDialog}
                  dataTestId="add-project-empty-cta"
                >
                  Add project
                </Button>
              {/snippet}
            </EmptyState>
          {:else if projectGroups.length === 0}
            <p class="empty" data-testid="session-filter-empty">
              No project or session matches “{sessionFilter}”.
            </p>
          {:else}
            {#each projectGroups as row (row.key)}
              {@const worstTone = row.worstStatus
                ? SESSION_STATUS_TONES[row.worstStatus]
                : undefined}
              {@const worstLabel = row.worstStatus ? SESSION_STATUS_LABELS[row.worstStatus] : ''}
              <div class="project-group" data-testid="project-group">
                <div class="project-group-header-row" data-sidebar-menu>
                  {#if renamingProjectId === row.project.id}
                    <span class="project-group-header-renaming">
                      <Icon
                        name="collapse-chevron"
                        class={row.expanded
                          ? 'project-group-chevron'
                          : 'project-group-chevron collapsed'}
                      />
                      <input
                        class="project-rename-input"
                        bind:value={renameDraft}
                        onkeydown={handleRenameKeydown}
                        onblur={commitRename}
                        aria-label={`Rename ${row.project.name}`}
                        data-testid="project-rename-input"
                        {@attach focusAndSelect}
                      />
                    </span>
                  {:else}
                    <button
                      type="button"
                      class="project-group-header"
                      onclick={() => toggleProjectGroupCollapsed(row.key)}
                      aria-expanded={row.expanded}
                      data-testid="project-group-header"
                    >
                      <Icon
                        name="collapse-chevron"
                        class={row.expanded
                          ? 'project-group-chevron'
                          : 'project-group-chevron collapsed'}
                      />
                      <span class="project-group-label">{row.project.name}</span>
                    </button>
                  {/if}
                  <span class="project-group-meta">
                    {#if row.attentionCount > 0}
                      <span class="project-group-count" data-testid="project-attention-count"
                        >{row.attentionCount}</span
                      >
                    {/if}
                    {#if worstTone}
                      <StatusDot tone={worstTone} label={`Worst status: ${worstLabel}`} size="sm" />
                    {/if}
                    <IconButton
                      label={`More actions for ${row.project.name}`}
                      class="project-row-more"
                      dataTestId="project-row-more"
                      onclick={() => {
                        const wasOpen = projectMenuFor === row.project.id;
                        closeSidebarMenus();
                        projectMenuFor = wasOpen ? undefined : row.project.id;
                      }}
                    >
                      <Icon name="more" />
                    </IconButton>
                  </span>
                  {#if projectMenuFor === row.project.id}
                    <div
                      class="popover-menu popover-below"
                      role="menu"
                      data-testid="project-row-menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onclick={() => {
                          closeSidebarMenus();
                          openNewSessionDialogFor(row.project);
                        }}
                      >
                        New session
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onclick={() => {
                          closeSidebarMenus();
                          startRenamingProject(row.project);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onclick={() => {
                          closeSidebarMenus();
                          void revealProjectPath(row.project);
                        }}
                      >
                        Reveal path
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="danger"
                        onclick={() => {
                          closeSidebarMenus();
                          removeProject(row.project.id);
                        }}
                        title="Removes this from the sidebar only. Sessions and files are untouched."
                      >
                        Remove project
                      </button>
                    </div>
                  {/if}
                </div>
                {#if row.expanded}
                  <ul class="project-group-sessions">
                    {#each row.sessions as session (session.id)}
                      {@render sessionRow(session)}
                    {/each}
                    <li class="project-new-session-row">
                      <button
                        type="button"
                        class="project-new-session"
                        onclick={() => openNewSessionDialogFor(row.project)}
                        data-testid="project-new-session-row"
                      >
                        <Icon name="plus" />
                        New session
                      </button>
                    </li>
                  </ul>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <div class="sidebar-account" data-sidebar-menu>
          {#if accountMenuOpen}
            <div class="popover-menu popover-above" role="menu" data-testid="account-menu">
              <p class="popover-heading">Signed in as</p>
              <p class="popover-identity">{accountLabel}</p>
              {#if authSession.email && authSession.email !== accountLabel}
                <p class="popover-identity-secondary">{authSession.email}</p>
              {/if}
              <button
                type="button"
                role="menuitem"
                onclick={() => {
                  closeSidebarMenus();
                  mainView = 'settings';
                }}
              >
                Appearance &amp; settings
              </button>
              <button
                type="button"
                role="menuitem"
                class="danger"
                onclick={() => {
                  closeSidebarMenus();
                  void signOut();
                }}
              >
                Sign out
              </button>
            </div>
          {/if}
          <button
            type="button"
            class="account-trigger"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onclick={() => {
              const wasOpen = accountMenuOpen;
              closeSidebarMenus();
              accountMenuOpen = !wasOpen;
            }}
            data-testid="account-menu-toggle"
          >
            <span class="account-avatar" aria-hidden="true">{accountInitial}</span>
            <span class="account-name">{accountLabel}</span>
            <Icon name="more" class="account-chevron" />
          </button>
        </div>

        {#if !sessionsRailCollapsed}
          <!-- A focusable, draggable `separator` is the WAI-ARIA APG's own
               "Window Splitter" pattern — a deliberate exception to the usual
               noninteractive-role rule, mirroring `PermissionCard.svelte`'s
               identical pair of ignores for its own keyboard-focusable
               `group`. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={sessionsWidthPx}
            aria-valuemin={MIN_SESSIONS_WIDTH_PX}
            aria-valuemax={MAX_SESSIONS_WIDTH_PX}
            tabindex="0"
            onpointerdown={startSessionsResize}
            onkeydown={handleSessionsResizeKeydown}
            data-testid="sessions-resize-handle"
          ></div>
        {/if}
      </aside>

      <div class="workspace">
        <!-- Two zones, not three (spec §3.3): context on the left, controls
             on the right. The brand and the account moved into the
             sidebar; the always-green connection dot is gone, replaced by
             a chip that only appears when there is something wrong and
             something to do about it. Design spec v4 §3.6 adds one case:
             while a destination page is showing, the left zone is that
             page's own title instead of the session breadcrumb, and the
             right zone drops every session-scoped control (Files/
             Terminal/Config/Export); none of them apply to a page. -->
        <header class="topbar">
          <div class="topbar-context">
            {#if mainView !== 'session'}
              <span class="topbar-title" data-testid="cockpit-page-title"
                >{MAIN_VIEW_TITLES[mainView]}</span
              >
            {:else if selectedSession}
              <span class="topbar-title" data-testid="cockpit-session-title"
                >{selectedSession.title}</span
              >
              <span class="topbar-breadcrumb" title={selectedSession.projectPath}>
                {projectDisplayName(selectedSession)}
                <span aria-hidden="true">·</span>
                {selectedSession.targetId}
              </span>
            {:else}
              <span class="topbar-title topbar-title-muted">No session selected</span>
            {/if}
          </div>

          <div class="topbar-actions">
            {#if connectionNotice}
              <span
                class="connection-chip"
                data-tone={connectionNotice.tone}
                data-testid="connection-status-chip"
                role="status"
              >
                <StatusDot
                  tone={connectionNotice.tone}
                  pulse={status === 'connecting' || status === 'closed'}
                  label={connectionNotice.label}
                  size="sm"
                />
                {connectionNotice.label}
                {#if connectionNotice.retry}
                  <button type="button" onclick={retryConnection} data-testid="connection-retry">
                    Retry
                  </button>
                {/if}
              </span>
            {/if}

            {#if selectedSessionId && mainView === 'session'}
              <IconButton
                label="Files"
                pressed={activeDrawer === 'files'}
                onclick={() => toggleDrawer('files')}
                dataTestId="file-tree-toggle"
              >
                <Icon name="file" />
              </IconButton>
              <IconButton
                label="Terminal"
                pressed={activeDrawer === 'terminal'}
                onclick={() => toggleDrawer('terminal')}
                dataTestId="terminal-toggle"
              >
                <Icon name="terminal" />
              </IconButton>
              <IconButton
                label="Project config"
                pressed={activeDrawer === 'config'}
                onclick={() => toggleDrawer('config')}
                dataTestId="project-config-toggle"
              >
                <Icon name="settings" />
              </IconButton>
              <CopyButton
                text={transcript ? exportTranscriptText(transcript) : ''}
                label="Export transcript"
                copyFn={exportTranscript}
              />
            {/if}
            <IconButton
              label="Jump to… (Ctrl/Cmd+K)"
              onclick={() => (paletteOpen = true)}
              dataTestId="command-palette-toggle"
            >
              <Icon name="command" />
            </IconButton>
          </div>
        </header>

        {#if authError}
          <div class="workspace-notice">
            <ErrorNotice message={authError} />
          </div>
        {/if}

        {#if escrowStatus !== 'idle'}
          <!-- The first-device escrow round trip (redesign brief §6, issue
               #430): a real `Card` for the in-flight wait, with the
               `thread-draw-fill-loop` sweep the brief names directly; a real
               `ErrorNotice` if it fails. -->
          <div
            class="workspace-notice escrow-status"
            data-testid="escrow-status"
            role={escrowStatus === 'in-flight' ? 'status' : undefined}
          >
            {#if escrowStatus === 'in-flight'}
              <Card elevation="raised" padding="sm">
                <div class="escrow-inflight-row">
                  <WovenLoader label="Securing your account key" />
                  <span>Securing your account key…</span>
                </div>
                <span class="in-flight-track" aria-hidden="true">
                  <span class="thread-draw-fill-loop in-flight-bar"></span>
                </span>
              </Card>
            {:else}
              <ErrorNotice
                message={`Couldn't save your Recovery Code to the relay${escrowError ? `: ${escrowError}` : '.'} This device still works, but recovering this account elsewhere may not until it does.`}
              />
            {/if}
          </div>
        {/if}

        <section class="canvas">
          {#if mainView !== 'session'}
            <!-- Design spec v4 §3.3: the three destinations are full-width
                 pages in this same canvas position, capped at the same
                 `--measure-wide` the transcript's own wide content opts
                 into, each with its own title and no close button: you
                 leave a page by going somewhere else. -->
            <div class="canvas-page">
              {#if mainView === 'inbox'}
                <InboxPage
                  items={attentionInboxItems}
                  onResolve={resolveInboxPermission}
                  onOpenSession={openSessionFromInbox}
                  onReply={replyFromInbox}
                />
              {:else if mainView === 'nodes'}
                <NodesPage
                  targets={targetStatusEntries}
                  loading={targetStatusLoading}
                  error={targetStatusError}
                  focusTarget={targetStatusFocus}
                  onRefresh={refreshTargetStatus}
                  onAddTarget={openAddTargetWizard}
                  onConnectNode={openAddTargetWizard}
                />
              {:else if mainView === 'settings' && authSession}
                <SettingsPage
                  {notificationPreferencesStorage}
                  {projectPaths}
                  {onNotificationPreferencesChange}
                  {deviceId}
                  relayBaseUrl={relayHttpBaseUrl(relayUrl)}
                  authToken={authSession.token}
                />
              {/if}
            </div>
          {:else if !selectedSessionId}
            <!-- Design spec v4 §3.3: the primary "New session" CTA now
                 lives here instead of the sidebar's old split button,
                 always the one action that unblocks the next step. -->
            <EmptyState
              message={emptyStateCta === 'connect-node'
                ? 'Connect a node to run agents on your machines.'
                : emptyStateCta === 'add-project'
                  ? 'Add a project to start a session in it.'
                  : 'Pick a session on the left to follow its live transcript, or start a new one.'}
            >
              {#snippet cta()}
                {#if emptyStateCta === 'connect-node'}
                  <Button
                    variant="primary"
                    onclick={openAddTargetWizard}
                    dataTestId="empty-state-connect-node"
                  >
                    Connect a node
                  </Button>
                {:else if emptyStateCta === 'add-project'}
                  <Button
                    variant="primary"
                    onclick={openAddProjectDialog}
                    dataTestId="empty-state-add-project"
                  >
                    Add project
                  </Button>
                {:else}
                  {@const defaultProject = projects[0]}
                  {#if defaultProject}
                    <Button
                      variant="primary"
                      onclick={() => openNewSessionDialogFor(defaultProject)}
                      dataTestId="empty-state-new-session"
                    >
                      New session
                    </Button>
                  {/if}
                {/if}
              {/snippet}
            </EmptyState>
          {:else}
            <ol class="items">
              {#each transcript?.items ?? [] as item (item.id)}
                <li>
                  {#if item.type === 'message'}
                    <MessageItem
                      {item}
                      thinking={item.kind === 'agent_thought_chunk' && transcript
                        ? isThoughtStillThinking(transcript, item.turnId)
                        : false}
                      turnActive={transcript?.turnActive ?? false}
                    />
                  {:else}
                    <ToolCallRow
                      {item}
                      awaitingPermission={permissionHead?.toolCall.id === item.id}
                    />
                  {/if}
                </li>
              {/each}
            </ol>

            <div class="canvas-footer">
              {#if transcript && transcript.plan.length > 0}
                <PlanCard
                  entries={transcript.plan}
                  collapsed={planCollapsed}
                  onToggle={togglePlanCollapsed}
                />
              {/if}

              <QueuedPromptBar prompts={queuedPrompts} />

              {#if staleNotice}
                <p class="stale-notice" role="status" data-testid="stale-permission-notice">
                  {staleNotice.message}
                </p>
              {/if}

              <PermissionQueueBar
                sessionId={selectedSessionId}
                queue={permissionQueue}
                onResolve={resolvePermission}
                onStop={stopSession}
                narrow={narrowViewport}
              />

              <!-- The composer's own mini-toolbar (redesign brief §1/§6, issue
                   #439): ConfigBar's mode toggle + context/cost meter and
                   AttachmentBar's attach trigger/chip row share one quiet strip
                   directly above the composer, collapsing under a single "···"
                   below `--bp-mobile`/480px (`narrowViewport`). -->
              <div class="composer-toolbar" data-testid="composer-toolbar">
                {#if composerToolbarVisible}
                  <div class="composer-toolbar-controls" data-testid="composer-toolbar-controls">
                    <AttachmentBar
                      {attachments}
                      onFiles={attachFiles}
                      onRetry={retryAttachment}
                      onRemove={removeAttachment}
                    />
                    <ConfigBar
                      options={configOptions}
                      usage={transcript?.usage}
                      cumulativeCostUsd={transcript?.cumulativeCostUsd ?? 0}
                      onChange={changeConfigOption}
                    />
                  </div>
                {/if}
                {#if narrowViewport}
                  <IconButton
                    label={composerToolbarExpanded
                      ? 'Hide composer options'
                      : 'More composer options'}
                    pressed={composerToolbarExpanded}
                    onclick={() => (composerToolbarExpanded = !composerToolbarExpanded)}
                    class="composer-toolbar-expand"
                  >
                    <Icon name="more" />
                  </IconButton>
                {/if}
              </div>

              <form class="composer" onsubmit={submitPrompt}>
                <div class="composer-row">
                  <textarea
                    bind:this={composerTextarea}
                    bind:value={draft}
                    oninput={handleComposerInput}
                    onkeydown={handleComposerKeydown}
                    placeholder="Send a follow-up prompt… (type @ to reference a file)"
                    aria-label="Follow-up prompt"
                    rows="1"
                    data-testid="composer-input"></textarea>
                  <div class="composer-actions">
                    <TurnStopControl
                      turnActive={transcript?.turnActive ?? false}
                      onStop={stopSession}
                    />
                    <Button type="submit" disabled={sendDisabled} ariaLabel="Send prompt"
                      >Send</Button
                    >
                  </div>
                </div>
                <p class="composer-hint" aria-hidden="true">
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                </p>
              </form>
            </div>
          {/if}
        </section>
      </div>

      <!-- The Drawer (redesign brief §1/§7; issue #462), narrowed by design
           spec v4 §3.5 to just the session's own workbench (Files/
           Terminal/Config). Inbox/Nodes/Settings are `mainView`
           destinations now (§3.3), not Drawer tabs. Overlay by default
           (<1280px, or unpinned) through the shared `Overlay` primitive;
           pinnable as a persistent third column at >=1280px
           (`--bp-wide`). -->
      {#snippet drawerPanel()}
        <!-- The click handler is only a guard against `Overlay`'s own
             backdrop-click-to-close bubbling past this panel when in
             overlay mode (mirrors `Dialog.svelte`'s identical
             stop-propagation guard on its own panel). -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <aside
          class="drawer"
          class:drawer-pinned={!drawerIsOverlay}
          data-testid="drawer"
          onclick={(event) => event.stopPropagation()}
          in:drawerSlide
          out:drawerSlide
        >
          <div class="drawer-header">
            <div class="drawer-tabs" role="tablist" aria-label="Panels">
              {#each drawerTabs as tab (tab.id)}
                <button
                  type="button"
                  role="tab"
                  class="drawer-tab"
                  class:active={activeDrawer === tab.id}
                  aria-selected={activeDrawer === tab.id}
                  onclick={() => setActiveDrawer(tab.id)}
                  data-testid={`drawer-tab-${tab.id}`}
                  {@attach revealActiveTab(activeDrawer === tab.id)}
                >
                  <Icon name={tab.icon} class="drawer-tab-icon" />
                  <span>{tab.label}</span>
                </button>
              {/each}
            </div>
            <div class="drawer-header-actions">
              <IconButton
                label={drawerPinned ? 'Unpin panel' : 'Pin panel'}
                pressed={drawerPinned}
                onclick={() => (drawerPinned = !drawerPinned)}
                class="drawer-pin-toggle"
                dataTestId="drawer-pin-toggle"
              >
                <Icon name="pin" />
              </IconButton>
              <IconButton
                label="Close panel"
                onclick={() => setActiveDrawer(null)}
                dataTestId="drawer-close"
              >
                <Icon name="close" />
              </IconButton>
            </div>
          </div>

          <div class="drawer-content">
            {#if activeDrawer === 'files' && selectedSessionId}
              <div class="drawer-panel-inner" data-testid="file-tree-panel-wrapper">
                <FileTreePanel
                  tree={fileTree}
                  onExpand={expandDirectory}
                  onSelectFile={insertFileReference}
                />
              </div>
            {:else if activeDrawer === 'terminal' && selectedSessionId && client}
              <div
                class="drawer-panel-inner drawer-panel-terminal"
                data-testid="terminal-panel-wrapper"
              >
                <InteractiveTerminal sessionId={selectedSessionId} {client} />
              </div>
            {:else if activeDrawer === 'config' && selectedProjectPath}
              <div class="drawer-panel-inner" data-testid="project-config-panel-wrapper">
                <ProjectConfigPanel projectPath={selectedProjectPath} />
              </div>
            {/if}
          </div>
        </aside>
      {/snippet}

      {#if drawerIsOverlay}
        <Overlay
          open={activeDrawer !== null}
          onClose={() => setActiveDrawer(null)}
          zIndex="--z-overlay"
          class="drawer-backdrop"
          testid="drawer-backdrop"
        >
          {@render drawerPanel()}
        </Overlay>
      {:else if activeDrawer !== null}
        {@render drawerPanel()}
      {/if}
    </div>

    <!-- Below `--bp-desktop` the sidebar becomes a sheet and this bar is the
         primary navigation. It deliberately sits ABOVE the sheet's own
         backdrop so the tab that opened the sheet can also close it — the v2
         rail was covered by that backdrop, which made the sheet a one-way
         door on touch. -->
    <nav class="tabbar" aria-label="Primary">
      <button
        type="button"
        class="tabbar-item"
        class:active={sessionsSheetOpen}
        onclick={() => (sessionsSheetOpen = !sessionsSheetOpen)}
        data-testid="tabbar-sessions"
      >
        <Icon name="sessions" class="tabbar-icon" />
        <span>Sessions</span>
      </button>
      <button
        type="button"
        class="tabbar-item"
        class:active={mainView === 'inbox'}
        onclick={() => {
          mainView = 'inbox';
          sessionsSheetOpen = false;
        }}
        data-testid="tabbar-inbox"
      >
        <Icon name="inbox" class="tabbar-icon" />
        <span>Inbox</span>
        {#if attentionInboxItems.length > 0}
          <span class="tabbar-badge">{attentionInboxItems.length}</span>
        {/if}
      </button>
      <button
        type="button"
        class="tabbar-item"
        class:active={mainView === 'nodes'}
        onclick={() => {
          openTargetStatus();
          sessionsSheetOpen = false;
        }}
        data-testid="tabbar-targets"
      >
        <Icon name="targets" class="tabbar-icon" />
        <span>Nodes</span>
      </button>
      <button
        type="button"
        class="tabbar-item"
        onclick={() => (paletteOpen = true)}
        data-testid="tabbar-command"
      >
        <Icon name="command" class="tabbar-icon" />
        <span>Command</span>
      </button>
      <button
        type="button"
        class="tabbar-item"
        class:active={mainView === 'settings'}
        onclick={() => {
          mainView = 'settings';
          sessionsSheetOpen = false;
        }}
        data-testid="tabbar-settings"
      >
        <Icon name="settings" class="tabbar-icon" />
        <span>Settings</span>
      </button>
    </nav>
  {/if}
</main>

<CommandPalette
  open={paletteOpen}
  sessions={paletteSessions}
  actions={paletteActions}
  onSelectSession={(id) => {
    selectSession(id);
    paletteOpen = false;
  }}
  onClose={() => (paletteOpen = false)}
/>

<FileReferencePicker
  open={filePickerOpen}
  tree={fileTree}
  onExpand={expandDirectory}
  onSelect={insertFileReference}
  onClose={closeFilePicker}
/>

{#if newSessionProject}
  <NewSessionDialog
    open={newSessionOpen}
    project={newSessionProject}
    {client}
    onClose={() => (newSessionOpen = false)}
    onCreated={handleSessionCreated}
    onGitRepoResolved={(isGitRepo) => {
      if (newSessionProject) projectStore.setGitRepo(newSessionProject.id, isGitRepo);
    }}
  />
{/if}

<AddProjectDialog
  open={addProjectOpen}
  targets={targetStatusEntries}
  {client}
  onClose={() => (addProjectOpen = false)}
  onCreated={handleProjectCreated}
/>

<AddTargetWizard open={addTargetOpen} {client} onClose={() => (addTargetOpen = false)} />

<style>
  main {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    gap: var(--space-lg);
    padding: var(--space-lg);
  }

  /* The cockpit (redesign v3 design spec §3.1) resets the plain stacked-
     column padding/gap above in favour of a sidebar + workspace row that
     fills the viewport edge to edge; the pre-cockpit screens (checking
     session / sign-in / onboarding) keep the original padded, centered
     column layout untouched.

     `height`, not `min-height`: the sidebar's own footer (secondary nav +
     account) is pinned to the bottom of a column that must therefore END at
     the viewport, and `min-height` lets a tall transcript push it off the
     bottom of the screen instead. */
  main.cockpit {
    height: 100dvh;
    gap: 0;
    padding: 0;
    overflow: hidden;
  }

  .header-lockup {
    position: relative;
    text-align: center;
  }

  .brand-heading {
    display: flex;
    justify-content: center;
    margin: 0;
  }

  .header-lockup p {
    margin: var(--space-2xs) 0 0;
    opacity: 0.7;
  }

  /* Brand lockup (issue #194) + theme/appearance toggles (issue #195/#376):
     pinned to the header's top-right corner rather than crowding the
     centered lockup/tagline. */
  .header-actions {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    gap: var(--space-2xs);
  }

  /* The active-toggle visual shared by every consolidated `Button`-based
     toggle in this file (issue #462) — see `toggleActiveClass`'s own doc
     comment. `Button` itself has no persisted "pressed" visual (only
     `IconButton` does via `pressed`/`aria-pressed`), so a plain text toggle
     button needs this instead. `:global` because `class` lands on the
     `<button>` `Button.svelte` renders, not an element `+page.svelte`
     renders directly (same reason `Dialog.svelte`'s `:global(.dialog-backdrop)`
     exists). */
  :global(.warp-toggle-active) {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .appearance-settings-panel {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-md);
  }

  .appearance-settings-panel h2 {
    font-size: 1rem;
    margin: 0 0 var(--space-sm);
  }

  .connection {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
  }

  /* The sign-in gate (redesign brief §4/§6) stacks its `EmptyState` +
     Relay URL override as a centered column instead of `.connection`'s
     default flex-wrap row — two classes on the one element gives this
     higher specificity than the bare `.connection` rule above without
     touching the other screens that still use `.connection` alone. */
  .connection.sign-in {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-lg);
  }

  .relay-url-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-sm);
  }

  .relay-url-row label {
    color: var(--color-text-secondary);
    font-size: var(--text-small-size);
  }

  .relay-url-row input {
    max-width: 24rem;
  }

  .connection input {
    flex: 1;
    min-width: 10rem;
    padding: var(--space-2xs) var(--space-sm);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-fill-subtle);
    color: inherit;
    font: inherit;
  }

  .connection input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  /* A shared baseline for the connection bar's own plain buttons ("Sign in
     with GitHub", "Jump to…", "Sign out") so they read as this app's UI
     rather than the browser's default unstyled `<button>` — the toggle
     buttons in this same bar (`.inbox-toggle`, `.notification-settings-
     toggle`) already draw this exact look, this just extends it to the
     rest instead of leaving them as an inconsistent outlier. This bar only
     renders now while checking session/signed-out/onboarding — the
     cockpit's own header below replaced it there. */
  .connection button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    border: 1px solid currentColor;
    border-radius: var(--radius-md);
    background: transparent;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    color: inherit;
    font-size: var(--text-small-size);
  }

  .connection button:hover {
    background: var(--color-fill-subtle);
  }

  .connection button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    opacity: 0.7;
    font-size: var(--text-small-size);
  }

  .loading-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .account {
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    opacity: 0.8;
  }

  /* Layout-only wrapper — the in-flight/error chrome itself comes from the
     nested `Card`/`ErrorNotice` (redesign brief §4/§6, issue #430). */
  .escrow-status {
    font-size: var(--text-small-size);
  }

  .escrow-inflight-row {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  /* thread-draw for the escrow in-flight state (redesign brief §6's
     "thread-draw for the escrow/pairing in-flight state"). */
  .in-flight-track {
    display: block;
    width: 100%;
    max-width: 12rem;
    height: 2px;
    margin-top: var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill-subtle);
    overflow: hidden;
  }

  .in-flight-bar {
    display: block;
    height: 100%;
    background: var(--color-accent);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* ================================================================== */
  /* The cockpit shell (redesign v3 design spec §3.1-§3.6): sidebar +     */
  /* workspace + drawer, filling the viewport edge to edge.               */
  /* ================================================================== */

  .shell {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar                                                             */
  /* ------------------------------------------------------------------ */

  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    min-height: 0;
    width: var(--sidebar-width);
    background: var(--color-rail);
    border-right: 1px solid var(--color-border);
    transition: width var(--duration-base) var(--ease-shuttle);
  }

  .sidebar.resizing {
    transition: none;
  }

  .sidebar.collapsed {
    width: var(--sidebar-width-collapsed);
  }

  .sidebar-brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
    height: 3rem;
    padding: 0 var(--space-sm) 0 var(--space-md);
    flex-shrink: 0;
  }

  .sidebar-brand-mark {
    margin: 0;
    min-width: 0;
    font-size: var(--text-body-size);
    line-height: 1;
  }

  /* Collapsed, the brand row stacks: the mark on top, the EXPAND control
     right under it. Hiding the control here (the first cut of this rewrite
     did) makes collapsing a one-way door — the only way back was clearing
     `loombox:sessions-collapsed` by hand. */
  .sidebar.collapsed .sidebar-brand {
    flex-direction: column;
    justify-content: center;
    gap: var(--space-2xs);
    height: auto;
    padding: var(--space-sm) 0;
  }

  /* Expanded, the control is quiet until the sidebar is hovered or holds
     focus — it is a preference, not a primary action. It is always visible
     while collapsed (see above) and on a coarse pointer, which has no
     hover to reveal it with. */
  .sidebar:not(.collapsed):not(:hover):not(:focus-within)
    .sidebar-brand
    :global(.sidebar-collapse-toggle) {
    opacity: 0;
  }

  @media (hover: none) {
    .sidebar .sidebar-brand :global(.sidebar-collapse-toggle) {
      opacity: 1;
    }
  }

  .sidebar-brand :global(.sidebar-collapse-toggle) {
    transition: opacity var(--duration-fast) var(--ease-beat);
  }

  .sidebar-brand :global(.icon.flip) {
    transform: scaleX(-1);
  }

  /* ------------------------------------------------------------------ */
  /* Primary destinations (design spec v4 §3.1): Inbox/Nodes/Settings, now */
  /* the top of the sidebar rather than a muted secondary nav at the       */
  /* bottom: their active state is a filled surface (not a subtle tint)   */
  /* because they now indicate what the MAIN AREA is showing, a stronger  */
  /* claim than the old toggle-a-drawer-tab behaviour they replace.       */
  /* ------------------------------------------------------------------ */

  .sidebar-destinations {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-sm) var(--space-sm) var(--space-xs);
    flex-shrink: 0;
  }

  .destination-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    height: var(--nav-row-height);
    padding: 0 var(--space-sm);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: var(--text-body-size);
    text-align: left;
  }

  .destination-row:hover {
    background: var(--color-fill-subtle);
    color: var(--color-text-primary);
  }

  .destination-row.active {
    background: var(--color-fill);
    color: var(--color-text-primary);
  }

  .destination-icon {
    display: inline-flex;
    flex-shrink: 0;
    width: var(--nav-icon-size);
    height: var(--nav-icon-size);
  }

  .destination-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .destination-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.2rem;
    height: 1.2rem;
    padding: 0 var(--space-2xs);
    border-radius: var(--radius-full);
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    font-size: var(--text-caption-size);
    font-family: var(--font-mono);
    font-feature-settings: var(--font-feature-tabular);
  }

  .destination-badge-dot {
    min-width: 0.45rem;
    width: 0.45rem;
    height: 0.45rem;
    padding: 0;
    background: var(--color-warning);
  }

  .sidebar-divider {
    height: 1px;
    margin: var(--space-xs) var(--space-md);
    background: var(--color-border-subtle);
    flex-shrink: 0;
  }

  .sidebar-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-xs) var(--space-sm) var(--space-2xs) var(--space-md);
    flex-shrink: 0;
  }

  .sidebar-section-title {
    font-size: var(--text-caption-size);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  /* ------------------------------------------------------------------ */
  /* Anchored popovers — no scrim, unlike the v2 account menu, which dimmed */
  /* the entire app behind a two-item list (spec §3.1 / defect A3).        */
  /* ------------------------------------------------------------------ */

  .popover-menu {
    position: absolute;
    z-index: var(--z-raised);
    min-width: 12rem;
    display: flex;
    flex-direction: column;
    padding: var(--space-2xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-lg);
  }

  .popover-below {
    top: calc(100% - var(--space-2xs));
    left: var(--space-md);
    right: var(--space-md);
  }

  .popover-above {
    bottom: calc(100% + var(--space-2xs));
    left: var(--space-sm);
    right: var(--space-sm);
  }

  .popover-heading {
    margin: 0;
    padding: var(--space-2xs) var(--space-sm) 0;
    font-size: var(--text-caption-size);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  .popover-identity {
    margin: 0;
    padding: 0 var(--space-sm);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .popover-identity-secondary {
    margin: 0;
    padding: 0 var(--space-sm);
    font-size: var(--text-caption-size);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The identity block is separated from the actions by one hairline,
     whichever of the two identity lines happens to be last. */
  .popover-above p:last-of-type {
    padding-bottom: var(--space-2xs);
    margin-bottom: var(--space-2xs);
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .popover-menu button {
    text-align: left;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-xs) var(--space-sm);
    font-size: var(--text-small-size);
    cursor: pointer;
  }

  .popover-menu button:hover,
  .popover-menu button:focus-visible {
    background: var(--color-fill-subtle);
  }

  .popover-menu button.danger {
    color: var(--color-danger);
  }

  /* ------------------------------------------------------------------ */
  /* Filter + session list                                               */
  /* ------------------------------------------------------------------ */

  .sidebar-filter {
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 var(--space-md) var(--space-sm);
    flex-shrink: 0;
  }

  .sidebar-filter :global(.sidebar-filter-icon) {
    position: absolute;
    left: var(--space-sm);
    color: var(--color-text-muted);
    pointer-events: none;
  }

  .sidebar-filter input {
    width: 100%;
    padding: var(--space-2xs) var(--space-sm) var(--space-2xs) var(--space-2xl);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    color: inherit;
    font: inherit;
    font-size: var(--text-small-size);
  }

  .sidebar-filter input::placeholder {
    color: var(--color-text-muted);
  }

  .sidebar-filter input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
    border-color: var(--color-border);
  }

  .sidebar-sessions {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-sm) var(--space-sm);
  }

  .sidebar.collapsed .sidebar-sessions {
    padding-inline: var(--space-2xs);
  }

  .sidebar-sessions ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .session-row {
    position: relative;
    display: flex;
    align-items: center;
    /* beat-in (redesign brief §2): 4px upward slide + fade, staggered
       20ms/item, capped at 5 rows — mirrors `AttentionInbox`'s own
       identical treatment. */
    animation: beat-in var(--duration-base) var(--ease-beat) both;
  }

  .session-row:nth-child(2) {
    animation-delay: 20ms;
  }

  .session-row:nth-child(3) {
    animation-delay: 40ms;
  }

  .session-row:nth-child(4) {
    animation-delay: 60ms;
  }

  .session-row:nth-child(n + 5) {
    animation-delay: 80ms;
  }

  @keyframes beat-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .session {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--space-sm);
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .session:hover {
    background: var(--color-fill-subtle);
  }

  .session.selected {
    background: var(--color-fill);
  }

  .session:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: calc(var(--focus-ring-offset) * -1);
  }

  .session-status {
    display: inline-flex;
    align-items: center;
  }

  .session-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
  }

  .session-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    min-width: 0;
  }

  .session-title-row strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body-size);
    font-weight: 500;
  }

  .session.selected .session-title-row strong {
    color: var(--color-text-primary);
  }

  .session-attention-dot {
    flex-shrink: 0;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: var(--radius-full);
    background: var(--color-warning);
  }

  .session-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
  }

  /* The `⋯` menu replaces the permanently visible "Target status" button
     that used to squeeze the title down to one character (defect B3),
     hover/focus-revealed rather than reserving its own column so the
     row's width budget goes entirely to the title. */
  .session-row-actions {
    position: absolute;
    right: var(--space-2xs);
    top: 50%;
    transform: translateY(-50%);
    opacity: 0;
    pointer-events: none;
  }

  .session-row:hover .session-row-actions,
  .session-row:focus-within .session-row-actions,
  .session-row.menu-open .session-row-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .session-row-actions .popover-menu {
    top: calc(100% + var(--space-2xs));
    right: 0;
  }

  /* A coarse pointer has no hover: the row menu stays visible there. */
  @media (hover: none) {
    .session-row-actions {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .project-group + .project-group {
    margin-top: var(--space-sm);
  }

  .project-group-header-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    padding: var(--space-2xs) var(--space-sm) var(--space-2xs) var(--space-2xs);
  }

  .project-group-header {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    padding: var(--space-2xs) var(--space-2xs) var(--space-2xs) var(--space-sm);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
    text-align: left;
  }

  .project-group-header:hover {
    color: var(--color-text-primary);
    background: var(--color-fill-subtle);
  }

  .project-group-header-renaming {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    padding-left: var(--space-sm);
  }

  :global(.project-group-chevron) {
    flex-shrink: 0;
    transform: rotate(0deg);
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  :global(.project-group-chevron.collapsed) {
    transform: rotate(-90deg);
  }

  .project-group-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-rename-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-3xs) var(--space-2xs);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-fill-subtle);
    color: inherit;
    font: inherit;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .project-rename-input:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .project-group-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
  }

  .project-group-count {
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
    font-feature-settings: var(--font-feature-tabular);
  }

  .project-group-sessions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* Indented one step under their group (design spec v4 §3.2). */
  .project-group-sessions .session {
    padding-left: calc(var(--space-sm) + var(--space-lg));
  }

  .project-new-session-row {
    display: flex;
  }

  .project-new-session {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-2xs) var(--space-sm) var(--space-2xs)
      calc(var(--space-sm) + var(--space-lg));
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: var(--text-small-size);
    text-align: left;
  }

  .project-new-session:hover {
    color: var(--color-text-secondary);
    background: var(--color-fill-subtle);
  }

  .key-mismatch {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    padding: var(--space-sm);
  }

  .key-mismatch-title {
    margin: 0;
    font-weight: 500;
    color: var(--color-danger);
  }

  .key-mismatch .hint {
    margin: 0;
    font-size: var(--text-small-size);
    color: var(--color-text-muted);
  }

  /* ------------------------------------------------------------------ */
  /* Collapsed sidebar: icon-only session rail                            */
  /* ------------------------------------------------------------------ */

  .selvage-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2xs);
  }

  .selvage-session {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    color: inherit;
    cursor: pointer;
    padding: 0;
  }

  .selvage-session.selected {
    border-color: var(--color-accent);
  }

  .selvage-session.needs-attention::after {
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: var(--radius-full);
    background: var(--color-warning);
  }

  .selvage-avatar {
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .selvage-session :global(.selvage-status-dot) {
    position: absolute;
    bottom: -2px;
    right: -2px;
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar footer: account                                              */
  /* ------------------------------------------------------------------ */

  .sidebar-account {
    position: relative;
    padding: 0 var(--space-sm) var(--space-sm);
    flex-shrink: 0;
  }

  .account-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    padding: var(--space-2xs) var(--space-sm);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .account-trigger:hover,
  .account-trigger[aria-expanded='true'] {
    background: var(--color-fill-subtle);
  }

  .account-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-sm);
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .account-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .sidebar.collapsed .destination-label,
  .sidebar.collapsed .account-name,
  .sidebar.collapsed :global(.account-chevron),
  .sidebar.collapsed .destination-badge:not(.destination-badge-dot) {
    display: none;
  }

  .sidebar.collapsed .destination-row,
  .sidebar.collapsed .account-trigger {
    justify-content: center;
    padding-inline: 0;
  }

  .sidebar-resize-handle {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    background: transparent;
    z-index: var(--z-raised);
  }

  .sidebar-resize-handle:hover,
  .sidebar-resize-handle:focus-visible {
    background: var(--color-accent-subtle);
    outline: none;
  }

  .sidebar-backdrop {
    display: none;
  }

  /* ------------------------------------------------------------------ */
  /* Workspace: context header + canvas                                   */
  /* ------------------------------------------------------------------ */

  .workspace {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    height: 3rem;
    flex-shrink: 0;
    padding: 0 var(--space-lg);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .topbar-context {
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    min-width: 0;
  }

  .topbar-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body-size);
    font-weight: 500;
  }

  .topbar-title-muted {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .topbar-breadcrumb {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-small-size);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
  }

  /* Rendered only when the connection is NOT healthy (spec §3.3): the v2
     header spent its highest-attention pixels on a permanently green,
     unlabelled dot that said nothing and offered nothing. */
  .connection-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    padding: var(--space-3xs) var(--space-xs);
    margin-right: var(--space-2xs);
    border-radius: var(--radius-full);
    font-size: var(--text-caption-size);
  }

  .connection-chip[data-tone='warning'] {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
  }

  .connection-chip[data-tone='danger'] {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
  }

  .connection-chip[data-tone='neutral'] {
    background: var(--color-fill-subtle);
    color: var(--color-text-muted);
  }

  .connection-chip button {
    border: none;
    background: transparent;
    color: inherit;
    padding: 0 var(--space-2xs);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  /* Same measure and centring as `.items` below, so a banner does not run
     the full 1920px canvas while everything under it is capped. */
  .workspace-notice {
    width: 100%;
    max-width: calc(var(--measure) + var(--space-lg) * 2);
    margin-inline: auto;
    padding: var(--space-sm) var(--space-lg) 0;
  }

  .canvas {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: var(--space-lg);
    gap: var(--space-md);
  }

  /* The three `mainView` pages render here instead of the transcript
     (design spec v4 §3.3): `.canvas` itself has no scroll of its own
     (the transcript's `.items` handles that internally while `.canvas-
     footer` stays pinned below it); a page has no such footer to reserve
     space for, so this is the one place that needs its own scroll. */
  .canvas-page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* A readable measure (spec §3.4 / defect C3): transcript prose used to
     run the full 1440-1920px canvas, ~150 characters a line. Code, diffs
     and terminal output opt into `--measure-wide` from their own
     components. */
  .items {
    flex: 1;
    width: 100%;
    max-width: var(--measure);
    margin-inline: auto;
    overflow-y: auto;
    list-style: none;
    padding: 0;
    margin-block: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .canvas-footer {
    width: 100%;
    max-width: var(--measure);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    flex-shrink: 0;
  }

  .composer-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .composer-toolbar-controls {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .composer-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-sm);
    padding: var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .composer-row:focus-within {
    border-color: var(--color-border-strong);
  }

  .composer-row textarea {
    flex: 1;
    min-width: 0;
    max-height: 40vh;
    resize: none;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: var(--text-body-line);
  }

  .composer-row textarea::placeholder {
    color: var(--color-text-muted);
  }

  .composer-row textarea:focus,
  .composer-row textarea:focus-visible {
    outline: none;
  }

  .composer-actions {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-shrink: 0;
  }

  .composer-hint {
    margin: 0;
    text-align: right;
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
  }

  .composer-hint kbd {
    font-family: var(--font-mono);
    font-size: inherit;
  }

  .empty {
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
  }

  .stale-notice {
    margin: 0;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-md);
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    font-size: var(--text-small-size);
  }

  /* ------------------------------------------------------------------ */
  /* Drawer                                                              */
  /* ------------------------------------------------------------------ */

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(26rem, 90vw);
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border-left: 1px solid var(--color-border-strong);
    box-shadow: var(--shadow-lg);
    z-index: var(--z-overlay);
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    padding: var(--space-2xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  /* One scrolling row, never two wrapped ones (spec §3.6 / defect D1). */
  .drawer-tabs {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .drawer-tabs::-webkit-scrollbar {
    display: none;
  }

  .drawer-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
    padding: var(--space-2xs) var(--space-xs);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: var(--text-small-size);
    white-space: nowrap;
  }

  .drawer-tab:hover {
    color: var(--color-text-primary);
  }

  .drawer-tab.active {
    background: var(--color-fill);
    color: var(--color-text-primary);
  }

  .drawer-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    flex-shrink: 0;
  }

  /* Pinning only has an effect at `--bp-wide` and above. */
  .drawer-header-actions :global(.drawer-pin-toggle) {
    display: none;
  }

  .drawer-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-md);
  }

  .drawer-panel-inner {
    height: 100%;
  }

  .drawer-panel-terminal {
    display: flex;
    min-height: 20rem;
  }

  /* ------------------------------------------------------------------ */
  /* Mobile tab bar                                                      */
  /* ------------------------------------------------------------------ */

  .tabbar {
    display: none;
  }

  /* ------------------------------------------------------------------ */
  /* Responsive                                                          */
  /* ------------------------------------------------------------------ */

  /* Below `--bp-desktop` (1024px) the sidebar becomes a sheet and the tab
     bar takes over primary navigation. */
  @media (max-width: 1023px) {
    .tabbar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      /* Deliberately ABOVE the sheet and its backdrop (`--z-overlay` vs the
         sheet's `--z-sticky`): the v2 rail sat underneath, so the tab that
         opened the sessions sheet could not close it again (defect B9). */
      z-index: var(--z-overlay);
      display: flex;
      height: 3.5rem;
      align-items: stretch;
      justify-content: space-around;
      border-top: 1px solid var(--color-border);
      background: var(--color-rail);
    }

    .tabbar-item {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-3xs);
      border: none;
      border-top: 2px solid transparent;
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      font-size: var(--text-caption-size);
    }

    .tabbar-item.active {
      border-top-color: var(--color-accent);
      color: var(--color-accent);
    }

    .tabbar-badge {
      position: absolute;
      top: var(--space-2xs);
      left: 55%;
      min-width: 1rem;
      padding: 0 var(--space-3xs);
      border-radius: var(--radius-full);
      background: var(--color-warning);
      color: var(--color-text-inverse);
      font-size: var(--text-caption-size);
      font-feature-settings: var(--font-feature-tabular);
    }

    .shell {
      padding-bottom: 3.5rem;
    }

    .sidebar {
      position: fixed;
      top: 0;
      bottom: 3.5rem;
      left: 0;
      z-index: var(--z-sticky);
      width: min(20rem, 85vw) !important;
      transform: translateX(-100%);
      transition: transform var(--duration-base) var(--ease-shuttle);
    }

    .sidebar.sheet-open {
      transform: translateX(0);
    }

    .sidebar-backdrop {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 3.5rem;
      z-index: calc(var(--z-sticky) - 1);
      border: none;
      background: var(--color-overlay);
      cursor: default;
    }

    /* Drag-resize and collapse-to-rail are wide-viewport concepts. */
    .sidebar-resize-handle,
    .sidebar-brand :global(.sidebar-collapse-toggle) {
      display: none;
    }
  }

  /* Below `--bp-tablet` (768px) the Drawer becomes a bottom sheet. */
  @media (max-width: 767px) {
    .topbar {
      padding-inline: var(--space-md);
    }

    .topbar-breadcrumb {
      display: none;
    }

    .canvas {
      padding: var(--space-md);
    }

    .drawer {
      top: auto;
      left: 0;
      right: 0;
      bottom: 3.5rem;
      width: 100%;
      height: 60vh;
      border-left: none;
      border-top: 1px solid var(--color-border-strong);
    }
  }

  /* At `--bp-wide` (1280px) and above the Drawer can be pinned as a
     persistent third column instead of an overlay. */
  @media (min-width: 1280px) {
    .drawer-header-actions :global(.drawer-pin-toggle) {
      display: inline-flex;
    }
  }

  /* The pinned static-column state itself (issue #462): applied by JS
     (`drawerIsOverlay`'s own doc comment) rather than gated behind the
     `--bp-wide` media query above. */
  .drawer-pinned {
    position: static;
    width: 24rem;
    flex-shrink: 0;
    box-shadow: none;
    border-left: 1px solid var(--color-border);
  }
</style>
