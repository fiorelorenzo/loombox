<script lang="ts">
  /**
   * The shared composition for every pre-cockpit screen — checking session,
   * signed-out sign-in, first-run onboarding, and the device-approval page at
   * `/device`: one viewport-centred column (brand lockup, tagline, then the
   * caller's own panel) on a low-contrast woven field.
   *
   * It carries no chrome of its own. An earlier version pinned a theme toggle
   * to a corner, on the reasoning that a blinding light screen is hard to sign
   * in through — but the saved preference is already applied by then
   * (`theme.ts`'s `init()` runs in `+layout.svelte`'s `onMount`), and its
   * default, `system`, follows the OS, so anyone in a dark desktop gets a dark
   * gate without asking. A control that changes nothing for almost everyone
   * does not earn a place on the one screen that should say exactly one thing.
   * Appearance lives in the cockpit's own settings, after sign-in.
   *
   * It exists because those screens had no layout at all. `+page.svelte`'s
   * `main` is a top-aligned flex column — its comment claimed the pre-cockpit
   * screens "keep the original padded, centered column layout", but the rule
   * never had `justify-content`, `align-items` or a `max-width` — so the
   * sign-in card sat directly under the header with two thirds of the window
   * empty below it, and the "Checking session…" line was stranded in the
   * top-left corner (measured: x=15, y=106 in a 1280x860 window) while the
   * lockup above it was centred. Two alignment systems on one screen.
   *
   * Two other things this fixes by construction, both of them why the gate
   * read as a different product from the cockpit:
   *  - The brand mark was drawn TWICE, ~110px apart: coloured in the lockup,
   *    then again dimmed inside `EmptyState`. Only the lockup remains, and
   *    `EmptyState` is gone from here entirely — its documented job is "empty
   *    sessions, empty inbox, empty targets", so it dressed the front door as
   *    "nothing here yet" rather than "welcome".
   *  - Nothing on the gate used the elevation ladder, while the cockpit is
   *    built out of it. The caller's panel is a real `floating` `Card`, the
   *    tier `/style-reference` documents for "the one card nothing else
   *    competes with".
   *
   * The field is the "Warp & Weft" motif (SPEC §4) used as cloth rather than
   * chrome. A plain weave is PAIRED threads with wide gaps between the pairs,
   * not a rule every 96px: the first attempt at this was a uniform grid and
   * read as graph paper. Warp and weft pairs are offset by half a repeat so
   * their crossings alternate, and the whole field is masked to fade out well
   * before the edges, so it reads as something the composition sits on
   * instead of a grid drawn over the window.
   */
  import type { Snippet } from 'svelte';

  import { APP_TAGLINE } from '$lib/constants';

  import BrandLockup from './BrandLockup.svelte';

  interface Props {
    /** The screen's own panel — typically one `<Card elevation="floating">`. */
    children: Snippet;
    /** An optional muted line under the panel: identity, connection state, a way out. */
    footer?: Snippet;
    /**
     * `panel` (default) sizes the column for a single-CTA card; `wide` is for
     * the onboarding steps, which carry a Recovery Code and its explanation
     * rather than one button.
     */
    width?: 'panel' | 'wide';
  }

  const { children, footer, width = 'panel' }: Props = $props();
</script>

<div class="gate-shell" data-testid="gate-shell" data-width={width}>
  <div class="gate-field" aria-hidden="true"></div>

  <div class="gate-column">
    <header class="gate-brand">
      <h1 class="gate-heading"><BrandLockup /></h1>
      <p class="gate-tagline">{APP_TAGLINE}</p>
    </header>

    {@render children()}

    {#if footer}
      <footer class="gate-footer">{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .gate-shell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-xl);
    /* The field is absolutely positioned to the shell's box; without this a
       sub-pixel overflow on it would add a scrollbar to a screen that has
       nothing to scroll. */
    overflow: hidden;
  }

  .gate-field {
    position: absolute;
    inset: 0;
    background-image:
      repeating-linear-gradient(
        90deg,
        var(--color-text-primary) 0 1px,
        transparent 1px 7px,
        var(--color-text-primary) 7px 8px,
        transparent 8px 176px
      ),
      repeating-linear-gradient(
        0deg,
        var(--color-text-primary) 0 1px,
        transparent 1px 7px,
        var(--color-text-primary) 7px 8px,
        transparent 8px 176px
      );
    /* Half a repeat, so warp and weft crossings alternate rather than lining
       up into a single lattice. */
    background-position:
      0 0,
      88px 88px;
    opacity: 0.07;
    mask-image: radial-gradient(ellipse 70% 60% at 50% 50%, black 15%, transparent 85%);
    pointer-events: none;
  }

  .gate-column {
    /* Above the field, which is a sibling rather than a background so it can
       carry its own mask without affecting the content's opacity. */
    position: relative;
    display: flex;
    flex-direction: column;
    /* `stretch`, not `center`: the caller's panel must fill the column so that
       every gate state draws the SAME box in the same place. Centring sized
       each panel to its own content instead, and the checking-session card
       (230px) then jumped to the sign-in card's width (334px) the moment the
       session resolved — measured, which is how this was caught. The brand
       and footer below centre their own contents. */
    align-items: stretch;
    gap: var(--space-xl);
    width: 100%;
    max-width: 22rem;
    /* Reserving the column's height is what actually keeps the composition
       still. Width alone was not enough: with the column sized to its content
       and centred in the viewport, a shorter panel sat lower, so the lockup
       jumped 46px upwards the moment the session resolved and the taller
       sign-in panel replaced the checking one (measured: card top 402 -> 356).
       A constant column height means a constant centre, so the brand and the
       panel's top edge stay put and only the panel's own contents change. Tall
       states (`wide`, onboarding) simply exceed it and re-centre, which is
       fine: that is a different screen, not a swap under the user's eyes. */
    min-height: 22rem;
    justify-content: flex-start;
  }

  .gate-shell[data-width='wide'] .gate-column {
    max-width: 34rem;
  }

  .gate-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-2xs);
  }

  .gate-heading {
    display: flex;
    margin: 0;
  }

  .gate-tagline {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .gate-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-sm);
    font-size: var(--text-small-size);
    color: var(--color-text-secondary);
  }

  /* On a phone the column IS the whole screen, so the field's fade would clip
     awkwardly around it. */
  @media (max-width: 480px) {
    .gate-shell {
      padding: var(--space-lg);
    }

    .gate-field {
      display: none;
    }
  }
</style>
