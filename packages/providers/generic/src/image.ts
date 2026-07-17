import type { AcpResourceLinkContentBlock } from '@loombox/providers-core';
import { IMAGE_EXTENSION_BY_MIME_TYPE, sniffImageMimeType } from '@loombox/providers-core';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The generic ACP fallback image hand-off (issue #159; SPEC.md §7.25: "Any
 * generic ACP adapter without the `image` capability writes the same temp
 * file and sends a `ContentBlock::ResourceLink` instead — protocol-
 * guaranteed for every ACP agent, not a per-CLI text convention"). Also
 * SPEC.md's defensive-fallback path for an adapter (including Claude) that
 * genuinely requires a local path despite advertising the image capability.
 *
 * These functions implement the *mechanism* only — writing/naming/cleaning
 * up the temp file. Actually invoking `cleanup()` at end of turn, and
 * scheduling `sweepStaleImageTempDirs` on a recurring timer, is the
 * supervisor's job (`packages/supervisor`, out of scope for this package;
 * SPEC.md §7.25 calls the temp file "supervisor-owned"). Both callers are
 * expected to run these against already-decrypted bytes handed to them by
 * the supervisor's own fetch-and-decrypt step.
 */

const DEFAULT_TEMP_DIR_PREFIX = 'loombox-image-';
/** SPEC.md §7.25's "24-hour sweep". */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ImageTempFileHandle {
  /** Absolute path to the written file. */
  path: string;
  /** The sniffed mime type (never a caller-declared one). */
  mimeType: string;
  /** Deletes the file and its containing temp directory. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Writes `bytes` to a fresh temp file: outside the project/worktree (always
 * under `os.tmpdir()`, never a caller-supplied project path), a 0700
 * directory (`fs.mkdtemp`'s own POSIX guarantee) holding a single 0600
 * file, both random-named — satisfying SPEC.md §7.25's "outside the
 * project/worktree, 0700 dir / 0600 file, random name" bullet in full.
 * The mime type is sniffed from the bytes themselves, same rule as the
 * Claude inline path (`@loombox/providers-claude`'s
 * `buildClaudeImageContentBlock`) — an unrecognized format still gets a
 * generic `application/octet-stream` file rather than failing the hand-off.
 */
export async function writeImageTempFile(
  bytes: Uint8Array,
  opts: { dirPrefix?: string } = {},
): Promise<ImageTempFileHandle> {
  const mimeType = sniffImageMimeType(bytes) ?? 'application/octet-stream';
  const extension =
    mimeType in IMAGE_EXTENSION_BY_MIME_TYPE
      ? IMAGE_EXTENSION_BY_MIME_TYPE[mimeType as keyof typeof IMAGE_EXTENSION_BY_MIME_TYPE]
      : 'bin';

  const dirPrefix = opts.dirPrefix ?? DEFAULT_TEMP_DIR_PREFIX;
  const dir = await mkdtemp(path.join(tmpdir(), dirPrefix));
  const fileName = `${randomBytes(16).toString('hex')}.${extension}`;
  const filePath = path.join(dir, fileName);

  await writeFile(filePath, bytes, { mode: 0o600 });

  return {
    path: filePath,
    mimeType,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Builds the ACP `ContentBlock::ResourceLink` pointing at a temp file
 * written by `writeImageTempFile` (issue #159's other acceptance bullet).
 */
export function buildImageResourceLinkContentBlock(
  handle: Pick<ImageTempFileHandle, 'path' | 'mimeType'>,
  opts: { name?: string; size?: number } = {},
): AcpResourceLinkContentBlock {
  return {
    type: 'resource_link',
    uri: `file://${handle.path}`,
    mimeType: handle.mimeType,
    name: opts.name,
    size: opts.size,
  };
}

/**
 * Deletes every temp directory under `baseDir` matching `dirPrefix` whose
 * last-modified time is older than `maxAgeMs` — the "24-hour sweep [that]
 * cleans up any temp file that outlives its turn" (SPEC.md §7.25, issue
 * #159's third acceptance bullet). Pure best-effort: a directory that
 * disappears mid-sweep (a race with another cleanup) is silently skipped,
 * never thrown on. Returns the paths actually removed, for logging/tests.
 */
export async function sweepStaleImageTempDirs(
  opts: { baseDir?: string; dirPrefix?: string; maxAgeMs?: number } = {},
): Promise<string[]> {
  const baseDir = opts.baseDir ?? tmpdir();
  const dirPrefix = opts.dirPrefix ?? DEFAULT_TEMP_DIR_PREFIX;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = Date.now();
  const removed: string[] = [];

  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(dirPrefix)) continue;
    const dirPath = path.join(baseDir, entry.name);
    try {
      const info = await stat(dirPath);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(dirPath, { recursive: true, force: true });
        removed.push(dirPath);
      }
    } catch {
      // Raced with another cleanup, or a permissions blip: skip, don't throw.
    }
  }

  return removed;
}
