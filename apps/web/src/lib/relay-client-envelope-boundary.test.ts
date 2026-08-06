import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const relayClientSource = readFileSync(join(here, 'relay-client.ts'), 'utf8');

/**
 * Asserts "no `crypto.subtle` call for session traffic remains on the main
 * thread" (issue #756's acceptance criterion) at the source level — a
 * lint-rule-style check, not a runtime one, because a runtime assertion
 * cannot observe *which thread* ran a given call from inside the same
 * single-threaded Node test process (see `envelope-crypto-client.ts`'s
 * `InlineEnvelopeCrypto` doc comment). What a static check on this exact
 * file CAN and does prove: `relay-client.ts` — the module that runs on the
 * real browser/Electron main thread — no longer imports or calls any
 * primitive that touches `crypto.subtle` for session/project/target
 * envelope traffic; every one of those now goes through
 * `this.envelopeCrypto` (`envelope-crypto-client.ts`), which is
 * worker-backed in a real browser/Electron (`createEnvelopeCrypto`).
 *
 * Deliberately NOT asserted against here: `unwrapAmkWithRecoveryCode`
 * (device-bootstrap-time AMK unwrap, SPEC §8 path 2) and
 * `exportPublicKeyRaw`/`generateEcdhKeyPair` (device ECDH identity) — both
 * one-shot device-lifecycle operations, not per-envelope session traffic,
 * and out of this issue's stated scope (see the PR body's boundary
 * discussion).
 */
describe('relay-client.ts never touches crypto.subtle directly (issue #756)', () => {
  it('contains no literal `crypto.subtle` call', () => {
    expect(relayClientSource).not.toMatch(/crypto\.subtle/);
  });

  it.each([
    'openJson',
    'sealJson',
    'aesGcmEncrypt',
    'aesGcmDecrypt',
    'encryptEnvelope',
    'decryptEnvelope',
    'deriveSessionKey',
    'deriveProjectKey',
    'deriveKeyTree',
    'importAesGcmKey',
    'wrapAmkWithRecoveryCode',
  ])('does not import %s from @loombox/crypto', (symbol) => {
    const cryptoImportBlock = relayClientSource.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*'@loombox\/crypto';/,
    );
    expect(cryptoImportBlock).not.toBeNull();
    expect(cryptoImportBlock![1]).not.toMatch(new RegExp(`\\b${symbol}\\b`));
  });

  it('routes session/project/target envelope operations through `this.envelopeCrypto`', () => {
    // Matches both single-line (`this.envelopeCrypto.seal(...)`) and
    // wrapped multi-line (`this.envelopeCrypto\n  .open<T>(...)`) call
    // sites, plus the one constructor assignment — 31 real call sites
    // (session_update, permission_request, fs_list_response,
    // fs_read_response, git_diff_response, git_hunk_action_response,
    // tracker_snapshot/write_response, test_runner_config_result/detected,
    // target_fs_list_response, terminal_opened/output/closed,
    // run_started/output/exit, decryptSessionMeta = 18 opens;
    // target_fs_list_request, test_runner_config_set, session_create,
    // terminal_input/resize, prompt_inject, fs_list_request,
    // fs_read_request, git_hunk_action_request, tracker_snapshot/
    // write_request, terminal_open, run_start = 12 seals; blob_upload = 1
    // sealBytes; escrowAmk = 1 wrapAmkForEscrow) plus the constructor
    // assignment — a regression here means a new/changed call site
    // reached back into direct `@loombox/crypto` primitives instead.
    // git_diff_request/git_hunk_diff_request themselves carry no envelope
    // at all (see `@loombox/protocol`'s `git-diff.ts`/`git-hunks.ts` doc
    // comments), so neither adds a seal call here.
    const matches = relayClientSource.match(/this\.envelopeCrypto\b/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(25);
  });

  it("keeps no `CryptoKey`-typed field or raw AMK field on the class (moved into envelope-crypto-client.ts's engine)", () => {
    expect(relayClientSource).not.toMatch(/private readonly amk: Uint8Array/);
    expect(relayClientSource).not.toMatch(/CryptoKey/);
  });
});
