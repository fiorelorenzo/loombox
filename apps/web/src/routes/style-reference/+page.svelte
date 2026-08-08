<script lang="ts">
  /**
   * The living style-reference route (issues #195/#196 acceptance: "A
   * living style-reference route in apps/web renders token swatches so
   * future UI work can check against it" / "The style-reference page
   * demonstrates both faces at representative weights/sizes"). Not linked
   * from the main cockpit shell — reached directly at `/style-reference` —
   * since it's a tool for whoever is building UI, not part of the product
   * itself.
   *
   * Every value on this page is read live off the CSS custom properties in
   * `$lib/styles/tokens.css`/`typography.css`, not hardcoded here: retuning
   * the palette in that one file is all it takes for this page to reflect
   * the change, which is the entire point of the token system.
   */
  import { onMount } from 'svelte';
  import { themeStore, type ThemePreference } from '$lib/theme';
  import WovenLoader from '$lib/components/WovenLoader.svelte';
  import Icon from '$lib/components/icons/Icon.svelte';
  // Warp Deck shared UI primitives (redesign brief §4, issue #428) — see
  // the "Components" section appended at the end of this file's markup.
  import Badge from '$lib/components/ui/Badge.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import ErrorNotice from '$lib/components/ui/ErrorNotice.svelte';
  import Row from '$lib/components/ui/Row.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';

  const neutralSwatches = [
    { name: '--color-bg', label: 'Background' },
    { name: '--color-surface', label: 'Surface' },
    { name: '--color-surface-raised', label: 'Surface raised' },
    { name: '--color-rail', label: 'Rail / sidebar' },
  ];

  const fillBorderSwatches = [
    { name: '--color-fill-subtle', label: 'Fill subtle' },
    { name: '--color-fill', label: 'Fill' },
    { name: '--color-border-subtle', label: 'Border subtle' },
    { name: '--color-border', label: 'Border' },
    { name: '--color-border-strong', label: 'Border strong' },
  ];

  const textSwatches = [
    { name: '--color-text-primary', label: 'Text primary' },
    { name: '--color-text-secondary', label: 'Text secondary' },
    { name: '--color-text-muted', label: 'Text muted' },
  ];

  const accentSwatches = [
    { name: '--color-accent', label: 'Accent ("thread")' },
    { name: '--color-accent-hover', label: 'Accent hover' },
    { name: '--color-accent-active', label: 'Accent active' },
    { name: '--color-accent-subtle', label: 'Accent subtle' },
  ];

  const statusSwatches = [
    { name: '--color-success', subtle: '--color-success-subtle', label: 'Success' },
    { name: '--color-warning', subtle: '--color-warning-subtle', label: 'Warning' },
    { name: '--color-danger', subtle: '--color-danger-subtle', label: 'Danger' },
    { name: '--color-info', subtle: '--color-info-subtle', label: 'Info' },
  ];

  const spacingSwatches = [
    '--space-3xs',
    '--space-2xs',
    '--space-xs',
    '--space-sm',
    '--space-md',
    '--space-lg',
    '--space-xl',
    '--space-2xl',
    '--space-3xl',
  ];

  const radiusSwatches = [
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--radius-full',
  ];

  // Issue #580 — the design-system audit's icon-size/dialog-geometry/
  // one-off-dimension stragglers.
  const iconSizeSwatches = [
    { token: '--icon-size-sm', label: 'sm — disclosure chevrons, compact tab icons' },
    { token: '--icon-size-md', label: 'md — a slightly heavier inline mark' },
    { token: '--icon-size-lg', label: 'lg — a standalone icon box' },
  ];

  const dialogGeometrySwatches = [
    { token: '--dialog-width-sm', label: 'width sm — plain list pickers' },
    { token: '--dialog-width-md', label: 'width md — CommandPalette (wider rows)' },
  ];

  const dimensionSwatches = [
    { token: '--status-meter-track-width', label: 'StatusBar meter track width' },
    { token: '--status-meter-track-height', label: 'StatusBar meter track height' },
    { token: '--attachment-thumb-size', label: 'AttachmentBar preview thumbnail' },
    { token: '--attachment-chip-max-width', label: 'AttachmentBar chip max-width' },
    { token: '--diff-gutter-width', label: 'DiffViewer line-number column' },
    { token: '--diff-marker-width', label: 'DiffViewer +/- marker column' },
    {
      token: '--scroll-cap-height',
      label: 'Collapsible scroll cap (DirectoryPicker, MessageItem)',
    },
    { token: '--swatch-icon-size', label: 'AppearanceSettings theme-option icon' },
    { token: '--swatch-size', label: 'AppearanceSettings accent swatch' },
    { token: '--swatch-check-size', label: 'AppearanceSettings swatch checkmark' },
    { token: '--swatch-custom-size', label: 'AppearanceSettings custom-color swatch' },
  ];

  const shadowSwatches = ['--shadow-sm', '--shadow-md', '--shadow-lg'];

  // ---------------------------------------------------------------------
  // Motion — "Shuttle Motion" (redesign brief `docs/design/redesign.md`
  // §2, issue #427). The demo dots below animate with
  // `animation-duration: var(--duration-*)`/`animation-timing-function:
  // var(--ease-*)` set directly from these token names (a `style` attribute
  // referencing the custom property, same pattern the spacing/radius
  // scales above already use) — so, like every other value on this page,
  // retuning `tokens.css` changes what's demonstrated here live, and the
  // `prefers-reduced-motion` rule that zeroes every `--duration-*` token
  // freezes these demos too, for free.
  const durationTokens = [
    { name: '--duration-instant', label: 'instant', job: 'press feedback (tension-press)' },
    { name: '--duration-fast', label: 'fast', job: 'hover, toggle, focus ring, status crossfade' },
    {
      name: '--duration-base',
      label: 'base',
      job: 'drawer/sheet slide, card entrance, transcript item arrival',
    },
    {
      name: '--duration-slow',
      label: 'slow',
      job: 'onboarding step transitions, page-level narrative',
    },
    {
      name: '--duration-weave',
      label: 'weave',
      job: 'permission-card entrance, thread-draw fills/reveals',
    },
  ];

  const easingTokens = [
    { name: '--ease-beat', label: 'beat', job: 'default: toggles, crossfades, symmetric motion' },
    {
      name: '--ease-shuttle',
      label: 'shuttle',
      job: 'entrances: fast-out, settles — drawer/sheet slide',
    },
    { name: '--ease-tension', label: 'tension', job: 'dialogs: snap-then-ease' },
    { name: '--ease-exit', label: 'exit', job: 'exits: accelerate out, never lingers' },
  ];

  const namedTransitions = [
    {
      name: 'beat-in',
      where: 'New transcript item, list row appearing',
      motion: '4px upward slide + fade',
      timing: '--duration-base / --ease-beat (staggered 20ms/item, capped at 5, initial load only)',
    },
    {
      name: 'shuttle-in / shuttle-out',
      where: 'Drawer open/close, mobile Sessions sheet, bottom sheets',
      motion: "Translate from the panel's edge + fade",
      timing: 'in: --duration-base/--ease-shuttle; out: --duration-fast/--ease-exit',
    },
    {
      name: 'thread-lift',
      where: 'Modal open (Dialog primitive)',
      motion: 'Backdrop fades independently; card scale(0.97→1) + fade',
      timing: '--duration-base / --ease-tension',
    },
    {
      name: 'tension-press',
      where: 'Button/row :active',
      motion: 'Background darkens ~8%, scale(0.98) — no bounce, no overshoot',
      timing: '--duration-instant / --ease-beat',
    },
    {
      name: 'status-crossfade',
      where: 'A status dot/badge changing state (working → permission_required, health flipping)',
      motion: 'Color/background crossfade, no snap',
      timing: '--duration-fast / --ease-beat',
    },
    {
      name: 'thread-draw',
      where:
        'Anything that fills or reveals: meter bars, the permission card’s one-time border sweep, the active-nav/active-tab indicator, focus-ring appearing',
      motion: 'stroke-dashoffset (SVG) or an equivalent background-position/clip-path sweep',
      timing: '--duration-weave / linear for continuous fills, --ease-tension for one-time reveals',
    },
  ];

  // ---------------------------------------------------------------------
  // Breakpoints (redesign brief §1, issue #427) — `lib/viewport.ts`'s
  // numeric siblings are what components' real `@media`/`matchMedia`
  // checks match against (plain CSS can't read a custom property inside a
  // media condition); these tokens are the one documented source for the
  // values themselves.
  const breakpointTokens = [
    {
      name: '--bp-mobile',
      label: 'Mobile',
      job: 'composer toolbar collapses under "···" below this',
    },
    { name: '--bp-tablet', label: 'Tablet', job: 'Sessions/Drawer become sheets below this' },
    { name: '--bp-desktop', label: 'Desktop', job: 'Rail becomes a bottom tab bar below this' },
    { name: '--bp-wide', label: 'Wide', job: 'Drawer pin threshold — pinned column at/above this' },
  ];

  // ---------------------------------------------------------------------
  // Elevation ladder (redesign brief §3, issue #427) — gives the existing
  // `--shadow-*` tokens above a documented job. Each tier's background/
  // border/shadow are read live the same way every other swatch on this
  // page is (inline `style` referencing the token), so this stays accurate
  // if the underlying color/shadow tokens ever change.
  const elevationTiers: {
    tier: string;
    background: string;
    border: string;
    shadow: string | null;
    usedBy: string;
  }[] = [
    {
      tier: 'flat',
      background: '--color-surface',
      border: '--color-border-subtle',
      shadow: null,
      usedBy: 'Agent message rows, generic list rows, hairline-divided rows',
    },
    {
      tier: 'raised',
      background: '--color-surface-raised',
      border: '--color-border',
      shadow: '--shadow-sm',
      usedBy:
        'Session rows (selected), tool-call rows, PlanCard, target cards, MCP/plugin config cards',
    },
    {
      tier: 'floating',
      background: '--color-surface-raised',
      border: '--color-border-strong',
      shadow: '--shadow-lg',
      usedBy: 'PermissionCard, Dialog, Drawer (overlay mode), Command Palette',
    },
  ];

  // ---------------------------------------------------------------------
  // Thread-draw motion primitive (redesign brief §2, issue #429) —
  // `$lib/styles/motion.css`'s formalized version of `WovenLoader`'s
  // stroke-dashoffset weave technique, for anything else that fills or
  // reveals. The SVG ring demo below needs its circle's real
  // circumference to drive `--thread-draw-length` (the same "set the
  // dash-array to the path length" step any real consumer — a meter, a
  // permission-card border — would do); the block-fill demo drives
  // `--thread-draw-progress` the same way a real progress bar would.
  const threadDrawRingRadius = 15;
  const threadDrawRingLength = 2 * Math.PI * threadDrawRingRadius;

  // Mirrors +page.svelte's theme-toggle wiring (issue #195) so this
  // reference page can be checked in both themes without leaving it.
  let themePreference = $state<ThemePreference>('system');

  onMount(() => {
    themeStore.init();
    const unsubscribeTheme = themeStore.preference.subscribe((value) => {
      themePreference = value;
    });
    return () => {
      unsubscribeTheme();
    };
  });

  // ---------------------------------------------------------------------
  // Components gallery (redesign brief §4, issue #428) — live state for
  // the interactive Dialog/IconButton samples in the "Components" section
  // appended at the end of this file's markup.
  let componentsDialogOpen = $state(false);
  let componentsDrawerPinned = $state(false);
  let componentsRowClicks = $state(0);
  let componentsRowActionClicks = $state(0);
