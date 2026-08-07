import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type {
  AgentInstructionsFileNameV1,
  AgentInstructionsFileStateV1,
  AgentInstructionsSetRequestPayloadV1,
  AgentInstructionsSetResponsePayloadV1,
} from '@loombox/protocol';
import type { ExecutionTarget } from './target';

/**
 * Per-project agent instructions (SPEC §7.18; issue #260) — reads and
 * writes a project's own `AGENTS.md`/`CLAUDE.md`, both of which live at
 * the session's worktree root. This is not a new store: unlike every
 * `*-store.ts` sibling in this package (which own a JSON record under
 * `NodeDaemonOptions.stateDir`), the file itself IS the state — it lives
 * in the project's own worktree and belongs to the repo, so `NodeDaemon`
 * reads and writes it straight through the session's `ExecutionTarget`
 * (`readFile`/`writeFile`), exactly the same seam `./git-diff.ts` drives
 * `git` through for the SAME reason (works identically against a `local`
 * or an `ssh:` target).
 *
 * The write side is optimistic-concurrency (`@loombox/protocol`'s
 * `agent-instructions.ts` doc comment has the full contract): every read
 * is hashed with {@link hashAgentInstructionsContent}, and a write is
 * refused with a `'conflict'` outcome — never applied — when the file's
 * current hash doesn't match the `baseHash` the edit started from. This
 * module never silently overwrites; `writeAgentInstructionsFile` only
 * ever calls `ExecutionTarget.writeFile` once the hashes are confirmed to
 * match.
 */

export const AGENT_INSTRUCTIONS_FILE_NAMES: readonly AgentInstructionsFileNameV1[] = [
  'AGENTS.md',
  'CLAUDE.md',
];

/** Thrown only when the project's worktree itself isn't reachable at all (missing, a transport failure against an `ssh:` target, ...) — never for an individual file simply not existing, which both functions below treat as ordinary "not present" state, matching `./git-diff.ts`'s `readWorktreeFile`'s identical degrade-not-fail contract for a single file. */
export class AgentInstructionsError extends Error {}

/** This pair's own optimistic-concurrency token (SPEC §7.18's "never overwrite blindly" acceptance line) — plain sha256 over the exact bytes a caller would see, never a git blob hash or mtime, since a `local` and an `ssh:` target expose neither uniformly through `ExecutionTarget`. */
export function hashAgentInstructionsContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** `worktreePath`'s reachability canary: a directory listing that must succeed for anything else here to mean anything (mirrors `computeWorktreeDiff`'s own `git status` canary in `./git-diff.ts`, adapted to plain filesystem primitives since this module never shells out to `git`). Throws {@link AgentInstructionsError} on failure — a missing/unreadable worktree, or an `ssh:` transport failure. */
async function assertWorktreeReachable(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<void> {
  try {
    await target.readdir(worktreePath);
  } catch (error) {
    throw new AgentInstructionsError(
      `project worktree is not reachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `filePath`'s current content, or `null` if it doesn't exist (or can't be read for any other reason) — never throws, the same "a per-file lookup failure degrades, it never fails the whole call" contract `./git-diff.ts`'s `readWorktreeFile` already documents. Callers that need to distinguish "truly missing" from "worktree unreachable" call {@link assertWorktreeReachable} first. */
async function readFileOrNull(target: ExecutionTarget, filePath: string): Promise<string | null> {
  try {
    return await target.readFile(filePath);
  } catch {
    return null;
  }
}

/** Every `AGENTS.md`/`CLAUDE.md` that actually exists at `worktreePath`'s root right now, each hashed via {@link hashAgentInstructionsContent}. `[]` for a project with neither — never an error; that's the client's cue to offer creating one. Throws {@link AgentInstructionsError} only when the worktree itself isn't reachable at all. */
export async function readAgentInstructionsFiles(
  target: ExecutionTarget,
  worktreePath: string,
): Promise<AgentInstructionsFileStateV1[]> {
  await assertWorktreeReachable(target, worktreePath);

  const files: AgentInstructionsFileStateV1[] = [];
  for (const fileName of AGENT_INSTRUCTIONS_FILE_NAMES) {
    const content = await readFileOrNull(target, posix.join(worktreePath, fileName));
    if (content === null) continue;
    files.push({ fileName, content, hash: hashAgentInstructionsContent(content) });
  }
  return files;
}

/**
 * Saves `payload.fileName` inside `worktreePath` — but only when
 * `payload.baseHash` still matches what's actually on disk right now
 * (`null` on both sides means "creating a file that doesn't exist yet").
 * Returns an `'ok'` or `'conflict'` outcome directly (both are legitimate
 * business results, not failures); throws {@link AgentInstructionsError}
 * only for a genuine I/O failure (worktree unreachable, permission
 * denied, an `ssh:` transport failure, ...), for the caller
 * (`NodeDaemon.writeAgentInstructionsForBridge`) to fold into the wire
 * pair's own `'error'` outcome — the same throw/catch split
 * `applyGitHunkAction`/`computeWorktreeDiff` already use in `./git-diff.ts`.
 */
export async function writeAgentInstructionsFile(
  target: ExecutionTarget,
  worktreePath: string,
  payload: AgentInstructionsSetRequestPayloadV1,
): Promise<AgentInstructionsSetResponsePayloadV1> {
  await assertWorktreeReachable(target, worktreePath);

  const filePath = posix.join(worktreePath, payload.fileName);
  const currentContent = await readFileOrNull(target, filePath);
  const current: AgentInstructionsFileStateV1 | null =
    currentContent === null
      ? null
      : {
          fileName: payload.fileName,
          content: currentContent,
          hash: hashAgentInstructionsContent(currentContent),
        };

  if ((current?.hash ?? null) !== payload.baseHash) {
    return { outcome: 'conflict', fileName: payload.fileName, current };
  }

  try {
    await target.writeFile(filePath, payload.content);
  } catch (error) {
    throw new AgentInstructionsError(
      `failed to write ${payload.fileName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    outcome: 'ok',
    fileName: payload.fileName,
    content: payload.content,
    hash: hashAgentInstructionsContent(payload.content),
  };
}
