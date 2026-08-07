import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { deriveFeatureFlags } from '@loombox/providers-core';
import type {
  AcpAgentCapabilities,
  AcpPermissionOption,
  AcpToolCallUpdate,
} from '@loombox/providers-core';
import { describe, expect, it } from 'vitest';

import { buildCodexImageContentBlock } from './image';
import { mapCodexPermissionOptions } from './permissions';
import { codexBespokeToolName, hasCodexBespokeWidget } from './tool-widgets';

/**
 * Build-time ACP completeness verification (issue #182, epic #19; SPEC.md
 * §10/§12's "Codex's ACP completeness verified at build time" gate).
 *
 * This suite reads the REAL, installed `@agentclientprotocol/codex-acp`
 * package — a pinned `devDependency` of this package added for exactly this
 * spike, never a runtime dependency: Codex is still only ever spawned via
 * `npx` at a floating version (`provider.ts`'s `CODEX_ACP_ARGS`) — and
 * asserts, as plain source-text checks against its bundled `dist/index.js`,
 * that the specific ACP capabilities loombox depends on are still there.
 * `dist/index.js` is an esbuild bundle that preserves the original
 * `src/*.ts` file-path comments and unminified identifiers/strings
 * (confirmed by reading it), so string/regex assertions against it are a
 * faithful proxy for the real TypeScript source Codex's maintainers
 * publish. Full citation trail, including the doc-URL corroboration for the
 * `agentCapabilities` shape: `docs/research/codex-acp-completeness.md`.
 *
 * The whole point: bump the pinned version below to pick up a newer
 * `codex-acp` release, and if that release drops or renames a capability
 * loombox relies on, the relevant assertion here goes red in CI instead of
 * a user discovering it live. The version is intentionally an exact pin,
 * not a caret range — this suite is a reviewed, deliberate re-verification
 * gate, not something that silently re-verifies itself on every
 * `pnpm install`.
 */
const VERIFIED_CODEX_ACP_VERSION = '1.1.10';

const require = createRequire(import.meta.url);
const codexAcpPackageJsonPath = require.resolve('@agentclientprotocol/codex-acp/package.json');
const codexAcpPackageDir = path.dirname(codexAcpPackageJsonPath);
const codexAcpPackageJson: unknown = JSON.parse(readFileSync(codexAcpPackageJsonPath, 'utf8'));
const codexAcpSource = readFileSync(path.join(codexAcpPackageDir, 'dist', 'index.js'), 'utf8');

function hasNonEmptyStringVersion(value: unknown): value is { version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    value.version.length > 0
  );
}

function packageVersion(pkg: unknown): string {
  if (!hasNonEmptyStringVersion(pkg)) {
    throw new Error(
      'test fixture: @agentclientprotocol/codex-acp package.json has no valid "version" field',
    );
  }
  return pkg.version;
}

describe('real @agentclientprotocol/codex-acp source (issue #182 build-time verification spike)', () => {
  it('is pinned to the exact version this suite verified, so a version bump is a deliberate re-verification', () => {
    expect(packageVersion(codexAcpPackageJson)).toBe(VERIFIED_CODEX_ACP_VERSION);
  });

  describe('initialize: agentCapabilities Codex actually advertises', () => {
    it('advertises promptCapabilities.image and embeddedContext (image.ts/capabilities.ts depend on this)', () => {
      expect(codexAcpSource).toContain(
        'promptCapabilities: {\n          embeddedContext: true,\n          image: true\n        }',
      );
    });

    it('advertises loadSession: true (gates the older session/load resume path)', () => {
      expect(codexAcpSource).toContain('loadSession: true,\n        promptCapabilities:');
    });

    it('advertises sessionCapabilities.resume/list/close/delete/additionalDirectories (issue #821)', () => {
      expect(codexAcpSource).toContain(
        'sessionCapabilities: {\n          resume: {},\n          list: {},\n          close: {},\n          delete: {},\n          additionalDirectories: {}\n        }',
      );
    });
  });

  describe('session/request_permission: the real ApprovalOptionId / PermissionOptionKind vocabulary', () => {
    it('still only emits the four ACP PermissionOptionKind values permissions.ts switches on', () => {
      expect(codexAcpSource).toContain(
        'var ApprovalOptionId = {\n  AllowOnce: "allow_once",\n  AllowAlways: "allow_always",\n  RejectOnce: "reject_once",',
      );
    });

    it('labels its buttons in Allow*/Reject vocabulary, never the "Yes"/"Stop, and explain" text SPEC.md previously assumed (issue #820)', () => {
      expect(codexAcpSource).toContain(
        'permissionOption(ApprovalOptionId.AllowOnce, "Allow Once", "allow_once"',
      );
      expect(codexAcpSource).toContain(
        'permissionOption(ApprovalOptionId.RejectOnce, "Reject", "reject_once", { decision: "decline" })',
      );
      expect(codexAcpSource).not.toMatch(/"Yes,? for this session"/);
      expect(codexAcpSource).not.toMatch(/Stop,? and explain/);
    });
  });

  describe('tool_call: the real title/kind shapes bespoke widgets must match (issue #819)', () => {
    it('titles a file-change tool call "Editing files" with kind "edit", never "Patch"/"Diff"', () => {
      expect(codexAcpSource).toContain(
        'title: "Editing files",\n    kind: "edit",\n    status: toAcpStatus(item.status),',
      );
    });

    it('strips a leading bash/zsh/sh shell prefix from a command title before it ever reaches ACP', () => {
      expect(codexAcpSource).toContain(
        'function stripShellPrefix(command) {\n  const withoutShell = command.replace(/^(?:\\/bin\\/)?(?:bash|zsh|sh)\\s+(?:-[lc]+\\s+)?/, "");',
      );
    });
  });

  describe('image content blocks: the data: URL hand-off SPEC.md §7.25/§16 already claims', () => {
    it('still converts an inline image ContentBlock into a data: URL exactly as documented', () => {
      expect(codexAcpSource).toContain(
        'function imageDataUrl(block) {\n  return `data:${block.mimeType};base64,${block.data}`;\n}',
      );
    });
  });
});

