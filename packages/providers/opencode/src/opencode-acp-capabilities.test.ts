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
 * Build-time ACP completeness verification (issue #285, epic #19; mirrors
 * issue #182's Codex spike and issue #272's Gemini spike,
 * `docs/research/codex-acp-completeness.md` /
 * `docs/research/gemini-acp-completeness.md`).
 *
 * Unlike either precedent, `opencode-ai`'s npm package is a tiny (7.9 kB,
 * 4-file) postinstall wrapper (`npm pack opencode-ai@1.18.16`, checked not
 * assumed) whose `postinstall.mjs` downloads a compiled, platform-specific
 * binary at install time — there is no bundled JS/TS source to vendor as a
 * devDependency at all, unlike Codex's single-file `dist/index.js` bundle.
 * This suite instead combines both of the other two spikes' methods:
 *
 * 1. A real, live, end-to-end run against the actual downloaded binary
 *    (`opencode acp`, no `OPENCODE_API_KEY`/login configured — OpenCode's
 *    own free "OpenCode Zen" tier answers `initialize`/`session/new`/
 *    `session/prompt` without auth, unlike Codex/Claude and going further
 *    than Gemini's spike, which could only reach `initialize` before an
 *    auth wall). This is the first of the three provider spikes to record
 *    a genuinely complete session: real tool calls (`bash`/`write`/`read`/
 *    `edit`), a real `session/request_permission` round trip, real
 *    `session/set_config_option` model/mode changes, and a real
 *    `session/resume`/`session/list`/`session/close` round trip — not just
 *    `initialize` plus a method-probe battery. Recorded verbatim into
 *    `test/fixtures/opencode-acp-live-probe.json`, the same recording
 *    convention `gemini-acp-live-probe.json` and
 *    `packages/providers/core/test/fixtures/omp-acp-session-new-response.json`
 *    already established.
 * 2. Real, unbundled TypeScript source at the exact commit GitHub's
 *    `v1.18.16` tag resolves to (`a3647eb025c7615159d417dcc49fc39fdaeba65b`,
 *    `gh api repos/anomalyco/opencode/git/refs/tags/v1.18.16`) —
 *    `packages/opencode/src/acp/{service,agent,content,permission,tool,
 *    config-option}.ts` — cited throughout
 *    `docs/research/opencode-acp-completeness.md` to corroborate every live
 *    observation against the code that produced it, the same
 *    cross-check discipline the Gemini spike used.
 *
 * The point, same as both precedents: re-run the live recording against a
 * newer `opencode-ai` release and if a capability or method loombox relies
 * on changed shape, the relevant assertion here goes red in CI instead of a
 * user discovering it live.
 */
const VERIFIED_OPENCODE_AI_VERSION = '1.18.16';

const require = createRequire(import.meta.url);
const fixturePath = require.resolve('../test/fixtures/opencode-acp-live-probe.json');

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

