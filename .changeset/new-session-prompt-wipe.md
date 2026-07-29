---
'@loombox/web': patch
---

Stop the New session dialog wiping what you type. Its reset effect called `resetForm()`, which reads the `providers` prop, and a Svelte 5 `$effect` tracks reads made inside the functions it calls — so the reset re-ran whenever `providers` changed identity, which `+page.svelte` does on every re-render (it derives the list from the polled target status). Measured against the deployed relay, a prompt typed into the open dialog was wiped within a second, repeatedly. The reset now fires on the closed-to-open transition instead, which also covers `open` being re-assigned the same `true`.
