<script lang="ts">
  /**
   * The user-editable keymap settings surface (Zed-parity F3-3, issue #760,
   * building on the action registry (#758) and the default binding set
   * (#759)). Lives in `SettingsPage`'s "Keyboard" section — desktop/wide
   * viewports only, per this module's own mobile answer below.
   *
   * **Every row reads the live registry**, exactly like `CanvasZeroState`'s
   * own "the bindings that matter" panel: `actionRegistry` in declaration
   * order, each row's chord resolved through `effectiveShortcut(action,
   * context, keymap)` — the same function the palette and the keyboard
   * dispatcher both read, so this panel can never show a binding that
   * disagrees with what actually fires.
   *
   * **Recording a chord.** Clicking "Change" arms a single `window`
   * keydown listener (`svelte:window`, this component's own, never a
   * second ad hoc one); the next keydown that holds Mod (Cmd/Ctrl) builds
   * this app's canonical `Mod+[Shift+][Alt+]<Key>` string
   * ({@link chordFromEvent}) and is validated against the live registry
   * ({@link validateKeymapCandidate}, `$lib/keymap.ts`) before ever
   * reaching {@link KeymapClient.setKeymap}. An invalid or conflicting
   * candidate is rejected right here, by name, in {@link saveError} — the
   * previous keymap is never touched, since `setKeymap` is simply never
   * called for a candidate that fails validation (issue #760's own
   * acceptance line).
   *
   * **The two questions issue #760 says must be answered, not glossed:**
   *
   * 1. **The phone.** This panel is never rendered on a narrow viewport at
   *    all — `SettingsPage.svelte` excludes "Keyboard" from its section
   *    list there (`viewport.ts`'s `isNarrowViewport`), since recording a
   *    chord has nothing to attach to with no physical keyboard to press.
   *    Not a read-only fallback: there is nothing this panel would show
   *    that the palette doesn't already show on every viewport.
   * 2. **Per-device availability.** No per-device field exists on the
   *    keymap itself — every row's "Unavailable here" badge is a RUNTIME
   *    read ({@link isChordUnavailableHere}, `$lib/keymap.ts`) for the
   *    CURRENT browser/environment only. A binding reserved here but free
   *    on another device still saves and still shows as bound there — see
   *    `$lib/keymap.ts`'s own top doc comment for the full reasoning.
   */
  import type { KeymapV1 } from '@loombox/protocol';
  import {
    actionRegistry,
    effectiveShortcut,
    isDesktopShell,
    isMacPlatform,
    type ActionContext,
  } from '$lib/action-registry';
  import { isChordUnavailableHere, validateKeymapCandidate } from '$lib/keymap';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import ErrorNotice from './ui/ErrorNotice.svelte';

  /** The one call this panel needs off `RelayClient` — see `PermissionPolicyPanel`'s own DI note for why a narrowed interface, not the real class, is what a component declares. */
  export interface KeymapClient {
    setKeymap(candidate: KeymapV1): Promise<KeymapV1>;
  }

  interface Props {
    /** `undefined` before `+page.svelte`'s `RelayClient` exists — mirrors `ConnectedAccountsSection`'s own "gate the whole section on prerequisite readiness" pattern. */
    client?: KeymapClient;
    /** `RelayClient.keymap`'s live value — `{}` (nothing remapped) until the first `keymap_result` lands, same "always the current full state, no delta" contract every other synced-state prop in this app already follows. */
    keymap: KeymapV1;
  }

  const { client, keymap }: Props = $props();

  /**
   * `isDesktopShell()`/`isMacPlatform()` computed once per component
   * instance, same "plain function call, not a store" choice `+page.svelte`
   * itself makes for `actionContext.desktopShell`/`macPlatform` — see
   * `keyboard.ts`'s own doc comments on those two functions.
   */
  const environment: Pick<ActionContext, 'desktopShell' | 'macPlatform'> = {
    desktopShell: isDesktopShell(),
    macPlatform: isMacPlatform(),
  };

  /**
   * A neutral `ActionContext` — every field this panel doesn't otherwise
   * care about (`turnActive`, `sessionCount`, …) fixed to a value that
   * never gates a shortcut off, since this panel deliberately shows every
   * registered action's binding, not just the ones live in whatever
   * session happens to be open right now (mirrors `CanvasZeroState`'s own
   * "deliberately NOT filtered by live isAvailable" choice).
   */
  const context: ActionContext = {
    turnActive: false,
    sessionCount: 2,
    sessionSelected: true,
    hasProjects: true,
    hasConfigOptions: true,
    ...environment,
  };

  let recordingActionId = $state<string | undefined>(undefined);
  let saving = $state(false);
  let saveError = $state<string | undefined>(undefined);

  /** The reverse of `keyboard.ts`'s own letter/digit/punctuation `code` mapping — an Alt-held chord has to read the physical key (`event.code`), never `event.key` (macOS remaps `Option+<letter>` to a different character), exactly for the reason `matchesShortcut`'s own doc comment gives. */
  function keyNameFromCode(code: string): string | undefined {
    if (code.startsWith('Key') && code.length === 4) return code.slice(3);
    if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
    if (code === 'ArrowRight') return 'Right';
    if (code === 'ArrowLeft') return 'Left';
    if (code === 'ArrowUp') return 'Up';
    if (code === 'ArrowDown') return 'Down';
    if (code === 'Period') return '.';
    if (code === 'Comma') return ',';
    if (code === 'BracketLeft') return '[';
    if (code === 'BracketRight') return ']';
    return undefined;
  }

  /** The no-Alt case: `event.key` is trustworthy (no Option remap in play), so this reads it directly rather than going through `code`. */
  function keyNameFromKey(key: string): string | undefined {
    if (key === 'ArrowRight') return 'Right';
    if (key === 'ArrowLeft') return 'Left';
    if (key === 'ArrowUp') return 'Up';
    if (key === 'ArrowDown') return 'Down';
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
    if (/^[0-9]$/.test(key)) return key;
    if (key === '.' || key === ',' || key === '[' || key === ']') return key;
    return undefined;
  }

  /** Builds this app's canonical `Mod+[Shift+][Alt+]<Key>` chord string from a real keydown, or `undefined` for a keypress that can't become one (no Mod held, or a key name `keyboard.ts` has no mapping for) — the caller keeps listening rather than treating `undefined` as an error, since most keys pressed while "recording" are never meant to end the recording (a bare letter typed by habit, a stray Shift-only tap). */
  function chordFromEvent(event: KeyboardEvent): string | undefined {
    if (!event.metaKey && !event.ctrlKey) return undefined;
    const keyName = event.altKey ? keyNameFromCode(event.code) : keyNameFromKey(event.key);
    if (!keyName) return undefined;
    const shift = event.shiftKey ? 'Shift+' : '';
    const alt = event.altKey ? 'Alt+' : '';
    return `Mod+${shift}${alt}${keyName}`;
  }

  function startRecording(actionId: string): void {
    saveError = undefined;
    recordingActionId = actionId;
  }

  function cancelRecording(): void {
    recordingActionId = undefined;
  }

  /** Validates `candidate` against the live registry, sends it only if valid, and always clears `recordingActionId` — an invalid/conflicting candidate is rejected by name in {@link saveError} and `setKeymap` is never called for it, so the previously-saved keymap (still reflected in the `keymap` prop) keeps working untouched. */
  async function applyCandidate(candidate: KeymapV1): Promise<void> {
    const result = validateKeymapCandidate(candidate);
    if (!result.ok) {
      saveError = result.error;
      recordingActionId = undefined;
      return;
    }
    if (!client) {
      saveError = 'Not connected — try again once signed in.';
      recordingActionId = undefined;
      return;
    }
    saving = true;
    try {
      await client.setKeymap(candidate);
      saveError = undefined;
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
      recordingActionId = undefined;
    }
  }

  function handleRecordKeydown(event: KeyboardEvent): void {
    if (!recordingActionId) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      cancelRecording();
      return;
    }
    const chord = chordFromEvent(event);
    if (!chord) return;
    const actionId = recordingActionId;
    void applyCandidate({ ...keymap, [actionId]: chord });
  }

  function resetToDefault(actionId: string): void {
    saveError = undefined;
    const { [actionId]: _dropped, ...rest } = keymap;
    void applyCandidate(rest);
  }
