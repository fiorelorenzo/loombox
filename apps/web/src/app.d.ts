import 'vite-plugin-pwa/svelte';
import 'vite-plugin-pwa/info';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};

// ci-filter-test: temporary marker for issue #611 evidence (apps/web/src-only path-filter live test), reverted/discarded, this branch is not merged
