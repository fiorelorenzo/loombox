---
'@loombox/web': patch
---

Say why a GitHub sign-in failed instead of doing nothing

`AuthStore.signInWithGithub` called Better Auth's `signIn.social` and ignored
what came back. That client reports failures in `{ error }` rather than throwing
(the two email/password paths beside it already check it), so a relay with no
GitHub provider configured answered `404 PROVIDER_NOT_FOUND`, the promise
resolved as if a redirect had started, and the button was simply dead: no
navigation, no message, nothing in the UI to explain it.

That is the exact state a relay starts in without `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` in its env, so the message names both the relay's URL and
the missing pair rather than passing Better Auth's bare "Provider not found"
through. The `/device` approval page's own sign-in button never caught anything
either, so it turned a failure into an unhandled rejection; it now shows the
same notice the cockpit does.

`scripts/dev.sh` grows a matching preflight: a non-empty client id is not a real
one, and this loop ran for three days on a hand-exported placeholder, where
every process came up healthy and the only symptom was github.com's own error
page at the end of the redirect. GitHub's device-code endpoint distinguishes an
unregistered client id (`Not Found`) from a real app (`device_flow_disabled`)
with no user session and no secret, so the loop now refuses to start on a client
id GitHub has never heard of, and prints how to register one.