</script>

<svelte:window onkeydown={handleRecordKeydown} />

<div class="keymap-panel" data-testid="keymap-panel">
  {#if saveError}
    <ErrorNotice message={saveError} class="keymap-panel-error" />
  {/if}
  <Card elevation="raised" padding="md" class="keymap-panel-list">
    {#each actionRegistry as action (action.id)}
      {@const shortcut = effectiveShortcut(action, context, keymap)}
      {@const isRemapped = keymap[action.id] !== undefined}
      {@const unavailable = shortcut !== undefined && isChordUnavailableHere(shortcut, environment)}
      <div class="keymap-row" data-testid="keymap-row-{action.id}">
        <span class="keymap-row-label">{action.label}</span>
        <span class="keymap-row-chord">
          {#if recordingActionId === action.id}
            <span class="keymap-row-recording" data-testid="keymap-row-recording">
              Press a shortcut… (Esc to cancel)
            </span>
          {:else if shortcut}
            <code>{shortcut}</code>
            {#if unavailable}
              <Badge tone="warning" size="sm" dataTestId="keymap-row-unavailable-{action.id}">
                Unavailable here
              </Badge>
            {/if}
          {:else}
            <span class="keymap-row-unbound">Not bound</span>
          {/if}
        </span>
        <span class="keymap-row-actions">
          {#if recordingActionId === action.id}
            <Button
              variant="ghost"
              size="sm"
              onclick={cancelRecording}
              dataTestId="keymap-row-cancel-{action.id}"
            >
              Cancel
            </Button>
          {:else}
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onclick={() => startRecording(action.id)}
              dataTestId="keymap-row-change-{action.id}"
            >
              Change
            </Button>
            {#if isRemapped}
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onclick={() => resetToDefault(action.id)}
                dataTestId="keymap-row-reset-{action.id}"
              >
                Reset
              </Button>
            {/if}
          {/if}
        </span>
      </div>
    {/each}
  </Card>
</div>

<style>
  .keymap-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  :global(.keymap-panel-list) {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  .keymap-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: var(--space-md);
    padding: var(--space-2xs) 0;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .keymap-row:last-child {
    border-bottom: none;
  }

  .keymap-row-label {
    color: var(--color-text-primary);
  }

  .keymap-row-chord {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    justify-self: end;
    font-family: var(--font-mono);
    color: var(--color-text-secondary);
  }

  .keymap-row-unbound {
    color: var(--color-text-muted);
    font-family: inherit;
  }

  .keymap-row-recording {
    color: var(--color-accent);
  }

  .keymap-row-actions {
    display: flex;
    gap: var(--space-2xs);
  }
</style>
