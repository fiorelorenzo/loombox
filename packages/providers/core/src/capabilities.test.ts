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
      supportsMcpServerPicker: false,
      supportsAdditionalDirectories: false,
      supportsSessionDelete: false,
      supportsPermissions: false,
      supportsPlans: false,
    });
  });

  it('treats a missing optional field as off, not as an error', () => {
    const partial: AcpAgentCapabilities = { loadSession: true };
    const flags = deriveFeatureFlags(partial);
    expect(flags.supportsResume).toBe(true);
    expect(flags.supportsImages).toBe(false);
    expect(flags.supportsMcpServerPicker).toBe(false);
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

  it('turns every advertised field on when the agent advertises the full set', () => {
    const full: AcpAgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpServerPicker: true,
      additionalDirectories: true,
      sessionDelete: true,
      requestPermission: true,
      plans: true,
    };
    expect(deriveFeatureFlags(full)).toEqual({
      supportsImages: true,
      supportsAudio: true,
      supportsEmbeddedContext: true,
      supportsResume: true,
      supportsMcpServerPicker: true,
      supportsAdditionalDirectories: true,
      supportsSessionDelete: true,
      supportsPermissions: true,
      supportsPlans: true,
    });
  });
});
