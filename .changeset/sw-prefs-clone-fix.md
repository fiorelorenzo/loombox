---
'@loombox/web': patch
---

Fix the app hanging on "Checking session…" for every visit after the first.

`+page.svelte`'s `onMount` syncs this device's notification preferences into the
service worker before it restores the session. It posted the `$state` object
itself, which is a proxy, and structured clone cannot clone a proxy, so
`postMessage` threw `DataCloneError: #<Object> could not be cloned` and took the
rest of `onMount` with it. The session was never restored, so the app sat on the
"Checking session…" screen forever, with no `/api/auth/get-session` request ever
made.

It only happened from the second visit on, because a service worker does not
claim the page that registered it: on the first load `navigator.serviceWorker
.controller` is still null and the sync is a no-op. That is also why no test
caught it, since none of them loaded the app twice in one browser context.

Found on production (app.loombox.dev) by driving the deployed app in a real
browser: unregistering the worker made the same page work immediately, and an
in-page error capture installed before hydration showed the `DataCloneError`.

The message now carries a `$state.snapshot`, and the whole sync is wrapped in a
`try`/`catch`: syncing notification preferences has no business being able to
stop someone signing in. Both a unit test (the posted payload must survive
`structuredClone`) and a Playwright spec (a second visit, with the worker
controlling the page, still reaches the sign-in button) cover it.
