<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import { env as publicEnv } from '$env/dynamic/public';
  import type {
    AcpAvailableCommand,
    AcpConfigOption,
    AcpPermissionOption,
    AcpSessionStatus,
    PermissionQueueState,
    TranscriptState,
  } from '@loombox/providers-core/browser';
  import {
    createPermissionQueueState,
    headPermissionRequest,
  } from '@loombox/providers-core/browser';
  import type { SessionStatusV1 } from '@loombox/protocol';
  import { copyToClipboard, exportTranscriptText } from '$lib/copy';
  import {
    RelayClient,
    bootstrapAmkFromRecoveryCode,
    type AttentionInboxItem,
    type BootstrapAmkResult,
    type BuildIdentityV1,
    type ClientSessionMeta,
    type ConnectedAccount,
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
  import {
    DockPanel,
    type DockPanelPersistence,
    type DockPanelState,
  } from '$lib/dock-panel.svelte';
  import { isModShortcut, isTypingTarget } from '$lib/keyboard';
  import {
    getAvailableActions,
    matchShortcut,
    type ActionContext,
    type ActionHandlers,
  } from '$lib/action-registry';
  import type { QueuedPrompt } from '$lib/outbox';
  import { isThoughtStillThinking } from '$lib/thinking';
  import {
    DESKTOP_VIEWPORT_BREAKPOINT_PX,
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
  import {
    createLocalStorageNotificationPreferencesStorage,
    defaultNotificationPreferences,
    type NotificationPreferences as NotificationPreferencesData,
    type NotificationPreferencesStorage,
  } from '$lib/notification-preferences';
  import {
    createLocalStorageConfigOptionDefaultsStorage,
    rememberConfigOptionValues,
    rememberedConfigOptionsFor,
    type ConfigOptionDefaultsStorage,
    type RememberedConfigOptionValues,
  } from '$lib/config-option-defaults';
  import {
    clearConfigOptionOverride,
    configOptionOverridesFor,
    createLocalStorageConfigOptionOverrideStorage,
    setConfigOptionOverride,
  } from '$lib/config-option-overrides';
  import {
    resolveConfigOptionDefaults,
    resolveConfigOptionSources,
    type ConfigOptionSource,
  } from '$lib/config-option-resolution';
  import {
    createProjectStore,
    projectKey,
    projectNameFromPath,
    sessionProjectKey,
    type NewProject,
    type Project,
  } from '$lib/projects';
  import AddProjectDialog from '$lib/components/AddProjectDialog.svelte';
  import ArchiveSessionDialog from '$lib/components/ArchiveSessionDialog.svelte';
  import AttachmentBar from '$lib/components/AttachmentBar.svelte';
  import BrandLockup from '$lib/components/BrandLockup.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import CommandPalette, { type CommandPaletteAction } from '$lib/components/CommandPalette.svelte';
  import ConfigBar from '$lib/components/ConfigBar.svelte';
  import FileReferencePicker from '$lib/components/FileReferencePicker.svelte';
  import FileTreePanel from '$lib/components/FileTreePanel.svelte';
  import GateShell from '$lib/components/GateShell.svelte';
  import Icon from '$lib/components/icons/Icon.svelte';
  import type { IconName } from '$lib/components/icons';
  import InteractiveTerminal from '$lib/components/InteractiveTerminal.svelte';
  import NewSessionDialog from '$lib/components/NewSessionDialog.svelte';
  import AddTargetWizard from '$lib/components/AddTargetWizard.svelte';
  import type { FocusTarget as TargetStatusFocusTarget } from '$lib/components/TargetStatusView.svelte';
  import OnboardingGate from '$lib/components/OnboardingGate.svelte';
  import InboxPage from '$lib/components/pages/InboxPage.svelte';
  import SettingsPage, { type SettingsSection } from '$lib/components/pages/SettingsPage.svelte';
  import TrackerPage from '$lib/components/pages/TrackerPage.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import ErrorNotice from '$lib/components/ui/ErrorNotice.svelte';
  import Field from '$lib/components/ui/Field.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Overlay from '$lib/components/ui/Overlay.svelte';
  import StatusDot, { type StatusTone } from '$lib/components/ui/StatusDot.svelte';
  import PermissionQueueBar from '$lib/components/PermissionQueueBar.svelte';
  import PlanCard from '$lib/components/PlanCard.svelte';
  import ProjectConfigPanel from '$lib/components/ProjectConfigPanel.svelte';
  import QueuedPromptBar from '$lib/components/QueuedPromptBar.svelte';
  import RecoveryCodeEntryForm from '$lib/components/RecoveryCodeEntryForm.svelte';
  import RunnerPanel from '$lib/components/RunnerPanel.svelte';
  import SlashCommandPicker from '$lib/components/SlashCommandPicker.svelte';
  import TranscriptTimeline from '$lib/components/TranscriptTimeline.svelte';
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
  // Account-wide remembered config-option values (issue #753, D4-2/D4-3) —
  // same "only ever constructed client-side" reasoning as `amkStorage`
  // above: `localStorage` doesn't exist during `routes/page.test.ts`'s SSR
  // render.
  let configOptionDefaultsStorage: ConfigOptionDefaultsStorage | undefined;
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
  // True from the moment the sign-in button is pressed until either the browser
  // leaves for GitHub or the attempt fails — see `signInWithGithub` below.
  let signingIn = $state(false);

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
   * destinations now, not workbench tabs; the right sidebar keeps only what
   * is scoped to the open session (Files/Config, `WORKBENCH_TABS` below).
   * Selecting a session always sets `'session'`; selecting a destination
   * sets that destination and deliberately LEAVES `selectedSessionId`
   * alone, so returning to the transcript is one click and the header
   * breadcrumb (§3.6) is never lost.
   *
   * Amended by issue #568: `'nodes'` is gone. Nodes & targets is no longer
   * a destination of its own — it is a section inside `'settings'` now
   * (`settingsSection` below), reached one click deeper than before. IA v4
   * §3.1 is amended accordingly (`docs/superpowers/specs/2026-07-25-ia-v4-design.md`).
   */
  let mainView = $state<'session' | 'inbox' | 'settings' | 'tracker'>('session');

  /**
   * Which section of the Settings page is showing (issue #568): Settings
   * outgrew a flat `<h2>` stack once Nodes moved in alongside Appearance/
   * Notifications/Push, so `SettingsPage` gets real section navigation and
   * this is the state that drives it. `'appearance'` is the default landing
   * section; `openTargetStatus` below sets this to `'nodes'` so the ⋯
   * "Target status" deep link still lands on the right section.
   */
  let settingsSection = $state<SettingsSection>('appearance');

  /**
   * The right sidebar's own sub-tabs (design spec §3.1/§3.3, issue #571):
   * Files and Config now, with a later Git tab (§2's Emdash reference) one
   * more entry here plus one more content branch below, not a refactor.
   * Was `DRAWER_PANELS`, which also carried Terminal and lived in the
   * topbar; the terminal leaves this panel entirely (its own bottom dock,
   * #572 — the tab is gone, not just moved), and the topbar keeps exactly
   * one control now (the toggle below), with the panel choice moving into
   * this array's own header strip (Lorenzo's read, 2026-08-03: two
   * controls for one choice is the defect v4 already fixed once for this
   * exact topbar). `testId` values are UNCHANGED from `DRAWER_PANELS` on
   * purpose — `project-config-panel.spec.ts` and half of
   * `cockpit-shell.spec.ts` already click them there; they still work
   * clicking the same ids at this panel's new home.
   */
  type WorkbenchTab = 'files' | 'config' | 'runner';
  const WORKBENCH_TABS: {
    id: WorkbenchTab;
    label: string;
    /** The accessible name, which must contain `label` (WCAG 2.5.3) and may say more than the pixels do. */
    name: string;
    icon: IconName;
    testId: string;
  }[] = [
    { id: 'files', label: 'Files', name: 'Files', icon: 'file', testId: 'file-tree-toggle' },
    {
      id: 'config',
      label: 'Config',
      name: 'Project config',
      icon: 'settings',
      testId: 'project-config-toggle',
    },
    {
      id: 'runner',
      label: 'Runner',
      name: 'Test/lint/build runner',
      icon: 'check',
      testId: 'test-runner-toggle',
    },
  ];
  /** Which of `WORKBENCH_TABS` the right sidebar's content area shows. Not persisted (unlike the sidebar's own open/size below): a fresh reload settling back on Files is the same "no surprise" default the old topbar switch gave, and nothing in the issue's acceptance asks for more. */
  let activeWorkbenchTab = $state<WorkbenchTab>('files');
  /** The radiogroup root, for moving focus onto the newly-selected segment when an arrow key changes it — mirrors `ConfigBar.svelte`'s identical `modeGroupEl`/`handleModeKeydown` pair for its own mutually-exclusive, always-one-selected mode switch (issue #549's own precedent for this exact idiom over the `aria-pressed` toggle group the old topbar switch used). */
  let workbenchTabsEl = $state<HTMLDivElement | undefined>(undefined);

  /** Arrow-key roving focus for `WORKBENCH_TABS`' `role="radiogroup"` (see `workbenchTabsEl`'s doc comment) — moves the selection AND the focus together, same as `ConfigBar`'s `handleModeKeydown`. */
  function handleWorkbenchTabKeydown(event: KeyboardEvent): void {
    let delta: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        delta = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        delta = -1;
        break;
      default:
        return;
    }
    event.preventDefault();

    const currentIndex = WORKBENCH_TABS.findIndex((tab) => tab.id === activeWorkbenchTab);
    const nextIndex =
      (Math.max(currentIndex, 0) + delta + WORKBENCH_TABS.length) % WORKBENCH_TABS.length;
    const nextTab = WORKBENCH_TABS[nextIndex];
    if (!nextTab) return;

    activeWorkbenchTab = nextTab.id;
    tick().then(() => {
      const radios = workbenchTabsEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      radios?.[nextIndex]?.focus();
    });
  }

  /**
   * The topbar's own Agent/Tracker `role="radiogroup"` root (issue #710,
   * design spec v8 D1-1) — same roving-focus idiom as `workbenchTabsEl`
   * above and `ConfigBar`'s `modeGroupEl`: arrow keys move the selection
   * AND the focus together, one tab stop for the whole group.
   */
  let topbarViewGroupEl = $state<HTMLDivElement | undefined>(undefined);

  /**
   * Switches the centre zone to Tracker (issue #710/#697): re-derives
   * `trackerProject` from the SELECTED session's own project rather than
   * trusting whatever it was last set to, because {@link openTrackerForProject}
   * can point it at an unrelated project via a project row's own "more
   * actions" menu without touching `selectedSessionId` — this switch is
   * "legato al progetto" (tied to the session), so it must not show a
   * stale project's board just because that menu ran more recently than
   * {@link selectSession} did.
   */
  function openSessionTracker(): void {
    if (!selectedSession) return;
    trackerProject = { nodeId: selectedSession.nodeId, projectPath: selectedSession.projectPath };
    mainView = 'tracker';
  }

  /** Arrow-key roving focus for the topbar's Agent/Tracker `role="radiogroup"` (see `topbarViewGroupEl`'s doc comment) — same shape as `handleWorkbenchTabKeydown` above, over the two-entry `['session', 'tracker']` set instead of `WORKBENCH_TABS`. */
  function handleTopbarViewKeydown(event: KeyboardEvent): void {
    let delta: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        delta = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        delta = -1;
        break;
      default:
        return;
    }
    event.preventDefault();

    const views = ['session', 'tracker'] as const;
    const currentIndex = views.indexOf(mainView === 'tracker' ? 'tracker' : 'session');
    const nextIndex = (currentIndex + delta + views.length) % views.length;
    const nextView = views[nextIndex];
    if (nextView === 'tracker') {
      openSessionTracker();
    } else {
      mainView = 'session';
    }
    tick().then(() => {
      const radios = topbarViewGroupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      radios?.[nextIndex]?.focus();
    });
  }

  /**
   * The right sidebar's own dock (design spec §3.2/§3.3, issue #571): the
   * shared `DockPanel` behaviour, the same one `sessionsDock` below runs on
   * (issue #570) — collapse, drag-resize and persistence come from there,
   * not a second hand-written copy. `collapsedSize: 0` (unlike the left
   * sidebar's 56px selvage rail): closing this one removes it from the
   * layout entirely rather than leaving an icon-only rail, since nothing in
   * the design spec asks for a right-edge rail.
   *
   * `open`'s constructor default (`false`) is deliberately a placeholder —
   * see `rightSidebarOpen`'s own doc comment below for the real "open by
   * default at `--bp-wide` with a session selected, persisted per user
   * after that" rule this dock alone can't express, since it doesn't know
   * about the viewport or the selected session.
   */
  const RIGHT_SIDEBAR_STORAGE_KEY = 'loombox:right-sidebar';
  /**
   * Whether `rightSidebarHasUserPreference` itself should restore `true`.
   * Deliberately NOT inferred from "does `RIGHT_SIDEBAR_STORAGE_KEY` have a
   * defined `open`" — `DockPanel.persist()` always writes `{ open, size }`
   * together, so dragging the resize handle while the panel is open ONLY
   * on its dynamic default (this dock's own `#open` still sitting at its
   * `false` placeholder — see `rightSidebarDock`'s own doc comment) would
   * otherwise persist that placeholder `false` as if it were a real closed
   * choice, and a later reload would wrongly freeze the panel shut. A
   * dedicated key, written only by `toggleRightSidebar`/`closeRightSidebar`
   * actually running, has no such ambiguity.
   */
  const RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY = 'loombox:right-sidebar-user-preference';
  const DEFAULT_RIGHT_SIDEBAR_WIDTH_PX = 384;
  const MIN_RIGHT_SIDEBAR_WIDTH_PX = 280;
  const MAX_RIGHT_SIDEBAR_WIDTH_PX = 480;

  function createRightSidebarDockPersistence(): DockPanelPersistence {
    return {
      load() {
        const raw = localStorage.getItem(RIGHT_SIDEBAR_STORAGE_KEY);
        if (!raw) return undefined;
        try {
          return JSON.parse(raw) as Partial<DockPanelState>;
        } catch {
          return undefined;
        }
      },
      save(state) {
        localStorage.setItem(RIGHT_SIDEBAR_STORAGE_KEY, JSON.stringify(state));
      },
    };
  }

  const rightSidebarPersistence = createRightSidebarDockPersistence();
  const rightSidebarDock = new DockPanel({
    edge: 'right',
    open: false,
    size: DEFAULT_RIGHT_SIDEBAR_WIDTH_PX,
    min: MIN_RIGHT_SIDEBAR_WIDTH_PX,
    max: MAX_RIGHT_SIDEBAR_WIDTH_PX,
    collapsedSize: 0,
    persistence: rightSidebarPersistence,
    restored: () => preferencesRestored,
  });
  /** True once a real choice exists for `rightSidebarDock.open` — either restored from `RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY` in `onMount`, or the user has clicked `workbenchToggle`/dismissed the sheet at least once THIS session (`toggleRightSidebar`/`closeRightSidebar`, both of which set this alongside the dock's own `open`). See `rightSidebarOpen`'s own doc comment for why this gate exists at all, and `RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY`'s for why it is its own key rather than inferred from the dock's persisted blob. */
  let rightSidebarHasUserPreference = $state(false);

  /** True below `DESKTOP_VIEWPORT_BREAKPOINT_PX` (1024px, design spec §3.3), where the right sidebar is a dismissible sheet (a side sheet at 768-1023px, a bottom sheet below 768px — see `rightSidebarSlide`) rather than a docked, canvas-pushing column. `exclusive: true` matches this file's own `@media (max-width: 1023px)` breakpoint exactly rather than also matching at 1024px itself (issue #573's fix, generalized to the pairing this panel introduces). */
  let rightSidebarSheetViewport = $state(false);
  /** True below `WIDE_VIEWPORT_BREAKPOINT_PX` (1280px, design spec §3.3) — feeds `rightSidebarOpen`'s dynamic default below. `exclusive: true` is issue #573 itself: without it, this and a `min-width: 1280px` CSS rule at the identical number are both true at exactly 1280px, which is exactly where the old pin control sat dead. There is no such sibling rule left in this file's CSS (the pin is gone), but the fix belongs in the boundary check itself, not in "nothing else happens to collide with it today". */
  let rightSidebarNarrowViewport = $state(false);
  const rightSidebarWideViewport = $derived(!rightSidebarNarrowViewport);

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
  /** The session a just-opened `ArchiveSessionDialog` confirms archiving for (design spec v4 §3.2's row menu); `undefined` when none is open. Kept separate from a plain boolean so the dialog's own exit transition still has real session content to render while it plays out — same split `newSessionProject`/`newSessionOpen` already use. */
  let archivingSession = $state<ClientSessionMeta | undefined>(undefined);
  let archiveSessionOpen = $state(false);
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

  /**
   * Opens or closes the right sidebar (design spec §3.3, issue #571): the
   * topbar's one control for it (`workbenchToggle`, below). Reads/writes
   * `rightSidebarOpen`'s CURRENT effective value rather than
   * `rightSidebarDock.open` directly, so the very first click — while this
   * dock is still running on its dynamic default — toggles from whatever
   * is actually on screen, not from the dock's own placeholder `false`.
   * Issue #572 added the `closeOtherMobileSheets` call below: opening this
   * sheet below `--bp-desktop` now dismisses the sessions sheet and the
   * terminal dock first, per design spec §3.3's "exactly one of the
   * three... at a time" rule — see that function's own doc comment
   * (declared further down, alongside the terminal dock it was added
   * for; hoisted, so this earlier call is fine).
   */
  function toggleRightSidebar(): void {
    const wasOpen = rightSidebarOpen;
    if (!wasOpen) closeOtherMobileSheets('right-sidebar');
    rightSidebarHasUserPreference = true;
    rightSidebarDock.open = !wasOpen;
  }

  /** Closes the right sidebar unconditionally — the sheet-mode `Overlay`'s `onClose` (backdrop click, Escape), which should never re-open it the way `toggleRightSidebar` would if called at the wrong moment. */
  function closeRightSidebar(): void {
    rightSidebarHasUserPreference = true;
    rightSidebarDock.open = false;
  }

  /**
   * Slides the right sidebar in/out — the mount/unmount transition on its
   * `<aside>`, mirroring the OLD Drawer's identical `drawerSlide` (redesign
   * brief §1/§7). Docked mode (`!rightSidebarSheetViewport`) has no motion
   * at all, same reasoning: it is part of the layout, not a dismissible
   * overlay. Slides along whichever axis the sheet itself uses at the
   * current width — vertical (bottom sheet) below `--bp-tablet`, horizontal
   * (side sheet) from there up to `--bp-desktop` — reusing
   * `sessionsSheetViewport` (the Sessions column's own subscription to that
   * exact breakpoint) rather than a second one.
   */
  function rightSidebarSlide(_node: Element): TransitionConfig {
    if (!rightSidebarSheetViewport) return { duration: 0, css: () => '' };
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

  /**
   * The left sidebar's own dock (design spec `docs/superpowers/specs/
   * 2026-08-03-cockpit-v6-design.md` §3.2, issue #570): drag-resize +
   * collapse-to-selvage + persistence, now the shared `DockPanel` behaviour
   * (`$lib/dock-panel.svelte.ts`) rather than hand-written here (as it was
   * from redesign brief §1 / issue #438 through #570). The right sidebar
   * (#571) and the terminal dock (#572) will be two more `DockPanel`
   * instances, not a second copy of this logic.
   *
   * The storage keys below predate `DockPanel` and stay EXACTLY as they
   * were — `loombox:sessions-width`/`loombox:sessions-collapsed`, the same
   * two independent values, the same '1'/'0' encoding — so an existing
   * user's sidebar restores unchanged; only where the read/write happens
   * moved. `sessionsDock.size` always holds the user's last dragged-to
   * width even while collapsed, so expanding again restores it rather than
   * snapping back to the default.
   *
   * What stayed a call-site concern rather than moving into `DockPanel`
   * (design spec §3.2's own call to make): the collapse toggle's placement
   * inside `.sidebar-brand`, the handle's absolute position against the
   * sidebar's own right edge (both markup/CSS, which the three docks don't
   * share at all), and the mobile sheet override below
   * (`sessionsSheetViewport` / `sessionsRailCollapsed` /
   * `sessionsColumnWidthPx`) — a breakpoint-driven reinterpretation of
   * "collapsed" specific to this one column, not a concept the right
   * sidebar or the terminal dock are known to need yet.
   */
  const SESSIONS_WIDTH_STORAGE_KEY = 'loombox:sessions-width';
  const SESSIONS_COLLAPSED_STORAGE_KEY = 'loombox:sessions-collapsed';
  /** 18rem, the redesign brief's default column width, at the app's own 16px base root font size. */
  const DEFAULT_SESSIONS_WIDTH_PX = 288;
  const MIN_SESSIONS_WIDTH_PX = 200;
  const MAX_SESSIONS_WIDTH_PX = 440;
  /** 3.5rem — the icon-only "selvage rail" width (redesign brief §1), matching the left `.rail`'s own 3.5rem. */
  const SESSIONS_SELVAGE_WIDTH_PX = 56;

  /** The exact pre-`DockPanel` two-key `localStorage` shape documented above, adapted to `DockPanelPersistence` — a bespoke adapter (not the generic single-JSON-key shape a from-scratch dock would use) purely so an existing user's sidebar is not silently reset by this refactor. */
  function createSessionsDockPersistence(): DockPanelPersistence {
    return {
      load() {
        const result: { open?: boolean; size?: number } = {};
        const widthRaw = localStorage.getItem(SESSIONS_WIDTH_STORAGE_KEY);
        if (widthRaw) {
          const parsed = Number(widthRaw);
          if (Number.isFinite(parsed)) result.size = parsed;
        }
        const collapsedRaw = localStorage.getItem(SESSIONS_COLLAPSED_STORAGE_KEY);
        if (collapsedRaw) result.open = collapsedRaw !== '1';
        return Object.keys(result).length > 0 ? result : undefined;
      },
      save(state) {
        localStorage.setItem(SESSIONS_WIDTH_STORAGE_KEY, String(state.size));
        localStorage.setItem(SESSIONS_COLLAPSED_STORAGE_KEY, state.open ? '0' : '1');
      },
    };
  }

  const sessionsDock = new DockPanel({
    edge: 'left',
    open: true,
    size: DEFAULT_SESSIONS_WIDTH_PX,
    min: MIN_SESSIONS_WIDTH_PX,
    max: MAX_SESSIONS_WIDTH_PX,
    collapsedSize: SESSIONS_SELVAGE_WIDTH_PX,
    persistence: createSessionsDockPersistence(),
    // See `preferencesRestored`'s own doc comment further down: read live,
    // so a write racing the host's own restore sequence can never clobber a
    // not-yet-read persisted value with this instance's compile-time
    // default.
    restored: () => preferencesRestored,
  });

  /** Which project groups are currently collapsed (design spec v4 §3.2), PERSISTED (unlike v3's transient `collapsedGroupKeys` this replaces): "a project you never use should stay shut across reloads." Keyed by {@link projectKey}, not a project's `id`: an `id` is re-minted if a project is removed and later re-adopted (§4.2's `adoptFromSessions`), while the `(nodeId, targetId, path)` triple stays stable across that cycle. Restored in `onMount`, persisted by the `$effect` below alongside the sessions column's own width/collapsed prefs. A `SvelteSet` (not a plain `Set` wrapped in `$state`) so `.add`/`.delete` are reactive in place, mirroring `planCollapsedBySession`'s own `SvelteMap`. */
  const PROJECT_GROUPS_COLLAPSED_STORAGE_KEY = 'loombox:project-groups-collapsed';
  const collapsedProjectKeys = new SvelteSet<string>();
  /** True at/below `--bp-tablet`/`TABLET_VIEWPORT_BREAKPOINT_PX` (768px), where Sessions renders as the full-height sheet (redesign brief §1) rather than an inline column — the icon-only selvage rail is a wide-viewport concept only, so it's parked (not cleared) here rather than in `sessionsDock`'s own `open`, which stays the user's actual persisted preference for whenever the viewport widens again. */
  let sessionsSheetViewport = $state(false);

  /** The effective collapsed-to-selvage state once the sheet-viewport override above is applied — what the template actually renders on. The mobile sheet override is this column's own concern, not `DockPanel`'s (see `sessionsDock`'s doc comment above), so it reads `sessionsDock.open` rather than living inside the shared behaviour itself. */
  const sessionsRailCollapsed = $derived(!sessionsDock.open && !sessionsSheetViewport);
  const sessionsColumnWidthPx = $derived(
    sessionsRailCollapsed ? sessionsDock.collapsedSize : sessionsDock.size,
  );

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
  /** `RelayClient.connectedAccounts`'s latest snapshot (SPEC §7.26, issue #221) — fed straight through to `ProjectConfigPanel`'s tracker section (issue #220), same "own no fetching, just mirror the store" split every other prop here already follows. */
  let connectedAccounts = $state<ConnectedAccount[]>([]);
  let selectedSessionId = $state<string | undefined>(undefined);
  /**
   * The project the Tracker destination currently points at (issue #697)
   * — decoupled from `selectedSessionId` on purpose, since a project's
   * tracker is reachable with no session selected at all (see
   * `TrackerPage.svelte`'s own doc comment). Whichever action ran last
   * wins: selecting a session sets this to that session's own project
   * ({@link selectSession} below), and {@link openTrackerForProject} sets
   * it directly from a project row's own "Open tracker" action, with no
   * session involved at all.
   */
  let trackerProject = $state<{ nodeId: string; projectPath: string } | undefined>(undefined);
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
  /** The selected session's agent-declared `/`-command catalog (Zed-parity C2-4, issue #743), mirrored off `client.commandsFor(id)` exactly like `configOptions` above — `[]` until the agent's first `available_commands_update`, and whenever it declares none at all. */
  let commands = $state<AcpAvailableCommand[]>([]);
  /**
   * The selected session's own agent's remembered account-wide values and
   * this project's pinned overrides (issue #753, D4-2/D4-3) — refreshed by
   * `selectSession` on every session switch, by `rememberConfigOptionValues`
   * every time `configOptions` itself changes, and by
   * `pinConfigOptionToProject`/`unpinConfigOptionFromProject` on a pin
   * action. `$state`, not read live off `localStorage` inside a `$derived`,
   * because a `localStorage` write is not itself a Svelte reactivity
   * source — see this file's own `configOptionSources` derived below,
   * which reacts to `configOptions` AND these two together.
   */
  let configOptionAccountDefaults = $state<RememberedConfigOptionValues>({});
  let configOptionProjectOverrides = $state<RememberedConfigOptionValues>({});
  let attachments = $state<ComposerAttachment[]>([]);
  let queuedPrompts = $state<QueuedPrompt[]>([]);
  let draft = $state('');
  // The read-only file-tree panel (SPEC §7.4; issue #171) and the @file
  // reference picker it backs (SPEC §7.25; issue #160). `fileTree` mirrors
  // `RelayClient.fileTreeFor(selectedSessionId)`'s live snapshot; the panel
  // itself is now the right sidebar's "Files" tab (`activeWorkbenchTab`,
  // issue #571), independent of the picker, which opens on typing '@' in
  // the composer.
  let fileTree = $state<Map<string, FileTreeDirectoryState>>(new Map());
  // The interactive PTY terminal panel (SPEC §7.5; issues #172/#173/#174)
  // used to be a Drawer tab; issue #571 took it out of that panel
  // entirely. It is its own bottom dock now (design spec §3.1/§3.2/§3.3,
  // issue #572), built on the same shared `DockPanel` behaviour (issue
  // #570) `sessionsDock`/`rightSidebarDock` above run on — see that
  // block's own doc comment, which forward-referenced this one.
  const TERMINAL_DOCK_STORAGE_KEY = 'loombox:terminal-dock';
  /** A comfortable first-open height — independent of `MIN_TERMINAL_DOCK_HEIGHT_PX` below, so a first-time user gets a genuinely usable pane, not the bare minimum. */
  const DEFAULT_TERMINAL_DOCK_HEIGHT_PX = 320;
  /** Issue #572's own acceptance line: "min around 12rem". */
  const MIN_TERMINAL_DOCK_HEIGHT_PX = 192;
  /** A generous ceiling so a drag can't swallow the transcript/composer entirely — same reasoning as `MAX_RIGHT_SIDEBAR_WIDTH_PX` above, sized for this dock's own axis. */
  const MAX_TERMINAL_DOCK_HEIGHT_PX = 640;

  /**
   * `DockPanelPersistence` for the terminal dock, mirroring
   * `createRightSidebarDockPersistence` exactly (one JSON blob — this dock
   * is new, so unlike the left sidebar's own adapter there is no existing
   * user's legacy two-key shape to stay compatible with). PER-USER
   * (`localStorage`, not `sessionStorage`), matching both the design
   * spec's own wording ("height persisted per user") and every other dock
   * in this file: nothing about §3.3's rules ties this dock's height to
   * any one session, so there is no reason to scope it narrower than the
   * other two.
   */
  function createTerminalDockPersistence(): DockPanelPersistence {
    return {
      load() {
        const raw = localStorage.getItem(TERMINAL_DOCK_STORAGE_KEY);
        if (!raw) return undefined;
        try {
          return JSON.parse(raw) as Partial<DockPanelState>;
        } catch {
          return undefined;
        }
      },
      save(state) {
        localStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, JSON.stringify(state));
      },
    };
  }

  const terminalDockPersistence = createTerminalDockPersistence();
  /**
   * The terminal dock itself: `edge: 'bottom'`. `open: false` is the REAL
   * default (unlike `rightSidebarDock`'s placeholder `false` — see that
   * block's own doc comment): design spec decision #4 is unconditional
   * ("closed by default... the layout must not move on its own"), so
   * there is no dynamic-default `$derived` this dock needs the way
   * `rightSidebarOpen` does. `terminalDock.open` alone is always the
   * truth, restored from `TERMINAL_DOCK_STORAGE_KEY` if this browser has
   * ever set it. `collapsedSize: 0`, same reasoning as
   * `rightSidebarDock`'s: closing it removes it from the layout, not a
   * rail — nothing in the design spec asks for a bottom rail either.
   */
  const terminalDock = new DockPanel({
    edge: 'bottom',
    open: false,
    size: DEFAULT_TERMINAL_DOCK_HEIGHT_PX,
    min: MIN_TERMINAL_DOCK_HEIGHT_PX,
    max: MAX_TERMINAL_DOCK_HEIGHT_PX,
    collapsedSize: 0,
    persistence: terminalDockPersistence,
    restored: () => preferencesRestored,
  });

  /**
   * Below `--bp-desktop` (1024px) the terminal dock becomes a bottom sheet
   * exactly like the right sidebar does at the same width (design spec
   * §3.3's responsive table gives both the identical row: "docked" at
   * ≥1024, "sheet" below it). Reusing `rightSidebarSheetViewport` rather
   * than opening a second `matchMedia` subscription at the same number IS
   * the "reconcile it with the existing mobile sheet" issue #572 asks
   * for: one signal drives both panels' docked/sheet switch, so they can
   * never drift onto two different breakpoints by accident.
   */
  const terminalDockSheetViewport = $derived(rightSidebarSheetViewport);

  /**
   * Sessions whose terminal has been opened at least once this page load
   * — the mount gate for `InteractiveTerminal` in the template below
   * (design spec decision #4: "never opens itself because a terminal
   * happens to be alive" — a session nobody ever opened the dock for
   * never opens a PTY either). Once a session is in this set, its
   * `InteractiveTerminal` stays MOUNTED even while `terminalDock.open`
   * later toggles closed: collapsing only hides it (`.terminal-dock`'s
   * own height/transform in the template below), so a collapse/reopen
   * round trip never re-runs `onMount`/`onDestroy` and never drops the
   * PTY or its scrollback — today, before this dock existed, closing the
   * old Drawer tab unmounted `InteractiveTerminal` and its own
   * `onDestroy` killed the terminal outright, exactly what this issue's
   * acceptance forbids. Plain `SvelteSet`, not persisted: it only needs
   * to survive this tab's own lifetime.
   */
  const terminalOpenedSessionIds = new SvelteSet<string>();
  $effect(() => {
    if (terminalDock.open && selectedSessionId) terminalOpenedSessionIds.add(selectedSessionId);
  });

  /**
   * Design spec §3.3's "below `--bp-desktop`, exactly one of the three
   * panels may be open at a time, and it is a sheet" rule (issue #572) —
   * called by whichever of the three sheets is ABOUT to open, so the
   * other two are dismissed first instead of stacking. A no-op for
   * whichever panel is currently DOCKED (not a sheet) at the present
   * width: closing a docked panel here would fight the user's own docked
   * preference for no reason, since two (or three) docked panels
   * coexisting is exactly what ≥1024px wants (design spec §3.1: "None of
   * them scrims. ... all three may be open together").
   */
  function closeOtherMobileSheets(opening: 'sessions' | 'right-sidebar' | 'terminal'): void {
    if (opening !== 'sessions' && sessionsSheetOpen && sessionsSheetViewport) {
      sessionsSheetOpen = false;
    }
    if (opening !== 'right-sidebar' && rightSidebarOpen && rightSidebarSheetViewport) {
      closeRightSidebar();
    }
    if (opening !== 'terminal' && terminalDock.open && terminalDockSheetViewport) {
      terminalDock.open = false;
    }
  }

  /**
   * Opens or closes the terminal dock — the topbar's one control for it
   * (`terminal-dock-toggle` below), mirroring `toggleRightSidebar` except
   * for the dynamic-default case that function's own doc comment
   * describes: this dock has none (see `terminalDock`'s own doc comment),
   * so there is no `hasUserPreference` gate to set alongside it.
   */
  function toggleTerminalDock(): void {
    const wasOpen = terminalDock.open;
    if (!wasOpen) closeOtherMobileSheets('terminal');
    terminalDock.open = !wasOpen;
  }

  // The project config surface (SPEC §7.7; issue #366) is now the right
  // sidebar's "Config" tab (`activeWorkbenchTab`); mounts the MCP-server
  // quick-add panel (#188) and the plugin/extension panel (#191). See
  // `ProjectConfigPanel.svelte`.
  let filePickerOpen = $state(false);
  // The index in `draft` where the triggering '@' sits, so a picked file
  // reference replaces exactly the '@partial-query' text the user typed,
  // rather than being appended blindly. `undefined` means "no active
  // trigger" (the picker was opened some other way, or was never opened).
  let atTriggerStart = $state<number | undefined>(undefined);
  let slashPickerOpen = $state(false);
  // The index in `draft` where the triggering '/' sits — see
  // `atTriggerStart` just above, same contract, scoped to the `/`-command
  // picker (issue #743). Only ever set when `/` is the very first
  // character of the composer (slash commands are a whole-message
  // convention, never embedded mid-sentence like `@file`).
  let slashTriggerStart = $state<number | undefined>(undefined);
  // The cross-project attention inbox (SPEC §7.13; issues #167/#168/#169):
  // one live list across every session on this account, independent of
  // which session (if any) is currently selected/open — see
  // `RelayClient.attentionInbox`'s doc comment. A `mainView` destination
  // (`InboxPage`) now, not a Drawer tab.
  let attentionInboxItems = $state<AttentionInboxItem[]>([]);
  // Per-project mute + quiet-hours settings panel (SPEC §7.11, issue #166),
  // now a section of `SettingsPage` (`mainView === 'settings'`), alongside
  // Appearance below. `notificationPreferencesStorage` is only ever
  // constructed client-side (onMount below, same reason `amkStorage` is) —
  // `localStorage` doesn't exist during `routes/page.test.ts`'s SSR render.
  let notificationPreferencesStorage = $state<NotificationPreferencesStorage | undefined>(
    undefined,
  );
  let notificationPreferences = $state<NotificationPreferencesData>(
    defaultNotificationPreferences(),
  );

  // The fuzzy command palette (SPEC §7.3; issue #132).
  let paletteOpen = $state(false);
  // Narrow-viewport permission footer (SPEC §7.3; issue #134) — a live
  // `matchMedia` read, client-only (see `viewport.ts`'s doc comment for why
  // it defaults `false` during SSR).
  let narrowViewport = $state(false);
  /**
   * The composer's picker collapse (redesign brief
   * `docs/design/redesign.md` §1: "below 480px, the composer's mini-toolbar
   * (mode/attach/context meter) collapses under a single '···' expand
   * affordance", issue #439). Manual toggle only matters at/below
   * `narrowViewport` (480px) — see `configControlsVisible` below.
   *
   * Narrowed when the toolbar folded into the composer's own control row
   * (Lorenzo's ask, 2026-07-30): it now hides ONLY the model/mode pickers.
   * The attach trigger, the context/cost meter and Send are always on
   * screen, so a phone no longer hides the figures a user watches behind an
   * unopened "···", and the old "force-expand while an attachment is
   * pending" clause is gone with the reason for it — pending chips render
   * above the textarea now, never inside this collapse.
   */
  let configControlsExpanded = $state(false);
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
  /** Parallels {@link sessionStatuses}, one `RelayClient.statusReasonFor` subscription per listed session (issue #730) — why a `'error'` status happened, when the node said so (a spawn that failed or timed out); `undefined` for every other status. Kept as a separate map/subscription pair rather than widening `sessionStatuses`' value type, since every existing reader of that map (severity ranking, row/selvage labels) only ever needed the bare status. */
  const sessionStatusReasons = new SvelteMap<string, string | undefined>();
  const sessionStatusReasonUnsubscribers = new SvelteMap<string, () => void>();

  /** (Re)syncs `sessionStatuses`'/`sessionStatusReasons`' subscriptions to exactly the currently-listed sessions — called every time `client.sessions` emits. */
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
    for (const [id, unsubscribe] of sessionStatusReasonUnsubscribers) {
      if (currentIds.has(id)) continue;
      unsubscribe();
      sessionStatusReasonUnsubscribers.delete(id);
      sessionStatusReasons.delete(id);
    }
    for (const session of list) {
      if (!sessionStatusUnsubscribers.has(session.id)) {
        const unsubscribe = activeClient
          .statusFor(session.id)
          .subscribe((value) => sessionStatuses.set(session.id, value));
        sessionStatusUnsubscribers.set(session.id, unsubscribe);
      }
      if (!sessionStatusReasonUnsubscribers.has(session.id)) {
        const unsubscribe = activeClient
          .statusReasonFor(session.id)
          .subscribe((value) => sessionStatusReasons.set(session.id, value));
        sessionStatusReasonUnsubscribers.set(session.id, unsubscribe);
      }
    }
  }

  function clearSessionStatusSubscriptions(): void {
    for (const unsubscribe of sessionStatusUnsubscribers.values()) unsubscribe();
    sessionStatusUnsubscribers.clear();
    sessionStatuses.clear();
    for (const unsubscribe of sessionStatusReasonUnsubscribers.values()) unsubscribe();
    sessionStatusReasonUnsubscribers.clear();
    sessionStatusReasons.clear();
  }

  // Persistence for the client-side UI preferences below (relay URL,
  // Drawer pin, project-groups-collapsed — `sessionsDock` above persists
  // its own open/size pair through this exact same flag, via the
  // `restored` callback passed to its constructor) is gated on this flag
  // because in Svelte 5 `onMount` is itself just another user effect,
  // scheduled in DECLARATION order alongside `$effect` — these effects are
  // declared above `onMount`, so on a fresh load they used to run FIRST and
  // write each preference's compile-time default over the persisted value
  // before `onMount` ever got to read it back (a self-hoster's relay URL, a
  // pinned Drawer, and a resized/collapsed Sessions column were all
  // silently lost on every reload). `onMount` flips this once it has
  // restored everything, including calling `sessionsDock.restore()`, after
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

  // Persists the right sidebar's own has-a-real-preference bit (issue
  // #571) — see `RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY`'s doc comment
  // for why this is a dedicated key rather than inferred from
  // `rightSidebarDock`'s own persisted `{ open, size }` blob.
  $effect(() => {
    const value = rightSidebarHasUserPreference;
    if (!preferencesRestored) return;
    localStorage.setItem(RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY, value ? '1' : '0');
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
  /**
   * The right sidebar's effective open state (design spec §3.3, issue
   * #571's "Open by default at >=1280px when a session is selected,
   * persisted per user after that"). Two regimes:
   *
   * - No real preference yet (`!rightSidebarHasUserPreference`, the state
   *   fresh from a browser that has never toggled this dock nor had
   *   anything persisted for it): tracks the viewport/session pair live,
   *   so widening past `--bp-wide` with a session open snaps it open and
   *   narrowing back closes it again, with no explicit click either way.
   * - A real preference exists (restored from `localStorage`, or set by
   *   `toggleRightSidebar` this session): reads `rightSidebarDock.open`
   *   alone, exactly like the left sidebar — sticky across every viewport
   *   change and every session switch from here on.
   */
  const rightSidebarOpen = $derived(
    rightSidebarHasUserPreference
      ? rightSidebarDock.open
      : rightSidebarWideViewport && selectedSessionId !== undefined,
  );
  /**
   * The selected session's live status (issue #702), read out of the same
   * `sessionStatuses` map every row badge already uses. Cast to the
   * protocol's wider `SessionStatusV1`, not the `AcpSessionStatus` the map
   * is declared with: `sessionStatuses` mirrors `client.statusFor(id)`
   * (typed `AcpSessionStatus | undefined`, `@loombox/providers-core`'s
   * five-value union), but the wire value it stores unchecked can also be
   * `'queued'`/`'starting'`/`'disconnected'` — the exact tolerance
   * `relay-client.ts`'s `parseSessionWireEvent` doc comment already
   * documents ("the reducer's case 'session_status' already stores
   * whichever string arrives unchecked either way"). Comparing against the
   * literal `'disconnected'` below needs the wider type; `session-
   * status.ts`'s Records only needed assignability, not a literal
   * comparison, so they didn't.
   */
  const selectedSessionStatus = $derived(
    selectedSessionId
      ? (sessionStatuses.get(selectedSessionId) as SessionStatusV1 | undefined)
      : undefined,
  );
  /**
   * Whether the selected session currently has a live agent that is
   * definitely NOT there to send a prompt to — issue #730, widening
   * #702's `'disconnected'`-only check (a session that survived a node
   * restart with no agent behind it, `session-manager.ts`'s
   * `SessionLifecycleState` doc comment) to every other `SessionStatusV1`
   * that means the same thing for the composer: `'queued'`/`'starting'`
   * (the agent hasn't spawned, or hasn't finished spawning, yet) and
   * `'error'`/`'exited'` (the spawn failed, or the agent already
   * stopped). In every one of these a new prompt genuinely has nowhere to
   * go (no agent process to hand it to, and `prompt_inject` has no reply
   * channel to report that failure on), so the composer says so instead
   * of looking ready and silently doing nothing — the same reasoning
   * #702 already established, just for five states instead of one.
   *
   * Deliberately does NOT include `undefined` (no `session_status` has
   * arrived yet): that is absence of information, not proof there is
   * nothing to send to, and this client's own resync ring is bounded
   * (`packages/relay/src/relay.ts`'s prune/quota machinery) — a long-
   * running session's true status can have aged out of it by the time a
   * reload re-subscribes, well before it or its agent did anything wrong.
   * Gating the composer on `undefined` too would block a perfectly
   * healthy, already-populated session's composer indefinitely after
   * every ordinary reload whenever that happens, trading #730's narrow
   * "freshly created session" bug for a much more common false negative.
   * The row/inbox already treat `undefined` as "unknown" rather than
   * "awaiting you" (`SESSION_STATUS_UNKNOWN_LABEL`,
   * `RelayClient.attentionInbox`'s own live-status gate) without needing
   * the composer to match.
   */
  const selectedSessionAgentless = $derived(
    selectedSessionStatus === 'disconnected' ||
      selectedSessionStatus === 'queued' ||
      selectedSessionStatus === 'starting' ||
      selectedSessionStatus === 'error' ||
      selectedSessionStatus === 'exited',
  );
  /** What the composer's disabled placeholder reads for {@link selectedSessionAgentless}'s current reason (issue #730) — `undefined` while a live agent could actually receive a prompt (including "status genuinely unknown"), so the composer keeps its ordinary placeholder. */
  const composerUnavailableReason = $derived.by((): string | undefined => {
    switch (selectedSessionStatus) {
      case 'disconnected':
        return "This session's agent isn't running — it disconnected when the node last restarted.";
      case 'queued':
        return 'Waiting for a concurrency slot to free up before this session can start…';
      case 'starting':
        return "This session's agent is still starting…";
      case 'error':
        return `This session's agent failed to start${transcript?.statusReason ? `: ${transcript.statusReason}` : '.'}`;
      case 'exited':
        return "This session's agent has already exited.";
      default:
        return undefined;
    }
  });
  // Issue #155's send-gate: disabled while any attachment is mid-upload or failed; issue #730's (widening #702's disconnected-only check): disabled while there is no live agent to send to.
  const sendDisabled = $derived(
    draft.trim() === '' || hasBlockingAttachments(attachments) || selectedSessionAgentless,
  );

  /**
   * A3-2 (issue #666): whether the selected session has a turn running right
   * now. Named for readability at each call site rather than repeating the
   * `transcript?.turnActive ?? false` fallback three times over — drives
   * the composer's single-slot Send/Stop swap (Stop *replaces* Send, never
   * sits disabled beside it) and the transcript-footer's live progress
   * line below.
   */
  const turnIsActive = $derived(transcript?.turnActive ?? false);

  /**
   * A3-2: "the working state is a live line in the transcript itself, on
   * the gutter the turn already owns. Progress belongs to the turn, not to
   * a button." Renders in `.canvas-footer`, directly under the transcript
   * (see the template) — not inside a control. Suppressed for the one case
   * where the transcript already carries its own live signal for this
   * exact turn: a thought still streaming shows its own `WovenLoader`
   * inline (`MessageItem`'s "Agent thinking"; `isThoughtStillThinking`),
   * and stacking a second "working" line directly under it would read as
   * two loaders arguing about the same fact. Every other active-turn
   * moment — before any item has arrived yet, mid tool-call, or while an
   * answer is still streaming — has no live cue of its own, so this line
   * covers it.
   */
  const turnProgressVisible = $derived.by(() => {
    if (!transcript || !turnIsActive) return false;
    const last = transcript.items.at(-1);
    if (last?.type === 'message' && last.kind === 'agent_thought_chunk') {
      return !isThoughtStillThinking(transcript, last.turnId);
    }
    return true;
  });

  /** See `configControlsExpanded`'s own doc comment above — the effective visibility the template renders the model/mode pickers on. */
  const configControlsVisible = $derived(!narrowViewport || configControlsExpanded);

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

  /** Every category's current source (issue #753, D4-3 — `ConfigBar`'s own acceptance: "shows the source of the current value"), recomputed off `configOptions` and the two remembered maps `selectSession`/`rememberConfigOptionValues`/the pin actions keep current. */
  const configOptionSources: Record<string, ConfigOptionSource> = $derived(
    resolveConfigOptionSources(
      configOptions,
      configOptionProjectOverrides,
      configOptionAccountDefaults,
    ),
  );

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
   * The same identity, shortened for the sidebar's own account button. That row
   * is only as wide as the sidebar, so a full address gets truncated
   * mid-domain there ("e2e-1785…@example.c…") while the menu it opens repeats
   * the whole thing one line above it.
   *
   * This shortens the LABEL rather than reading `email` directly, because
   * `displayName` is very often an address too: Better Auth stores whatever
   * `name` a sign-up sent, and an email/password sign-up commonly sends the
   * address itself (the e2e harness does exactly that). Keying off the field
   * instead of the value left the trigger unchanged for every such account.
   * A real name from an OAuth provider passes through untouched.
   */
  const accountShortLabel = $derived(
    accountLabel.includes('@') ? accountLabel.split('@')[0] : accountLabel,
  );

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
  /** This account's relay's own build identity (issue #655), mirrored off `client.relayBuildIdentity` — see `TargetStatusView`'s own doc comment for what it drives. */
  let relayBuildIdentity = $state<BuildIdentityV1 | undefined>(undefined);
  let unsubscribeStatus: (() => void) | undefined;
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeConnectedAccounts: (() => void) | undefined;
  let unsubscribeSessionDecryptFailures: (() => void) | undefined;
  let unsubscribeTranscript: (() => void) | undefined;
  let unsubscribePermissionQueue: (() => void) | undefined;
  let unsubscribeConfigOptions: (() => void) | undefined;
  let unsubscribeCommands: (() => void) | undefined;
  let unsubscribeAttachments: (() => void) | undefined;
  let unsubscribeQueuedPrompts: (() => void) | undefined;
  let unsubscribeAttentionInbox: (() => void) | undefined;
  let unsubscribeStaleNotice: (() => void) | undefined;
  let unsubscribeFileTree: (() => void) | undefined;
  let unsubscribeRelayBuildIdentity: (() => void) | undefined;

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

  /**
   * `sessionId -> {provider, projectPath}` for a session `handleSessionCreated`
   * just reported (issue #753), consumed by `handleConfigOptionsUpdate`
   * below the moment that session's first real (non-empty) catalog
   * arrives — the ONE signal that tells it "apply this session's
   * remembered defaults now", and, until `sessions` itself catches up
   * (the exact same gap `handleSessionCreated`'s own doc comment already
   * calls out), a `provider`/`projectPath` fallback. Never cleaned up
   * beyond that one consume — a leftover entry for a long-closed session
   * is inert.
   */
  let recentSessionCreationHints: Record<string, { provider: string; projectPath: string }> = {};

  /**
   * `sessionId -> categories` awaiting the ack of a `changeConfigOption`
   * call this device just made (issue #753) — the ONE signal
   * `handleConfigOptionsUpdate` uses to tell a genuine user pick apart
   * from every other reason `configOptions` can change: a brand-new
   * session's raw, untouched catalog; this session's own remembered
   * defaults being applied (`applyRememberedConfigOptions`, driven by
   * `recentSessionCreationHints` above); or an unprompted agent-initiated
   * change. Only a category in this set gets remembered as the agent's
   * new account-wide "last used" once its push lands, and it is cleared
   * unconditionally at that point — even a push that leaves `current`
   * exactly where it already was (the agent rejected the pick, issue
   * #718) still resolves it, so a refusal never leaves a category
   * "pending" forever waiting for a value that will never arrive. Without
   * this, a session that just had a PROJECT override applied would
   * immediately re-remember that same value as the ACCOUNT'S last used
   * the moment the ack landed — exactly the cross-project bleed D4-3
   * exists to prevent, just one layer removed.
   */
  let pendingUserConfigOptionChanges: Record<string, SvelteSet<string>> = {};

  /**
   * The live config-option catalog changed for the selected session
   * (issue #753, D4-2/D4-3). `configOptions` itself is always replaced
   * wholesale (unchanged behavior). Two things happen on top, in order:
   *
   * 1. If `recentSessionCreationHints` still has an entry for
   *    `sessionId` — this is that brand-new session's FIRST real catalog
   *    — consume it and call `applyRememberedConfigOptions`, which may
   *    issue `setConfigOption` for whichever categories resolve to
   *    something other than the agent's own current selection. This
   *    never itself counts as a "last used" pick (see
   *    `pendingUserConfigOptionChanges`'s own doc comment).
   * 2. Any category named in `pendingUserConfigOptionChanges` for this
   *    session — a real `changeConfigOption` call awaiting its ack — is
   *    remembered as this agent's new account-wide "last used"
   *    (`rememberConfigOptionValues`) and cleared from the pending set.
   *
   * Either way, `configOptionAccountDefaults`/`configOptionProjectOverrides`
   * are refreshed from storage so `configOptionSources` (`ConfigBar`'s own
   * source badge) always matches, even on a push that wrote nothing. A
   * still-empty catalog (a session that hasn't heard from its agent yet)
   * does none of this.
   */
  function handleConfigOptionsUpdate(sessionId: string, value: AcpConfigOption[]): void {
    configOptions = value;
    if (value.length === 0) return;
    const session = sessions.find((entry) => entry.id === sessionId);
    const hint = recentSessionCreationHints[sessionId];
    const provider = session?.provider ?? hint?.provider;
    const projectPath = session?.projectPath ?? hint?.projectPath;
    if (!provider) return;

    if (hint) {
      delete recentSessionCreationHints[sessionId];
      applyRememberedConfigOptions(sessionId, provider, projectPath, value);
    }

    const pendingCategories = pendingUserConfigOptionChanges[sessionId];
    if (pendingCategories && pendingCategories.size > 0 && configOptionDefaultsStorage) {
      const changed = value.filter((option) => pendingCategories.has(option.category));
      if (changed.length > 0)
        rememberConfigOptionValues(configOptionDefaultsStorage, provider, changed);
      pendingCategories.clear();
    }

    configOptionAccountDefaults = configOptionDefaultsStorage
      ? rememberedConfigOptionsFor(configOptionDefaultsStorage, provider)
      : {};
    configOptionProjectOverrides = projectPath
      ? configOptionOverridesFor(
          createLocalStorageConfigOptionOverrideStorage(projectPath),
          provider,
        )
      : {};
  }

  function selectSession(id: string): void {
    selectedSessionId = id;
    const session = sessions.find((entry) => entry.id === id);
    if (session) trackerProject = { nodeId: session.nodeId, projectPath: session.projectPath };
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
    unsubscribeCommands?.();
    unsubscribeAttachments?.();
    unsubscribeQueuedPrompts?.();
    unsubscribeStaleNotice?.();
    unsubscribeFileTree?.();
    transcript = undefined;
    permissionQueue = createPermissionQueueState();
    configOptions = [];
    commands = [];
    configOptionAccountDefaults = {};
    configOptionProjectOverrides = {};
    attachments = [];
    queuedPrompts = [];
    staleNotice = undefined;
    fileTree = new Map();
    configControlsExpanded = false;
    if (!client) return;
    unsubscribeTranscript = client.transcriptFor(id).subscribe((value) => (transcript = value));
    unsubscribePermissionQueue = client.permissionQueueFor(id).subscribe((value) => {
      permissionQueue = value;
      maybeResolvePendingPushAction(id, value);
    });
    unsubscribeConfigOptions = client
      .configOptionsFor(id)
      .subscribe((value) => handleConfigOptionsUpdate(id, value));
    unsubscribeCommands = client.commandsFor(id).subscribe((value) => (commands = value));
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
    unsubscribeRelayBuildIdentity = client.relayBuildIdentity.subscribe((value) => {
      relayBuildIdentity = value;
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
      } else if (selectedSessionId && !value.some((s) => s.id === selectedSessionId)) {
        // Issue #512: an archive (this device's own request, or another
        // device's — the relay fans session_archive_response out account-
        // wide) can drop the selected session out of `value`. Falls back
        // exactly like the "nothing selected yet" branch above: the next
        // remaining session, or the empty state if none are left.
        if (value[0]) selectSession(value[0].id);
        else selectedSessionId = undefined;
      }
    });
    // SPEC §7.26, issue #221: fed by `connected_account_list`, requested once
    // on `connect()`'s own handshake — this only mirrors the store, same
    // split as every other subscription in this block.
    unsubscribeConnectedAccounts = client.connectedAccounts.subscribe((value) => {
      connectedAccounts = value;
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

  /** The Nodes-and-targets deep link (SPEC §7.21; issue #269; design spec v4 §3.1/§3.3, amended by issue #568): `focus` optionally scopes the highlight to one session's target (wired from the session row's own `⋯` menu below). Lands on the Settings page with its Nodes section selected — Nodes stopped being its own `mainView` destination once issue #568 folded it into Settings. Polling itself is already running (`startTargetStatusPolling`, connection-scoped); this just switches the main area and requests an immediate refresh so the view isn't stale from the moment it's shown. */
  function openTargetStatus(focus?: TargetStatusFocusTarget): void {
    targetStatusFocus = focus;
    mainView = 'settings';
    settingsSection = 'nodes';
    void refreshTargetStatus();
  }

  /** `SettingsPage`'s sub-nav/segmented-control callback (issue #568): a manual switch into Nodes behaves like the old bare "Nodes" destination click — it drops any single-target focus a previous deep link left behind and refreshes, rather than silently keeping a stale highlight. */
  function selectSettingsSection(section: SettingsSection): void {
    settingsSection = section;
    if (section === 'nodes') {
      targetStatusFocus = undefined;
      void refreshTargetStatus();
    }
  }

  /**
   * A brand-new session's remembered config-option defaults (issue #753,
   * D4-2/D4-3): project override beats account beats the agent's own
   * default. Called exactly once, by `handleConfigOptionsUpdate`, the
   * moment this session's real catalog (`catalog`) first arrives — never
   * a subscription of its own (an earlier version of this function was;
   * see `handleConfigOptionsUpdate`'s own doc comment for why folding it
   * in was the fix, not just a simplification: two independent
   * subscriptions to the same session both trying to be the one that
   * decides what counts as a "last used" pick raced each other). A
   * category whose resolved value already equals the agent's own current
   * selection is skipped — no redundant round trip — and
   * `resolveConfigOptionDefaults` has already dropped anything stale
   * (issue #718: never send a value the agent doesn't offer).
   */
  function applyRememberedConfigOptions(
    sessionId: string,
    provider: string,
    projectPath: string | undefined,
    catalog: AcpConfigOption[],
  ): void {
    if (!client) return;
    const projectOverrides = projectPath
      ? configOptionOverridesFor(
          createLocalStorageConfigOptionOverrideStorage(projectPath),
          provider,
        )
      : {};
    const accountDefaults = configOptionDefaultsStorage
      ? rememberedConfigOptionsFor(configOptionDefaultsStorage, provider)
      : {};
    for (const resolution of resolveConfigOptionDefaults(
      catalog,
      projectOverrides,
      accountDefaults,
    )) {
      if (resolution.source === 'default' || resolution.optionId === undefined) continue;
      const option = catalog.find((entry) => entry.category === resolution.category);
      if (option && option.current !== resolution.optionId) {
        client.setConfigOption(sessionId, resolution.category, resolution.optionId);
      }
    }
  }

  /** `NewSessionDialog`'s success callback (issue #385): opening it is just the same `selectSession` any other session click uses. Issue #761 removed `RelayClient.createSession`'s wait for the node's own `session_announce` (it only ever existed to safely time the since-removed starting prompt), so unlike before, the session is not guaranteed to be in `sessions` yet when this fires — `selectSession` doesn't need that: it subscribes regardless and shows the session's live status the moment the announce actually arrives. Making that brief pre-announce window read honestly instead of "Awaiting you" is issue #730's remaining half. `provider` (issue #753) is `NewSessionDialog`'s own selection, recorded into `recentSessionCreationHints` here (alongside the project path this dialog was opened for) rather than looked up from `sessions` — the exact same "not guaranteed to be there yet" gap; `handleConfigOptionsUpdate` is what actually applies the remembered defaults once the real catalog arrives. */
  function handleSessionCreated(sessionId: string, provider: string): void {
    const projectPath = newSessionProject?.path;
    if (projectPath) recentSessionCreationHints[sessionId] = { provider, projectPath };
    selectSession(sessionId);
  }

  function disconnect(): void {
    unsubscribeStatus?.();
    unsubscribeSessions?.();
    unsubscribeConnectedAccounts?.();
    unsubscribeSessionDecryptFailures?.();
    unsubscribeTranscript?.();
    unsubscribePermissionQueue?.();
    unsubscribeConfigOptions?.();
    unsubscribeCommands?.();
    unsubscribeAttachments?.();
    unsubscribeQueuedPrompts?.();
    unsubscribeAttentionInbox?.();
    unsubscribeStaleNotice?.();
    unsubscribeFileTree?.();
    unsubscribeRelayBuildIdentity?.();
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
    commands = [];
    attachments = [];
    queuedPrompts = [];
    attentionInboxItems = [];
    staleNotice = undefined;
    paletteOpen = false;
    fileTree = new Map();
    filePickerOpen = false;
    atTriggerStart = undefined;
    slashPickerOpen = false;
    slashTriggerStart = undefined;
    configControlsExpanded = false;
    newSessionOpen = false;
    newSessionProject = undefined;
    addProjectOpen = false;
    // Design spec v4 §3.3: back to the transcript/empty-state view, same
    // reasoning as every other per-connection UI reset below: none of
    // Inbox/Settings has anything live to show once disconnected.
    mainView = 'session';
    closeSidebarMenus();
    // Nothing left to show on either workbench tab once disconnected —
    // resets to the default the same way a fresh session-scoped panel would.
    activeWorkbenchTab = 'files';
    stopTargetStatusPolling();
    targetStatusEntries = [];
    targetStatusError = undefined;
    targetStatusFocus = undefined;
    settingsSection = 'appearance';
  }

  function ensureAuthStore(): AuthStore {
    authStore ??= new AuthStore({ relayBaseUrl: relayHttpBaseUrl(relayUrl) });
    return authStore;
  }

  /**
   * SPEC §8: login is Google/GitHub OAuth only — this starts the real browser
   * redirect to the relay's Better Auth.
   *
   * `signingIn` is what the button reads as its `loading` state. It matters
   * because the redirect is not instant: the click costs a round trip to the
   * relay before the browser leaves, and with no feedback that gap reads as a
   * dead button (Lorenzo's ask, 2026-08-01). It is deliberately NOT cleared on
   * success — the page is on its way out, so the button stays busy until it
   * unloads rather than flicking back to idle mid-navigation.
   */
  async function signInWithGithub(): Promise<void> {
    if (signingIn) return;
    authError = undefined;
    signingIn = true;
    try {
      await ensureAuthStore().signInWithGithub(window.location.href);
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error);
      signingIn = false;
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

    // Detects a `/`-command trigger (Zed-parity C2-4; issue #743): unlike
    // `@file`, a slash command is a whole-message convention, not
    // something embedded mid-sentence, so this only fires when `/` sits at
    // the very start of the composer (nothing but `/` plus a run of
    // non-whitespace before the caret). Never a hardcoded loombox command
    // list — `commands` is exactly what the connected agent declared
    // (`RelayClient.commandsFor`, issue #741), so an agent that has
    // declared none leaves this branch permanently closed: `/` does
    // nothing.
    const slashMatch = /^\/(\S*)$/.exec(beforeCaret);
    if (slashMatch && commands.length > 0) {
      slashTriggerStart = 0;
      slashPickerOpen = true;
    } else {
      slashPickerOpen = false;
      slashTriggerStart = undefined;
    }
  }

  /**
   * Inserts `/name ` into the composer for the selected declared command
   * (Zed-parity C2-4; issue #743) — `/name` plus a trailing space, ready
   * for the user's own argument text, exactly the same "plain text in the
   * draft, sent as an ordinary prompt on submit" shape
   * {@link insertFileReference} already uses for `@path`. No loombox
   * schema parses or validates the argument: `command.input?.hint` is
   * rendered by `SlashCommandPicker` purely as on-screen guidance, never
   * inserted as literal text, since the actual argument is whatever the
   * agent itself expects the user to type next. Always replaces the
   * triggering `/partial-query` text at `slashTriggerStart` — this picker
   * only ever opens via `/`-typing (unlike the `@file` picker, there is no
   * other entry point), so `slashTriggerStart` is always defined here.
   */
  function insertSlashCommand(command: AcpAvailableCommand): void {
    if (slashTriggerStart !== undefined) {
      const before = draft.slice(0, slashTriggerStart);
      const afterTrigger = draft.slice(slashTriggerStart);
      const afterQuery = /^\/\S*/.exec(afterTrigger)?.[0] ?? '/';
      const rest = draft.slice(slashTriggerStart + afterQuery.length).replace(/^\s+/, '');
      draft = `${before}/${command.name} ${rest}`;
    }
    closeSlashPicker();
  }

  function closeSlashPicker(): void {
    slashPickerOpen = false;
    slashTriggerStart = undefined;
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

  /** SPEC §7.3 "Keyboard & command palette" (issue #132) — the live snapshot of state every registered action's `isAvailable` predicate reads (`$lib/action-registry.ts`'s own doc comment has the full rule; issue #758). `turnIsActive` already exists above for the composer's Send/Stop swap, reused here rather than re-deriving `transcript?.turnActive`. */
  const actionContext = $derived<ActionContext>({
    turnActive: turnIsActive,
    sessionCount: sessions.length,
  });

  /** Cycles `selectedSessionId` through `sessions` in its existing list order, wrapping — the handler behind the registry's `next-session`/`previous-session` actions (issue #758). No-ops with fewer than two sessions or nothing selected, which is also exactly when those two actions are unavailable, so this is never reached in a state where it would do nothing; kept defensive anyway since `isAvailable` and `run` are independent functions. */
  function selectAdjacentSession(direction: 1 | -1): void {
    if (sessions.length < 2 || !selectedSessionId) return;
    const index = sessions.findIndex((session) => session.id === selectedSessionId);
    if (index === -1) return;
    selectSession(sessions[(index + direction + sessions.length) % sessions.length].id);
  }

  /** Wires each registry action's effect to this component's own state and the live `client` (issue #758) — the registry module itself stays a plain, framework-free array so `action-registry.test.ts` can exercise its predicates without mounting Svelte. */
  const actionHandlers: ActionHandlers = {
    stopTurn: stopSession,
    toggleSessionsSidebar: () => sessionsDock.toggle(),
    openInbox: () => (mainView = 'inbox'),
    openNodes: () => openTargetStatus(),
    selectNextSession: () => selectAdjacentSession(1),
    selectPreviousSession: () => selectAdjacentSession(-1),
  };

  /** SPEC §7.3 "Keyboard & command palette" (issue #132) — a pure view over `actionRegistry` (issue #758): every entry whose `isAvailable` predicate accepts `actionContext` becomes a row, so the palette never lists something that would no-op if picked right now. */
  const paletteActions = $derived.by((): CommandPaletteAction[] =>
    getAvailableActions(actionContext).map((action) => ({
      id: action.id,
      label: action.label,
      shortcut: action.shortcut,
      run: () => action.run(actionHandlers),
    })),
  );

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
    // `loadPercent`, never the deprecated `cpuPercent` those two used to
    // share: same number, but the old name claimed it was utilisation when
    // it has always been a load-average proxy (v5 design spec §3). A peer
    // that predates the field reports no load at all, which must not read as
    // a healthy zero - `TargetStatusView` shows an em dash for exactly this,
    // so the dot abstains here too rather than inventing good news.
    const { loadPercent, memPercent, diskPercent } = target.health;
    if (loadPercent === undefined) return 'no-data';
    if (
      loadPercent >= TARGET_OVERLOAD_PERCENT ||
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

  /**
   * One shared empty list, so "this target announced nothing" is a stable value
   * rather than a fresh array on every render. Never mutated - it is only ever
   * read, and handed down as a prop.
   */
  const NO_PROVIDERS: string[] = [];

  /** The provider ids `project`'s own target can actually spawn (forms + real providers design spec §2/§3): looked up from the already-polled `targetStatusEntries` (issue #269) the exact same way {@link sessionTargetLabel} finds a session's target. A target this device hasn't heard from yet (or has fallen out of the list) reads as zero providers, same as a genuinely bare one — `NewSessionDialog` treats both identically until the next poll fills it in. */
  function providersForProject(project: Project): string[] {
    const target = targetStatusEntries.find(
      (entry) => entry.nodeId === project.nodeId && entry.targetId === project.targetId,
    );
    // `NO_PROVIDERS` rather than a fresh `[]`: this is read on every render while
    // `NewSessionDialog` is open, and a new array identity each time is prop churn
    // that consumers have to defend against (it used to wipe the open form - see
    // that component's reset effect).
    return target?.providers ?? NO_PROVIDERS;
  }

  /** `project`'s own target, named for a human — mirrors {@link sessionTargetLabel}'s identical label-with-id-fallback idiom; used only to name the target in `NewSessionDialog`'s zero-providers message. */
  function targetLabelForProject(project: Project): string {
    const target = targetStatusEntries.find(
      (entry) => entry.nodeId === project.nodeId && entry.targetId === project.targetId,
    );
    return target?.label ?? project.targetId;
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
    worstStatus: SessionStatusV1 | undefined;
    /** True when this group renders expanded: the filter force-expands every group it keeps (design spec v4 §3.2's "auto-expands every group that has a match"), regardless of {@link collapsedProjectKeys}. */
    expanded: boolean;
  }

  /**
   * Ranks a live session status worst-first, for a project group's single
   * summary `StatusDot` (design spec v4 §3.2). Reuses `$lib/session-
   * status.ts`'s own tone/label maps for the actual dot and its
   * `aria-label`, so this ranking never invents wording of its own. Keyed
   * by the protocol's `SessionStatusV1` (8 values), not the narrower
   * `AcpSessionStatus` (5) — same reasoning as `session-status.ts`'s own
   * doc comment: `'queued'`/`'starting'`/`'disconnected'` (issue #702) are
   * real values `sessionStatuses` can hold, and a project group whose
   * first-seen session happened to be one of those used to get stuck
   * there (`SESSION_STATUS_SEVERITY[status]` came back `undefined` for
   * them, so no later, genuinely worse status could ever out-rank it —
   * `undefined > n` is always `false`). `'starting'` ranks beside
   * `'working'` (both actively in flight); `'queued'` ranks below
   * `'awaiting_input'` (waiting for a slot, not yet asking anything);
   * `'disconnected'` ranks just above `'exited'` (passive, but — unlike
   * `'exited'` — something a person may want to act on).
   */
  const SESSION_STATUS_SEVERITY: Record<SessionStatusV1, number> = {
    error: 7,
    permission_required: 6,
    working: 5,
    starting: 5,
    awaiting_input: 3,
    queued: 2,
    disconnected: 1,
    exited: 0,
  };

  /**
   * The row/selvage badge's status text (issue #730): the plain
   * `SESSION_STATUS_LABELS`/`SESSION_STATUS_UNKNOWN_LABEL` reading, except
   * for `'error'` with a `reason` the node sent (`RelayClient.
   * statusReasonFor` — a spawn that failed or timed out), where the
   * reason is appended so a hover/hold on the row's own tooltip or the
   * dot's accessible name reads WHY, not just that it failed.
   */
  function sessionStatusLabelWithReason(
    status: SessionStatusV1 | undefined,
    reason: string | undefined,
  ): string {
    if (!status) return SESSION_STATUS_UNKNOWN_LABEL;
    const label = SESSION_STATUS_LABELS[status];
    return status === 'error' && reason ? `${label}: ${reason}` : label;
  }

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
      let worstStatus: SessionStatusV1 | undefined;
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
   * Opens the Tracker page for `project` directly (issue #697) — reachable
   * from a project's own "more actions" menu with no session involved at
   * all, unlike the top nav's `destination-tracker` shortcut (which only
   * ever reflects whichever session happens to be selected, via
   * {@link selectSession}). Leaves `selectedSessionId` untouched,
   * mirroring every other destination's own "selecting one leaves the
   * session alone" contract (§3.3).
   */
  function openTrackerForProject(project: Project): void {
    trackerProject = { nodeId: project.nodeId, projectPath: project.path };
    mainView = 'tracker';
    sessionsSheetOpen = false;
    closeSidebarMenus();
  }

  /** The session row menu's "Archive session…" action (design spec v4 §3.2; issue #512). */
  function openArchiveSessionDialog(session: ClientSessionMeta): void {
    archivingSession = session;
    archiveSessionOpen = true;
  }

  function closeArchiveSessionDialog(): void {
    archiveSessionOpen = false;
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
   *
   * `$state.snapshot` is load-bearing, and its absence took the whole app
   * down in production: `notificationPreferences` is a `$state` proxy, and
   * structured clone cannot clone a Proxy, so `postMessage` threw
   * `DataCloneError: #<Object> could not be cloned`. This runs early in
   * `onMount`, well before the session is restored, so the app never issued
   * its `/api/auth/get-session` request at all and sat on "Checking session…"
   * forever — on every visit AFTER the first, since the worker only controls
   * the page from the second load on. `tests-e2e/pwa-shell.spec.ts` covers
   * exactly that second visit now.
   *
   * The `try`/`catch` is deliberate belt-and-braces on top of the snapshot: a
   * notification-preference sync has no business being able to stop someone
   * signing in, whatever a future payload puts in this message.
   */
  function syncNotificationPreferencesToServiceWorker(): void {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return;
    const sessionProjectMap: Record<string, string> = {};
    for (const session of sessions) sessionProjectMap[session.id] = session.projectPath;
    try {
      navigator.serviceWorker.controller.postMessage({
        type: 'loombox:notification-prefs-sync',
        preferences: $state.snapshot(notificationPreferences),
        sessionProjectMap,
      });
    } catch (error) {
      console.warn('loombox: could not sync notification preferences to the service worker', error);
    }
  }

  function onNotificationPreferencesChange(preferences: NotificationPreferencesData): void {
    notificationPreferences = preferences;
    syncNotificationPreferencesToServiceWorker();
  }

  /** The global shortcut dispatcher (issue #132): Escape closes an open sidebar menu; Mod+K opens the palette from anywhere, including mid-typing — deliberately, so jumping sessions doesn't require clearing focus first; every other shortcut is matched against `actionRegistry` (issue #758) and gated by the same "not typing" guard the old ad hoc `Mod+.`/`Mod+B` checks used to apply by hand. The palette itself owns Esc/Arrow/Enter once open (`CommandPalette.svelte`). */
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
    if (isTypingTarget(event.target)) return;
    const action = matchShortcut(event, actionContext);
    if (!action) return;
    event.preventDefault();
    action.run(actionHandlers);
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

  /** The attention inbox's "Open" action (issue #168) — jumps to the item's originating session. The right sidebar's own open state is independent of this navigation now (design spec §3.3, issue #571): unlike the old overlay Drawer, it does not force-close on a session switch, exactly like the left sidebar doesn't. */
  function openSessionFromInbox(sessionId: string): void {
    selectSession(sessionId);
  }

  /** The attention inbox's inline reply action (issue #168) — the exact same `RelayClient.sendPrompt` call the session's own composer form makes, so a reply sent from the inbox is not a second, divergent send path; it works for any listed session, not only the currently selected one. */
  function replyFromInbox(sessionId: string, text: string): void {
    if (!client) return;
    client.sendPrompt(sessionId, text);
  }

  /** `ConfigBar`'s value pickers (a genuine user pick, unlike `applyRememberedConfigOptions`'s automatic one) — flags `category` as pending in `pendingUserConfigOptionChanges` so `handleConfigOptionsUpdate` remembers whatever value its ack actually lands with as this agent's new account-wide "last used" (issue #753, D4-2), whether or not it's the value requested here (the agent's own ack, never an optimistic local guess, is still the only source of truth — see `RelayClient.setConfigOption`'s own doc comment). */
  function changeConfigOption(category: string, optionId: string): void {
    if (!client || !selectedSessionId) return;
    const pending = pendingUserConfigOptionChanges[selectedSessionId] ?? new SvelteSet<string>();
    pending.add(category);
    pendingUserConfigOptionChanges[selectedSessionId] = pending;
    client.setConfigOption(selectedSessionId, category, optionId);
  }

  /** `ConfigBar`'s "pin to project" action (issue #753, D4-3): pins `category`'s CURRENT choice as the selected session's project's override for its agent — a plain client-local write, no wire round trip at all (unlike `changeConfigOption`, nothing here needs the agent's own ack; the value is already live). Refreshes `configOptionProjectOverrides` immediately so the badge/pin state reflects it without waiting on the next `configOptions` push. A no-op if the category has no current selection yet. */
  function pinConfigOptionToProject(category: string): void {
    if (!selectedSession) return;
    const option = configOptions.find((entry) => entry.category === category);
    if (!option || option.current === undefined) return;
    const storage = createLocalStorageConfigOptionOverrideStorage(selectedSession.projectPath);
    setConfigOptionOverride(storage, selectedSession.provider, category, option.current);
    configOptionProjectOverrides = configOptionOverridesFor(storage, selectedSession.provider);
  }

  /** The inverse of {@link pinConfigOptionToProject} — clears `category`'s project override, falling back to the account default or the agent's own. */
  function unpinConfigOptionFromProject(category: string): void {
    if (!selectedSession) return;
    const storage = createLocalStorageConfigOptionOverrideStorage(selectedSession.projectPath);
    clearConfigOptionOverride(storage, selectedSession.provider, category);
    configOptionProjectOverrides = configOptionOverridesFor(storage, selectedSession.provider);
  }

  async function exportTranscript(): Promise<void> {
    if (!transcript) return;
    await copyToClipboard(exportTranscriptText(transcript));
  }

  /** The turn currently being forked, if any (design spec `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746) — drives the fork button's busy state on that one row (`TranscriptTimeline`'s own `forkingTurnId`). */
  let forkingTurnId = $state<string | undefined>(undefined);
  /** The most recent fork request's refusal reason, if any — cleared on the next attempt. Rendered inline above the transcript (see the template below); mirrors this file's own `rePairError`/`escrowError`/`targetStatusError` convention for a lightweight, non-dialog async action. */
  let forkError = $state<string | undefined>(undefined);

  /** The turn's own fork affordance (`MessageItem`'s hover-revealed icon, v7 B3's row convention — see design spec `2026-08-05-zed-parity-decisions.md` §3's C6-2). On success, navigates straight to the new session, exactly like `handleSessionCreated` already does for an ordinary creation. */
  async function forkSessionFromTurn(turnId: string): Promise<void> {
    if (!client || !selectedSessionId || forkingTurnId) return;
    forkingTurnId = turnId;
    forkError = undefined;
    try {
      const newSessionId = await client.forkSession(selectedSessionId, turnId);
      selectSession(newSessionId);
    } catch (error) {
      forkError = error instanceof Error ? error.message : String(error);
    } finally {
      forkingTurnId = undefined;
    }
  }

  onMount(() => {
    // Design spec v4 §4.2: mirrors the project registry's store into
    // `projects`, created eagerly at module scope above (its default storage
    // is SSR-safe), but the subscription itself lives here so every
    // subscription in this component starts/stops in the same place.
    const unsubscribeProjects = projectStore.subscribe((value) => {
      projects = value;
    });

    amkStorage = createLocalStorageAmkStorage();
    configOptionDefaultsStorage = createLocalStorageConfigOptionDefaultsStorage();
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

    // The right sidebar's push-vs-sheet breakpoint (design spec §3.3,
    // issue #571) — see `rightSidebarSheetViewport`'s own doc comment.
    const unsubscribeRightSidebarSheetViewport = isNarrowViewport(DESKTOP_VIEWPORT_BREAKPOINT_PX, {
      exclusive: true,
    }).subscribe((value) => (rightSidebarSheetViewport = value));

    // The right sidebar's open-by-default breakpoint (design spec §3.3,
    // issue #571) — see `rightSidebarNarrowViewport`'s own doc comment.
    const unsubscribeRightSidebarNarrowViewport = isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX, {
      exclusive: true,
    }).subscribe((value) => (rightSidebarNarrowViewport = value));

    // Restores an operator-customized relay URL before constructing
    // `authStore` against it, so a self-hoster who edits this field, then
    // signs in (a full-page OAuth redirect that reloads this component from
    // scratch on return), lands back on the SAME relay's session rather than
    // silently falling back to `DEFAULT_RELAY_URL`.
    const persistedRelayUrl = localStorage.getItem(RELAY_URL_STORAGE_KEY);
    if (persistedRelayUrl) relayUrl = persistedRelayUrl;

    // Issue #571: restores the right sidebar's own persisted state —
    // `rightSidebarDock.restore()` for `{ open, size }` (its own `open`
    // stays a placeholder whenever `rightSidebarHasUserPreference` is
    // false, since nothing ever writes to it through that path — see
    // `rightSidebarOpen`'s doc comment), and this dedicated key for
    // whether a real choice exists at all (see
    // `RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY`'s own doc comment for
    // why this can't just be inferred from the dock's own blob).
    const persistedRightSidebarUserPreference = localStorage.getItem(
      RIGHT_SIDEBAR_USER_PREFERENCE_STORAGE_KEY,
    );
    rightSidebarHasUserPreference = persistedRightSidebarUserPreference === '1';
    rightSidebarDock.restore();

    // Redesign brief §1, issue #438; issue #570 extracted this into
    // `DockPanel` itself, but the restore-before-persisting ORDER stays the
    // exact same shape: called here, before `preferencesRestored` flips
    // below, so `sessionsDock`'s own gate (reading that same flag) never
    // writes back the value it just read.
    sessionsDock.restore();

    // Issue #572: restores the terminal dock's own persisted `{ open,
    // size }` — same order requirement as `rightSidebarDock.restore()`/
    // `sessionsDock.restore()` above, before `preferencesRestored` flips
    // below.
    terminalDock.restore();

    // Every preference above is now the persisted one, so the persistence
    // effects declared near the top of this component (and `sessionsDock`'s
    // own internal persistence, gated the same way) may start writing (see
    // `preferencesRestored`'s own doc comment).
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
      unsubscribeProjects();
      unsubscribeAuthSession();
      unsubscribeNarrow();
      unsubscribeSessionsSheetViewport();
      unsubscribeRightSidebarSheetViewport();
      unsubscribeRightSidebarNarrowViewport();
      disconnect();
    };
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} onpointerdown={handleWindowPointerDown} />

<main class:cockpit={cockpitReady}>
  {#if !authChecked}
    <!-- Checking the session. The same centred panel the sign-in state uses,
         in the same place, so resolving the session swaps the panel's contents
         without moving anything on screen. The weave is the motif at `md`
         (2.5rem): this used to be `WovenLoader`'s default `sm` (1em, so 12px)
         on a line stranded in the window's top-left corner, while the lockup
         above it was centred. -->
    <GateShell>
      <Card elevation="floating" padding="lg">
        <div class="gate-checking">
          <WovenLoader size="md" label="Checking session" />
          <p>Checking session…</p>
        </div>
      </Card>
    </GateShell>
  {:else if !authSession}
    <!-- The signed-out gate (redesign brief §4/§6, issue #430): lead, one
         primary action, the reassurance that belongs next to a sign-in button,
         then the self-hoster's Relay URL override folded into a disclosure —
         through the app's own `Field` + `Input` rather than the bare
         `<label>` + `<input>` this screen hand-rolled. `EmptyState` used to
         carry this, but its documented job is "empty sessions, empty inbox,
         empty targets": it dressed the front door as "nothing here yet", and
         its dimmed `BrandMark` drew the brand a second time ~110px under the
         lockup's own. -->
    <GateShell>
      <Card elevation="floating" padding="lg">
        <p class="gate-lead">Sign in to load your sessions and connect to your nodes.</p>
        <Button
          variant="primary"
          fullWidth
          loading={signingIn}
          dataTestId="sign-in-github"
          onclick={signInWithGithub}>Sign in with GitHub</Button
        >
        <p class="gate-fineprint">
          Every session is encrypted end to end. Your keys never leave your devices.
        </p>
        {#if authError}
          <ErrorNotice message={authError} />
        {/if}
        <details class="gate-selfhost">
          <summary>Self-hosting your own relay?</summary>
          <div class="gate-selfhost-body">
            <Field label="Relay URL">
              {#snippet children({ id, describedBy })}
                <Input {id} {describedBy} bind:value={relayUrl} monospace />
              {/snippet}
            </Field>
          </div>
        </details>
      </Card>
    </GateShell>
  {:else if onboardingNeeded}
    <!-- First-run onboarding (redesign v3 design spec §3.1) in the same shell,
         so the app does not re-centre itself between signing in and setting
         this device up. `wide`, since the steps carry a Recovery Code and its
         explanation rather than a single button. The identity + connection +
         sign-out row that used to sit above it is the shell's footer now. -->
    <!-- A `{#snippet}` body is not narrowed by the branch that encloses it (it
         is rendered later, by the component it is passed to), so the footer
         below reads the account off a const bound out here instead. -->
    {@const session = authSession}
    <GateShell width="wide">
      <OnboardingGate
        accountId={authSession.accountId}
        {relayUrl}
        authToken={authSession.token}
        onFirstDevice={handleFirstDeviceOnboarded}
        onNewDevice={handleNewDeviceOnboarded}
      />
      {#if authError}
        <ErrorNotice message={authError} />
      {/if}
      {#snippet footer()}
        <span class="account font-mono">{session.accountId}</span>
        <span class="status" data-status={status}>
          {#if status === 'connecting'}
            <WovenLoader label="Connecting to the relay" />
          {/if}
          {connectionNotice?.label ?? 'Connected'}
        </span>
        <Button variant="ghost" size="sm" onclick={signOut}>Sign out</Button>
      {/snippet}
    </GateShell>
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
      {@const statusLabel = sessionStatusLabelWithReason(
        sessionStatus,
        sessionStatusReasons.get(session.id),
      )}
      {@const statusTone = sessionStatus ? SESSION_STATUS_TONES[sessionStatus] : 'neutral'}
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
          <!-- The dot is drawn ONLY when it has something to say, which is the
               rule the header's own connection state already follows (see
               `connectionNotice`'s doc comment: "a permanently green dot in the
               app's highest-attention corner spent those pixels saying
               nothing"). Every neutral tone - no status yet, awaiting input,
               exited - used to render an identical grey speck in the row's
               leading indent, so the dot could not be read as meaning anything;
               `working`, `permission_required` and `error` are the three that
               can. The label still reaches a screen reader either way.

               The wrapper is NOT inside the branch: `.sr-only` is
               position-absolute, so a bare one is out of flow, `.session-main`
               auto-places into the dot's grid column, and the title jogs 16px
               sideways the moment a session starts working (measured before
               this span was hoisted out: x=30.4 quiet vs x=46.3 working). -->
          <span class="session-status">
            {#if statusTone === 'neutral'}
              <span class="sr-only">{statusLabel}</span>
            {:else}
              <StatusDot
                tone={statusTone}
                pulse={sessionStatus === 'working'}
                label={statusLabel}
                size="sm"
              />
            {/if}
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
            <span class="session-meta font-mono" data-testid="session-activity">
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
              <!-- D3-3 (design spec §4; issue #670): export used to be a
                   bare copy-glyph in the header, which left the header
                   with a control nobody could identify. It now sits beside
                   the row's other two session actions, plain-labelled, no
                   copy glyph — only actionable for the session that's
                   actually open, since that's the only transcript this
                   page holds decoded client-side. -->
              {#if session.id === selectedSessionId && mainView === 'session'}
                <button
                  type="button"
                  role="menuitem"
                  data-testid="session-export-link"
                  onclick={() => {
                    closeSidebarMenus();
                    void exportTranscript();
                  }}
                >
                  Export transcript
                </button>
              {/if}
              <button
                type="button"
                role="menuitem"
                data-testid="session-archive-link"
                onclick={() => {
                  closeSidebarMenus();
                  openArchiveSessionDialog(session);
                }}
              >
                Archive session…
              </button>
            </div>
          {/if}
        </div>
      </li>
    {/snippet}

    <!-- The collapsed sidebar's icon-only row: avatar + status dot only. -->
    {#snippet selvageSessionRow(session: ClientSessionMeta)}
      {@const sessionStatus = sessionStatuses.get(session.id)}
      {@const statusLabel = sessionStatusLabelWithReason(
        sessionStatus,
        sessionStatusReasons.get(session.id),
      )}
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
        class:resizing={sessionsDock.dragging}
        style={sessionsSheetViewport ? undefined : `width: ${sessionsColumnWidthPx}px`}
        data-testid="sessions-column"
      >
        <div class="sidebar-brand">
          <!-- Not an `<h1>`: the wordmark names the app, which never changes,
               while the heading names the view, which is what the topbar's
               session title and `PageLayout`'s page title already do. Two
               `<h1>`s on one screen is what the old markup produced, and one
               of them was always wrong. `BrandLockup`/`BrandMark` carry their
               own accessible name, so nothing is lost by dropping the tag. -->
          <div class="sidebar-brand-mark">
            {#if sessionsRailCollapsed}
              <BrandMark decorative={false} label="loombox" />
            {:else}
              <BrandLockup />
            {/if}
          </div>
          <IconButton
            label={sessionsDock.open ? 'Collapse sidebar' : 'Expand sidebar'}
            pressed={!sessionsDock.open}
            onclick={() => sessionsDock.toggle()}
            class="sidebar-collapse-toggle"
            dataTestId="sidebar-collapse-toggle"
          >
            <Icon name="sidebar-panel" />
          </IconButton>
        </div>

        <!-- Primary destinations (design spec v4 §3.1, amended by issue
             #568): heavier than v3's muted secondary nav they replace, and
             moved to the TOP: they now indicate what the main area is
             showing, not a panel to toggle. Selecting one leaves
             `selectedSessionId` untouched (§3.3), so returning to the
             transcript is one click. Nodes & targets is no longer one of
             these rows — issue #568 folded it into Settings, reachable from
             the account menu below, so Inbox is the sole row left; the
             health dot that used to live here moved onto the account
             trigger and the Settings menu entry instead (see
             `hasUnhealthyTarget` below). -->
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
          {#if trackerProject}
            <!-- Project-scoped, unlike Inbox above (issue #212): the
                 native tracker's kanban/list UI is reachable once a
                 project is in view, not once a session is selected
                 (issue #697 dropped the session dependency entirely —
                 `TrackerPage.svelte`'s own doc comment) — the same gate
                 the right sidebar's Config tab uses for
                 `selectedProjectPath`, one layer looser. Closes
                 `sessionsSheetOpen` itself (mirrors the tabbar's own
                 `tabbar-inbox` handler, not this same nav's
                 `destination-inbox` sibling, which has no mobile-tabbar
                 duplicate to lean on) — Tracker has no tabbar entry of
                 its own, so this row IS the only mobile path to it, and
                 it must close the sheet it lives inside on its way there
                 or the backdrop it leaves open blocks the destination
                 page underneath (caught by `tracker-mobile.spec.ts`).
                 Demoted, not deleted, now that the topbar carries its own
                 Agent/Tracker switch (v8 D1-1, issue #710): this row stays
                 for the two reasons that hold regardless of where that
                 switch lives — it is still the only way into Tracker for a
                 project with no session open (the switch itself only
                 exists once a session is selected, same as `workbench-
                 toggle`), and below `--bp-desktop` the switch drops out of
                 the topbar entirely, so this sheet stays the only route
                 there on narrow viewports too. -->
            <button
              type="button"
              class="destination-row"
              class:active={mainView === 'tracker'}
              onclick={() => {
                mainView = 'tracker';
                sessionsSheetOpen = false;
              }}
              data-testid="destination-tracker"
            >
              <span class="destination-icon"><Icon name="tracker" size="100%" /></span>
              <span class="destination-label">Tracker</span>
            </button>
          {/if}
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
                        onclick={() => openTrackerForProject(row.project)}
                        data-testid="project-open-tracker"
                      >
                        Open tracker
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
                class="settings-menu-item"
                onclick={() => {
                  closeSidebarMenus();
                  mainView = 'settings';
                }}
              >
                <span>Settings</span>
                {#if hasUnhealthyTarget}
                  <span
                    class="menu-item-alert-dot"
                    data-testid="settings-menu-health-badge"
                    aria-hidden="true"
                  ></span>
                  <span class="sr-only">Some targets need attention</span>
                {/if}
              </button>
              <!-- Not `danger`: signing out ends a session on this device and
                   nothing else. The red belonged to the surfaces that destroy
                   something (archiving a session, removing a connection). -->
              <button
                type="button"
                role="menuitem"
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
            <span class="account-avatar" aria-hidden="true">
              {accountInitial}
              {#if hasUnhealthyTarget}
                <span
                  class="account-avatar-alert"
                  data-testid="account-health-badge"
                  aria-hidden="true"
                ></span>
              {/if}
            </span>
            {#if hasUnhealthyTarget}
              <span class="sr-only">Some targets need attention</span>
            {/if}
            <span class="account-name">{accountShortLabel}</span>
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
            aria-orientation={sessionsDock.ariaOrientation}
            aria-label="Resize sidebar"
            aria-valuenow={sessionsDock.size}
            aria-valuemin={sessionsDock.min}
            aria-valuemax={sessionsDock.max}
            tabindex="0"
            onpointerdown={sessionsDock.startDrag}
            onkeydown={sessionsDock.handleKeydown}
            data-testid="sessions-resize-handle"
          ></div>
        {/if}
      </aside>

      <div class="workspace">
        <!-- Three zones (v8 D1-1, issue #710): context on the left, the
             Agent/Tracker switch centred, controls on the right. The brand
             and the account moved into the sidebar; the always-green
             connection dot is gone, replaced by a chip that only appears
             when there is something wrong and something to do about it.
             Coherence v5 §2/§0.1: the topbar's own title span is gone — a
             destination page carries its title in `PageLayout`'s real
             `<h1>` now, so the left zone shows ONLY the session breadcrumb,
             and only while a session is open (§3.3's mainView === 'session'
             gate); the right zone still drops every session-scoped control
             while a page shows. `.topbar` is a real `grid-template-columns:
             1fr auto 1fr` (not the old two-zone `space-between` flex) so
             the centre column sits at the WINDOW's centre regardless of how
             wide the left or right zone's own content is — the exact
             failure D1-1's own trade sentence names for bolting a third
             child onto the flex instead. -->
        <header class="topbar">
          <div class="topbar-context">
            {#if mainView === 'session'}
              {#if selectedSession}
                <!-- The session's own `<h1>`, mirroring what `PageLayout`
                     gives the three destination pages: whatever the main area
                     is showing owns the page heading. The wordmark in the
                     sidebar deliberately is not one - it names the app, which
                     never changes, not the view, which is the whole point of a
                     heading. -->
                <h1 class="topbar-title" data-testid="cockpit-session-title">
                  {selectedSession.title}
                </h1>
                <span
                  class="topbar-breadcrumb font-mono"
                  data-testid="topbar-breadcrumb"
                  title={selectedSession.projectPath}
                >
                  {projectDisplayName(selectedSession)}
                  <span aria-hidden="true">·</span>
                  {selectedSession.targetId}
                </span>
              {:else}
                <h1 class="topbar-title topbar-title-muted">No session selected</h1>
              {/if}
            {/if}
          </div>

          <!-- The Agent/Tracker switch (v8 D1-1, issue #710): "il tracker
               non ha senso che stia come voce principale nella sidebar...
               metterei un button group con due voci agent e tracker verso
               il centro in alto" — a button group tied to the SELECTED
               session's own project, not a global destination, so it only
               exists once a session is selected (same gate `workbench-
               toggle`/`terminal-dock-toggle` below use), and it stays
               visible while showing that session's own Tracker board so
               there is a way back to Agent. No session selected: the whole
               centre column is empty rather than a disabled control (the
               sidebar's own `destination-tracker` row, demoted not
               deleted, is still the only route into Tracker with no
               session open — `:2711-2739`'s own doc comment). `role=
               "radiogroup"`/`role="radio"` with a roving tabindex, the same
               mutually-exclusive idiom `WORKBENCH_TABS` and `ConfigBar`'s
               mode switch already use (issue #549's precedent), not
               `aria-pressed`: exactly one of Agent/Tracker is always
               current. -->
          {#if selectedSessionId && (mainView === 'session' || mainView === 'tracker')}
            <div
              class="topbar-switch"
              role="radiogroup"
              aria-label="View"
              data-testid="topbar-view-switch"
              bind:this={topbarViewGroupEl}
            >
              <Button
                variant="ghost"
                size="sm"
                class={`topbar-view-choice ${mainView !== 'tracker' ? 'selected' : ''}`.trim()}
                role="radio"
                ariaChecked={mainView !== 'tracker'}
                tabindex={mainView !== 'tracker' ? 0 : -1}
                onclick={() => (mainView = 'session')}
                onkeydown={handleTopbarViewKeydown}
                dataTestId="topbar-view-agent"
              >
                Agent
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class={`topbar-view-choice ${mainView === 'tracker' ? 'selected' : ''}`.trim()}
                role="radio"
                ariaChecked={mainView === 'tracker'}
                tabindex={mainView === 'tracker' ? 0 : -1}
                onclick={openSessionTracker}
                onkeydown={handleTopbarViewKeydown}
                dataTestId="topbar-view-tracker"
              >
                Tracker
              </Button>
            </div>
          {/if}

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
              <!-- One toggle for the right sidebar itself (design spec §3.3,
                   issue #571): the Files/Terminal/Config three-button group
                   that used to live here is gone. Two controls for one
                   choice was the defect (Lorenzo's read, 2026-08-03): this
                   button opens/closes the panel, and the Files/Config
                   choice moved onto sub-tabs inside the panel's own header
                   (`WORKBENCH_TABS`), which is the only place that choice
                   is offered now. A plain icon toggle, no label, ever (v8
                   C1-3, issue #710): Lorenzo asked for the Files/Config/
                   Runner group to reach the topbar; the option he actually
                   picked kills the "Workbench" word instead and leaves that
                   group where it already was, inside the panel's own
                   header below. This is what pays for D1-1's centre zone
                   right beside it — do not reintroduce `.panel-word` here
                   even at a wide viewport, and do not add the tab group to
                   the topbar to "finish" what C1-3 deliberately leaves
                   half-done. -->
              <Button
                variant="ghost"
                size="sm"
                class="workbench-toggle"
                pressed={rightSidebarOpen}
                ariaLabel="Workbench"
                title="Workbench"
                onclick={toggleRightSidebar}
                dataTestId="workbench-toggle"
              >
                <Icon name="sidebar-panel" />
              </Button>
              <!-- The terminal's own toggle (design spec §3.1/§3.2/§3.3,
                   issue #572): a fourth zone alongside the left sidebar,
                   canvas and right sidebar, not a fourth tab inside any of
                   them — it left the right sidebar's `WORKBENCH_TABS`
                   entirely (that panel's own doc comment above), so it
                   gets the exact same "one control, opens/closes"
                   treatment `workbench-toggle` gives the right sidebar,
                   right beside it. -->
              <Button
                variant="ghost"
                size="sm"
                class="terminal-dock-toggle"
                pressed={terminalDock.open}
                ariaLabel="Terminal"
                title="Terminal"
                onclick={toggleTerminalDock}
                dataTestId="terminal-dock-toggle"
              >
                <Icon name="terminal" />
                <span class="panel-word">Terminal</span>
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="sm"
              class="palette-trigger"
              ariaLabel="Jump to… (Ctrl/Cmd+K)"
              title="Jump to… (Ctrl/Cmd+K)"
              onclick={() => (paletteOpen = true)}
              dataTestId="command-palette-toggle"
            >
              <Icon name="command" />
              <span class="panel-word">Jump to…</span>
            </Button>
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
              {:else if mainView === 'settings' && authSession}
                <SettingsPage
                  {notificationPreferencesStorage}
                  {projectPaths}
                  {onNotificationPreferencesChange}
                  {deviceId}
                  relayBaseUrl={relayHttpBaseUrl(relayUrl)}
                  authToken={authSession.token}
                  targets={targetStatusEntries}
                  loading={targetStatusLoading}
                  error={targetStatusError}
                  focusTarget={targetStatusFocus}
                  onRefresh={refreshTargetStatus}
                  {relayBuildIdentity}
                  onAddTarget={openAddTargetWizard}
                  onConnectNode={openAddTargetWizard}
                  {client}
                  {connectedAccounts}
                  section={settingsSection}
                  onSectionChange={selectSettingsSection}
                />
              {:else if mainView === 'tracker' && trackerProject && client}
                <TrackerPage
                  {client}
                  projectPath={trackerProject.projectPath}
                  nodeId={trackerProject.nodeId}
                  {connectedAccounts}
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
            {#if forkError}
              <p class="fork-error" role="alert" data-testid="fork-error">
                {forkError}
              </p>
            {/if}
            <!-- Issue #730: a session with no live agent behind it must not
                 sit as a blank transcript with no explanation — the
                 original bug's exact symptom ("the optimistically echoed
                 user turn sitting in an otherwise empty transcript,
                 forever"). Shares `selectedSessionAgentless`/
                 `composerUnavailableReason` with the composer's own gate
                 just below, so the two surfaces never disagree. -->
            {#if selectedSessionAgentless}
              <div class="workspace-notice" data-testid="session-agentless-notice">
                {#if selectedSessionStatus === 'error' || selectedSessionStatus === 'exited' || selectedSessionStatus === 'disconnected'}
                  <ErrorNotice message={composerUnavailableReason ?? ''} />
                {:else}
                  <Card elevation="raised" padding="sm">
                    <div class="escrow-inflight-row">
                      <WovenLoader label={composerUnavailableReason ?? 'Waiting…'} />
                      <span>{composerUnavailableReason}</span>
                    </div>
                  </Card>
                {/if}
              </div>
            {/if}
            <TranscriptTimeline
              sessionKey={selectedSessionId}
              items={transcript?.items ?? []}
              {transcript}
              turnActive={transcript?.turnActive ?? false}
              providerId={selectedSession?.provider}
              {permissionHead}
              onFork={narrowViewport ? undefined : forkSessionFromTurn}
              {forkingTurnId}
            />

            <div class="canvas-footer">
              <!-- A3-2 (issue #666): the turn's own live line, not a
                   spinner welded to the Stop button — see `turnProgressVisible`'s
                   own doc comment (script section) for exactly when this
                   shows. Reuses `.composer-gutter`, the same column every
                   row in this strip aligns to, so it reads as the
                   transcript's own next line rather than a toast bolted
                   onto the footer. -->
              {#if turnProgressVisible}
                <div class="turn-progress" data-testid="turn-progress-line">
                  <div class="composer-gutter" aria-hidden="true"></div>
                  <div class="turn-progress-content">
                    <WovenLoader size="sm" variant="working" label="Turn in progress" />
                    Working…
                  </div>
                </div>
              {/if}

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
                <!-- Design spec v6 §3.4 (issue #575): the composer is the
                     last entry in the timeline, not a chat box bolted to the
                     bottom of one. It takes the same fixed role gutter every
                     transcript item uses, so the column runs unbroken from
                     the first turn into the thing you are about to say — it
                     no longer paints a caption-case "YOU" to do that (no
                     transcript row does anymore, see `MessageItem`): v7 §2's
                     amended B1-2/B2-4 (2026-08-04 decisions) drop every
                     gutter role mark entirely, sighted or not — surface is
                     the only signal left, same as a real `user` transcript
                     row, and the field's own bordered, raised
                     `--color-surface-raised` box with a soft shadow (below,
                     A1-3) is that surface. The whole strip stays
                     `aria-hidden` — the textarea's own `aria-label` is this
                     row's real accessible name, there never was one on the
                     word this replaces.

                     One strip, not two (Lorenzo's ask, 2026-07-30): the attach
                     trigger, the pickers and the context/cost figures used to
                     sit in a mini-toolbar ABOVE the composer, with a keyboard
                     hint occupying the row below the textarea. They now share
                     that one row under the text, so everything about the turn
                     you are composing reads inside the field's own column. -->
                <div class="composer-row">
                  <div class="composer-gutter" aria-hidden="true"></div>
                  <!-- The drop/paste zone wraps the field (see AttachmentBar's
                       doc comment): dropping a file on the textarea, or pasting
                       an image into it, used to do nothing at all. -->
                  <AttachmentBar
                    {attachments}
                    onFiles={attachFiles}
                    onRetry={retryAttachment}
                    onRemove={removeAttachment}
                  >
                    {#snippet field({ pickFiles })}
                      <div class="composer-field">
                        <textarea
                          bind:this={composerTextarea}
                          bind:value={draft}
                          oninput={handleComposerInput}
                          onkeydown={handleComposerKeydown}
                          disabled={selectedSessionAgentless}
                          placeholder={composerUnavailableReason ?? 'Send a follow-up prompt…'}
                          aria-label="Follow-up prompt"
                          aria-describedby="composer-hint"
                          rows="1"
                          data-testid="composer-input"></textarea>
                        <!-- Screen-reader only: the row below is full of live
                             facts now (agent, model, context, cost), and a
                             keyboard hint read once in a lifetime does not get
                             to compete with them for the same pixels. It stays
                             in the DOM because `aria-describedby` above points
                             at it. -->
                        <p class="composer-hint sr-only" id="composer-hint">
                          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new
                          line · <kbd>@</kbd> to reference a file
                        </p>
                        <div class="composer-controls" data-testid="composer-controls">
                          <IconButton label="Attach image" onclick={pickFiles}>
                            <Icon name="attach" size="20px" />
                          </IconButton>
                          {#if narrowViewport}
                            <IconButton
                              label={configControlsExpanded
                                ? 'Hide composer options'
                                : 'More composer options'}
                              pressed={configControlsExpanded}
                              onclick={() => (configControlsExpanded = !configControlsExpanded)}
                            >
                              <Icon name="more" />
                            </IconButton>
                          {/if}
                          <ConfigBar
                            options={configOptions}
                            usage={transcript?.usage}
                            cumulativeCostUsd={transcript?.cumulativeCostUsd ?? 0}
                            onChange={changeConfigOption}
                            providerId={selectedSession?.provider}
                            compact={!configControlsVisible}
                            sources={configOptionSources}
                            onPinToProject={pinConfigOptionToProject}
                            onUnpinFromProject={unpinConfigOptionFromProject}
                          />
                          <div class="composer-actions">
                            <!-- A3-2 (issue #666): one button in one slot —
                                 while a turn runs the button IS Stop, Send is
                                 gone (not disabled-and-present). Both render
                                 at `size="md"` (Stop no longer takes the
                                 smaller `sm` it used to sit at next to a
                                 disabled Send) so the slot itself never
                                 changes footprint at the swap. -->
                            {#if turnIsActive}
                              <TurnStopControl turnActive={turnIsActive} onStop={stopSession} />
                            {:else}
                              <Button
                                type="submit"
                                variant="primary"
                                disabled={sendDisabled}
                                ariaLabel="Send prompt">Send</Button
                              >
                            {/if}
                          </div>
                        </div>
                      </div>
                    {/snippet}
                  </AttachmentBar>
                </div>
              </form>
            </div>
          {/if}
        </section>
      </div>

      <!-- The right sidebar (design spec §3.1/§3.2/§3.3, issue #571): built
           on the shared `DockPanel` behaviour (issue #570), same as the left
           sidebar — collapse, drag-resize, persistence, no second
           hand-written copy. Docked (pushes the canvas, no scrim at all —
           design spec §0.6 "a workbench panel never dims the app") at/above
           `--bp-desktop`; a dismissible sheet below that (a side sheet at
           768-1023px, a bottom sheet under 768px — `rightSidebarSlide`'s own
           doc comment). Files and Config are sub-tabs inside its own header
           now (`WORKBENCH_TABS`), not a second copy of the topbar's old
           three-button switch; the terminal left this panel entirely for its
           own bottom dock (#572). -->
      {#snippet rightSidebarPanel()}
        <!-- The click handler is only a guard against `Overlay`'s own
             backdrop-click-to-close bubbling past this panel in sheet mode
             (mirrors `Dialog.svelte`'s identical stop-propagation guard on
             its own panel). -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <aside
          class="right-sidebar"
          class:resizing={rightSidebarDock.dragging}
          data-testid="right-sidebar"
          onclick={(event) => event.stopPropagation()}
          in:rightSidebarSlide
          out:rightSidebarSlide
          style={rightSidebarSheetViewport ? undefined : `width: ${rightSidebarDock.size}px`}
        >
          <!-- Sub-tabs, not a duplicate of the topbar's own toggle: this
               panel states/switches WHICH workbench panel it shows, the
               topbar switch states/switches WHETHER it shows at all — two
               different choices, so two controls is correct here, unlike the
               old three-button switch that duplicated the SAME choice
               ("Panels") in both places. `role="radiogroup"`/`role="radio"`
               (not `aria-pressed`): exactly one of these is always selected,
               the same mutually-exclusive semantics `ConfigBar`'s mode
               switch already uses (issue #549's precedent). -->
          <div
            class="right-sidebar-tabs"
            role="radiogroup"
            aria-label="Workbench panel"
            bind:this={workbenchTabsEl}
          >
            {#each WORKBENCH_TABS as tab (tab.id)}
              <Button
                variant="ghost"
                size="sm"
                class={`right-sidebar-tab ${activeWorkbenchTab === tab.id ? 'selected' : ''}`.trim()}
                role="radio"
                ariaChecked={activeWorkbenchTab === tab.id}
                tabindex={activeWorkbenchTab === tab.id ? 0 : -1}
                ariaLabel={tab.name}
                onclick={() => (activeWorkbenchTab = tab.id)}
                onkeydown={handleWorkbenchTabKeydown}
                dataTestId={tab.testId}
              >
                <Icon name={tab.icon} />
                {tab.label}
              </Button>
            {/each}
          </div>

          <!-- Both panels stay mounted (the native `hidden` attribute, not `{#if}`-unmounted)
               once a session/project exists for them — switching tabs must
               not remount the other one (issue #571's own acceptance line).
               `FileTreePanel`'s expanded-folder state and any future
               `ProjectConfigPanel` scroll position both survive a round trip
               through the OTHER tab this way. -->
          <div class="right-sidebar-content">
            {#if selectedSessionId}
              <div
                class="right-sidebar-panel-inner"
                hidden={activeWorkbenchTab !== 'files'}
                data-testid="file-tree-panel-wrapper"
              >
                <FileTreePanel
                  tree={fileTree}
                  onExpand={expandDirectory}
                  onSelectFile={insertFileReference}
                />
              </div>
            {/if}
            {#if selectedProjectPath}
              <div
                class="right-sidebar-panel-inner"
                hidden={activeWorkbenchTab !== 'config'}
                data-testid="project-config-panel-wrapper"
              >
                <ProjectConfigPanel
                  projectPath={selectedProjectPath}
                  sessionId={selectedSessionId}
                  relayClient={client}
                />
              </div>
            {/if}
            {#if selectedSessionId}
              <div
                class="right-sidebar-panel-inner"
                hidden={activeWorkbenchTab !== 'runner'}
                data-testid="test-runner-panel-wrapper"
              >
                <RunnerPanel sessionId={selectedSessionId} {client} />
              </div>
            {/if}
          </div>

          {#if !rightSidebarSheetViewport}
            <!-- The WAI-ARIA APG "Window Splitter" pattern, same exception
                 to the noninteractive-role rule `sessions-resize-handle`
                 already takes. Drag-resize is a docked-mode-only affordance
                 (design spec §3.3's responsive table never resizes a sheet),
                 hence the gate. -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="right-sidebar-resize-handle"
              role="separator"
              aria-orientation={rightSidebarDock.ariaOrientation}
              aria-label="Resize right sidebar"
              aria-valuenow={rightSidebarDock.size}
              aria-valuemin={rightSidebarDock.min}
              aria-valuemax={rightSidebarDock.max}
              tabindex="0"
              onpointerdown={rightSidebarDock.startDrag}
              onkeydown={rightSidebarDock.handleKeydown}
              data-testid="right-sidebar-resize-handle"
            ></div>
          {/if}
        </aside>
      {/snippet}

      {#if rightSidebarOpen && selectedSessionId && mainView === 'session'}
        {#if rightSidebarSheetViewport}
          <Overlay
            open={true}
            onClose={closeRightSidebar}
            zIndex="--z-overlay"
            class="right-sidebar-backdrop"
            testid="right-sidebar-backdrop"
          >
            {@render rightSidebarPanel()}
          </Overlay>
        {:else}
          {@render rightSidebarPanel()}
        {/if}
      {/if}
    </div>

    <!-- The terminal dock (design spec §3.1/§3.2/§3.3, issue #572): a
         sibling of `.shell`, not nested inside it — see `.terminal-dock`'s
         own CSS doc comment for why. Gated on the same
         `selectedSessionId && mainView === 'session'` pair the workbench
         toggle and right sidebar use: there is nothing to open a terminal
         ON without a selected session. The wrapper mounts once a
         session's terminal has EVER been opened
         (`terminalOpenedSessionIds`) and never unmounts again for that
         session — `terminalDock.open` only ever drives its `height`/
         `transform`/`inert`, never its presence in the DOM, so a
         collapse/reopen round trip never touches `InteractiveTerminal`'s
         own `onMount`/`onDestroy` (that component's own doc comment: it
         opens a PTY on mount, closes it on destroy — this dock must never
         trigger the second half of that on a mere collapse).
         `{#key selectedSessionId}` still remounts it fresh whenever the
         SELECTED session changes while the dock has content, same as any
         other session-scoped panel — only collapsing and reopening THE
         SAME session's dock is what issue #572's acceptance protects. -->
    {#if selectedSessionId && mainView === 'session' && client}
      {@const activeClient = client}
      {#if terminalDockSheetViewport && terminalDock.open}
        <button
          type="button"
          class="terminal-dock-backdrop"
          aria-label="Close terminal"
          onclick={() => (terminalDock.open = false)}
          data-testid="terminal-dock-backdrop"
        ></button>
      {/if}
      <div
        class="terminal-dock"
        class:terminal-dock-open={terminalDock.open}
        class:sheet-open={terminalDockSheetViewport && terminalDock.open}
        class:resizing={terminalDock.dragging}
        inert={!terminalDock.open}
        data-testid="terminal-dock"
        style={terminalDockSheetViewport ? undefined : `height: ${terminalDock.effectiveSize}px`}
      >
        {#if !terminalDockSheetViewport}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="terminal-dock-resize-handle"
            role="separator"
            aria-orientation={terminalDock.ariaOrientation}
            aria-label="Resize terminal"
            aria-valuenow={terminalDock.size}
            aria-valuemin={terminalDock.min}
            aria-valuemax={terminalDock.max}
            tabindex="0"
            onpointerdown={terminalDock.startDrag}
            onkeydown={terminalDock.handleKeydown}
            data-testid="terminal-dock-resize-handle"
          ></div>
        {/if}
        {#if terminalOpenedSessionIds.has(selectedSessionId)}
          {#key selectedSessionId}
            <InteractiveTerminal sessionId={selectedSessionId} client={activeClient} />
          {/key}
        {/if}
      </div>
    {/if}

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
        onclick={() => {
          const opening = !sessionsSheetOpen;
          if (opening) closeOtherMobileSheets('sessions');
          sessionsSheetOpen = opening;
        }}
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
          <span class="tabbar-badge" data-testid="tabbar-inbox-count"
            >{attentionInboxItems.length}</span
          >
        {/if}
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

<SlashCommandPicker
  open={slashPickerOpen}
  {commands}
  onSelect={insertSlashCommand}
  onClose={closeSlashPicker}
/>

{#if newSessionProject}
  <NewSessionDialog
    open={newSessionOpen}
    project={newSessionProject}
    {client}
    providers={providersForProject(newSessionProject)}
    targetLabel={targetLabelForProject(newSessionProject)}
    onClose={() => (newSessionOpen = false)}
    onCreated={handleSessionCreated}
  />
{/if}

{#if archivingSession}
  <ArchiveSessionDialog
    open={archiveSessionOpen}
    session={archivingSession}
    {client}
    onClose={closeArchiveSessionDialog}
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
  /* The pre-cockpit screens (checking session / sign-in / onboarding) own
     their own full-viewport, centred layout in `GateShell`, so `main` adds
     nothing for them at all. It used to be a top-aligned padded flex column
     here — under a comment claiming the gate kept "the original padded,
     centered column layout", which that rule never had (no `justify-content`,
     no `align-items`, no `max-width`) — and that is exactly what left those
     screens hugging the top of the window.

     `height`, not `min-height`: the sidebar's own footer (secondary nav +
     account) is pinned to the bottom of a column that must therefore END at
     the viewport, and `min-height` lets a tall transcript push it off the
     bottom of the screen instead. */
  main.cockpit {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }

  /* The gate's panel internals. `GateShell` owns the composition around them
     (centring, the woven field, the lockup); these are just the contents of
     the one floating `Card` it centres. */
  .gate-checking {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-md);
    padding: var(--space-md) 0;
  }

  .gate-checking p {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .gate-lead {
    margin: 0 0 var(--space-md);
    color: var(--color-text-secondary);
    text-align: center;
  }

  .gate-fineprint {
    margin: var(--space-md) 0 0;
    color: var(--color-text-muted);
    font-size: var(--text-caption-size);
    text-align: center;
  }

  /* The self-hoster's escape hatch: present, but not competing with the one
     action every other visitor is here for. */
  .gate-selfhost {
    margin-top: var(--space-md);
    border-top: 1px solid var(--color-border-subtle);
    padding-top: var(--space-sm);
    font-size: var(--text-caption-size);
  }

  .gate-selfhost summary {
    cursor: pointer;
    color: var(--color-text-muted);
  }

  .gate-selfhost summary:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .gate-selfhost-body {
    margin-top: var(--space-sm);
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
    /* Matches `.topbar`'s own `height: var(--topbar-height)` (below), not
       a coincidence: this row sits beside the topbar at the same y, and a
       literal `3rem` here is exactly the duplicate-of-a-token case A2-1
       (issue #734) went hunting for — it happened to equal the OLD
       `--topbar-height` and would have silently stopped matching once
       that token tightened. */
    height: var(--topbar-height);
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

  /* The control is always visible, just quiet until the sidebar is hovered or
     holds focus: it is a preference rather than a primary action, but it is
     also the only pointer affordance for shutting the sidebar (`Mod+B` is the
     other, and nobody guesses a shortcut), so hiding it outright meant the
     column could only be closed by someone who happened to hover the header.
     Full opacity while collapsed and on a coarse pointer, neither of which has
     a hover state to reveal anything with. Below `--bp-desktop` it is
     `display: none` (see the narrow-viewport block): there the sidebar is an
     overlay sheet, not a column to collapse. */
  .sidebar-brand :global(.sidebar-collapse-toggle) {
    opacity: 0.55;
    transition: opacity var(--duration-fast) var(--ease-beat);
  }

  .sidebar:hover .sidebar-brand :global(.sidebar-collapse-toggle),
  .sidebar:focus-within .sidebar-brand :global(.sidebar-collapse-toggle),
  .sidebar.collapsed .sidebar-brand :global(.sidebar-collapse-toggle) {
    opacity: 1;
  }

  @media (hover: none) {
    .sidebar .sidebar-brand :global(.sidebar-collapse-toggle) {
      opacity: 1;
    }
  }

  /* No mirrored variant of the glyph on purpose. Flipping it would move the
     marked column to the right, which reads as "the panel moves to the other
     side" rather than "the panel is shut" — and the state is already carried,
     accessibly and visibly, by `IconButton`'s own `aria-pressed` styling
     (accent-subtle fill + accent border) plus the label flipping between
     Collapse and Expand. The chevron this replaced did have a `scaleX(-1)`
     variant, but its path was symmetric about x=32, so that transform drew an
     identical glyph: the control had never actually shown its state. */

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
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  /* Touch-optimized controls (SPEC.md §7.3, issue #133), the same
     coarse-pointer convention `Button`/`IconButton`/`Input` already use
     (`Button.svelte:328-337`). `.destination-row` never had one (A2-1,
     issue #734): at the old 40px `--nav-row-height` that was slack, not a
     gap, since 40px already cleared the 44px floor's own neighbourhood
     closely enough that nothing caught it missing — at the new 30px it
     is a real 14px shortfall on the tablet session sheet with nothing to
     catch it, so this row gets the same floor every other clickable
     surface has under `(pointer: coarse)`. `min-height`, not `height`:
     the row's own `height: var(--nav-row-height)` above stays the fine-
     pointer value, and `min-height` only overrides it upward when the
     coarse floor is taller. */
  @media (pointer: coarse) {
    .destination-row {
      min-height: 2.75rem;
    }
  }

  .destination-row:hover {
    background: var(--color-fill-subtle);
    color: var(--color-text-primary);
  }

  .destination-row.active {
    background: var(--color-fill);
    color: var(--color-text-primary);
  }

  /* Coherence v5 §2: this row had hover but neither of the two states
     `Button.svelte`/`IconButton.svelte` give every other clickable
     surface — same `--focus-ring-*`/tension-press tokens, just applied
     here since a sidebar row isn't routed through either primitive. */
  .destination-row:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .destination-row:active {
    transform: scale(0.98);
    background: var(--color-fill);
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
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .popover-menu button:hover,
  .popover-menu button:focus-visible {
    background: var(--color-fill-subtle);
  }

  /* Coherence v5 §2: these already had hover/focus; press (tension-press,
     `Button.svelte`'s own token) was the missing state. */
  .popover-menu button:active {
    transform: scale(0.98);
    background: var(--color-fill);
  }

  .popover-menu button.danger {
    color: var(--color-danger);
  }

  /* The Settings menu item's own alert dot (issue #568's account-menu-
     trigger route for `hasUnhealthyTarget`, replacing the sidebar row's
     dot the old Nodes destination carried). Every other `.popover-menu`
     button is a plain text label, so this class alone gets the flex
     treatment needed to push the dot to the trailing edge. */
  .settings-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .menu-item-alert-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: var(--radius-full);
    background: var(--color-warning);
    flex-shrink: 0;
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
    grid-template-columns: var(--status-dot-size-sm) minmax(0, 1fr);
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

  /* Fixed, not `auto`: the dot itself only appears for the three tones that
     mean something, so an intrinsic column would collapse for every quiet row
     and every title would jog a dot's width sideways the moment its session
     started working. The slot is reserved either way. */
  .session-status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--status-dot-size-sm);
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
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .project-group-header:hover {
    color: var(--color-text-primary);
    background: var(--color-fill-subtle);
  }

  /* Same `Button.svelte`/`IconButton.svelte` tokens as `.destination-row`
     above (coherence v5 §2). */
  .project-group-header:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .project-group-header:active {
    transform: scale(0.98);
    background: var(--color-fill);
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
    transition:
      background-color var(--duration-fast) var(--ease-beat),
      transform var(--duration-instant) var(--ease-beat);
  }

  .account-trigger:hover,
  .account-trigger[aria-expanded='true'] {
    background: var(--color-fill-subtle);
  }

  /* Same `Button.svelte`/`IconButton.svelte` tokens as `.destination-row`
     above (coherence v5 §2). */
  .account-trigger:focus-visible {
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .account-trigger:active {
    transform: scale(0.98);
    background: var(--color-fill);
  }

  .account-avatar {
    position: relative;
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

  /* The account trigger's own health signal (issue #568): an unhealthy
     target used to light a dot on the sidebar's Nodes row; now that Nodes
     is two levels deep inside Settings, this is the "still discoverable
     without opening Settings" surface the issue asks for, mirroring the
     old sidebar Nodes row's dot (size/color; issue #568 removed that row
     along with its own `.destination-badge-dot` class). */
  .account-avatar-alert {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--radius-full);
    background: var(--color-warning);
    border: 1.5px solid var(--color-surface);
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
  .sidebar.collapsed .destination-badge {
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

  /* A real three-column grid (v8 D1-1, issue #710), not the old two-zone
     `space-between` flex: the centre column is `auto`-sized to whatever it
     holds (nothing when it's empty), and the two `1fr` flanks are FORCED to
     equal width by the grid algorithm — that equality is what keeps the
     centre column's midpoint pinned to the topbar's own midpoint no matter
     how long the left zone's project path/title gets, or how many icons
     the right zone carries. A middle child bolted onto `space-between`
     drifts the instant the two sides' content differs in width, which they
     never reliably do once `.topbar-actions` carries even one button — the
     exact failure D1-1's own trade sentence names. */
  .topbar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--space-md);
    height: var(--topbar-height);
    flex-shrink: 0;
    padding: 0 var(--space-lg);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .topbar-context {
    grid-column: 1;
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    min-width: 0;
  }

  /* An `<h1>` now (see the markup comment), so the global heading rule's
     display sizing and margins have to be reset here - the topbar's title is
     chrome-sized by design and must not grow just because its element became
     semantic. */
  .topbar-title {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body-size);
    line-height: var(--text-body-line);
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
    color: var(--color-text-muted);
  }

  /* The grid's own centre column (`grid-column: 2`, `auto`-sized) — see
     `.topbar`'s own doc comment for why that, not a flex child, is what
     keeps this centred on the window rather than on whatever's left over
     between the other two zones. `justify-self: center` matters only if a
     future caller widens this column past its own content; harmless
     today, since `auto` already sizes it exactly to its two buttons. */
  .topbar-switch {
    grid-column: 2;
    justify-self: center;
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  /* `Button`'s own scope hides `.topbar-view-choice`/`.selected` from this
     file's hash — reach in with `:global()`, the same pattern `ConfigBar`'s
     `.mode-choice` and the right sidebar's `.right-sidebar-tab` already
     use for their own segmented controls. */
  :global(.topbar-view-choice) {
    color: var(--color-text-secondary);
    border-radius: 0;
  }

  :global(.topbar-view-choice:hover) {
    text-decoration: none;
    background: var(--color-fill-subtle);
  }

  :global(.topbar-view-choice.selected) {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .topbar-actions {
    grid-column: 3;
    justify-self: end;
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    flex-shrink: 0;
  }

  /* `ghost` underlines its label on hover, which reads as a text link and
     not what a lone toggle button of chrome should look like — killed the
     same way `.palette-trigger` (below) already kills it for its own
     equivalent lone ghost button. `Button`'s own `aria-pressed` treatment
     (accent-subtle fill + accent border) already carries the open state,
     so nothing else is declared here. */
  :global(.workbench-toggle:hover) {
    text-decoration: none;
  }
  :global(.palette-trigger:hover) {
    text-decoration: none;
  }

  /* The word beside each glyph. Hidden below the width where the topbar can
     hold it without crowding the session title — the accessible name and the
     tooltip are props on the button itself, so nothing is lost from the
     accessibility tree when the pixels go (see the markup). Spacing lives on
     the word, not as a `gap` on `Button`'s label: `PermissionCard`'s
     shortcut-plus-name buttons already space themselves that way, and a gap
     on the shared primitive would double theirs. */
  .panel-word {
    display: none;
    margin-left: var(--space-2xs);
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

  /* Everything below the transcript - the live plan, queued prompts, the
     permission bar, the toolbar and the composer - is one docked strip.
     A1-3 (issue #666, v7 §1) removes the hairline that used to draw this
     strip's top edge: the composer field is the only surface in this app
     deliberately allowed to look raised (its own border + soft shadow —
     see `.composer-field` below), and a flat rule sitting directly above
     that shadow read as two competing separators once the shadow existed.
     `padding-top` alone now carries the grouping the hairline used to. */
  .canvas-footer {
    width: 100%;
    max-width: var(--measure);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    flex-shrink: 0;
    padding-top: var(--space-sm);
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  /* v6 reverses the "no chrome" reading of v5 §0.4, not the intent (design
     spec §3.5; issue #577): a docked field still ends the timeline aligned to
     the same gutter, but it is now unmistakably an input rather than plain
     text run against the page background. Border, surface, radius and
     padding live on `.composer-field` below, not here — A1-3 (issue #666)
     removed the last hairline this strip ever drew (`.canvas-footer`'s old
     `border-top`, above), so the field's own border + shadow is now the
     ONLY boundary anywhere in the strip, drawn once, by the one surface
     that's allowed to look raised. */
  .composer-row {
    display: flex;
    align-items: flex-start;
  }

  /* Deliberately NO `gap`: this row's 7.6px of space between the role word and
     the field is the gutter's own `padding-right` below, exactly as it is on
     every transcript row. A `gap: var(--space-sm)` here added that space a
     SECOND time, outside the 4.75rem column, so at 1440px the textarea began
     at x=493.8 while the prose above it began at 486.2 — the one column the
     whole timeline is built on, off by 7.6px on the row you type into.
     `cockpit-shell.spec.ts` measures the two against each other now. */

  /* Mirrors `MessageItem`'s `.gutter`: same token, same right alignment, same
     inner padding, so the column runs unbroken from the last turn into the
     one you are typing. It used to claim "same centring" while actually
     being `align-items: center` against the transcript's `flex-end`, which
     put YOU on a different vertical line from every CLAUDE above it —
     `cockpit-shell.spec.ts` measures the gutter boxes against each other
     now, not a role word's bounding box (neither one exists to measure
     anymore).

     v7 §2's amended B1-2/B2-4 (2026-08-04 decisions, issue #667) drop every
     gutter role mark app-wide, including the inset accent bar this rule
     used to carry for "your turn" — role is told by surface alone now (the
     field's own raised `--color-surface-raised` box already says "you" the
     same way a real `user` transcript row's tinted fill does), so this
     gutter is inert chrome: pure alignment space, nothing painted in it.
     `min-height` stays anyway, matching `MessageItem`'s own copy of this
     rule, so an empty gutter never collapses the row's height out from
     under the textarea beside it. */
  .composer-gutter {
    flex: 0 0 var(--gutter);
    width: var(--gutter);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3xs);
    padding-top: var(--space-3xs);
    padding-right: var(--space-sm);
    min-height: var(--text-body-line);
  }

  /* Below `--bp-mobile` the transcript's role column collapses and every
     row's mark moves above its content (see `MessageItem`'s own copy of
     that block for the measurement and rationale). The composer — and the
     turn-progress line below it, A3-2 — are the last rows of that same
     timeline, so both collapse the same way: leaving either one beside its
     content would keep the one indent the whole change exists to remove,
     on the row where the phone's width matters most. */
  @media (max-width: 479px) {
    .composer-row,
    .turn-progress {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-3xs);
    }

    .composer-gutter {
      flex: 0 0 auto;
      width: auto;
      min-height: 0;
      align-items: flex-start;
      padding-right: 0;
    }
  }

  /* `ui/TextArea` is the shared vocabulary this reuses (border, `--radius-md`,
     `--color-surface-raised`, focus-ring token) but not the component
     itself: the composer needs a raw `bind:this` element ref for imperative
     auto-grow (`handleComposerInput` below writes `style.height` directly),
     custom Enter-to-send/Shift+Enter-newline keydown handling, and a footer
     controls row (attach, pickers, Send) sharing this same bordered box —
     none of which `ui/TextArea` exposes a seam for. Hand-rolled on the same
     tokens rather than forking the primitive's API for one call site.

     A1-3 (issue #666, v7 §1): the field is the one surface in the whole app
     deliberately allowed to look raised. Every hairline that used to sit
     above it in this strip is gone (`.canvas-footer`'s old `border-top`) —
     the border below plus a new `--shadow-md` are now the field's own,
     ONLY boundary, in both themes. `--shadow-md` on purpose, not
     `--shadow-lg`: soft enough to read as "floating a little," not
     modal-weight elevation. Composer stays the only caller of this exact
     pairing — don't spread it to another surface just because it's
     available; the rest of the app staying flat is what makes this one
     lifted control read as deliberate. */
  .composer-field {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-md);
    transition: border-color var(--duration-fast) var(--ease-beat);
  }

  .composer-field:hover {
    border-color: var(--color-border-strong);
  }

  /* The same focus-ring token every other input primitive uses (`ui/TextArea`,
     `ui/Input`), on the field's own border box rather than the textarea:
     `:focus-within` so the ring stays lit while the textarea, the attach
     button or a picker inside this same strip holds focus, not just while
     the caret sits in the text itself. This is C2/§3.5 (issue #577): at-rest
     and focused used to be byte-identical, nothing here ever drew a ring. */
  .composer-field:focus-within {
    border-color: var(--color-border-strong);
    outline: var(--focus-ring-width) solid var(--color-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .composer-field textarea {
    width: 100%;
    max-height: 40vh;
    resize: none;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: var(--text-body-line);
    padding: 0;
  }

  .composer-field textarea::placeholder {
    color: var(--color-text-muted);
  }

  /* The textarea itself stays borderless and transparent on purpose: its
     surface is the `.composer-field` box above, and a second nested border
     here would double the chrome. Native focus outline suppressed for the
     same reason — the ring lives on `.composer-field:focus-within` above,
     not on this element. */
  .composer-field textarea:focus,
  .composer-field textarea:focus-visible {
    outline: none;
  }

  /* The one strip the composer has: attach, the pickers, the context/cost
     figures, then the send controls. `align-items: center` rather than the
     row's `flex-start` because these are controls of one height, not text
     that has to share a baseline with the gutter. */
  .composer-controls {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  /* `margin-left: auto` so Send hugs the right edge on whichever line it lands:
     beside the figures on a desktop, on its own wrapped line on a phone. */
  .composer-actions {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-shrink: 0;
    margin-left: auto;
  }

  .composer-hint {
    margin: 0;
  }

  /* A3-2 (issue #666): the turn's own live line — see `turnProgressVisible`'s
     doc comment (script section) and the markup comment above `.canvas-footer`
     for what this replaces and when it shows. `.composer-gutter` (reused,
     not duplicated) keeps it on the exact same alignment column as every
     other row in this strip; `align-items: center` here (not the gutter
     row's own `flex-start`) because a one-line status reads as one baseline,
     not text sharing a column with a taller sibling. */
  .turn-progress {
    display: flex;
    align-items: center;
  }

  .turn-progress-content {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    color: var(--color-text-muted);
    font-size: var(--text-small-size);
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
  /* Right sidebar                                                      */
  /* ------------------------------------------------------------------ */

  /* Sheet mode's backdrop only (design spec §3.3, issue #571) — `Overlay`
     never mounts at all in docked mode (no scrim, design spec §0.6 "a
     workbench panel never dims the app"), so this hook only ever matters
     below `--bp-desktop`. Same reasoning the old Drawer's identical rule
     carried: a full-viewport backdrop would cover the topbar's own toggle,
     the one control that opens/closes this panel, which would then close
     it on the very click meant to reach the control past it. Set through
     `Overlay`'s own `--overlay-top` hook rather than a `:global` override,
     which its scoped rule outranks (see that component's comment). */
  :global(.right-sidebar-backdrop) {
    --overlay-top: var(--topbar-height);
  }

  /* Docked default (design spec §3.3, issue #571): a flex sibling of
     `.workspace` inside `.shell`, not a `position: fixed` overlay — no
     scrim, and `flex-shrink: 0` plus the JS-set inline `width` (see the
     markup) is what pushes the canvas rather than covering it. This is the
     OPPOSITE default from the old Drawer, which was `position: fixed` and
     only became this on the rare pinned+wide combination. Below
     `--bp-desktop` (1024px) this flips to a dismissible sheet instead — a
     side sheet at 768-1023px, a bottom sheet under 768px (the two `@media`
     overrides further down). */
  .right-sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    background: var(--color-surface);
    border-left: 1px solid var(--color-border);
    transition: width var(--duration-base) var(--ease-shuttle);
  }

  .right-sidebar.resizing {
    transition: none;
  }

  /* One bordered object with a selected segment — the same segmented idiom
     `ConfigBar`'s own mode `radiogroup` uses (border/radius/overflow on the
     group, `Button`'s `ghost` for each choice, reached into with `:global`
     for the same reason that one is). Lives in the panel's own header now,
     not the topbar: it switches WHICH workbench panel shows, a different
     choice from the topbar toggle's WHETHER it shows at all. */
  .right-sidebar-tabs {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    margin: var(--space-2xs) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  :global(.right-sidebar-tab) {
    flex: 1;
    color: var(--color-text-secondary);
    border-radius: 0;
  }

  :global(.right-sidebar-tab:hover) {
    text-decoration: none;
    background: var(--color-fill-subtle);
  }

  :global(.right-sidebar-tab.selected) {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .right-sidebar-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-md);
  }

  .right-sidebar-panel-inner {
    height: 100%;
  }

  /* The WAI-ARIA APG "Window Splitter" pattern, same as `.sidebar-resize-handle`
     — a docked-mode-only affordance (the markup gates its own mount on
     `!rightSidebarSheetViewport`), so no `@media` hides it here the way the
     left sidebar's own handle needs. Sits on the LEFT edge (the sidebar's
     own, since dragging left grows a right-anchored panel), the mirror image
     of `.sidebar-resize-handle`'s `right: -3px`. */
  .right-sidebar-resize-handle {
    position: absolute;
    top: 0;
    left: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    background: transparent;
    z-index: var(--z-raised);
  }

  .right-sidebar-resize-handle:hover,
  .right-sidebar-resize-handle:focus-visible {
    background: var(--color-accent-subtle);
    outline: none;
  }

  /* The terminal dock (design spec §3.1/§3.2/§3.3, issue #572): built on
     the shared `DockPanel` behaviour (issue #570), same as the left and
     right sidebars — collapse (to nothing, `collapsedSize: 0`, same as
     the right sidebar), drag-resize, persistence, no second hand-written
     copy. A flex sibling of `.shell` inside `main.cockpit` (both direct
     children of that flex COLUMN), not nested inside `.shell` itself: the
     design spec §3.1 diagram draws this dock under ALL three columns
     (left sidebar, canvas, right sidebar), not just under the canvas, so
     it needs to sit outside the flex ROW those three share. Docked
     (pushes the canvas up, no scrim — design spec §0.6) at/above
     `--bp-desktop`; a dismissible bottom sheet below that (the
     `@media (max-width: 1023px)` block further down, alongside the right
     sidebar's own). Stays mounted at all times once a session's terminal
     has ever been opened (`terminalOpenedSessionIds`) — `height`/
     `transform` show or hide it, nothing ever unmounts
     `InteractiveTerminal` on a collapse (issue #572's own acceptance
     line: "collapsing and reopening... does not lose scrollback or kill
     the PTY"). */
  /* D2-2 (design spec §4, issue #669): sits on `--color-rail` — one shade
     off the canvas's own `--color-bg` — so the seam against the canvas is
     a colour step, not a hairline (see `.terminal-dock.terminal-dock-open`
     below for the border removal this pairs with). `--color-rail` is the
     same token the sessions sidebar already uses for the identical "shell
     surface, distinct from the canvas" role. */
  .terminal-dock {
    position: relative;
    flex-shrink: 0;
    /* A flex item's own `min-height: auto` default would otherwise
       override the `height: 0px` this wrapper's inline `style` sets while
       closed (`terminalDock.effectiveSize` is `collapsedSize`, `0`) with
       its CHILDREN's min-content size instead — the exact "collapsing
       does nothing" bug the drag-resize and mobile-sheet e2e specs caught
       (issue #572). */
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-rail);
    transition: height var(--duration-base) var(--ease-shuttle);
  }

  /* `padding` lives here, not on `.terminal-dock` itself: with
     `box-sizing: border-box` (`typography.css`), padding a `height: 0`
     box can't shrink INTO still forces a rendered floor of that padding
     (a content box can't go negative) — a few visible pixels of "closed"
     chrome that broke `height: 0` as a real "gone" signal, exactly what
     the drag-resize/mobile-sheet e2e specs caught as "collapsing does
     nothing" (issue #572). Scoping it to `.terminal-dock-open` makes the
     CLOSED box genuinely `0×width`, no chrome left over.

     No `border-top` here (D2-2, issue #669): the hairline between the
     canvas and this dock is gone on purpose — `.terminal-dock`'s own
     `--color-rail` background above is the seam now, a colour step
     against the canvas's `--color-bg` rather than a line. With no line,
     `.terminal-dock-resize-handle` below is the ONLY proof this edge is
     resizable, which is why that rule keeps its hover/focus-visible
     highlight — removing the border must never mean the handle goes
     invisible too.

     The class is `terminal-dock-open`, not the shorter `open` a first
     draft used: `AttentionInbox.svelte` already owns a GLOBAL (unscoped)
     `:global(.open)` rule for its own menu, and Svelte's `class:` scoping
     does not protect against an unrelated component's `:global()` rule
     matching the same bare class name — it silently applied THAT rule's
     `align-items: flex-start` here too, which broke `align-items: stretch`
     (the flex default this wrapper's width relies on) and fed a real
     shrink-to-nothing loop through `FitAddon.fit()` (each `fit()` measured
     an already-narrower `.xterm-container`, `resize()`d narrower still,
     which is what the drag/reflow e2e spec caught as cols collapsing
     during a purely vertical drag). Prefixed and unique now, the way this
     file's OTHER dock classes (`sheet-open`, `resizing`) already are. */
  .terminal-dock.terminal-dock-open {
    padding: var(--space-2xs);
  }

  .terminal-dock.resizing {
    transition: none;
  }

  /* `InteractiveTerminal`'s own root is `height: 100%` (no `min-height` of
     its own) — it fills whatever this wrapper gives it, tall-narrow or
     wide-short alike, so no override is needed here beyond `flex: 1` to
     claim the space `.terminal-dock-resize-handle` doesn't. */
  .terminal-dock :global(.interactive-terminal) {
    flex: 1;
    min-height: 0;
  }

  /* The WAI-ARIA APG "Window Splitter" pattern, same exception to the
     noninteractive-role rule `.right-sidebar-resize-handle` already
     takes. Sits on the dock's own TOP edge (dragging it up grows a
     bottom-anchored panel — `DockPanel`'s own `axisPos` already flips the
     sign for a `bottom` edge, this is just where the handle sits
     visually), the same "mirror image" relationship
     `.right-sidebar-resize-handle`'s `left: -3px` has to
     `.sidebar-resize-handle`'s `right: -3px`. Drag-resize is a
     docked-mode-only affordance (the markup gates its own mount on
     `!terminalDockSheetViewport`, same as the right sidebar's handle), so
     no `@media` needs to hide it separately. */
  .terminal-dock-resize-handle {
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: row-resize;
    background: transparent;
    z-index: var(--z-raised);
  }

  .terminal-dock-resize-handle:hover,
  .terminal-dock-resize-handle:focus-visible {
    background: var(--color-accent-subtle);
    outline: none;
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
      height: var(--tabbar-height);
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

    /* Too narrow for three zones (v8 D1-1, issue #710) — the defined
       narrow-window answer: the switch drops out of the topbar entirely
       rather than let the centre column steal width from the truncating
       left zone or the rigid right one. It does not need a full-width bar
       of its own down here, because it is not this width's only route:
       the sidebar/tabbar split already happens at this exact breakpoint
       (`.tabbar` above), and the sidebar's own `destination-tracker` row
       (demoted, not deleted — see that row's own doc comment) is already
       primary navigation below `--bp-desktop`, session-scoped or not. */
    .topbar-switch {
      display: none;
    }

    .shell {
      padding-bottom: var(--tabbar-height);
    }

    .sidebar {
      position: fixed;
      top: 0;
      bottom: var(--tabbar-height);
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
      bottom: var(--tabbar-height);
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

    /* Design spec §3.3, issue #571: below `--bp-desktop` the right sidebar
       is a dismissible side sheet instead of a docked column — the exact
       geometry the old Drawer defaulted to everywhere, narrowed now to just
       this range. Drag-resize is docked-only (the markup itself never
       mounts `.right-sidebar-resize-handle` here), so no companion
       `display: none` is needed the way `.sidebar-resize-handle` above
       needs one. */
    .right-sidebar {
      position: fixed;
      top: var(--topbar-height);
      right: 0;
      bottom: 0;
      width: min(26rem, 90vw);
      box-shadow: var(--shadow-lg);
      z-index: var(--z-overlay);
    }

    /* Design spec §3.3, issue #572: below `--bp-desktop` the terminal
       dock is a dismissible BOTTOM sheet at every width in this block
       (768-1023px AND, via the next media query's own narrower rules,
       below 768px too) — unlike the right sidebar, which is a SIDE sheet
       in this range and only becomes a bottom sheet below 768px, the
       design spec's own responsive table (§3.3) gives the terminal dock
       "bottom sheet" for both rows, so one `@media` block covers both
       instead of splitting it the way `.right-sidebar` above needs to.
       Reuses the sessions sidebar's own mechanism (`.sidebar`/
       `.sidebar-backdrop`: always mounted, `transform` slides it
       off/on-screen, a manually-conditioned backdrop button) rather than
       `Overlay`'s conditional-mount one (`.right-sidebar`'s own, above):
       `Overlay` unmounts its children on close, which is exactly what
       this dock must never do to `InteractiveTerminal` (see
       `.terminal-dock`'s own doc comment above) — this is the "reconcile
       it with the existing mobile sheet" issue #572 asks for, choosing
       the ALREADY-EXISTING mechanism that fits rather than inventing a
       third one. */
    .terminal-dock {
      position: fixed;
      left: 0;
      right: 0;
      bottom: var(--tabbar-height);
      z-index: var(--z-sticky);
      height: min(60vh, 32rem) !important;
      /* A dismissible overlay sheet is the `floating` elevation tier
         (same tier `Dialog`/`Card`'s own `elevation="floating"` use) —
         `box-shadow`, not the D2-2 `--color-rail` colour-step alone,
         separates it from the page behind it here, since this variant
         sits ABOVE page content rather than beside it inline. */
      box-shadow: var(--shadow-lg);
      /* `100%` alone (the pattern `.sidebar`'s own `translateX(-100%)`
         uses) only clears an edge that sits FLUSH with the viewport — this
         box's resting `bottom` is already inset by `--tabbar-height`
         (56px) to leave room for the tab bar, so sliding down by exactly
         its own height still leaves that 56px sliver on screen (measured:
         a viewport-390×844 spec caught the sessions sheet's own toggle
         failing to fully hide this dock after closing it). The extra
         `+ var(--tabbar-height)` clears that gap too. */
      transform: translateY(calc(100% + var(--tabbar-height)));
      transition: transform var(--duration-base) var(--ease-shuttle);
    }

    .terminal-dock.sheet-open {
      transform: translateY(0);
    }

    /* `top: var(--topbar-height)`, not `0`: this dock's own toggle lives
       IN the topbar (unlike the sessions sidebar's, which lives in the
       tabbar, already elevated above `.sidebar-backdrop` by z-index) — a
       full-height backdrop would cover the very control that opens/closes
       it, and any other topbar control (`workbench-toggle`) besides.
       `.right-sidebar-backdrop` already fixed this exact bug once, via
       `Overlay`'s own `--overlay-top` hook (see that rule's own doc
       comment above); this backdrop is hand-rolled, not `Overlay`, so it
       gets the same inset directly rather than through that hook. */
    .terminal-dock-backdrop {
      display: block;
      position: fixed;
      top: var(--topbar-height);
      left: 0;
      right: 0;
      bottom: var(--tabbar-height);
      z-index: calc(var(--z-sticky) - 1);
      border: none;
      background: var(--color-overlay);
      cursor: default;
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

    .right-sidebar {
      top: auto;
      left: 0;
      right: 0;
      bottom: var(--tabbar-height);
      width: 100%;
      height: 60vh;
      border-left: none;
      border-top: 1px solid var(--color-border-strong);
    }
  }

  /* At `--bp-wide` (1280px) and above the topbar's own controls say their
     names. That threshold is measured, not guessed: at 1280px the whole
     right-hand cluster with every word visible is 344px of a 992px topbar,
     so the session title and its breadcrumb still get two thirds of the
     row. Below it the words would be competing with the title for a much
     narrower row, so the cluster falls back to its icon-only form. */
  @media (min-width: 1280px) {
    .panel-word {
      display: inline;
    }
  }

  /* The fork-from-turn action's refusal reason (design spec
     `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746) — a
     lightweight inline banner above the transcript, the same
     `--color-danger` token every other inline error in this file uses,
     no dialog needed for a single-line, dismiss-by-retrying message. */
  .fork-error {
    margin: 0 0 var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm);
    background: var(--color-danger-subtle);
    color: var(--color-danger);
    font-size: 0.875rem;
  }
</style>
