---
'@loombox/web': minor
---

Checkpoint list, on-demand "checkpoint now", and a restore confirmation dialog (SPEC §7.20, issue #268) over the wire surface #603/PR #805 built. `RelayClient` gains `createCheckpoint`/`listCheckpoints`/`previewCheckpointRestore`/`restoreCheckpoint`, each resolving the whole `checkpoint_*_result` outcome union (`'ok'` | `'error'`, `restoreCheckpoint` also `'confirmation_required'`) rather than throwing for a named `errorType` — an `ssh:` session's `unsupported_target` or a live turn's `turn_in_progress` are expected, renderable states, not transport failures.

A new "Checkpoints" right-sidebar sub-tab (`CheckpointPanel.svelte`, beside Files/Config/Runner) lists a session's checkpoints oldest-to-newest-on-screen with their label and time, offers a "Checkpoint now" affordance with an optional label, and opens `CheckpointRestoreDialog.svelte` per row. The dialog loads `checkpoint_restore_preview`'s own `RestorePreview` before ever enabling its "Restore checkpoint" button, states exactly what will be discarded (uncommitted changes) versus preserved (real commits since the checkpoint), and gives a sharper warning when `isWorkInPlace` is set. An `ssh:` session's list renders a dedicated "checkpoints aren't available here" state instead of a dead "Checkpoint now" button or a generic error; a restore refused mid-turn shows the node's own `turn_in_progress` message verbatim, never a generic failure.

Kept deliberately scoped to the checkpoint list and its dialog — issue #747 (rewind) consumes the same `GitCheckpointStore` engine from the transcript side in parallel and owns its own files.