describe("real-shape conformance: loombox's Codex adapter functions against actual source-verified data", () => {
  it('mapCodexPermissionOptions resolves the right verb from real Codex button labels via the text rule itself (issue #820: the text rule is the primary path now, not just the kind fallback)', () => {
    const realCommandOptions: AcpPermissionOption[] = [
      { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Allow for Session', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];
    expect(mapCodexPermissionOptions(realCommandOptions).map((b) => b.verb)).toEqual([
      'allow_once',
      'allow_for_session',
      'reject',
    ]);
  });

  it('[fixed, issue #819] hasCodexBespokeWidget fires for a real Codex edit tool call titled "Editing files"', () => {
    const realEditToolCall: Pick<AcpToolCallUpdate, 'title' | 'toolKind'> = {
      title: 'Editing files',
      toolKind: 'edit',
    };
    expect(hasCodexBespokeWidget(realEditToolCall)).toBe(true);
    expect(codexBespokeToolName(realEditToolCall)).toBe('edit');
  });

  it('[fixed, issue #819] hasCodexBespokeWidget fires for a real Codex command tool call by toolKind alone (its bash prefix is already stripped from the title)', () => {
    const realCommandToolCall: Pick<AcpToolCallUpdate, 'title' | 'toolKind'> = {
      title: 'ls -la',
      toolKind: 'execute',
    };
    expect(hasCodexBespokeWidget(realCommandToolCall)).toBe(true);
    expect(codexBespokeToolName(realCommandToolCall)).toBe('bash');
  });

  it('[fixed, issue #819] hasCodexBespokeWidget does not fire for a real Codex sub-action tool call outside the bespoke set', () => {
    const realReadToolCall: Pick<AcpToolCallUpdate, 'title' | 'toolKind'> = {
      title: "Read file 'src/foo.ts'",
      toolKind: 'read',
    };
    expect(hasCodexBespokeWidget(realReadToolCall)).toBe(false);
  });

  it('buildCodexImageContentBlock is gated on the real negotiated image capability, which Codex does advertise', () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
    // #158 changed this builder's return from a bare block to a discriminated
    // result (`{ ok: true, block }` / `{ ok: false, reason }`), so the block now
    // hangs off `.block`. The two landed the same night from different branches,
    // each green on its own, and only crossed on main.
    const result = buildCodexImageContentBlock(pngBytes, { imageCapabilityNegotiated: true });
    expect(result.ok).toBe(true);
    expect(result.ok && result.block.mimeType).toBe('image/png');
  });

  it("deriveFeatureFlags reports supportsSessionDelete/supportsAdditionalDirectories/supportsResume correctly against Codex's real capabilities, reading the real nested/renamed fields (issue #821 fix)", () => {
    // Codex's real agentCapabilities shape (dist/index.js:28773-28795):
    // `delete`/`additionalDirectories` live nested under
    // `sessionCapabilities`, and the method AcpClient's resumeSession()
    // actually calls (session/resume) is gated by
    // `sessionCapabilities.resume`, not the older top-level `loadSession`
    // flag (which gates session/load, a method this client never calls).
    const realCodexAgentCapabilities: AcpAgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: {
        resume: {},
        list: {},
        close: {},
        delete: {},
        additionalDirectories: {},
      },
    };
    const flags = deriveFeatureFlags(realCodexAgentCapabilities);
    expect(flags.supportsSessionDelete).toBe(true);
    expect(flags.supportsAdditionalDirectories).toBe(true);
    expect(flags.supportsResume).toBe(true);
  });

  it('deriveFeatureFlags reports supportsResume: false for an agent that sets the older loadSession flag but not sessionCapabilities.resume (issue #821: loadSession gates session/load, a different method than the one this client calls)', () => {
    const loadSessionOnlyAgent: AcpAgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
    };
    expect(deriveFeatureFlags(loadSessionOnlyAgent).supportsResume).toBe(false);
  });
});