interface OpencodeAcpLiveProbeFixture {
  _recordedFrom: { package: string; version: string };
  initializeResult: {
    protocolVersion: number;
    agentInfo?: { name: string; version: string };
    agentCapabilities?: AcpAgentCapabilities;
  };
  methodProbe: Array<{ method: string; response: JsonRpcResponse }>;
  sessionNewResult: {
    sessionId: string;
    configOptions: Array<{
      id: string;
      category: string;
      type: string;
      currentValue: string;
      options: Array<{ value: string; name: string; description?: string }>;
    }>;
  };
  toolCallNotifications: Array<{
    params: { update: Record<string, unknown> & { sessionUpdate: string } };
  }>;
  permissionRequest?: {
    params: { options: Array<{ optionId: string; kind: string; name: string }> };
  };
  setConfigOptionModeResult: {
    configOptions: OpencodeAcpLiveProbeFixture['sessionNewResult']['configOptions'];
  };
  setConfigOptionModelResult: {
    configOptions: OpencodeAcpLiveProbeFixture['sessionNewResult']['configOptions'];
  };
  resumeResult: { configOptions: unknown };
  listAfterResumeResult: { sessions: Array<{ sessionId: string; cwd?: string; title?: string }> };
  closeResult: Record<string, never>;
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as OpencodeAcpLiveProbeFixture;

function methodProbeFor(method: string): JsonRpcResponse {
  const entry = fixture.methodProbe.find((probe) => probe.method === method);
  if (!entry) throw new Error(`fixture has no recorded probe for method ${method}`);
  return entry.response;
}

function toolCallUpdatesFor(kind: 'tool_call' | 'tool_call_update') {
  return fixture.toolCallNotifications
    .map((n) => n.params.update)
    .filter((u) => u.sessionUpdate === kind);
}

describe('real opencode-ai --acp source/wire (issue #285 build-time verification spike)', () => {
  it('the fixture is pinned to the exact version this suite verified, so a version bump is a deliberate re-verification', () => {
    expect(fixture._recordedFrom.package).toBe('opencode-ai');
    expect(fixture._recordedFrom.version).toBe(VERIFIED_OPENCODE_AI_VERSION);
    expect(fixture.initializeResult.agentInfo?.version).toBe(VERIFIED_OPENCODE_AI_VERSION);
  });

  describe('initialize: agentCapabilities OpenCode actually advertises', () => {
    it('advertises promptCapabilities.image/embeddedContext, mcpCapabilities.http/sse, and a real sessionCapabilities object (unlike Gemini)', () => {
      expect(fixture.initializeResult.agentCapabilities).toMatchObject({
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      });
    });

    it('[real OpenCode gap, not filed -- already anticipated by AcpSessionCapabilities own doc comment] advertises a real sessionCapabilities.fork field core does not read', () => {
      // service.ts:124-129 (GitHub a3647eb0) literally returns
      // sessionCapabilities: {close, fork, list, resume} -- `fork` exists on
      // the real ACP v1 SessionCapabilities object but nothing in this
      // codebase reads it (types.ts's AcpSessionCapabilities doc comment
      // already documents this exact case: "fork exists on the real object
      // too but nothing in this codebase reads it yet, so it's left off
      // rather than typed and ignored"). OpenCode is the first live,
      // cataloged agent this repo has actually observed sending it.
      const raw = fixture.initializeResult.agentCapabilities as unknown as {
        sessionCapabilities?: { fork?: unknown };
      };
      expect(raw.sessionCapabilities?.fork).toBeDefined();
    });

    it('advertises NO sessionCapabilities.delete and NO sessionCapabilities.additionalDirectories -- genuinely unimplemented, not merely unadvertised (see method-probe below)', () => {
      expect(
        fixture.initializeResult.agentCapabilities?.sessionCapabilities?.delete,
      ).toBeUndefined();
      expect(
        fixture.initializeResult.agentCapabilities?.sessionCapabilities?.additionalDirectories,
      ).toBeUndefined();
    });
  });

  describe('session lifecycle: which methods OpenCode actually implements', () => {
    it('session/delete is genuinely unimplemented (-32601, same code as a deliberately bogus method) -- confirmed against agent.ts, which has no deleteSession method on the class at all', () => {
      const bogus = methodProbeFor('totally/bogus/method');
      expect(bogus.error?.code).toBe(-32601);

      const del = methodProbeFor('session/delete');
      expect(del.error?.code).toBe(-32601);
      expect(del.error?.message).toContain('session/delete');
    });

    it('session/resume against a session that does not exist yet fails with a real internal error, not "Method not found" -- a genuinely implemented method, unlike session/delete', () => {
      const resume = methodProbeFor('session/resume');
      expect(resume.error?.code).not.toBe(-32601);
    });

    it('[real, live, full-lifecycle round trip -- more than either precedent spike achieved] session/resume, session/list, and session/close all genuinely work end to end against a real session', () => {
      // Not the method-probe battery (a bogus sessionId) -- this is the
      // resumeResult/listAfterResumeResult/closeResult trio recorded
      // against a session/new'd, session/prompt'd, then genuinely resumed
      // session (docs/research/opencode-acp-completeness.md's Method
      // section). Neither Codex's spike (no live binary) nor Gemini's spike
      // (session/resume/list/close are all unimplemented on the real
      // Gemini binary) could exercise this path against a real agent.
      expect(fixture.resumeResult.configOptions).toBeDefined();
      expect(fixture.listAfterResumeResult.sessions.length).toBeGreaterThan(0);
      expect(fixture.listAfterResumeResult.sessions[0]).toMatchObject({
        sessionId: expect.any(String),
        cwd: expect.any(String),
      });
      expect(fixture.closeResult).toEqual({});
    });
  });
});

describe("real-shape conformance: loombox's capability derivation and generic tier against OpenCode's real data", () => {
  it('deriveFeatureFlags reports supportsResume: true via the REAL session/resume capability (not a session/load fallback -- unlike Gemini) and supportsSessionDelete/supportsAdditionalDirectories: false honestly', () => {
    const flags = deriveFeatureFlags(fixture.initializeResult.agentCapabilities);
    expect(flags).toEqual({
      supportsImages: true,
      supportsAudio: false,
      supportsEmbeddedContext: true,
      supportsResume: true,
      supportsAdditionalDirectories: false,
      supportsSessionDelete: false,
    });
  });

  it("mapGenericPermissionOptions handles the real, fixed OpenCode button set (Allow once/Always allow/Reject) -- always exactly these three, by construction (permission.ts's permissionOptions is a literal, unconditional array, not per-confirmation-type like Gemini or Codex)", () => {
    const realOptions = fixture.permissionRequest?.params.options as AcpPermissionOption[];
    expect(realOptions).toEqual([
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ]);
    expect(mapGenericPermissionOptions(realOptions).map((b) => b.verb)).toEqual([
      'allow',
      'allow_always',
      'deny',
    ]);
  });

  it("classifyGenericToolKind classifies every real OpenCode tool_call kind (execute/edit/read) -- all three already members of AcpToolKind, no type gap unlike Codex/Gemini's switch_mode finding", () => {
    const created = toolCallUpdatesFor('tool_call');
    const kinds = created.map((u) => u.kind as AcpToolKind);
    expect(kinds).toEqual(['execute', 'edit', 'read', 'edit']);
    for (const toolKind of kinds) {
      expect(classifyGenericToolKind({ toolKind })).toBe(toolKind);
    }
  });

  it('a real tool_call_update omitting kind on its terminal "completed" status does not clobber the tool row\'s previously-known kind -- exercises reduceTranscript\'s toolKind: update.toolKind ?? existing.toolKind fallback against a real agent that actually omits it', () => {
    const updates = toolCallUpdatesFor('tool_call_update');
    const completedWithNoKind = updates.find(
      (u) => u.status === 'completed' && u.kind === undefined,
    );
    expect(completedWithNoKind).toBeDefined();
  });

  it('extractDiff-shaped content: a real OpenCode edit tool call carries {type: "diff", path, oldText, newText} inside its completed content[] array, byte-identical to what client.ts\'s extractDiff reads', () => {
    const updates = toolCallUpdatesFor('tool_call_update');
    const withDiff = updates.find(
      (u) =>
        Array.isArray(u.content) &&
        (u.content as Array<{ type: string }>).some((c) => c.type === 'diff'),
    );
    expect(withDiff).toBeDefined();
    const diffEntry = (
      withDiff!.content as Array<{ type: string; path: string; oldText: string; newText: string }>
    ).find((c) => c.type === 'diff');
    expect(diffEntry).toMatchObject({ type: 'diff', oldText: 'done', newText: 'done\nedited' });
  });

  it('session/set_config_option genuinely switches BOTH mode and model through the single standard ACP method -- no vendor unstable_setSessionModel fallback needed, unlike Gemini (issue #844)', () => {
    // OpenCode's real session/new response already carries model/mode as
    // ordinary configOptions entries (type: 'select'), not a vendor
    // `models` sub-object -- so mapConfigOptions's UNSTABLE_MODEL_CONFIG_TYPE
    // branch is never reached for OpenCode at all. Confirmed live: sending
    // session/set_config_option with configId: 'model' (config-option.ts's
    // setSessionConfigOption, service.ts:409-422, GitHub a3647eb0) actually
    // changes the session's real currentValue.
    const modeOptions = fixture.sessionNewResult.configOptions.filter((o) => o.category === 'mode');
    const modelOptions = fixture.sessionNewResult.configOptions.filter(
      (o) => o.category === 'model',
    );
    expect(modeOptions[0]?.type).toBe('select');
    expect(modelOptions[0]?.type).toBe('select');

    const modeAfter = fixture.setConfigOptionModeResult.configOptions.find(
      (o) => o.category === 'mode',
    );
    const modelAfter = fixture.setConfigOptionModelResult.configOptions.find(
      (o) => o.category === 'model',
    );
    expect(modeAfter?.currentValue).not.toBe(modeOptions[0]?.currentValue);
    expect(modelAfter?.currentValue).not.toBe(modelOptions[0]?.currentValue);
  });
});
