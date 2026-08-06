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
    // `loadSession` gates the older session/load method, not session/resume
    // (issue #821) -- with no sessionCapabilities.resume at all, resume is
    // correctly off despite loadSession being set.
    expect(flags.supportsResume).toBe(false);
    expect(flags.supportsImages).toBe(false);
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

  it('reads sessionCapabilities.resume for supportsResume, not the older top-level loadSession flag (issue #821)', () => {
    // loadSession gates session/load; AcpClient.resumeSession calls
    // session/resume, gated separately by sessionCapabilities.resume.
    const loadSessionOnly: AcpAgentCapabilities = {
      loadSession: true,
      sessionCapabilities: {},
    };
    expect(deriveFeatureFlags(loadSessionOnly).supportsResume).toBe(false);

    const resumeOnly: AcpAgentCapabilities = {
      loadSession: false,
      sessionCapabilities: { resume: {} },
    };
    expect(deriveFeatureFlags(resumeOnly).supportsResume).toBe(true);
  });
});
