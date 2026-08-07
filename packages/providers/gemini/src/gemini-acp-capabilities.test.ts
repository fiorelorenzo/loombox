import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { deriveFeatureFlags } from '@loombox/providers-core';
import type {
  AcpAgentCapabilities,
  AcpPermissionOption,
  AcpToolKind,
} from '@loombox/providers-core';
import { classifyGenericToolKind, mapGenericPermissionOptions } from '@loombox/providers-generic';
import { describe, expect, it } from 'vitest';

/**
 * Build-time ACP completeness verification (issue #272, epic #19; mirrors
 * issue #182's Codex spike, `docs/research/codex-acp-completeness.md`).
 *
 * Unlike the Codex spike, this suite does NOT read a pinned devDependency's
 * `node_modules` source: `@google/gemini-cli` (npm, the same package the
 * ACP registry / `agent-catalogue.ts`'s `gemini-cli` entry verifies against)
 * is a 20.7 MB compressed / 97.8 MB unpacked, 448-file, code-split CLI
 * bundle (checked with `npm view @google/gemini-cli dist.unpackedSize
 * dist.fileCount`, not assumed) — nothing like `@agentclientprotocol/
 * codex-acp`'s single 1.2 MB `dist/index.js`. Vendoring that as a
 * devDependency of this package for a text-grep would be disproportionate
 * (see `docs/research/gemini-acp-completeness.md`'s Method section for the
 * full weight comparison), and its dozens of hashed `chunk-*.js` files
 * aren't a stable citation target run to run.
 *
 * Instead this fixture (`test/fixtures/gemini-acp-live-probe.json`) is a
 * REAL recording: `npx -y @google/gemini-cli@0.54.0 --acp` was actually
 * spawned and sent a real `initialize` request plus one request per
 * candidate session-lifecycle method, over real stdio, no credentials
 * configured — the same recording convention
 * `packages/providers/core/test/fixtures/omp-acp-session-new-response.json`
 * already established for a real `omp acp` binary. This is a live
 * end-to-end run, not source-inspection-only — a step further than the
 * Codex spike could take (it had no real `codex` binary/credentials on the
 * devbox). Corroborated against the real TypeScript source at the exact
 * commit GitHub's `v0.54.0` tag resolves to
 * (`a74b483d14a93159fa36e7ee9e32cf44bda594df`), cited throughout
 * `docs/research/gemini-acp-completeness.md`.
 *
 * The whole point, same as Codex's suite: re-run the recording against a
 * newer `gemini-cli` release (the version lives in the fixture's own
 * `_recordedFrom.version`, checked below) and if a capability or method
 * loombox relies on changed shape, the relevant assertion here goes red in
 * CI instead of a user discovering it live.
 */
const VERIFIED_GEMINI_CLI_VERSION = '0.54.0';