</script>

<svelte:head>
  <title>loombox — style reference</title>
</svelte:head>

<main>
  <header>
    <div>
      <h1>Style reference</h1>
      <p>
        Every token in <code>$lib/styles/tokens.css</code> and
        <code>$lib/styles/typography.css</code>, rendered live. Not part of the product UI — a
        working reference for whoever is building it.
      </p>
    </div>
    <div class="header-controls">
      <button
        type="button"
        onclick={() => themeStore.toggleTheme()}
        data-testid="theme-toggle"
        data-theme-preference={themePreference}
      >
        Theme: {themePreference}
      </button>
    </div>
  </header>

  <section aria-labelledby="colors-heading">
    <h2 id="colors-heading">Color</h2>

    <h3>Neutral / surface</h3>
    <div class="swatch-row">
      {#each neutralSwatches as swatch (swatch.name)}
        <div class="swatch-card">
          <div
            class="swatch"
            style={`background: var(${swatch.name}); border: 1px solid var(--color-border);`}
          ></div>
          <span class="swatch-label">{swatch.label}</span>
          <code class="swatch-token">{swatch.name}</code>
        </div>
      {/each}
    </div>

    <h3>Fill &amp; border</h3>
    <div class="swatch-row">
      {#each fillBorderSwatches as swatch (swatch.name)}
        <div class="swatch-card">
          <div class="swatch on-surface" style={`background: var(${swatch.name});`}></div>
          <span class="swatch-label">{swatch.label}</span>
          <code class="swatch-token">{swatch.name}</code>
        </div>
      {/each}
    </div>

    <h3>Text</h3>
    <div class="text-swatch-list">
      {#each textSwatches as swatch (swatch.name)}
        <p class="text-swatch" style={`color: var(${swatch.name});`}>
          {swatch.label} — the quick brown fox jumps over the lazy dog.
          <code class="swatch-token">{swatch.name}</code>
        </p>
      {/each}
    </div>

    <h3>Accent — the "thread" (SPEC.md §4)</h3>
    <div class="swatch-row">
      {#each accentSwatches as swatch (swatch.name)}
        <div class="swatch-card">
          <div class="swatch" style={`background: var(${swatch.name});`}></div>
          <span class="swatch-label">{swatch.label}</span>
          <code class="swatch-token">{swatch.name}</code>
        </div>
      {/each}
    </div>

    <h3>Semantic status</h3>
    <div class="swatch-row">
      {#each statusSwatches as swatch (swatch.name)}
        <div class="swatch-card">
          <div class="swatch" style={`background: var(${swatch.name});`}></div>
          <span class="swatch-label">{swatch.label}</span>
          <code class="swatch-token">{swatch.name}</code>
          <div
            class="status-pill"
            style={`background: var(${swatch.subtle}); color: var(${swatch.name});`}
          >
            Pill on subtle
          </div>
        </div>
      {/each}
    </div>

    <h3>Contrast check (body text, WCAG AA)</h3>
    <p class="contrast-note">
      <code>--color-text-primary</code> on <code>--color-bg</code> and
      <code>--color-surface</code> clears 7:1+ in dark AND light (well past the 4.5:1 AA threshold
      for normal-size body text); <code>--color-text-secondary</code> clears at least 4.5:1 against
      both in either theme too. <code>--color-text-muted</code> stays a caption/hint tone in dark
      (large-text-only AA, ~3:1, never used for paragraph body copy), but was strengthened to a real
      AA-normal-text 4.5:1 tone in light as part of redesign v3's light re-tune (issue #502) — see
      <code>deck.css</code>'s light block doc comment for the full ratio table. Verified with a
      relative-luminance script against the exact hex values in <code>deck.css</code> as of this token
      set's introduction.
    </p>
  </section>

  <section aria-labelledby="spacing-heading">
    <h2 id="spacing-heading">Spacing scale</h2>
    <div class="scale-row">
      {#each spacingSwatches as token (token)}
        <div class="scale-item">
          <div class="spacing-bar" style={`width: var(${token});`}></div>
          <code>{token}</code>
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="radius-heading">
    <h2 id="radius-heading">Radius scale</h2>
    <div class="scale-row">
      {#each radiusSwatches as token (token)}
        <div class="scale-item">
          <div class="radius-box" style={`border-radius: var(${token});`}></div>
          <code>{token}</code>
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="icon-size-heading">
    <h2 id="icon-size-heading">Icon-size scale (issue #580)</h2>
    <div class="scale-row">
      {#each iconSizeSwatches as { token, label } (token)}
        <div class="scale-item">
          <div class="icon-size-box">
            <Icon name="collapse-chevron" size={`var(${token})`} />
          </div>
          <code>{token}</code>
          <span class="scale-item-label">{label}</span>
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="dialog-geometry-heading">
    <h2 id="dialog-geometry-heading">Dialog geometry (issue #580)</h2>
    <p class="motion-intro">
      The compact list-picker dialogs (CommandPalette, MentionPicker, SlashCommandPicker,
      SnippetPicker) override <code>Dialog.svelte</code>'s own default box and now read these
      instead of each carrying its own literal width/scroll cap.
    </p>
    <div class="scale-row">
      {#each dialogGeometrySwatches as { token, label } (token)}
        <div class="scale-item">
          <div class="dialog-geometry-box" style={`width: var(${token});`}></div>
          <code>{token}</code>
          <span class="scale-item-label">{label}</span>
        </div>
      {/each}
    </div>
    <code class="scale-tag">--dialog-max-height: 70vh, the scroll cap all four dialogs share</code>
  </section>

  <section aria-labelledby="dimension-tokens-heading">
    <h2 id="dimension-tokens-heading">Component dimensions (issue #580)</h2>
    <p class="motion-intro">
      One-off dimensions the v6 design-system audit found repeated (or at risk of drifting apart)
      across more than one call site — each is named once instead of trusting every copy to stay in
      sync by hand.
    </p>
    <dl class="dimension-list">
      {#each dimensionSwatches as { token, label } (token)}
        <div class="dimension-row">
          <dt><code>{token}</code></dt>
          <dd>{label}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <section aria-labelledby="elevation-heading">
    <h2 id="elevation-heading">Elevation</h2>
    <div class="scale-row">
      {#each shadowSwatches as token (token)}
        <div class="scale-item">
          <div class="shadow-box" style={`box-shadow: var(${token});`}></div>
          <code>{token}</code>
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="elevation-in-use-heading">
    <h2 id="elevation-in-use-heading">Elevation in use (redesign brief §3, issue #427)</h2>
    <p class="motion-intro">
      Three tiers, each with one documented job — status color on list rows defaults to a quiet
      left-edge stripe rather than a tinted background, so a long list stays scannable;
      <code>PermissionCard</code> is the one deliberate exception, since it's meant to interrupt.
    </p>
    <div class="elevation-row">
      {#each elevationTiers as level (level.tier)}
        <div
          class="elevation-card"
          style={`background: var(${level.background}); border: 1px solid var(${level.border}); box-shadow: ${level.shadow ? `var(${level.shadow})` : 'none'};`}
        >
          <code class="elevation-tier">{level.tier}</code>
          <p class="elevation-used-by">{level.usedBy}</p>
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="motion-heading">
    <h2 id="motion-heading">Woven-thread motif (SPEC.md §4, issue #274)</h2>
    <p class="motion-intro">
      The recurring loading/"agent working" motif: threads being woven, in the accent color. Two
      states — <code>loading</code> for an indeterminate wait, <code>working</code> for a
      continuous, ongoing process — both driven by CSS animation only, and a static fallback for
      <code>prefers-reduced-motion</code>.
    </p>
    <div class="motion-row">
      <div class="motion-sample">
        <WovenLoader size="md" variant="loading" label="Loading" />
        <span class="motion-label">size="md" variant="loading"</span>
      </div>
      <div class="motion-sample">
        <WovenLoader size="md" variant="working" label="Working" />
        <span class="motion-label">size="md" variant="working"</span>
      </div>
      <div class="motion-sample">
        <WovenLoader size="sm" variant="loading" label="Loading" />
        <span class="motion-label">size="sm" (inline, e.g. in a button)</span>
      </div>
      <div class="motion-sample">
        <WovenLoader size="md" variant="working" reducedMotion label="Working" />
        <span class="motion-label">reducedMotion static fallback</span>
      </div>
    </div>
  </section>

  <section aria-labelledby="shuttle-motion-heading">
    <h2 id="shuttle-motion-heading">Motion — "Shuttle Motion" (redesign brief §2, issue #427)</h2>
    <p class="motion-intro">
      One small set of durations/easings, each with one documented job, layered next to
      <code>WovenLoader</code>'s existing weave rather than replacing it. The moving dots below
      animate with <code>animation-duration</code>/<code>animation-timing-function</code> set
      directly from these token names, so they demonstrate the real values live — and freeze under
      <code>prefers-reduced-motion</code>, same as everything else driven by these tokens.
    </p>

    <h3>Durations</h3>
    <div class="motion-token-row">
      {#each durationTokens as token (token.name)}
        <div class="motion-token-card">
          <div class="motion-track">
            <div class="motion-dot" style={`animation-duration: var(${token.name});`}></div>
          </div>
          <span class="motion-token-label">{token.label}</span>
          <code class="swatch-token">{token.name}</code>
          <p class="motion-token-job">{token.job}</p>
        </div>
      {/each}
    </div>

    <h3>Easings</h3>
    <div class="motion-token-row">
      {#each easingTokens as token (token.name)}
        <div class="motion-token-card">
          <div class="motion-track">
            <div
              class="motion-dot"
              style={`animation-duration: var(--duration-slow); animation-timing-function: var(${token.name});`}
            ></div>
          </div>
          <span class="motion-token-label">{token.label}</span>
          <code class="swatch-token">{token.name}</code>
          <p class="motion-token-job">{token.job}</p>
        </div>
      {/each}
    </div>

    <h3>Named transitions</h3>
    <div class="transition-table" role="table" aria-label="Named transitions">
      <div class="transition-row transition-row-head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Where</span>
        <span role="columnheader">Motion</span>
        <span role="columnheader">Timing</span>
      </div>
      {#each namedTransitions as row (row.name)}
        <div class="transition-row" role="row">
          <span role="cell"><code>{row.name}</code></span>
          <span role="cell">{row.where}</span>
          <span role="cell">{row.motion}</span>
          <span role="cell" class="transition-timing">{row.timing}</span>
        </div>
      {/each}
    </div>

    <h3>Breakpoints</h3>
    <div class="scale-row">
      {#each breakpointTokens as token (token.name)}
        <div class="scale-item">
          <code>{token.name}</code>
          <span class="motion-token-job">{token.label} — {token.job}</span>
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="type-heading">
    <h2 id="type-heading">Typography (issue #196: Inter + JetBrains Mono, self-hosted)</h2>

    <p class="display-sample">Command your coding agents from anywhere.</p>
    <code class="scale-tag"
      >--text-display-size / --text-display-line / --text-display-weight, --font-ui</code
    >

    <p class="title-sample">Session: refactor the relay's reconnect handshake</p>
    <code class="scale-tag">--text-title-size / --text-title-line / --text-title-weight</code>

    <p class="body-sample">
      This is body copy set in Inter, the UI grotesk (SPEC.md §4). It should read cleanly at the
      app's default size and line height, with tabular figures for aligned numbers: 0123456789.
    </p>
    <code class="scale-tag"
      >--text-body-size / --text-body-line / --text-body-weight, --font-ui</code
    >

    <p class="small-sample">Small/caption text — timestamps, hints, muted metadata.</p>
    <code class="scale-tag">--text-small-size / --text-small-line</code>

    <h3>Code / diff surface (JetBrains Mono)</h3>
    <pre class="font-mono code-sample">{`function reconnect(relay: RelayClient): void {
  // agent output, code, and diffs render in the monospace face (SPEC.md §4)
  relay.connect();
}`}</pre>
    <code class="scale-tag">--text-code-size / --text-code-line, --font-mono</code>

    <h3>Diff line</h3>
    <div class="diff-sample font-mono">
      <div class="diff-line removed">- return legacyReconnect(relay);</div>
      <div class="diff-line added">+ return relay.reconnect({`{ retries: 3 }`});</div>
    </div>

    <h3>Fallback stack (no invisible text before web fonts load)</h3>
    <p>
      <code>--font-ui</code>:
      <code class="stack"
        >'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif</code
      >
    </p>
    <p>
      <code>--font-mono</code>:
      <code class="stack"
        >'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo,
        Consolas, 'Liberation Mono', monospace</code
      >
    </p>
  </section>

  <section aria-labelledby="mono-identifiers-heading">
    <h2 id="mono-identifiers-heading">Structural identifiers, everywhere (issue #735, A4-1)</h2>
    <p>
      The pick: project paths, branch names, target/node names, session ids, tool names, file names
      in tool rows, and every numeric figure (counts, durations, token and cost numbers) render mono
      — everywhere, including inline inside prose. One rule carries all of it:
      <code>.font-mono</code> (<code>$lib/styles/typography.css</code>), the same class already used
      for code, diffs, and the terminal (SPEC.md §4) — an identifier needs the exact same visual
      treatment as a code surface, so there is no second CSS taxonomy to keep in sync, only this
      enumeration.
    </p>

    <h3>Project path</h3>
    <p>
      <span class="font-mono" data-testid="mono-identifier-project-path">/home/dev/loombox</span>
    </p>
    <code class="scale-tag"
      >topbar breadcrumb, session row, command palette, attention inbox, file reference picker</code
    >

    <h3>Branch name</h3>
    <p>
      <span class="font-mono" data-testid="mono-identifier-branch-name">feat/mono-identifiers</span>
    </p>
    <code class="scale-tag"
      >no call site renders a git branch name yet — #746's fork/branch UI is the first likely
      consumer</code
    >

    <h3>Target / node name</h3>
    <p>
      <span class="font-mono" data-testid="mono-identifier-target-name">node_a1b2 · local</span>
    </p>
    <code class="scale-tag">TargetStatusView, TargetPicker, a session row's meta line</code>

    <h3>Session / account id</h3>
    <p><span class="font-mono" data-testid="mono-identifier-session-id">0.0.5127391</span></p>
    <code class="scale-tag">the sign-in gate footer</code>

    <h3>Tool name</h3>
    <p>
      <span class="font-mono" data-testid="mono-identifier-tool-name"
        >Read apps/web/src/lib/diff.ts</span
      >
    </p>
    <code class="scale-tag">GenericToolRow, EditWriteWidget, PermissionCard titles</code>

    <h3>File name in a tool row</h3>
    <p>
      <span class="font-mono" data-testid="mono-identifier-file-name">apps/web/src/lib/diff.ts</span
      >
    </p>
    <code class="scale-tag">DiffViewer's path header, FileReferencePicker results</code>

    <h3>Numeric figure — count</h3>
    <p><span class="font-mono" data-testid="mono-identifier-count">3</span> pending</p>
    <code class="scale-tag"
      >PermissionQueueBar, TodoWidget's done/total, DiffViewer's +/- totals</code
    >

    <h3>Numeric figure — duration</h3>
    <p>Thinking <span class="font-mono" data-testid="mono-identifier-duration">12s</span></p>
    <code class="scale-tag"
      >MessageItem's thinking timer, TargetStatusView's relative sample age</code
    >

    <h3>Numeric figure — tokens</h3>
    <p>
      <span class="font-mono" data-testid="mono-identifier-tokens">76k</span> /
      <span class="font-mono">200k</span>
    </p>
    <code class="scale-tag">ConfigBar's context meter</code>

    <h3>Numeric figure — cost</h3>
    <p><span class="font-mono" data-testid="mono-identifier-cost">$1.23</span></p>
    <code class="scale-tag">ConfigBar's session cost</code>

    <h3>Where the pick's own caveat shows worst</h3>
    <p>
      "All numbers" reaches further than Zed's own habit, and the option's own trade sentence says
      so: a lone relative timestamp has nothing to align against, so the tabular-figure benefit is
      moot and the font swap can read as a glitch rather than an alignment aid. Applied anyway,
      since that is the decision — the two places it reads worst:
    </p>
    <p>
      <strong>MessageItem's thinking timer</strong> (<code>.thinking-timer</code>) — a live-ticking
      <span class="font-mono">Ns</span> that advances every 250ms inside a two-word phrase, at caption
      size; the digit hops font mid-sentence on every tick.
    </p>
    <p>
      <strong>TargetStatusView's relative sample age</strong> (<code>.target-age</code>) — the
      caveat's own example: a 2–3 character string (<span class="font-mono">28s</span>,
      <span class="font-mono">5m</span>) with no neighboring column, dropped into a dense row of
      otherwise proportional labels.
    </p>
  </section>

  <!-- === Warp Deck: UI primitives === -->
  <section aria-labelledby="components-heading">
    <h2 id="components-heading">Components (redesign brief §4, issue #428)</h2>
    <p class="motion-intro">
      The shared <code>lib/components/ui/</code> primitive set every wave-3 surface builds on —
      <code>Badge</code>, <code>Button</code>, <code>IconButton</code>, <code>Card</code>,
      <code>Dialog</code>, <code>EmptyState</code>, <code>ErrorNotice</code>, <code>Row</code>, and
      <code>StatusDot</code>. Existing surfaces keep their current markup until their own
      per-surface restyle issue; this page is each primitive's variant/state gallery.
    </p>

    <h3>Button</h3>
    <div class="component-row">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
    </div>
    <div class="component-row">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button disabled>Disabled</Button>
      <Button loading>Loading</Button>
    </div>

    <h3>Badge (issue #579)</h3>
    <div class="component-row">
      <Badge>cli</Badge>
      <Badge tone="success">healthy</Badge>
      <Badge tone="warning">overloaded</Badge>
      <Badge tone="danger">offline</Badge>
      <Badge tone="info">preview</Badge>
    </div>
    <div class="component-row">
      <Badge size="sm">Small</Badge>
      <Badge size="md">Medium</Badge>
      <Badge tone="success" dot dotLabel="Healthy">Healthy</Badge>
    </div>
    <p class="motion-token-job">
      The last badge composes the real <code>StatusDot</code> (via <code>dot</code>) rather than
      redrawing it — see <code>TargetStatusView</code>'s health badge.
    </p>

    <h3>IconButton</h3>
    <div class="component-row">
      <IconButton label="Command palette">
        <svg
          class="icon-glyph"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 10h12M10 4v12" />
        </svg>
      </IconButton>
      <IconButton
        label="Pin drawer"
        pressed={componentsDrawerPinned}
        onclick={() => (componentsDrawerPinned = !componentsDrawerPinned)}
      >
        <svg
          class="icon-glyph"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M10 3v9M6 8l4-4 4 4" />
          <path d="M5 15h10" />
        </svg>
      </IconButton>
      <IconButton label="Inbox" badge={3}>
        <svg
          class="icon-glyph"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="14" height="11" rx="1.5" />
          <path d="M3 8h14" />
        </svg>
      </IconButton>
      <IconButton label="Disabled action" disabled>
        <svg
          class="icon-glyph"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6" />
        </svg>
      </IconButton>
    </div>
    <p class="motion-token-job">
      "Pin drawer" toggles <code>aria-pressed</code> — currently {componentsDrawerPinned
        ? 'pressed'
        : 'not pressed'}.
    </p>

    <h3>Card — elevation ladder (issue #427)</h3>
    <div class="component-row">
      <Card elevation="flat" class="component-card-sample">
        <strong>flat</strong>
        <p>Agent message rows, generic list rows, hairline-divided rows.</p>
      </Card>
      <Card elevation="raised" class="component-card-sample">
        <strong>raised</strong>
        <p>Session rows (selected), tool-call rows, PlanCard, target cards.</p>
      </Card>
      <Card elevation="floating" class="component-card-sample">
        <strong>floating</strong>
        <p>PermissionCard, Dialog, Drawer (overlay), Command Palette.</p>
      </Card>
    </div>

    <h3>Row (issue #579)</h3>
    <ul class="row-sample-list">
      <Row as="li" active>
        {#snippet leading()}
          <StatusDot tone="success" label="Working" pulse />
        {/snippet}
        <strong>Selected session</strong>
        <small>demo/project · main.ts</small>
        {#snippet trailing()}
          <span class="row-sample-time">2m</span>
        {/snippet}
      </Row>
      <Row as="li" onclick={() => (componentsRowClicks += 1)}>
        {#snippet leading()}
          <StatusDot tone="neutral" label="Idle" />
        {/snippet}
        <strong>Clickable row</strong>
        <small>A plain &lt;li&gt; with its own onclick</small>
        {#snippet trailing()}
          <IconButton
            label="Row action (does not also trigger the row's own click)"
            onclick={() => (componentsRowActionClicks += 1)}
          >
            <svg
              class="icon-glyph"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="1" />
              <circle cx="10" cy="5" r="1" />
              <circle cx="10" cy="15" r="1" />
            </svg>
          </IconButton>
        {/snippet}
      </Row>
    </ul>
    <p class="motion-token-job">
      Row clicked {componentsRowClicks} time(s), row action clicked
      {componentsRowActionClicks} time(s) — independently, never both from one click. It's a plain
      <code>li</code>
      synthesizing <code>role="button"</code>/<code>tabindex</code>/keydown (never a literal
      <code>&lt;button&gt;</code>, since its trailing slot holds a real one — a real
      <code>&lt;button&gt;</code>
      cannot contain another interactive control). The trailing icon button's own click never bubbles
      into the row's own <code>onclick</code>.
    </p>

    <h3>Dialog — thread-lift entrance/exit, Esc/backdrop-click/focus-trap</h3>
    <div class="component-row">
      <Button variant="primary" onclick={() => (componentsDialogOpen = true)}>Open dialog</Button>
    </div>
    <Dialog
      open={componentsDialogOpen}
      label="Example dialog"
      onClose={() => (componentsDialogOpen = false)}
    >
      {#snippet header()}
        <h2>Example dialog</h2>
      {/snippet}
      <p>
        Esc, a backdrop click, or the buttons below all call <code>onClose</code>. Tab cycles
        between the two footer buttons without escaping the panel.
      </p>
      {#snippet footer()}
        <Button variant="secondary" onclick={() => (componentsDialogOpen = false)}>Cancel</Button>
        <Button variant="primary" onclick={() => (componentsDialogOpen = false)}>Confirm</Button>
      {/snippet}
    </Dialog>

    <h3>EmptyState</h3>
    <div class="component-row">
      <div class="empty-state-sample">
        <EmptyState message="No sessions yet — start one to see it here." />
      </div>
      <div class="empty-state-sample">
        <EmptyState message="No targets connected yet — start a loombox node.">
          {#snippet cta()}
            <Button variant="primary">Add a target</Button>
          {/snippet}
        </EmptyState>
      </div>
    </div>

    <h3>ErrorNotice</h3>
    <div class="component-row component-row-stack">
      <ErrorNotice message="This session's history failed to decrypt." />
      <ErrorNotice message="Couldn't reach the relay." retryable onRetry={() => {}} />
    </div>

    <h3>StatusDot</h3>
    <div class="component-row">
      <span class="status-dot-sample"><StatusDot tone="neutral" label="Idle" /> Idle</span>
      <span class="status-dot-sample"><StatusDot tone="info" label="Working" pulse /> Working</span>
      <span class="status-dot-sample"
        ><StatusDot tone="warning" label="Permission required" /> Permission required</span
      >
      <span class="status-dot-sample"><StatusDot tone="danger" label="Error" /> Error</span>
      <span class="status-dot-sample"><StatusDot tone="success" label="Healthy" /> Healthy</span>
    </div>
  </section>
  <!-- === /Warp Deck: UI primitives === -->
  <!-- === Warp Deck: thread-draw motion === -->
  <section aria-labelledby="thread-draw-heading">
    <h2 id="thread-draw-heading">Thread-draw motion primitive (redesign brief §2, issue #429)</h2>
    <p class="motion-intro">
      <code>WovenLoader</code>'s <code>stroke-dashoffset</code> weave technique, formalized into a
      reusable primitive in <code>$lib/styles/motion.css</code> for anything else that fills or
      reveals: progress/meter bars, the active-nav/active-tab indicator, and one-time reveals like
      the permission card's border sweep. Two forms — <code>.thread-draw</code> for SVG strokes,
      <code>.thread-draw-fill</code> for plain block elements via <code>clip-path</code> — each with
      a <code>-once</code> (a single reveal) and <code>-loop</code> (a continuous fill) mode, both
      on
      <code>--duration-weave</code>.
    </p>

    <h3>SVG stroke form — <code>.thread-draw</code></h3>
    <div class="thread-draw-showcase-row">
      <div class="thread-draw-showcase-sample">
        <svg class="thread-draw-showcase-svg" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="thread-draw-showcase-track" cx="18" cy="18" r={threadDrawRingRadius} />
          <circle
            class="thread-draw thread-draw-once thread-draw-showcase-ring"
            cx="18"
            cy="18"
            r={threadDrawRingRadius}
            style={`--thread-draw-length: ${threadDrawRingLength};`}
          />
        </svg>
        <span class="motion-label">.thread-draw-once (single reveal)</span>
      </div>
      <div class="thread-draw-showcase-sample">
        <svg class="thread-draw-showcase-svg" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="thread-draw-showcase-track" cx="18" cy="18" r={threadDrawRingRadius} />
          <circle
            class="thread-draw thread-draw-loop thread-draw-showcase-ring"
            cx="18"
            cy="18"
            r={threadDrawRingRadius}
            style={`--thread-draw-length: ${threadDrawRingLength};`}
          />
        </svg>
        <span class="motion-label">.thread-draw-loop (continuous fill)</span>
      </div>
      <div class="thread-draw-showcase-sample">
        <svg class="thread-draw-showcase-svg" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="thread-draw-showcase-track" cx="18" cy="18" r={threadDrawRingRadius} />
          <circle
            class="thread-draw thread-draw-loop thread-draw-reduced-motion thread-draw-showcase-ring"
            cx="18"
            cy="18"
            r={threadDrawRingRadius}
            style={`--thread-draw-length: ${threadDrawRingLength};`}
          />
        </svg>
        <span class="motion-label">reduced-motion static fallback</span>
      </div>
    </div>

    <h3>Block-fill form — <code>.thread-draw-fill</code></h3>
    <div class="thread-draw-showcase-row">
      <div class="thread-draw-showcase-sample thread-draw-showcase-sample-wide">
        <div class="thread-draw-fill-showcase-track">
          <div
            class="thread-draw-fill thread-draw-fill-showcase-bar"
            style="--thread-draw-progress: 70%;"
          ></div>
        </div>
        <span class="motion-label">.thread-draw-fill (one-time reveal to 70%)</span>
      </div>
      <div class="thread-draw-showcase-sample thread-draw-showcase-sample-wide">
        <div class="thread-draw-fill-showcase-track">
          <div class="thread-draw-fill-loop thread-draw-fill-showcase-bar"></div>
        </div>
        <span class="motion-label">.thread-draw-fill-loop (continuous sweep)</span>
      </div>
    </div>

    <h3>Skeleton state — <code>WovenLoader variant="skeleton"</code></h3>
    <p class="motion-intro">
      An additive third <code>WovenLoader</code> variant (same locked warp/weft geometry, same
      reduced-motion contract as <code>loading</code>/<code>working</code>) for loading-placeholder
      chrome — muted rather than accent-colored, since a placeholder isn't an accent-worthy active
      state. A consumer stacks a few instances to stand in for not-yet-loaded rows, e.g. transcript
      history that's still decrypting.
    </p>
    <div class="motion-row">
      <div class="motion-sample">
        <WovenLoader size="md" variant="skeleton" label="Loading placeholder" />
        <span class="motion-label">size="md" variant="skeleton"</span>
      </div>
      <div class="motion-sample">
        <WovenLoader size="sm" variant="skeleton" label="Loading placeholder" />
        <span class="motion-label">size="sm" variant="skeleton"</span>
      </div>
      <div class="motion-sample">
        <WovenLoader size="md" variant="skeleton" reducedMotion label="Loading placeholder" />
        <span class="motion-label">reducedMotion static fallback</span>
      </div>
    </div>

    <h4>Stacked as transcript-loading placeholder rows</h4>
    <div class="skeleton-rows-showcase">
      {#each [0, 1, 2] as row (row)}
        <div class="skeleton-row-showcase">
          <WovenLoader size="sm" variant="skeleton" label="Loading transcript history" />
          <span class="skeleton-row-showcase-bar"></span>
        </div>
      {/each}
    </div>
  </section>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xl);
    padding: var(--space-xl);
    max-width: 56rem;
    margin: 0 auto;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
  }

  header p {
    max-width: 40rem;
    opacity: 0.75;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  header button {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    padding: var(--space-2xs) var(--space-sm);
    cursor: pointer;
    font: inherit;
    text-transform: capitalize;
    flex-shrink: 0;
  }

  h2 {
    border-bottom: 1px solid var(--color-border);
    padding-bottom: var(--space-xs);
  }

  h3 {
    font-size: var(--text-small-size);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
    margin: var(--space-lg) 0 var(--space-sm);
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.85em;
  }

  .swatch-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
  }

  .swatch-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    width: 9rem;
  }

  .swatch {
    height: 3rem;
    border-radius: var(--radius-md);
  }

  .swatch.on-surface {
    background-clip: padding-box;
    border: 1px solid var(--color-border-subtle);
  }

  .swatch-label {
    font-size: var(--text-small-size);
  }

  .swatch-token {
    opacity: 0.65;
    font-size: 0.72rem;
  }

  .status-pill {
    border-radius: var(--radius-full);
    padding: var(--space-3xs) var(--space-xs);
    font-size: 0.72rem;
    text-align: center;
  }

  .text-swatch-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .text-swatch {
    margin: 0;
  }

  .contrast-note {
    max-width: 42rem;
    opacity: 0.85;
    font-size: var(--text-small-size);
  }

  .motion-intro {
    max-width: 42rem;
    opacity: 0.85;
    margin: 0 0 var(--space-md);
  }

  .motion-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-lg);
  }

  .motion-sample {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-sm);
    width: 8rem;
    padding: var(--space-lg);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
  }

  .motion-label {
    font-size: var(--text-small-size);
    text-align: center;
    opacity: 0.7;
  }

  /* Elevation ladder cards (redesign brief §3, issue #427). */
  .elevation-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-lg);
  }

  .elevation-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    width: 14rem;
    padding: var(--space-lg);
    border-radius: var(--radius-lg);
  }

  .elevation-tier {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.75rem;
  }

  .elevation-used-by {
    margin: 0;
    opacity: 0.75;
    font-size: var(--text-small-size);
  }

  /* Shuttle Motion token demos (redesign brief §2, issue #427). */
  .motion-token-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-lg);
    margin-bottom: var(--space-md);
  }

  .motion-token-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    width: 12rem;
  }

  .motion-track {
    position: relative;
    width: 100%;
    height: 1.25rem;
    border-radius: var(--radius-full);
    background: var(--color-fill-subtle);
    overflow: hidden;
  }

  .motion-dot {
    position: absolute;
    top: 50%;
    left: 0;
    width: 0.85rem;
    height: 0.85rem;
    margin-top: -0.425rem;
    border-radius: var(--radius-full);
    background: var(--color-accent);
    animation-name: motion-token-slide;
    animation-timing-function: var(--ease-beat);
    animation-iteration-count: infinite;
    animation-direction: alternate;
  }

  @keyframes motion-token-slide {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(calc(12rem - 2.5rem));
    }
  }

  .motion-token-label {
    font-size: var(--text-small-size);
    font-weight: 600;
    text-transform: capitalize;
  }

  .motion-token-job {
    margin: 0;
    opacity: 0.7;
    font-size: 0.75rem;
  }

  /* Named-transitions table (redesign brief §2). A plain ARIA `role="table"`
     grid rather than a real `<table>`, matching this page's existing
     div-based swatch layout instead of introducing a new element pattern. */
  .transition-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .transition-row {
    display: grid;
    grid-template-columns: 11rem 16rem 1fr 14rem;
    gap: var(--space-md);
    padding: var(--space-sm) var(--space-md);
    border-bottom: 1px solid var(--color-border-subtle);
    font-size: var(--text-small-size);
  }

  .transition-row:last-child {
    border-bottom: none;
  }

  .transition-row-head {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.7rem;
    opacity: 0.7;
    background: var(--color-fill-subtle);
  }

  .transition-timing {
    font-family: var(--font-mono);
    opacity: 0.85;
  }

  .scale-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-lg);
  }

  .scale-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2xs);
  }

  .spacing-bar {
    height: var(--space-md);
    background: var(--color-accent);
    border-radius: var(--radius-sm);
  }

  .radius-box {
    width: 3rem;
    height: 3rem;
    background: var(--color-fill);
    border: 1px solid var(--color-border);
  }

  .shadow-box {
    width: 4rem;
    height: 3rem;
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
  }

  .icon-size-box {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    color: var(--color-text-secondary);
  }

  .dialog-geometry-box {
    height: 1.5rem;
    background: var(--color-fill);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  .scale-item-label {
    font-size: var(--text-caption-size);
    color: var(--color-text-muted);
    max-width: 12rem;
  }

  .dimension-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
    margin: 0;
  }

  .dimension-row {
    display: flex;
    gap: var(--space-sm);
    align-items: baseline;
  }

  .dimension-row dt {
    flex: 0 0 16rem;
  }

  .dimension-row dd {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .display-sample {
    font-size: var(--text-display-size);
    line-height: var(--text-display-line);
    font-weight: var(--text-display-weight);
    margin: 0;
  }

  .title-sample {
    font-size: var(--text-title-size);
    line-height: var(--text-title-line);
    font-weight: var(--text-title-weight);
    margin: var(--space-sm) 0 0;
  }

  .body-sample {
    font-size: var(--text-body-size);
    line-height: var(--text-body-line);
    font-weight: var(--text-body-weight);
    font-feature-settings: var(--font-feature-tabular);
    max-width: 40rem;
    margin: var(--space-sm) 0 0;
  }

  .small-sample {
    font-size: var(--text-small-size);
    line-height: var(--text-small-line);
    opacity: 0.75;
    margin: var(--space-sm) 0 0;
  }

  .scale-tag {
    display: inline-block;
    margin-top: var(--space-2xs);
    opacity: 0.55;
  }

  .code-sample {
    margin: 0;
    padding: var(--space-md);
    border-radius: var(--radius-lg);
    background: var(--color-bg);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    overflow-x: auto;
  }

  .diff-sample {
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-lg);
    overflow: hidden;
    font-size: var(--text-code-size);
    border: 1px solid var(--color-border);
  }

  .diff-line {
    padding: var(--space-2xs) var(--space-sm);
    white-space: pre;
  }

  .diff-line.added {
    background: var(--color-success-subtle);
    color: var(--color-success);
  }

  .diff-line.removed {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
  }

  .stack {
    display: inline-block;
    opacity: 0.75;
  }

  /* === Warp Deck: UI primitives (redesign brief §4, issue #428) === */
  .component-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-md);
    margin-bottom: var(--space-md);
  }

  .component-row-stack {
    flex-direction: column;
    align-items: stretch;
    max-width: 28rem;
  }

  /* `Card`'s `class` prop lands on an element inside Card's own component
     scope, not this one — `:global()` is the standard, narrowly-scoped way
     to reach it. `strong`/`p` below are written directly in this file's own
     template (as Card's passed-in children), so they stay normally scoped
     and don't need `:global()` themselves. */
  :global(.component-card-sample) {
    width: 14rem;
    display: flex;
    flex-direction: column;
    gap: var(--space-2xs);
  }

  :global(.component-card-sample) strong {
    font-size: var(--text-small-size);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  :global(.component-card-sample) p {
    margin: 0;
    font-size: var(--text-small-size);
    opacity: 0.75;
  }

  .row-sample-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    max-width: 28rem;
    margin-bottom: var(--space-md);
  }

  .row-sample-time {
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  .empty-state-sample {
    width: 18rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
  }

  /* === Warp Deck: thread-draw motion showcase (redesign brief §2, issue
     #429) === */
  .thread-draw-showcase-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-lg);
    margin-bottom: var(--space-md);
  }

  .thread-draw-showcase-sample {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-sm);
    width: 8rem;
    padding: var(--space-lg);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
  }

  .status-dot-sample {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-small-size);
  }

  .icon-glyph {
    width: 1.125rem;
    height: 1.125rem;
  }
  /* === /Warp Deck: UI primitives === */
  .thread-draw-showcase-sample-wide {
    width: 16rem;
  }

  .thread-draw-showcase-svg {
    width: 3rem;
    height: 3rem;
    transform: rotate(-90deg); /* draw clockwise from 12 o'clock, like a real progress ring */
  }

  .thread-draw-showcase-track {
    fill: none;
    stroke: var(--color-fill);
    stroke-width: 2.5;
  }

  .thread-draw-showcase-ring {
    fill: none;
    stroke: var(--color-accent);
    stroke-width: 2.5;
    stroke-linecap: round;
  }

  .thread-draw-fill-showcase-track {
    width: 100%;
    height: var(--space-md);
    border-radius: var(--radius-full);
    background: var(--color-fill-subtle);
    overflow: hidden;
  }

  .thread-draw-fill-showcase-bar {
    width: 100%;
    height: 100%;
    background: var(--color-accent);
  }

  .skeleton-rows-showcase {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    max-width: 24rem;
  }

  .skeleton-row-showcase {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle);
  }

  .skeleton-row-showcase-bar {
    flex: 1;
    height: var(--space-md);
    border-radius: var(--radius-sm);
    background: var(--color-fill-subtle);
  }
</style>
