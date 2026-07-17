import type { AcpAgentCapabilities } from './types';

/**
 * The flat, typed feature-flag surface a client UI reads to show/hide
 * optional affordances (SPEC.md §5.5: "Capability negotiation gates the UI,
 * not provider branding"; issue #180). One flag per optional affordance
 * named in §5.5, plus the two structural flags (`supportsResume`,
 * `supportsPermissions`/`supportsPlans`) callers need to branch ACP-vs-ACP
 * behavior safely regardless of which provider is connected.
 */
export interface AcpFeatureFlags {
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsEmbeddedContext: boolean;
  supportsResume: boolean;
  supportsMcpServerPicker: boolean;
  supportsAdditionalDirectories: boolean;
  supportsSessionDelete: boolean;
  supportsPermissions: boolean;
  supportsPlans: boolean;
}

/** Every flag off — the safe default for a session with no negotiated capabilities at all. */
const ALL_OFF: AcpFeatureFlags = {
  supportsImages: false,
  supportsAudio: false,
  supportsEmbeddedContext: false,
  supportsResume: false,
  supportsMcpServerPicker: false,
  supportsAdditionalDirectories: false,
  supportsSessionDelete: false,
  supportsPermissions: false,
  supportsPlans: false,
};

/**
 * Turns a session's negotiated `initialize` capabilities into the flat flag
 * set above. A missing optional field is treated as off, never as an error
 * (issue #180's third acceptance bullet) — this function never throws.
 * Deliberately branding-blind: it reads only the shape of
 * `AcpAgentCapabilities`, never `agentInfo.name`, so a plain generic-ACP
 * session and a Claude Code session that negotiate the same capabilities
 * produce byte-identical flags (issue #180's second acceptance bullet).
 */
export function deriveFeatureFlags(
  agentCapabilities: AcpAgentCapabilities | undefined,
): AcpFeatureFlags {
  if (!agentCapabilities) return { ...ALL_OFF };

  const prompt = agentCapabilities.promptCapabilities;
  return {
    supportsImages: prompt?.image ?? false,
    supportsAudio: prompt?.audio ?? false,
    supportsEmbeddedContext: prompt?.embeddedContext ?? false,
    supportsResume: agentCapabilities.loadSession ?? false,
    supportsMcpServerPicker: agentCapabilities.mcpServerPicker ?? false,
    supportsAdditionalDirectories: agentCapabilities.additionalDirectories ?? false,
    supportsSessionDelete: agentCapabilities.sessionDelete ?? false,
    supportsPermissions: agentCapabilities.requestPermission ?? false,
    supportsPlans: agentCapabilities.plans ?? false,
  };
}
