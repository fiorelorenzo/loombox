// Real-process fixture for `../../src/node-lock.test.ts`'s issue #929
// acceptance tests: acquires `acquireNodeLock` against `process.argv[2]`
// (the state dir), reports the outcome on stdout/stderr with an exit code
// the parent test can assert on, then — only on a successful acquire —
// blocks forever so the parent controls this process's lifetime (a normal
// exit, a SIGTERM, or a SIGKILL, depending which behavior the test needs).
//
// Run via `node --import tsx/esm` (never the forking `tsx` CLI — this file
// imports the real TS source under test, and using the CLI wrapper here
// would blur exactly the distinction issue #929 is about: the parent's
// `child_process.spawn` pid needs to be the process actually holding the
// lock, not a wrapper in front of it).
import { acquireNodeLock, NodeLockHeldError } from '../../src/node-lock';

const stateDir = process.argv[2];
if (!stateDir) {
  console.error('node-lock-holder: missing state dir argv');
  process.exit(2);
}

try {
  const lock = acquireNodeLock({ stateDir, nodeId: 'fixture-node' });
  // Parent scans stdout for this exact marker before proceeding.
  console.log(`LOCKED pid=${process.pid} path=${lock.path}`);
  // Keeps the event loop alive indefinitely so this process only ever
  // ends via a signal the parent test sends (a plain unresolved promise
  // does NOT do this: with nothing else pending, Node exits early on its
  // own with "unfinished top-level await" — exit code 13 — rather than
  // actually waiting; a live timer is what `systemd-local-supervisor-
  // backend.test.ts`'s own "keep this process alive" fixture uses too,
  // there via a listening socket instead of a timer for the same reason).
  setInterval(() => {}, 60_000);
} catch (error) {
  if (error instanceof NodeLockHeldError) {
    console.error(`REFUSED pid=${error.holderPid}: ${error.message}`);
    process.exit(1);
  }
  console.error(`UNEXPECTED_ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(3);
}
