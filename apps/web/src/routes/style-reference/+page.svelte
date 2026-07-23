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

  const neutralSwatches = [
    { name: '--color-bg', label: 'Background' },
    { name: '--color-surface', label: 'Surface' },
    { name: '--color-surface-raised', label: 'Surface raised' },
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

  const shadowSwatches = ['--shadow-sm', '--shadow-md', '--shadow-lg'];

  // Mirrors +page.svelte's theme-toggle wiring (issue #195) so this
  // reference page can be checked in both themes without leaving it.
  let themePreference = $state<ThemePreference>('system');

  onMount(() => {
    themeStore.init();
    const unsubscribe = themeStore.preference.subscribe((value) => {
      themePreference = value;
    });
    return unsubscribe;
  });
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
    <button
      type="button"
      onclick={() => themeStore.toggleTheme()}
      data-testid="theme-toggle"
      data-theme-preference={themePreference}
    >
      Theme: {themePreference}
    </button>
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
      <code>--color-text-secondary</code> on <code>--color-bg</code> both clear 4.5:1 (the AA
      threshold for normal-size body text) in dark AND light — verified with a relative-luminance
      script against the exact hex values in <code>tokens.css</code>
      as of this token set's introduction. <code>--color-text-muted</code> is a caption/hint tone only
      (large-text-only AA, ~3:1+), never used for paragraph body copy.
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
</style>
