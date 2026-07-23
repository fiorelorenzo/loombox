<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
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
  import { isNarrowViewport } from '$lib/viewport';
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
  import CommandPalette, { type CommandPaletteAction } from '$lib/components/CommandPalette.svelte';
  import ConfigBar from '$lib/components/ConfigBar.svelte';
  import CopyButton from '$lib/components/CopyButton.svelte';
  import FileReferencePicker from '$lib/components/FileReferencePicker.svelte';
  import FileTreePanel from '$lib/components/FileTreePanel.svelte';
  import InteractiveTerminal from '$lib/components/InteractiveTerminal.svelte';
  import PushNotificationToggle from '$lib/components/PushNotificationToggle.svelte';
  import NotificationPreferences from '$lib/components/NotificationPreferences.svelte';
  import MessageItem from '$lib/components/MessageItem.svelte';
  import NewSessionDialog from '$lib/components/NewSessionDialog.svelte';
  import AddTargetWizard from '$lib/components/AddTargetWizard.svelte';
  import OnboardingGate from '$lib/components/OnboardingGate.svelte';
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
  // itself is a togglable side panel (`fileTreeOpen`), independent of the
  // picker, which opens on typing '@' in the composer.
  let fileTree = $state<Map<string, FileTreeDirectoryState>>(new Map());
  let fileTreeOpen = $state(false);
  // The interactive PTY terminal panel (SPEC §7.5; issues #172/#173/#174):
  // a togglable side panel, same shape as `fileTreeOpen` above. Each toggle
  // ON mounts a fresh `InteractiveTerminal`, which opens its own new
  // terminal on mount and closes it on unmount (its own doc comment) — so
  // toggling it off and back on again opens a new terminal each time,
  // rather than this page tracking one itself (issue #173's "multiple
  // terminals" is the node/client's job below this component, not this
  // page's).
  let terminalOpen = $state(false);
  // The project config surface (SPEC §7.7; issue #366): a togglable side
  // panel, same shape as `fileTreeOpen`/`terminalOpen` above, that mounts
  // the MCP-server quick-add panel (#188) and the plugin/extension panel
  // (#191) — both shipped in #364 but left unmounted from this file to
  // avoid a parallel-edit clash. See `ProjectConfigPanel.svelte`.
  let projectConfigOpen = $state(false);
  let filePickerOpen = $state(false);
  // The index in `draft` where the triggering '@' sits, so a picked file
  // reference replaces exactly the '@partial-query' text the user typed,
  // rather than being appended blindly. `undefined` means "no active
  // trigger" (the picker was opened some other way, or was never opened).
  let atTriggerStart = $state<number | undefined>(undefined);
  // The cross-project attention inbox (SPEC §7.13; issues #167/#168/#169):
  // one live list across every session on this account, independent of
  // which session (if any) is currently selected/open — see
  // `RelayClient.attentionInbox`'s doc comment.
  let attentionInboxItems = $state<AttentionInboxItem[]>([]);
  let inboxOpen = $state(false);
  // Per-project mute + quiet-hours settings panel (SPEC §7.11, issue #166).
  // `notificationPreferencesStorage` is only ever constructed client-side
  // (onMount below, same reason `amkStorage` is) — `localStorage` doesn't
  // exist during `routes/page.test.ts`'s SSR render.
  let notificationSettingsOpen = $state(false);
  // `$state` (not a plain `let`) because the template's notification
  // settings panel reads it reactively to decide whether to render.
  let notificationPreferencesStorage = $state<NotificationPreferencesStorage | undefined>(
    undefined,
  );
  let notificationPreferences = $state<NotificationPreferencesData>(
    defaultNotificationPreferences(),
  );
  // Design tokens' theme toggle (SPEC.md §4/issue #195): mirrors
  // `$lib/theme.ts`'s store so the header button's label reflects the
  // current preference; the actual `data-theme` DOM effect and
  // localStorage persistence happen in `theme.ts` itself, not here.
  let themePreference = $state<ThemePreference>('system');
  // Appearance settings panel (SPEC.md §4; issues #194/#376): a togglable
  // panel, same shape as `notificationSettingsOpen` below, holding the
  // theme radios and the accent preset/custom picker. `AppearanceSettings`
  // itself owns all the reading/writing against `theme.ts`/`accent.ts`.
  let appearanceSettingsOpen = $state(false);

  // The fuzzy command palette (SPEC §7.3; issue #132).
  let paletteOpen = $state(false);
  // Narrow-viewport permission footer (SPEC §7.3; issue #134) — a live
  // `matchMedia` read, client-only (see `viewport.ts`'s doc comment for why
  // it defaults `false` during SSR).
  let narrowViewport = $state(false);
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

  // Persists an operator-edited relay URL as soon as it changes (not just on
  // submit) so it survives the full-page reload a real OAuth redirect does —
  // see `onMount`'s restore of the same key. `$effect` is client/DOM-only in
  // Svelte 5 (never runs during `routes/page.test.ts`'s SSR render).
  $effect(() => {
    localStorage.setItem(RELAY_URL_STORAGE_KEY, relayUrl);
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
      if (value === 'open' && pendingEscrowRecoveryCode) {
        void escrowPendingRecoveryCode();
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
    inboxOpen = false;
    staleNotice = undefined;
    paletteOpen = false;
    fileTree = new Map();
    fileTreeOpen = false;
    projectConfigOpen = false;
    filePickerOpen = false;
    atTriggerStart = undefined;
    newSessionOpen = false;
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
    const input = event.currentTarget as HTMLInputElement;
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
      label: inboxOpen ? 'Close attention inbox' : 'Open attention inbox',
      run: () => (inboxOpen = !inboxOpen),
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

  /** The global shortcut dispatcher (issue #132): Mod+K opens the palette from anywhere except while the user is already typing somewhere else; Mod+. stops the current turn. The palette itself owns Esc/Arrow/Enter once open (`CommandPalette.svelte`). */
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
    inboxOpen = false;
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

    // Restores an operator-customized relay URL before constructing
    // `authStore` against it, so a self-hoster who edits this field, then
    // signs in (a full-page OAuth redirect that reloads this component from
    // scratch on return), lands back on the SAME relay's session rather than
    // silently falling back to `DEFAULT_RELAY_URL`.
    const persistedRelayUrl = localStorage.getItem(RELAY_URL_STORAGE_KEY);
    if (persistedRelayUrl) relayUrl = persistedRelayUrl;

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
      disconnect();
    };
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<main>
  <header>
    <h1 class="brand-heading"><BrandLockup /></h1>
    <p>{APP_TAGLINE}</p>
    <div class="header-actions">
      <!-- SPEC.md §4 "Tone of voice ... No emoji in product chrome" — a text
           label, not an icon glyph, states the toggle's current mode. -->
      <button
        type="button"
        class="theme-toggle"
        onclick={() => themeStore.toggleTheme()}
        title={`Theme: ${themePreference}`}
        aria-label={`Switch theme (currently ${themePreference})`}
        data-testid="theme-toggle"
        data-theme-preference={themePreference}
      >
        {themePreference}
      </button>
      <button
        type="button"
        class="appearance-toggle"
        class:active={appearanceSettingsOpen}
        onclick={() => (appearanceSettingsOpen = !appearanceSettingsOpen)}
        data-testid="appearance-settings-toggle"
      >
        Appearance
      </button>
    </div>
  </header>

  {#if appearanceSettingsOpen}
    <section class="appearance-settings-panel">
      <h2>Appearance</h2>
      <AppearanceSettings />
    </section>
  {/if}

  {#if !authChecked}
    <section class="connection">
      <p class="empty loading-line">
        <WovenLoader label="Checking session" />
        Checking session…
      </p>
    </section>
  {:else if !authSession}
    <section class="connection sign-in">
      <label for="relay-url">Relay URL</label>
      <input id="relay-url" type="text" bind:value={relayUrl} />
      <button type="button" onclick={signInWithGithub}>Sign in with GitHub</button>
      {#if authError}
        <p class="error" role="alert">{authError}</p>
      {/if}
    </section>
  {:else}
    <section class="connection">
      <span class="account">{authSession.accountId}</span>
      <span class="status" data-status={status}>
        {#if status === 'connecting'}
          <WovenLoader label="Connecting to the relay" />
        {/if}
        status: {status}
      </span>
      <button
        type="button"
        class="inbox-toggle"
        class:active={inboxOpen}
        onclick={() => (inboxOpen = !inboxOpen)}
        data-testid="inbox-toggle"
      >
        Inbox
        {#if attentionInboxItems.length > 0}
          <span class="inbox-count" data-testid="inbox-count">{attentionInboxItems.length}</span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => (paletteOpen = true)}
        data-testid="command-palette-toggle"
      >
        Jump to… (Ctrl/Cmd+K)
      </button>
      <button type="button" onclick={signOut}>Sign out</button>
      {#if deviceId}
        <PushNotificationToggle
          relayBaseUrl={relayHttpBaseUrl(relayUrl)}
          authToken={authSession.token}
          {deviceId}
        />
        <button
          type="button"
          class="notification-settings-toggle"
          class:active={notificationSettingsOpen}
          onclick={() => (notificationSettingsOpen = !notificationSettingsOpen)}
          data-testid="notification-settings-toggle"
        >
          Mute &amp; quiet hours
        </button>
      {/if}
      {#if authError}
        <p class="error" role="alert">{authError}</p>
      {/if}
    </section>

    {#if onboardingNeeded}
      <OnboardingGate
        accountId={authSession.accountId}
        {relayUrl}
        authToken={authSession.token}
        onFirstDevice={handleFirstDeviceOnboarded}
        onNewDevice={handleNewDeviceOnboarded}
      />
    {:else}
      {#if escrowStatus !== 'idle'}
        <p class="escrow-status" role="status" data-testid="escrow-status">
          {#if escrowStatus === 'in-flight'}
            <WovenLoader label="Securing your account key" />
            Securing your account key…
          {:else}
            Couldn't save your Recovery Code to the relay{escrowError ? `: ${escrowError}` : '.'} This
            device still works, but recovering this account elsewhere may not until it does.
          {/if}
        </p>
      {/if}

      {#if notificationSettingsOpen && notificationPreferencesStorage}
        <section class="notification-settings-panel">
          <h2>Notifications</h2>
          <NotificationPreferences
            {projectPaths}
            storage={notificationPreferencesStorage}
            onChange={onNotificationPreferencesChange}
          />
        </section>
      {/if}

      {#if inboxOpen}
        <section class="inbox-panel">
          <h2>Attention inbox</h2>
          <AttentionInbox
            items={attentionInboxItems}
            onResolve={resolveInboxPermission}
            onOpenSession={openSessionFromInbox}
            onReply={replyFromInbox}
          />
        </section>
      {/if}

      <div class="cockpit">
        <aside class="sessions">
          <div class="sessions-header">
            <h2>Sessions</h2>
            {#if status === 'open'}
              <div class="sessions-header-actions">
                <button
                  type="button"
                  class="add-target-button"
                  onclick={openAddTargetWizard}
                  data-testid="add-target-button"
                >
                  Add target
                </button>
                <button
                  type="button"
                  class="new-session-button"
                  onclick={openNewSessionDialog}
                  data-testid="new-session-button"
                >
                  New session
                </button>
              </div>
            {/if}
          </div>
          {#if status === 'connecting' || status === 'idle'}
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
            <div class="empty-sessions">
              <p class="empty">No sessions yet.</p>
              <button
                type="button"
                onclick={openNewSessionDialog}
                data-testid="new-session-empty-cta"
              >
                Start your first session
              </button>
            </div>
          {:else}
            <ul>
              {#each sessions as session (session.id)}
                <li>
                  <button
                    type="button"
                    class="session"
                    class:selected={session.id === selectedSessionId}
                    onclick={() => selectSession(session.id)}
                  >
                    <span class="session-title-row">
                      <strong>{session.title}</strong>
                      {#if sessionStatuses.get(session.id)}
                        <span
                          class="status-badge"
                          data-status={sessionStatuses.get(session.id)}
                          data-testid="session-status-badge"
                        >
                          {sessionStatuses.get(session.id)}
                        </span>
                      {/if}
                    </span>
                    <small>{session.provider} · {session.projectPath} · {session.targetId}</small>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </aside>

        <section class="transcript">
          {#if !selectedSessionId}
            <p class="empty">Select a session to view its live transcript.</p>
          {:else}
            <div class="transcript-toolbar">
              <ConfigBar
                options={configOptions}
                usage={transcript?.usage}
                cumulativeCostUsd={transcript?.cumulativeCostUsd ?? 0}
                onChange={changeConfigOption}
              />
              <TurnStopControl turnActive={transcript?.turnActive ?? false} onStop={stopSession} />
              <CopyButton
                text={transcript ? exportTranscriptText(transcript) : ''}
                label="Export transcript"
                copyFn={exportTranscript}
              />
              <button
                type="button"
                class="file-tree-toggle"
                class:active={fileTreeOpen}
                onclick={() => (fileTreeOpen = !fileTreeOpen)}
                data-testid="file-tree-toggle"
              >
                Files
              </button>
              <button
                type="button"
                class="terminal-toggle"
                class:active={terminalOpen}
                onclick={() => (terminalOpen = !terminalOpen)}
                data-testid="terminal-toggle"
              >
                Terminal
              </button>
              <button
                type="button"
                class="project-config-toggle"
                class:active={projectConfigOpen}
                onclick={() => (projectConfigOpen = !projectConfigOpen)}
                data-testid="project-config-toggle"
              >
                Config
              </button>
            </div>

            {#if fileTreeOpen}
              <aside class="file-tree-panel" data-testid="file-tree-panel-wrapper">
                <FileTreePanel
                  tree={fileTree}
                  onExpand={expandDirectory}
                  onSelectFile={insertFileReference}
                />
              </aside>
            {/if}

            {#if terminalOpen && client}
              <aside class="terminal-panel" data-testid="terminal-panel-wrapper">
                <InteractiveTerminal sessionId={selectedSessionId} {client} />
              </aside>
            {/if}

            {#if projectConfigOpen && selectedProjectPath}
              <aside
                class="project-config-panel-wrapper"
                data-testid="project-config-panel-wrapper"
              >
                <ProjectConfigPanel projectPath={selectedProjectPath} />
              </aside>
            {/if}

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

            <form class="composer" onsubmit={submitPrompt}>
              <AttachmentBar
                {attachments}
                onFiles={attachFiles}
                onRetry={retryAttachment}
                onRemove={removeAttachment}
              />
              <div class="composer-row">
                <input
                  type="text"
                  bind:value={draft}
                  oninput={handleComposerInput}
                  placeholder="Send a follow-up prompt… (type @ to reference a file)"
                  aria-label="Follow-up prompt"
                  data-testid="composer-input"
                />
                <button type="submit" disabled={sendDisabled}>Send</button>
              </div>
            </form>
          {/if}
        </section>
      </div>
    {/if}
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

  header {
    position: relative;
    text-align: center;
  }

  .brand-heading {
    display: flex;
    justify-content: center;
    margin: 0;
  }

  header p {
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

  .theme-toggle,
  .appearance-toggle {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font-size: var(--text-small-size);
  }

  .theme-toggle {
    text-transform: capitalize;
  }

  .appearance-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
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
     rest instead of leaving them as an inconsistent outlier. */
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

  .inbox-toggle {
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

  .inbox-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
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

  .inbox-panel {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-md);
  }

  .inbox-panel h2 {
    font-size: 1rem;
    margin: 0 0 var(--space-sm);
  }

  .notification-settings-toggle {
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

  .notification-settings-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .notification-settings-panel {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-md);
  }

  .notification-settings-panel h2 {
    font-size: 1rem;
    margin: 0 0 var(--space-sm);
  }

  .file-tree-toggle {
    display: inline-flex;
    align-items: center;
    border: 1px solid currentColor;
    border-radius: var(--radius-md);
    background: transparent;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    color: inherit;
    font-size: var(--text-small-size);
  }

  .file-tree-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .file-tree-panel {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-sm);
    max-height: 16rem;
    overflow-y: auto;
  }

  .terminal-toggle {
    display: inline-flex;
    align-items: center;
    border: 1px solid currentColor;
    border-radius: var(--radius-md);
    background: transparent;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    color: inherit;
    font-size: var(--text-small-size);
  }

  .terminal-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .terminal-panel {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    /* Reachability parity (#174): min-width 0 lets this panel shrink inside
       a narrow/mobile flex layout instead of forcing horizontal overflow —
       the same panel, not a separate mobile variant. */
    min-width: 0;
    height: 20rem;
  }

  .project-config-toggle {
    display: inline-flex;
    align-items: center;
    border: 1px solid currentColor;
    border-radius: var(--radius-md);
    background: transparent;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    color: inherit;
    font-size: var(--text-small-size);
  }

  .project-config-toggle.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
  }

  .project-config-panel-wrapper {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-md);
    /* Same narrow/mobile parity fix as `.terminal-panel` (#174). */
    min-width: 0;
    max-height: 24rem;
    overflow-y: auto;
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

  .cockpit {
    display: flex;
    flex: 1;
    gap: var(--space-lg);
    min-height: 0;
  }

  .sessions {
    width: 16rem;
    flex-shrink: 0;
  }

  .sessions-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    margin-bottom: var(--space-sm);
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

  .new-session-button {
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .add-target-button {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font-size: var(--text-small-size);
    font-weight: 600;
  }

  .empty-sessions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-sm);
  }

  .empty-sessions button {
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-md);
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    padding: var(--space-sm) var(--space-md);
    cursor: pointer;
    font-weight: 600;
    font-size: var(--text-small-size);
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

  .escrow-status {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0;
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-fill-subtle);
    font-size: var(--text-small-size);
  }

  .sessions ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .session {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: var(--space-3xs);
    padding: var(--space-sm);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
  }

  .session.selected {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
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
    justify-content: space-between;
    gap: var(--space-xs);
    min-width: 0;
  }

  .session-title-row strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Session-status badge (SPEC §7.13/§7.24; issue #126) — a neutral default,
     overridden per status so a glance at the list shows what needs attention. */
  .status-badge {
    flex-shrink: 0;
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

  .transcript {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    gap: var(--space-sm);
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

  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .composer-row {
    display: flex;
    gap: var(--space-sm);
  }

  .composer-row input {
    flex: 1;
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
</style>
