---
'@loombox/web': patch
---

Tool calls in the transcript now rest as a single line (command plus outcome), with output behind a disclosure instead of always expanded — a passing multi-line call costs the same row as a one-liner until you click to expand it. A failed call is the one exception: it always renders in full, uncapped, with its disclosure locked open so it can't be collapsed by accident. Consecutive tool calls now render as a tight, compact list instead of each carrying full turn spacing.
