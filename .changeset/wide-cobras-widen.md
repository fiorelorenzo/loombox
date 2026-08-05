---
"@loombox/web": patch
---

Widened the transcript's reading measure from 90ch to 100ch (v8 decision A1-1). One token, `--measure` in `tokens.css`; the transcript column, the composer/toolbar strip beneath it, and the escrow/auth banner all read wider since they were already tied to the same value. `--measure-wide` (diffs, code, terminal, page shells) is untouched at 120ch and stays inert inside the transcript, same as before.