const require = createRequire(import.meta.url);
const fixturePath = require.resolve('../test/fixtures/gemini-acp-live-probe.json');
interface GeminiAcpLiveProbeFixture {
  _recordedFrom: { package: string; version: string };
  initializeResult: {
    protocolVersion: number;
    agentInfo?: { name: string; title?: string; version: string };
    agentCapabilities?: AcpAgentCapabilities;
  };
  methodProbe: Array<{
    method: string;
    response: { result?: unknown; error?: { code: number; message: string } };
  }>;
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GeminiAcpLiveProbeFixture;

function methodProbeFor(method: string) {
  const entry = fixture.methodProbe.find((probe) => probe.method === method);
  if (!entry) throw new Error(`fixture has no recorded probe for method ${method}`);
  return entry.response;
}

describe('real gemini-cli --acp source/wire (issue #272 build-time verification spike)', () => {
  it('the fixture is pinned to the exact version this suite verified, so a version bump is a deliberate re-verification', () => {
    expect(fixture._recordedFrom.package).toBe('@google/gemini-cli');
    expect(fixture._recordedFrom.version).toBe(VERIFIED_GEMINI_CLI_VERSION);
    expect(fixture.initializeResult.agentInfo?.version).toBe(VERIFIED_GEMINI_CLI_VERSION);
  });

  describe('initialize: agentCapabilities Gemini CLI actually advertises', () => {
    it('advertises promptCapabilities.image/audio/embeddedContext and mcpCapabilities.http/sse, matching capabilities.ts', () => {
      expect(fixture.initializeResult.agentCapabilities).toMatchObject({
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      });
    });

    it('[real Gemini gap] advertises NO sessionCapabilities field at all, despite loadSession: true', () => {
      // acpRpcDispatcher.ts's real initialize() (GitHub a74b483d, packages/cli/
      // src/acp/acpRpcDispatcher.ts) returns agentCapabilities with exactly
      // {loadSession, promptCapabilities, mcpCapabilities} — no
      // sessionCapabilities key whatsoever, unlike Codex's (which sets
      // resume/list/close/delete/additionalDirectories all to {}). Flip this
      // to `.toBeDefined()` to see the suite go red today (see this file's
      // header + docs/research/gemini-acp-completeness.md's Executable
      // checks section for the recorded before/after).
      expect(fixture.initializeResult.agentCapabilities?.sessionCapabilities).toBeUndefined();
    });
  });

  describe('session lifecycle: which methods Gemini CLI actually implements', () => {
    it('session/resume, session/list, session/close, session/delete are all unimplemented (-32601, same code as a deliberately bogus method)', () => {
      const bogus = methodProbeFor('totally/bogus/method');
      expect(bogus.error?.code).toBe(-32601);

      for (const method of ['session/resume', 'session/list', 'session/close', 'session/delete']) {
        const probed = methodProbeFor(method);
        expect(probed.error?.code).toBe(-32601);
        expect(probed.error?.message).toContain(method);
      }
    });

    it('session/load and session/new ARE implemented — real methods rejecting on missing auth, not "Method not found"', () => {
      const load = methodProbeFor('session/load');
      const newSession = methodProbeFor('session/new');
      expect(load.error?.code).toBe(-32000);
      expect(load.error?.message).not.toContain('Method not found');
      expect(newSession.error?.code).toBe(-32000);
      expect(newSession.error?.message).not.toContain('Method not found');
    });
  });
});

describe("real-shape conformance: loombox's capability derivation and generic tier against Gemini's real data", () => {
  it('[issue #843 resolved] deriveFeatureFlags reports supportsResume: true via the session/load fallback, even though sessionCapabilities.resume itself is genuinely absent', () => {
    // sessionCapabilities really is absent for Gemini (confirmed above) —
    // that part of issue #821's finding still holds. What changed: issue
    // #843 gave packages/providers/core/src/client.ts's resumeSession() a
    // session/load fallback for exactly this shape (loadSession: true, no
    // sessionCapabilities.resume), so a Gemini session genuinely CAN be
    // resumed via loombox's client now — reporting supportsResume: false
    // here would be capability reporting saying what we wish were, not
    // what's genuinely available, the opposite of what this suite exists
    // to hold honest. supportsAdditionalDirectories/supportsSessionDelete
    // stay false: session/load has no equivalent fallback for either (it
    // only ever substitutes for session/resume).
    const flags = deriveFeatureFlags(fixture.initializeResult.agentCapabilities);
    expect(flags).toEqual({
      supportsImages: true,
      supportsAudio: true,
      supportsEmbeddedContext: true,
      supportsResume: true,
      supportsAdditionalDirectories: false,
      supportsSessionDelete: false,
    });
  });

  it('mapGenericPermissionOptions handles the real Gemini button set (Allow/Reject plus an optional "Allow for this session"), never producing a deny_always the generic tier would have to invent', () => {
    // acpUtils.ts's real basicPermissionOptions + the 'edit'/'exec' branch of
    // toPermissionOptions (GitHub a74b483d) — Gemini never sends a
    // reject_always-kind option at all.
    const realEditConfirmationOptions: AcpPermissionOption[] = [
      { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
    ];
    expect(mapGenericPermissionOptions(realEditConfirmationOptions).map((b) => b.verb)).toEqual([
      'allow_always',
      'allow',
      'deny',
    ]);
  });

  it("[corroborates issue #822, not re-filed] classifyGenericToolKind passes a real Gemini switch_mode tool call through at runtime, though AcpToolKind's TYPE has no such member", () => {
    // acpUtils.ts's toAcpToolKind (GitHub a74b483d) maps Gemini's own
    // Kind.SwitchMode straight through to the ACP-standard 'switch_mode'
    // value — the same real ACP v1 ToolKind Codex's spike found Codex could
    // also send (issue #822). classifyGenericToolKind is a passthrough
    // (`update.toolKind ?? 'other'`) so it survives an untyped value fine at
    // runtime; the cast below is what a real caller would need today since
    // AcpToolKind's declared union (types.ts) still doesn't include it.
    const realSwitchModeToolCall = { toolKind: 'switch_mode' as unknown as AcpToolKind };
    expect(classifyGenericToolKind(realSwitchModeToolCall)).toBe('switch_mode');
  });
});
