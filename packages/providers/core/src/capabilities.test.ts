import { describe, expect, it } from 'vitest';

import { deriveFeatureFlags } from './capabilities';
import type { AcpAgentCapabilities } from './types';

describe('deriveFeatureFlags', () => {
  it('turns every field off for an undefined capability set', () => {
    expect(deriveFeatureFlags(undefined)).toEqual({
      supportsImages: false,
      supportsAudio: false,
      supportsEmbeddedContext: false,
      supportsResume: false,
      supportsAdditionalDirectories: false,
      supportsSessionDelete: false,
    });
  });

  it('treats a missing optional field as off, not as an error', () => {
    const partial: AcpAgentCapabilities = { loadSession: true };
    const flags = deriveFeatureFlags(partial);
    // A missing `promptCapabilities` is off, not an error (issue #180).
    expect(flags.supportsImages).toBe(false);
    // `loadSession: true` alone now genuinely means resume works (issue
    // #843): AcpClient.resumeSession() falls back to `session/load`
    // whenever `sessionCapabilities.resume` is absent, so this reports the
    // resume path this client can actually take, not just the wire's
    // newest field.
    expect(flags.supportsResume).toBe(true);
  });

  it('produces identical flags for a plain generic-ACP session and a Claude Code session sharing the same negotiated capability', () => {
    // Two fixture sessions, differing only in agentInfo/branding, negotiate the same `image` capability.
    const genericAgentCapabilities: AcpAgentCapabilities = {
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    };
    const claudeAgentCapabilities: AcpAgentCapabilities = {
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      loadSession: true,
    };

    const genericFlags = deriveFeatureFlags(genericAgentCapabilities);
    const claudeFlags = deriveFeatureFlags(claudeAgentCapabilities);

    // The shared affordance (image) is identical regardless of branding.
    expect(genericFlags.supportsImages).toBe(claudeFlags.supportsImages);
    expect(genericFlags.supportsImages).toBe(true);
  });

  it('turns every advertised field on when the agent advertises the full real ACP v1 set (issue #821: sessionCapabilities nested, never flat)', () => {
    const full: AcpAgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      sessionCapabilities: {
        resume: {},
        list: {},
        close: {},
        delete: {},
        additionalDirectories: {},
      },
    };
    expect(deriveFeatureFlags(full)).toEqual({
      supportsImages: true,
      supportsAudio: true,
      supportsEmbeddedContext: true,
      supportsResume: true,
      supportsAdditionalDirectories: true,
      supportsSessionDelete: true,
    });
  });

  it('reports supportsResume true via either the real sessionCapabilities.resume field or the session/load fallback through loadSession (issue #821, extended by #843)', () => {
    // Real `session/resume` support, no loadSession at all.
    const resumeOnly: AcpAgentCapabilities = {
      loadSession: false,
      sessionCapabilities: { resume: {} },
    };
    expect(deriveFeatureFlags(resumeOnly).supportsResume).toBe(true);

    // No real session/resume, but loadSession is set -- Gemini CLI's real
    // shape (docs/research/gemini-acp-completeness.md). AcpClient.
    // resumeSession() falls back to session/load in exactly this case
    // (issue #843), so resume genuinely works and must report true, not
    // the wire's-newest-field-only reading issue #821 established before
    // the fallback existed.
    const loadSessionOnly: AcpAgentCapabilities = {
      loadSession: true,
      sessionCapabilities: {},
    };
    expect(deriveFeatureFlags(loadSessionOnly).supportsResume).toBe(true);

    // Neither: no fallback exists, so resume is genuinely unavailable.
    const neither: AcpAgentCapabilities = { loadSession: false, sessionCapabilities: {} };
    expect(deriveFeatureFlags(neither).supportsResume).toBe(false);
  });
});
