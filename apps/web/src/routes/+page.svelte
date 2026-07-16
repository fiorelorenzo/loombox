<script lang="ts">
  import { APP_NAME, APP_TAGLINE } from '$lib/constants';
</script>

<main>
  <h1>{APP_NAME}</h1>
  <p>{APP_TAGLINE}</p>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    gap: 0.5rem;
    text-align: center;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }

  h1 {
    font-size: 2rem;
    margin: 0;
  }

  p {
    margin: 0;
    opacity: 0.7;
  }
</style>
