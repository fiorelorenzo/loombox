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
  import { themeStore, type ThemePreference } from '$lib/theme';
  import {
    createLocalStorageNotificationPreferencesStorage,
    defaultNotificationPreferences,
    type NotificationPreferences as NotificationPreferencesData,
    type NotificationPreferencesStorage,
  } from '$lib/notification-preferences';
  import AppearanceSettings from '$lib/components/AppearanceSettings.svelte';
  import AttachmentBar from '$lib/components/AttachmentBar.svelte';
  import AttentionInbox from '$lib/components/AttentionInbox.svelte';
  import BrandLockup from '$lib/components/BrandLockup.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import CommandPalette, { type CommandPaletteAction } from '$lib/components/CommandPalette.svelte';
  import ConfigBar from '$lib/components/ConfigBar.svelte';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import FileReferencePicker from '$lib/components/FileReferencePicker.svelte';
  import FileTreePanel from '$lib/components/FileTreePanel.svelte';
  import Icon from '$lib/components/icons/Icon.svelte';
  import InteractiveTerminal from '$lib/components/InteractiveTerminal.svelte';
  import PushNotificationToggle from '$lib/components/PushNotificationToggle.svelte';
  import NotificationPreferences from '$lib/components/NotificationPreferences.svelte';
  import MessageItem from '$lib/components/MessageItem.svelte';
  import NewSessionDialog from '$lib/components/NewSessionDialog.svelte';
  import AddTargetWizard from '$lib/components/AddTargetWizard.svelte';
  import TargetStatusView, {
    type FocusTarget as TargetStatusFocusTarget,
  } from '$lib/components/TargetStatusView.svelte';
  import OnboardingGate from '$lib/components/OnboardingGate.svelte';
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

  /**
   * The single Drawer state (redesign brief `docs/design/redesign.md` §1/§7,
   * issue #427): replaces six independently-toggled panel booleans
   * (`inboxOpen`, `targetStatusOpen`, `appearanceSettingsOpen`,
   * `notificationSettingsOpen`, `fileTreeOpen`, `terminalOpen`,
   * `projectConfigOpen`) with one union — only one Drawer tab is ever open
   * at a time now ("one tab visible at a time in overlay mode"). `'settings'`
   * covers both the old Appearance and Notification panels (now two
   * sections of one Drawer tab); the pre-authentication sign-in screen's
   * own minimal Appearance-only affordance reuses this exact same state
   * rather than a parallel boolean, so there is still only ever one "what
   * panel is open" answer for the whole page. Every existing panel
   * component (`AttentionInbox`, `TargetStatusView`, `FileTreePanel`,
   * `InteractiveTerminal`, `ProjectConfigPanel`, `AppearanceSettings`,
   * `NotificationPreferences`) keeps its own props/logic/tests unchanged —
   * only the container deciding whether it renders changed.
   */
  type DrawerTab = 'inbox' | 'targets' | 'files' | 'terminal' | 'config' | 'settings';
  let activeDrawer = $state<DrawerTab | null>(null);
  /** The Drawer's persistent-column mode at `--bp-wide`/`WIDE_VIEWPORT_BREAKPOINT_PX` and above (redesign brief §1's "toggle, persisted per-user"); below that width this is ignored and the Drawer is always an overlay/bottom-sheet — see this file's style block. Restored from `localStorage` in `onMount` below. */
  let drawerPinned = $state(false);
  const DRAWER_PINNED_STORAGE_KEY = 'loombox:drawer-pinned';
  /** True at/below `--bp-wide`/`WIDE_VIEWPORT_BREAKPOINT_PX` (1280px), where `drawerPinned` is ignored and the Drawer is always an overlay/bottom-sheet (see `WIDE_VIEWPORT_BREAKPOINT_PX`'s own doc comment) — a live `matchMedia` read, subscribed in `onMount` below, mirroring `sessionsSheetViewport`'s identical pattern for the Sessions column's own breakpoint. Drives `drawerIsOverlay` below, which is what decides whether the Drawer renders through the shared `Overlay` primitive (issue #462's backdrop-click/Escape close). */
  let drawerNarrowViewport = $state(false);
  /** The mobile/tablet Sessions sheet (redesign brief §1's "<768px ... full-height sheet reached via a header 'Sessions' affordance, dismissed on pick"); a no-op at wider viewports where the Sessions column is always visible inline. */
  let sessionsSheetOpen = $state(false);
  /** The cockpit header's account/settings menu (redesign brief §1's "one account/settings menu"). */
  let accountMenuOpen = $state(false);

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

  /** The redesign brief's header title zone: "current session title once selected" (§1). */
  const selectedSessionTitle = $derived(
    sessions.find((session) => session.id === selectedSessionId)?.title,
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

  // Most logic (the WS connection, the E2E-encrypted session list, the
  // transcript decrypt+reduce, the permission queue, config options, and the
  // composer's send path) lives in $lib/relay-client.ts, unit-tested there
  // against a real in-process relay plus a fake independently-keyed node —
  // no browser. This component renders that module's stores through the
  // Wave D.2 widget set ($lib/components/*): tier-1/tier-2 tool-call
  // widgets, the diff viewer, the inline plan card, the permission FIFO
  // queue bar, and the config bar, each unit-tested on its own against fixed
  // fixtures rather than through this page.
  let client: RelayClient | undefined;
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

  /** The "New session" flow's entry point (SPEC §7.1; issue #385) — wired to the sessions aside's CTA and the empty-state's own action. */
  function openNewSessionDialog(): void {
    newSessionOpen = true;
  }

  /** The "Add target" zero-touch provision-and-pair wizard's entry point (SPEC §7.23; issue #408) — wired to the sessions aside's CTA and `NewSessionDialog`'s own "no nodes connected yet" empty state. */
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

  /** The node/target status view's entry point (SPEC §7.21; issue #269; redesign brief's Drawer "targets" tab) — `focus` optionally scopes the highlight to one session's target (wired from the sessions list's target link below). Polling itself is already running (`startTargetStatusPolling`, connection-scoped) — this just opens the Drawer and requests an immediate refresh so the view isn't stale from the moment it's shown. */
  function openTargetStatus(focus?: TargetStatusFocusTarget): void {
    targetStatusFocus = focus;
    setActiveDrawer('targets');
    void refreshTargetStatus();
  }

  function closeTargetStatus(): void {
    if (activeDrawer === 'targets') setActiveDrawer(null);
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
    // Closes whatever Drawer tab was open (inbox/targets/files/terminal/
    // config/settings) — none of them have anything to show once
    // disconnected.
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
      id: 'toggle-inbox',
      label: activeDrawer === 'inbox' ? 'Close attention inbox' : 'Open attention inbox',
      run: () => toggleDrawer('inbox'),
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
  interface SessionGroup {
    key: string;
    label: string;
    sessions: ClientSessionMeta[];
  }

  function sessionTargetKey(session: ClientSessionMeta): string {
    return `${session.nodeId}:${session.targetId}`;
  }

  /** The group header's label — the live target list's own label when it's arrived, falling back to the bare `targetId` before it has (mirrors `targetHealthDots`' own `label ?? targetId` fallback above). */
  function sessionTargetLabel(session: ClientSessionMeta): string {
    const target = targetStatusEntries.find(
      (entry) => entry.nodeId === session.nodeId && entry.targetId === session.targetId,
    );
    return target?.label ?? session.targetId;
  }

  const groupSessionsByTarget = $derived(new Set(sessions.map(sessionTargetKey)).size > 1);

  const sessionGroups = $derived.by((): SessionGroup[] => {
    if (!groupSessionsByTarget) return [];
    const groups = new SvelteMap<string, SessionGroup>();
    for (const session of sessions) {
      const key = sessionTargetKey(session);
      let group = groups.get(key);
      if (!group) {
        group = { key, label: sessionTargetLabel(session), sessions: [] };
        groups.set(key, group);
      }
      group.sessions.push(session);
    }
    return Array.from(groups.values());
  });

  /** Which target groups are currently collapsed (redesign brief §1's "collapsible" group header) — transient UI state, unlike the column's own persisted width/collapsed-state, so it resets to "all expanded" on reload. A `SvelteSet` (not a plain `Set` wrapped in `$state`) so mutating it in place is enough to trigger reactivity, mirroring `planCollapsedBySession`'s own `SvelteMap` above. */
  const collapsedGroupKeys = new SvelteSet<string>();

  function toggleGroupCollapsed(key: string): void {
    if (collapsedGroupKeys.has(key)) collapsedGroupKeys.delete(key);
    else collapsedGroupKeys.add(key);
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

  /** Maps `AcpSessionStatus` onto the shared `StatusDot` tone vocabulary — the same four colors the row's existing `.status-badge` text already carries (see its own CSS below), just also driving the dot. */
  const SESSION_STATUS_TONES: Record<AcpSessionStatus, StatusTone> = {
    working: 'info',
    awaiting_input: 'neutral',
    permission_required: 'warning',
    error: 'danger',
    exited: 'neutral',
  };

  const SESSION_STATUS_LABELS: Record<AcpSessionStatus, string> = {
    working: 'Working',
    awaiting_input: 'Awaiting input',
    permission_required: 'Permission required',
    error: 'Error',
    exited: 'Exited',
  };

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
      unsubscribeAuthSession();
      unsubscribeNarrow();
      unsubscribeSessionsSheetViewport();
      unsubscribeDrawerNarrowViewport();
      disconnect();
    };
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

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
    <section class="connection">
      <span class="account">{authSession.accountId}</span>
      <span class="status" data-status={status}>
        {#if status === 'connecting'}
          <WovenLoader label="Connecting to the relay" />
        {/if}
        status: {status}
      </span>
      <Button
        variant="ghost"
        size="sm"
        class={toggleActiveClass(activeDrawer === 'inbox')}
        onclick={() => toggleDrawer('inbox')}
        dataTestId="inbox-toggle"
      >
        Inbox
        {#if attentionInboxItems.length > 0}
          <span class="inbox-count" data-testid="inbox-count">{attentionInboxItems.length}</span>
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class={toggleActiveClass(activeDrawer === 'targets')}
        onclick={() => (activeDrawer === 'targets' ? closeTargetStatus() : openTargetStatus())}
        dataTestId="target-status-toggle"
      >
        Nodes &amp; targets
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onclick={() => (paletteOpen = true)}
        dataTestId="command-palette-toggle"
      >
        Jump to… (Ctrl/Cmd+K)
      </Button>
      <Button variant="ghost" size="sm" onclick={signOut}>Sign out</Button>
      {#if deviceId}
        <PushNotificationToggle
          relayBaseUrl={relayHttpBaseUrl(relayUrl)}
          authToken={authSession.token}
          {deviceId}
        />
        <Button
          variant="ghost"
          size="sm"
          class={toggleActiveClass(activeDrawer === 'settings')}
          onclick={() => toggleDrawer('settings')}
          dataTestId="notification-settings-toggle"
        >
          Mute &amp; quiet hours
        </Button>
      {/if}
      {#if authError}
        <p class="error" role="alert">{authError}</p>
      {/if}
    </section>

    <OnboardingGate
      accountId={authSession.accountId}
      {relayUrl}
      authToken={authSession.token}
      onFirstDevice={handleFirstDeviceOnboarded}
      onNewDevice={handleNewDeviceOnboarded}
    />
  {:else}
    <!-- The Warp Deck cockpit (redesign brief §1, issue #427): a sticky
         3-zone header, then a rail/sessions/canvas/drawer row filling the
         rest of the viewport. -->
    <header class="warp-header">
      <div class="warp-header-zone warp-header-left">
        <h1 class="cockpit-brand">
          <BrandMark decorative={false} label="loombox" />
        </h1>
        {#if selectedSessionTitle}
          <span class="session-title" data-testid="cockpit-session-title"
            >{selectedSessionTitle}</span
          >
        {/if}
      </div>

      <div class="warp-header-zone warp-header-center">
        <!-- The compact, always-visible target-health StatusDot cluster
             (redesign brief §0/§1/§6): glanceable node/target health without
             opening the Drawer. Fed by `startTargetStatusPolling`, which
             runs continuously once connected, not only while the Drawer's
             "targets" tab happens to be open. -->
        {#if targetHealthDots.length > 0}
          <Button
            variant="ghost"
            size="sm"
            class="target-health-cluster"
            onclick={() => openTargetStatus()}
            ariaLabel="Nodes &amp; targets"
            dataTestId="target-health-cluster"
          >
            {#each targetHealthDots.slice(0, 6) as dot (dot.key)}
              <!-- TODO(redesign wave 2): replace with <StatusDot>. -->
              <span class="target-dot" data-state={dot.state} title={dot.label}></span>
            {/each}
            {#if targetHealthDots.length > 6}
              <span class="target-dot-overflow">+{targetHealthDots.length - 6}</span>
            {/if}
          </Button>
        {/if}
      </div>

      <div class="warp-header-zone warp-header-right">
        <span
          class="connection-dot"
          data-status={status}
          title={`status: ${status}`}
          data-testid="connection-status-dot"
        >
          <span class="sr-only">status: {status}</span>
        </span>
        <IconButton
          label="Jump to… (Ctrl/Cmd+K)"
          onclick={() => (paletteOpen = true)}
          dataTestId="command-palette-toggle"
        >
          <Icon name="command" />
        </IconButton>
        <div class="account-menu">
          <!-- `aria-haspopup`/`aria-expanded` on a disclosure trigger aren't
               attributes the shared `Button` primitive forwards — kept as a
               plain button rather than dropping real, load-bearing a11y
               semantics for the sake of consolidation. -->
          <button
            type="button"
            class="account-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onclick={() => (accountMenuOpen = !accountMenuOpen)}
            data-testid="account-menu-toggle"
          >
            {authSession.accountId}
          </button>
        </div>
      </div>
    </header>

    <!-- The account menu's dropdown (redesign v2 §2 "Drawer that closes + IA
         cleanup", issue #462): rendered through the shared `Overlay`
         primitive, as a sibling of `.warp-header` rather than nested inside
         it — `.warp-header`'s own `position: sticky` + `z-index` establishes
         a stacking context that used to cap the dropdown's effective z-index
         below the Drawer's, regardless of its own (higher) local z-index.
         Sharing one overlay root at the top level fixes that. IA cleanup:
         this menu is identity-only now — Sign out and an Appearance
         shortcut; Notifications/Nodes & targets/Inbox are all reachable from
         the rail (or the Settings Drawer tab) already, so they're gone from
         here rather than duplicated. -->
    <Overlay
      open={accountMenuOpen}
      onClose={() => (accountMenuOpen = false)}
      zIndex="--z-overlay"
      class="account-menu-backdrop"
      testid="account-menu-backdrop"
    >
      <!-- The click handler is only a guard against `Overlay`'s own
           backdrop-click-to-close bubbling past this panel (mirrors
           `Dialog.svelte`'s identical stop-propagation guard on its own
           panel) — every real interaction here is a child button. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div
        class="account-menu-dropdown"
        role="menu"
        data-testid="account-menu"
        onclick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            setActiveDrawer('settings');
            accountMenuOpen = false;
          }}
        >
          Appearance
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          onclick={() => {
            accountMenuOpen = false;
            void signOut();
          }}
        >
          Sign out
        </button>
      </div>
    </Overlay>

    {#if escrowStatus !== 'idle'}
      <!-- The first-device escrow round trip (redesign brief §6, issue
           #430): a real `Card` for the in-flight wait, with the
           `thread-draw-fill-loop` sweep the brief names directly for
           "the escrow/pairing in-flight state"; a real `ErrorNotice` if it
           fails, rather than a bare tinted paragraph either way. -->
      <div
        class="escrow-status"
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
    {#if authError}
      <p class="error" role="alert">{authError}</p>
    {/if}

    <div class="warp-body">
      <nav class="rail" aria-label="Primary">
        <button
          type="button"
          class="rail-item"
          class:active={sessionsSheetOpen}
          onclick={() => (sessionsSheetOpen = !sessionsSheetOpen)}
          data-testid="rail-sessions"
        >
          <Icon name="sessions" class="rail-icon" />
          <span class="rail-label">Sessions</span>
        </button>
        <button
          type="button"
          class="rail-item"
          class:active={activeDrawer === 'inbox'}
          onclick={() => toggleDrawer('inbox')}
          data-testid="rail-inbox"
        >
          <Icon name="inbox" class="rail-icon" />
          <span class="rail-label">Inbox</span>
          {#if attentionInboxItems.length > 0}
            <span class="rail-badge" data-testid="rail-inbox-badge"
              >{attentionInboxItems.length}</span
            >
          {/if}
        </button>
        <button
          type="button"
          class="rail-item"
          class:active={activeDrawer === 'targets'}
          onclick={() => (activeDrawer === 'targets' ? closeTargetStatus() : openTargetStatus())}
          data-testid="rail-targets"
        >
          <Icon name="targets" class="rail-icon" />
          <span class="rail-label">Nodes &amp; targets</span>
          {#if hasUnhealthyTarget}
            <span
              class="rail-badge rail-badge-dot"
              data-testid="rail-targets-badge"
              aria-hidden="true"
            ></span>
          {/if}
        </button>
        <button
          type="button"
          class="rail-item"
          onclick={() => (paletteOpen = true)}
          data-testid="rail-command"
        >
          <Icon name="command" class="rail-icon" />
          <span class="rail-label">Command</span>
        </button>
        <div class="rail-spacer"></div>
        <button
          type="button"
          class="rail-item"
          class:active={activeDrawer === 'settings'}
          onclick={() => toggleDrawer('settings')}
          data-testid="rail-settings"
        >
          <Icon name="settings" class="rail-icon" />
          <span class="rail-label">Settings</span>
        </button>
      </nav>

      {#if sessionsSheetOpen}
        <button
          type="button"
          class="sessions-backdrop"
          aria-label="Close sessions"
          onclick={() => (sessionsSheetOpen = false)}
        ></button>
      {/if}

      <!-- A single row's markup (redesign brief §1/§4, issue #438: StatusDot
           + first-letter avatar + title + last-activity + attention
           affordance), shared between the flat list and the grouped-by-
           target list below so neither copy can drift from the other. -->
      {#snippet sessionRow(session: ClientSessionMeta)}
        {@const sessionStatus = sessionStatuses.get(session.id)}
        {@const needsAttention = sessionsNeedingAttention.has(session.id)}
        <li class="session-row" data-testid="session-row-item">
          <button
            type="button"
            class="session"
            class:selected={session.id === selectedSessionId}
            onclick={() => selectSession(session.id)}
          >
            <span class="session-avatar" aria-hidden="true">{sessionInitial(session)}</span>
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
                {#if sessionStatus}
                  <span
                    class="status-badge"
                    data-status={sessionStatus}
                    data-testid="session-status-badge"
                  >
                    <StatusDot
                      tone={SESSION_STATUS_TONES[sessionStatus]}
                      pulse={sessionStatus === 'working'}
                      label={SESSION_STATUS_LABELS[sessionStatus]}
                      size="sm"
                    />
                    {sessionStatus}
                  </span>
                {/if}
              </span>
              <span class="session-meta-row">
                <small>{session.provider} · {session.projectPath} · {session.targetId}</small>
                <span class="session-activity font-mono" data-testid="session-activity"
                  >{formatSessionActivity(session.createdAt)}</span
                >
              </span>
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            class="session-target-status-link"
            ariaLabel={`View status for target ${session.targetId}`}
            onclick={() => openTargetStatus({ nodeId: session.nodeId, targetId: session.targetId })}
            dataTestId="session-target-status-link"
          >
            Target status
          </Button>
        </li>
      {/snippet}

      <!-- The icon-only "selvage rail" row (redesign brief §1: "status dot
           + first-letter avatar, tooltip on hover"). -->
      {#snippet selvageSessionRow(session: ClientSessionMeta)}
        {@const sessionStatus = sessionStatuses.get(session.id)}
        <li>
          <button
            type="button"
            class="selvage-session"
            class:selected={session.id === selectedSessionId}
            class:needs-attention={sessionsNeedingAttention.has(session.id)}
            onclick={() => selectSession(session.id)}
            title={session.title}
            aria-label={session.title}
            data-testid="selvage-session"
          >
            <span class="selvage-avatar" aria-hidden="true">{sessionInitial(session)}</span>
            <StatusDot
              tone={sessionStatus ? SESSION_STATUS_TONES[sessionStatus] : 'neutral'}
              pulse={sessionStatus === 'working'}
              label={sessionStatus ? SESSION_STATUS_LABELS[sessionStatus] : 'No status yet'}
              size="sm"
              class="selvage-status-dot"
            />
          </button>
        </li>
      {/snippet}

      <aside
        class="sessions"
        class:sheet-open={sessionsSheetOpen}
        class:collapsed={sessionsRailCollapsed}
        class:resizing={sessionsResizing}
        style={sessionsSheetViewport ? undefined : `width: ${sessionsColumnWidthPx}px`}
        data-testid="sessions-column"
      >
        <div class="sessions-header">
          {#if !sessionsRailCollapsed}
            <h2>Sessions</h2>
          {/if}
          <div class="sessions-header-actions">
            {#if !sessionsRailCollapsed && status === 'open'}
              <Button
                variant="secondary"
                size="sm"
                onclick={openAddTargetWizard}
                dataTestId="add-target-button"
              >
                Add target
              </Button>
              <Button
                variant="primary"
                size="sm"
                onclick={openNewSessionDialog}
                dataTestId="new-session-button"
              >
                New session
              </Button>
            {/if}
            <!-- TODO(redesign wave 2/5): replace this chevron glyph with the real icon set (SPEC brief §5). -->
            <IconButton
              label={sessionsCollapsed ? 'Expand sessions' : 'Collapse sessions'}
              pressed={sessionsCollapsed}
              onclick={toggleSessionsCollapsed}
              class="sessions-collapse-toggle"
            >
              <span aria-hidden="true">{sessionsCollapsed ? '»' : '«'}</span>
            </IconButton>
          </div>
        </div>

        <div class="sessions-content">
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
          {:else if sessions.length === 0}
            <EmptyState message="No sessions yet. Start one to connect an agent to a project.">
              {#snippet cta()}
                <Button
                  variant="primary"
                  onclick={openNewSessionDialog}
                  dataTestId="new-session-empty-cta"
                >
                  Start your first session
                </Button>
              {/snippet}
            </EmptyState>
          {:else if groupSessionsByTarget}
            {#each sessionGroups as group (group.key)}
              <div class="session-group">
                <button
                  type="button"
                  class="session-group-header"
                  onclick={() => toggleGroupCollapsed(group.key)}
                  aria-expanded={!collapsedGroupKeys.has(group.key)}
                  data-testid="session-group-header"
                >
                  <Icon
                    name="collapse-chevron"
                    class={collapsedGroupKeys.has(group.key)
                      ? 'session-group-chevron collapsed'
                      : 'session-group-chevron'}
                  />
                  <span class="session-group-label">{group.label}</span>
                  <span class="session-group-count">{group.sessions.length}</span>
                </button>
                {#if !collapsedGroupKeys.has(group.key)}
                  <ul>
                    {#each group.sessions as session (session.id)}
                      {@render sessionRow(session)}
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          {:else}
            <ul>
              {#each sessions as session (session.id)}
                {@render sessionRow(session)}
              {/each}
            </ul>
          {/if}
        </div>

        {#if !sessionsRailCollapsed}
          <!-- A focusable, draggable `separator` (redesign brief §1's
               drag-resize handle) is the WAI-ARIA APG's own "Window
               Splitter" pattern — a deliberate exception to the usual
               noninteractive-role rule, mirroring `PermissionCard.svelte`'s
               identical pair of ignores for its own keyboard-focusable
               `group`. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="sessions-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sessions column"
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

      <section class="canvas">
        {#if !selectedSessionId}
          <p class="empty">Select a session to view its live transcript.</p>
        {:else}
          <div class="transcript-toolbar">
            <CopyButton
              text={transcript ? exportTranscriptText(transcript) : ''}
              label="Export transcript"
              copyFn={exportTranscript}
            />
            <Button
              variant="ghost"
              size="sm"
              class={toggleActiveClass(activeDrawer === 'files')}
              onclick={() => toggleDrawer('files')}
              dataTestId="file-tree-toggle"
            >
              Files
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class={toggleActiveClass(activeDrawer === 'terminal')}
              onclick={() => toggleDrawer('terminal')}
              dataTestId="terminal-toggle"
            >
              Terminal
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class={toggleActiveClass(activeDrawer === 'config')}
              onclick={() => toggleDrawer('config')}
              dataTestId="project-config-toggle"
            >
              Config
            </Button>
          </div>

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
               below `--bp-mobile`/480px (`narrowViewport`) — see
               `composerToolbarVisible`'s own doc comment for the
               force-expand-when-attaching exception. -->
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
                label={composerToolbarExpanded ? 'Hide composer options' : 'More composer options'}
                pressed={composerToolbarExpanded}
                onclick={() => (composerToolbarExpanded = !composerToolbarExpanded)}
                class="composer-toolbar-expand"
              >
                ···
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
                <Button type="submit" disabled={sendDisabled} ariaLabel="Send prompt">Send</Button>
              </div>
            </div>
          </form>
        {/if}
      </section>

      <!-- The Drawer (redesign brief §1/§7; issue #462): replaces the six
           independently-toggled inline panels with tabs of one component,
           one tab visible at a time. Overlay by default (<1280px, or
           unpinned) — rendered through the shared `Overlay` primitive
           (backdrop-click/Escape close, same z-index tier as the account
           menu); pinnable as a persistent third column at >=1280px
           (`--bp-wide`) via `drawerPinned`, in which case there's no
           backdrop/Escape at all (it's part of the layout, not a
           dismissible overlay) — see `drawerIsOverlay`'s own doc comment. -->
      {#snippet drawerPanel(authSession: StoredAuthSession)}
        <!-- The click handler is only a guard against `Overlay`'s own
             backdrop-click-to-close bubbling past this panel when in
             overlay mode (mirrors `Dialog.svelte`'s identical
             stop-propagation guard on its own panel; a no-op, but
             harmless, in pinned mode where there's no backdrop to guard
             against) — every real interaction here is a child control. -->
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
              <Button
                variant="ghost"
                size="sm"
                class={toggleActiveClass(activeDrawer === 'inbox')}
                onclick={() => setActiveDrawer('inbox')}
                dataTestId="drawer-tab-inbox"
              >
                Inbox
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class={toggleActiveClass(activeDrawer === 'targets')}
                onclick={() => setActiveDrawer('targets')}
                dataTestId="drawer-tab-targets"
              >
                Nodes &amp; targets
              </Button>
              {#if selectedSessionId}
                <Button
                  variant="ghost"
                  size="sm"
                  class={toggleActiveClass(activeDrawer === 'files')}
                  onclick={() => setActiveDrawer('files')}
                  dataTestId="drawer-tab-files"
                >
                  Files
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class={toggleActiveClass(activeDrawer === 'terminal')}
                  onclick={() => setActiveDrawer('terminal')}
                  dataTestId="drawer-tab-terminal"
                >
                  Terminal
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class={toggleActiveClass(activeDrawer === 'config')}
                  onclick={() => setActiveDrawer('config')}
                  dataTestId="drawer-tab-config"
                >
                  Config
                </Button>
              {/if}
              <Button
                variant="ghost"
                size="sm"
                class={toggleActiveClass(activeDrawer === 'settings')}
                onclick={() => setActiveDrawer('settings')}
                dataTestId="drawer-tab-settings"
              >
                Settings
              </Button>
            </div>
            <div class="drawer-header-actions">
              <!-- Redesign brief §1: pinnable as a persistent column at
                   >=1280px only — the toggle itself is always reachable,
                   but has no visible effect below that width. `aria-pressed`
                   on a *text* toggle isn't something either shared primitive
                   supports (`Button` has no pressed state; `IconButton`
                   hides visible text), so this one stays a plain button
                   rather than lose that a11y semantic. -->
              <button
                type="button"
                class="drawer-pin-toggle"
                class:active={drawerPinned}
                aria-pressed={drawerPinned}
                onclick={() => (drawerPinned = !drawerPinned)}
                data-testid="drawer-pin-toggle"
                title={drawerPinned ? 'Unpin panel' : 'Pin panel'}
              >
                Pin
              </button>
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
            {#if activeDrawer === 'inbox'}
              <AttentionInbox
                items={attentionInboxItems}
                onResolve={resolveInboxPermission}
                onOpenSession={openSessionFromInbox}
                onReply={replyFromInbox}
              />
            {:else if activeDrawer === 'targets'}
              <TargetStatusView
                targets={targetStatusEntries}
                loading={targetStatusLoading}
                error={targetStatusError}
                focusTarget={targetStatusFocus}
                onRefresh={refreshTargetStatus}
                onClose={closeTargetStatus}
              />
            {:else if activeDrawer === 'files' && selectedSessionId}
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
            {:else if activeDrawer === 'settings'}
              <div class="settings-tab">
                <section class="settings-section">
                  <h3>Appearance</h3>
                  <AppearanceSettings />
                </section>
                {#if notificationPreferencesStorage}
                  <section class="settings-section">
                    <h3>Notifications</h3>
                    <NotificationPreferences
                      {projectPaths}
                      storage={notificationPreferencesStorage}
                      onChange={onNotificationPreferencesChange}
                    />
                  </section>
                {/if}
                {#if deviceId}
                  <section class="settings-section">
                    <h3>Push notifications</h3>
                    <PushNotificationToggle
                      relayBaseUrl={relayHttpBaseUrl(relayUrl)}
                      authToken={authSession.token}
                      {deviceId}
                    />
                  </section>
                {/if}
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
          {@render drawerPanel(authSession)}
        </Overlay>
      {:else if activeDrawer !== null}
        {@render drawerPanel(authSession)}
      {/if}
    </div>
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

<NewSessionDialog
  open={newSessionOpen}
  {client}
  onCreated={handleSessionCreated}
  onClose={() => (newSessionOpen = false)}
  onAddTarget={() => {
    newSessionOpen = false;
    openAddTargetWizard();
  }}
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

  /* The Warp Deck cockpit (redesign brief `docs/design/redesign.md` §1,
     issue #427) resets the plain stacked-column padding/gap above in favor
     of a sticky header plus a rail/sessions/canvas/drawer row that fills
     the rest of the viewport edge-to-edge; the pre-cockpit screens
     (checking session/sign-in/onboarding) keep the original padded,
     centered column layout untouched. */
  main.cockpit {
    gap: 0;
    padding: 0;
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

  .inbox-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.2rem;
    height: 1.2rem;
    padding: 0 var(--space-2xs);
    border-radius: var(--radius-full);
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    font-size: 0.7rem;
    font-family: var(--font-mono);
    font-feature-settings: var(--font-feature-tabular);
  }

  .session-row {
    display: flex;
    align-items: stretch;
    gap: var(--space-2xs);
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

  .session-row .session {
    flex: 1;
    min-width: 0;
  }

  /* `:global` — `class` here lands on the `<button>` `Button.svelte` (a
     child component) renders, which carries `Button`'s own scope hash, not
     this file's, so a plain (non-`:global`) selector would never match. */
  :global(.session-target-status-link) {
    flex-shrink: 0;
    align-self: center;
  }

  .account {
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
    opacity: 0.8;
  }

  .error {
    color: var(--color-danger);
    margin: 0;
    font-size: var(--text-small-size);
    width: 100%;
  }

  /* The pre-cockpit `.error` above sits inside a padded `.connection` row;
     the cockpit's own top-level error/escrow banners are direct children
     of the now-unpadded `main.cockpit`, so they need their own inline
     margin to line up with the header/rail/canvas content around them. */
  main.cockpit > .escrow-status,
  main.cockpit > .error {
    margin-inline: var(--space-lg);
  }

  /* Layout-only wrapper now — the in-flight/error chrome itself comes from
     the nested `Card`/`ErrorNotice` (redesign brief §4/§6, issue #430). */
  .escrow-status {
    margin: var(--space-sm) 0 0;
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

  /* ------------------------------------------------------------------ */
  /* The cockpit's 3-zone sticky header (redesign brief §1)               */
  /* ------------------------------------------------------------------ */

  .warp-header {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-sm) var(--space-lg);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .warp-header-zone {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
  }

  .warp-header-left,
  .warp-header-right {
    flex: 1;
    min-width: 0;
  }

  .warp-header-right {
    justify-content: flex-end;
  }

  .warp-header-center {
    flex: 0 0 auto;
  }

  .cockpit-brand {
    display: flex;
    align-items: center;
    margin: 0;
    color: var(--color-accent);
    font-size: 1.4rem;
    flex-shrink: 0;
  }

  .session-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-small-size);
    font-weight: 600;
    opacity: 0.85;
  }

  /* The compact, always-visible target-health StatusDot cluster (redesign
     brief §0/§1/§6): glanceable node/target health without opening the
     Drawer. TODO(redesign wave 2): replace `.target-dot` with a real
     <StatusDot> component (thread-draw pulse while `working`, etc.) — this
     is a minimal inline placeholder for the foundation shell. */
  /* `:global` — `class` here lands on the `<button>` `Button.svelte` (a
     child component) renders, which carries `Button`'s own scope hash, not
     this file's, so a plain (non-`:global`) selector would never match
     (same reason as `.session-target-status-link` above). */
  :global(.target-health-cluster) {
    gap: var(--space-3xs);
    border-color: var(--color-border);
    border-radius: var(--radius-full);
  }

  :global(.target-health-cluster:hover),
  :global(.target-health-cluster:focus-visible) {
    border-color: var(--color-border-strong);
  }

  .target-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .target-dot[data-state='healthy'] {
    background: var(--color-success);
  }

  .target-dot[data-state='overloaded'] {
    background: var(--color-warning);
  }

  .target-dot[data-state='unreachable'] {
    background: var(--color-danger);
  }

  .target-dot-overflow {
    font-size: 0.65rem;
    opacity: 0.7;
    font-family: var(--font-mono);
  }

  .connection-dot {
    display: inline-flex;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    transition: background-color var(--duration-fast) var(--ease-beat);
  }

  .connection-dot[data-status='open'] {
    background: var(--color-success);
  }

  .connection-dot[data-status='connecting'] {
    background: var(--color-warning);
  }

  .connection-dot[data-status='error'] {
    background: var(--color-danger);
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

  .account-menu {
    position: relative;
  }

  .account-menu-trigger {
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--text-small-size);
  }

  .account-menu-trigger[aria-expanded='true'] {
    border-color: var(--color-accent);
  }

  /* The backdrop itself (position/z-index/dim) is `Overlay`'s own concern
     now (issue #462) — this `:global` only lays out where the dropdown
     panel sits within it. `:global` because `Overlay` (a child component)
     renders the element this class lands on, not `+page.svelte` directly,
     the same reason `Dialog.svelte`'s own `:global(.dialog-backdrop)`
     exists. Anchored with `position: fixed` (not `absolute` relative to the
     trigger) since the dropdown is now a sibling of `.warp-header`, not
     nested inside it — see the template's own doc comment on why. `top:
     3.5rem` mirrors `.drawer`'s identical assumption about the header's
     rendered height. */
  :global(.account-menu-backdrop) {
    display: flex;
    justify-content: flex-end;
    padding: 3.5rem var(--space-lg) 0 0;
  }

  .account-menu-dropdown {
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    min-width: 12rem;
    height: fit-content;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-lg);
    padding: var(--space-2xs);
  }

  .account-menu-dropdown button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-xs) var(--space-sm);
    cursor: pointer;
    text-align: left;
    font-size: var(--text-small-size);
  }

  .account-menu-dropdown button:hover,
  .account-menu-dropdown button:focus-visible {
    background: var(--color-fill-subtle);
  }

  .account-menu-dropdown button.danger {
    color: var(--color-danger);
  }

  /* ------------------------------------------------------------------ */
  /* The four-zone body: Rail | Sessions | Canvas | Drawer (redesign      */
  /* brief §1)                                                            */
  /* ------------------------------------------------------------------ */

  .warp-body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .rail {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    flex-shrink: 0;
    width: 3.5rem;
    border-right: 1px solid var(--color-border);
    padding: var(--space-sm) 0;
  }

  .rail-item {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3xs);
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: inherit;
    padding: var(--space-sm) var(--space-2xs);
    cursor: pointer;
    opacity: 0.75;
  }

  .rail-item:hover,
  .rail-item:focus-visible {
    opacity: 1;
    background: var(--color-fill-subtle);
  }

  /* Selected rail item reads via a 2px accent left-bar, never a filled
     background (redesign brief §1: "keeping the rail visually quiet"). */
  .rail-item.active {
    opacity: 1;
    border-left-color: var(--color-accent);
    color: var(--color-accent);
  }

  /* `:global` — `class` here lands on the `<svg>` `Icon.svelte` (a child
     component) renders, which carries `Icon`'s own scope hash, not this
     file's, so a plain (non-`:global`) selector would never match. */
  :global(.rail-icon) {
    width: 1.25rem;
    height: 1.25rem;
  }

  .rail-label {
    font-size: 0.6rem;
    text-align: center;
    line-height: 1;
  }

  .rail-badge {
    position: absolute;
    top: var(--space-3xs);
    right: var(--space-3xs);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1rem;
    height: 1rem;
    padding: 0 var(--space-3xs);
    border-radius: var(--radius-full);
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    font-size: 0.6rem;
    font-family: var(--font-mono);
  }

  .rail-badge-dot {
    min-width: 0.5rem;
    width: 0.5rem;
    height: 0.5rem;
    padding: 0;
    background: var(--color-danger);
  }

  .rail-spacer {
    flex: 1;
  }

  .sessions-backdrop {
    display: none;
  }

  /* Drag-resizable width + collapse-to-selvage (redesign brief §1, issue
     #438). Width itself comes from the inline `style` binding
     (`sessionsColumnWidthPx`); the `transition` here only smooths a
     collapse/expand toggle — `.resizing` suppresses it during an active
     drag so the column tracks the pointer instead of visibly lagging. */
  .sessions {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    min-width: 0;
    border-right: 1px solid var(--color-border);
    transition: width var(--duration-fast) var(--ease-beat);
  }

  .sessions.resizing {
    transition: none;
  }

  .sessions-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    padding: var(--space-lg) var(--space-lg) var(--space-sm);
    flex-shrink: 0;
  }

  .sessions.collapsed .sessions-header {
    justify-content: center;
    padding: var(--space-lg) var(--space-2xs) var(--space-sm);
  }

  .sessions-header h2 {
    font-size: 1rem;
    margin: 0;
  }

  .sessions-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .sessions-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-lg) var(--space-lg);
  }

  .sessions.collapsed .sessions-content {
    padding: 0 var(--space-2xs) var(--space-lg);
  }

  /* The drag handle itself — a thin hit target straddling the column's
     right edge (redesign brief §1's "drag-resizable width"). */
  .sessions-resize-handle {
    position: absolute;
    top: 0;
    right: -0.25rem;
    bottom: 0;
    width: 0.5rem;
    cursor: col-resize;
    touch-action: none;
    z-index: var(--z-raised);
  }

  .sessions-resize-handle:hover,
  .sessions-resize-handle:focus-visible {
    background: var(--color-accent-subtle);
  }

  .sessions-resize-handle:focus-visible {
    outline: none;
  }

  .key-mismatch {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
  }

  .key-mismatch-title {
    margin: 0;
    font-weight: 600;
    color: var(--color-danger);
  }

  .key-mismatch .hint {
    margin: 0;
    font-size: var(--text-small-size);
    opacity: 0.85;
  }

  .sessions ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  /* Target/node group headers (redesign brief §1/§4, issue #438): mono,
     small-caps, collapsible — shown only once more than one target is
     active (`groupSessionsByTarget`), otherwise the list stays flat. */
  .session-group + .session-group {
    margin-top: var(--space-md);
  }

  .session-group-header {
    display: flex;
    align-items: center;
    width: 100%;
    gap: var(--space-xs);
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    padding: var(--space-2xs);
    cursor: pointer;
    font-family: var(--font-mono);
    font-variant-caps: small-caps;
    font-size: var(--text-small-size);
    letter-spacing: 0.03em;
    transition: color var(--duration-fast) var(--ease-beat);
  }

  .session-group-header:hover,
  .session-group-header:focus-visible {
    color: var(--color-text-primary);
  }

  /* `:global` — `class` here lands on the `<svg>` `Icon.svelte` (a child
     component) renders, which carries `Icon`'s own scope hash, not this
     file's, so a plain (non-`:global`) selector would never match. */
  :global(.session-group-chevron) {
    flex-shrink: 0;
    transition: transform var(--duration-fast) var(--ease-beat);
  }

  :global(.session-group-chevron.collapsed) {
    transform: rotate(-90deg);
  }

  .session-group-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-group-count {
    flex-shrink: 0;
    margin-left: auto;
    opacity: 0.7;
    font-variant-caps: normal;
  }

  /* Rows (redesign brief §4): quiet hairline-divided, not boxed cards;
     selected/active state is a 2px left accent bar + subtle background
     tint, echoing a highlighted thread on a warp rather than a "selected
     card" pattern. */
  .session {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-sm);
    border-radius: var(--radius-md);
    border-left: 2px solid transparent;
    background: transparent;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat);
  }

  .session:hover:not(.selected) {
    background: var(--color-fill-subtle);
  }

  .session.selected {
    border-left-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .session-avatar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    margin-top: var(--space-3xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .session-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
  }

  .session small {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .session-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    min-width: 0;
  }

  .session-title-row strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The row's "needs attention" affordance (redesign brief's row content,
     issue #438) — a session with a pending item in the cross-project
     attention inbox, distinct from (and additional to) the session's own
     ACP status. */
  .session-attention-dot {
    flex-shrink: 0;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: var(--radius-full);
    background: var(--color-warning);
  }

  .session-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
    min-width: 0;
  }

  .session-meta-row small {
    flex: 1;
    min-width: 0;
  }

  .session-activity {
    flex-shrink: 0;
    opacity: 0.55;
    font-size: 0.7rem;
  }

  /* Session-status badge (SPEC §7.13/§7.24; issue #126) — a neutral default,
     overridden per status so a glance at the list shows what needs
     attention. Redesign brief §4/issue #438: now also carries a `StatusDot`
     alongside its text, mirroring `TargetStatusView.svelte`'s own health
     badge (dot + label together, never color alone). */
  .status-badge {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: var(--space-3xs);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: var(--space-3xs) var(--space-xs);
    border-radius: var(--radius-full);
    background: var(--color-fill);
    opacity: 0.85;
  }

  .status-badge[data-status='working'] {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .status-badge[data-status='permission_required'] {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
  }

  .status-badge[data-status='error'] {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
  }

  .status-badge[data-status='exited'] {
    background: var(--color-fill);
  }

  /* The icon-only "selvage rail" (redesign brief §1: "status dot +
     first-letter avatar, tooltip on hover"). */
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
    width: 2.75rem;
    height: 2.75rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      border-color var(--duration-fast) var(--ease-beat);
  }

  .selvage-session:hover {
    background: var(--color-fill-subtle);
  }

  .selvage-session:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .selvage-session.selected {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .selvage-session.needs-attention .selvage-avatar {
    box-shadow: 0 0 0 2px var(--color-warning);
  }

  .selvage-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-full);
    background: var(--color-fill);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
  }

  /* `StatusDot`'s `class` prop lands inside its own component scope — see
     `EmptyState`'s identical `:global()`-under-a-local-ancestor pattern. */
  .selvage-session :global(.selvage-status-dot) {
    position: absolute;
    bottom: 0.3rem;
    right: 0.3rem;
  }

  .canvas {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    gap: var(--space-sm);
    padding: var(--space-lg);
  }

  .transcript-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    padding-bottom: var(--space-xs);
  }

  .items {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  /* The composer's own mini-toolbar (redesign brief §1/§6, issue #439):
     ConfigBar + AttachmentBar's trigger/chip row share one quiet strip
     directly above the composer, collapsing under a single "···"
     affordance below --bp-mobile/480px (`composerToolbarVisible`'s own
     force-expand-while-attaching exception lives in the script above). */
  .composer-toolbar {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
  }

  .composer-toolbar-controls {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-2xs) var(--space-sm);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
  }

  :global(.composer-toolbar-expand) {
    flex-shrink: 0;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  /* Considered prompt input (redesign brief §4 "Inputs"): flat style, no
     inner shadow — the wrapper's own border strengthens on focus-within
     rather than a colored glow on the textarea itself. */
  .composer-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-sm);
    padding: var(--space-xs);
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
    resize: none;
    border: none;
    background: transparent;
    color: inherit;
    font-family: var(--font-ui);
    font-size: var(--text-body-size);
    line-height: 1.45;
    padding: var(--space-sm) var(--space-xs);
    /* 1-8 rows (redesign brief §4): auto-grows via this file's own
       `autoGrowComposer`, capped here so growth past ~8 lines scrolls
       internally instead of pushing the composer's own actions off-canvas. */
    max-height: 13rem;
    overflow-y: auto;
  }

  .composer-row textarea::placeholder {
    color: var(--color-text-muted);
  }

  .composer-row textarea:focus {
    outline: none;
  }

  .composer-row textarea:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }

  .composer-actions {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-shrink: 0;
    padding-bottom: var(--space-2xs);
  }

  .empty {
    opacity: 0.6;
  }

  /* Stale approve/deny discard note (SPEC §7.3; issue #131). */
  .stale-notice {
    margin: 0;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-md);
    background: var(--color-warning-subtle);
    font-size: 0.8rem;
  }

  /* ------------------------------------------------------------------ */
  /* The Drawer (redesign brief §1/§7): one component, tabs, one tab      */
  /* visible at a time — replaces the six independently-toggled inline    */
  /* panels. Overlay by default; pinnable as a persistent third column at */
  /* >=1280px (`--bp-wide`) via `drawerPinned`. Below 768px it becomes a   */
  /* bottom sheet instead (see the media query at the bottom of this      */
  /* file).                                                                */
  /* ------------------------------------------------------------------ */

  .drawer {
    position: fixed;
    top: 3.5rem;
    right: 0;
    bottom: 0;
    z-index: var(--z-overlay);
    display: flex;
    flex-direction: column;
    width: min(24rem, 100vw);
    background: var(--color-surface-raised);
    border-left: 1px solid var(--color-border-strong);
    box-shadow: var(--shadow-lg);
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .drawer-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2xs);
    min-width: 0;
  }

  .drawer-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
  }

  .drawer-pin-toggle {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-3xs) var(--space-sm);
    cursor: pointer;
    font-size: var(--text-small-size);
  }

  /* Only meaningful — and only shown — at >=1280px (`--bp-wide`), where the
     Drawer can actually become a persistent column; see the media query
     below. Below that width pinning would have no visible effect. */
  .drawer-pin-toggle {
    display: none;
  }

  .drawer-pin-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .drawer-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-md);
  }

  .drawer-panel-inner {
    min-width: 0;
  }

  .drawer-panel-terminal {
    height: 100%;
    min-height: 20rem;
  }

  .settings-tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  .settings-section h3 {
    font-size: var(--text-small-size);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
    margin: 0 0 var(--space-sm);
  }

  /* ------------------------------------------------------------------ */
  /* Responsive collapse (redesign brief §1)                              */
  /* ------------------------------------------------------------------ */

  /* Below `--bp-desktop`/`DESKTOP_VIEWPORT_BREAKPOINT_PX` (1024px): the
     rail collapses to a bottom tab bar. */
  @media (max-width: 1023px) {
    .rail {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      top: auto;
      z-index: var(--z-sticky);
      width: auto;
      height: 3.5rem;
      flex-direction: row;
      align-items: stretch;
      justify-content: space-around;
      border-right: none;
      border-top: 1px solid var(--color-border);
      background: var(--color-bg);
      padding: 0;
    }

    .rail-item {
      flex: 1;
      border-left: none;
      border-top: 2px solid transparent;
      padding: var(--space-2xs);
    }

    .rail-item.active {
      border-left-color: transparent;
      border-top-color: var(--color-accent);
    }

    .rail-spacer {
      display: none;
    }

    .warp-body {
      padding-bottom: 3.5rem;
    }
  }

  /* Below `--bp-tablet`/`TABLET_VIEWPORT_BREAKPOINT_PX` (768px): Sessions
     becomes a dismissible full-height sheet, and the Drawer becomes a
     bottom sheet instead of a right-edge overlay column. */
  @media (max-width: 767px) {
    .session-title {
      display: none;
    }

    .sessions {
      position: fixed;
      inset: 0;
      z-index: var(--z-modal);
      width: 100%;
      border-right: none;
      background: var(--color-bg);
      transform: translateX(-100%);
      transition: transform var(--duration-base) var(--ease-shuttle);
    }

    .sessions.sheet-open {
      transform: translateX(0);
    }

    /* The drag-resize handle and collapse-to-selvage toggle are both a
       wide-viewport concept (redesign brief §1) — below this width Sessions
       is always the full sheet above, `sessionsSheetViewport` already keeps
       the JS side from ever rendering the selvage rail here too. `IconButton`'s
       `class` prop lands inside its own component scope, same as
       `.selvage-session :global(.selvage-status-dot)` below — see
       `EmptyState`'s identical `:global()`-under-a-local-ancestor pattern. */
    .sessions-resize-handle,
    .sessions-header-actions :global(.sessions-collapse-toggle) {
      display: none;
    }

    .sessions-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: calc(var(--z-modal) - 1);
      border: none;
      background: var(--color-overlay);
      cursor: default;
    }

    .drawer {
      top: auto;
      left: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      height: 60vh;
      border-left: none;
      border-top: 1px solid var(--color-border-strong);
    }
  }

  /* At `--bp-wide`/`WIDE_VIEWPORT_BREAKPOINT_PX` (1280px) and above: the
     Drawer can be pinned as a persistent third column instead of an
     overlay (redesign brief §1's "power user" escape hatch). */
  @media (min-width: 1280px) {
    .drawer-pin-toggle {
      display: inline-flex;
    }
  }

  /* The pinned static-column state itself (issue #462): applied by JS
     (`drawerIsOverlay`'s own doc comment) rather than gated behind the
     `--bp-wide` media query above — `drawerIsOverlay` already accounts for
     that exact breakpoint via `drawerNarrowViewport`, so this class is only
     ever present when pinning is genuinely in effect, and no `{#if
     drawer-open}` combinator is needed either now that the Drawer only
     mounts at all while `activeDrawer` is non-null (see the template). */
  .drawer-pinned {
    position: static;
    top: auto;
    width: 22rem;
    flex-shrink: 0;
    height: auto;
    box-shadow: none;
    border-left: 1px solid var(--color-border);
  }
</style>
