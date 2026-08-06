import type { AcpAgentCapabilities } from './types';

/**
 * The flat, typed feature-flag surface a client UI reads to show/hide
 * optional affordances (SPEC.md §5.5: "Capability negotiation gates the UI,
 * not provider branding"; issue #180). One flag per real ACP v1 capability
 * `AcpAgentCapabilities` carries, plus the one structural flag
 * (`supportsResume`) every caller needs to branch ACP-vs-ACP behavior
 * safely regardless of which provider is connected.
 *
 * Issue #821 dropped `supportsMcpServerPicker`/`supportsPermissions`/
 * `supportsPlans`: none of them ever gated on a real ACP capability
 * (`mcpServerPicker`/`requestPermission`/`plans` don't exist on the wire —
 * see `AcpAgentCapabilities`'s own doc comment), and nothing in this
 * codebase read any of the three, so there was no honest value to keep
 * deriving. `session/request_permission` in particular isn't optional at
 * all: `AcpClient.handleIncomingRequest` answers it unconditionally,
 * regardless of what (if anything) `initialize` advertised, so gating it
 * behind a capability flag would have been dishonest in the other
 * direction — a flag that never varies with the session isn't capability
 * negotiation.
 */
export interface AcpFeatureFlags {
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsEmbeddedContext: boolean;
  supportsResume: boolean;
  supportsAdditionalDirectories: boolean;
  supportsSessionDelete: boolean;
}

/** Every flag off — the safe default for a session with no negotiated capabilities at all. */
const ALL_OFF: AcpFeatureFlags = {
  supportsImages: false,
  supportsAudio: false,
  supportsEmbeddedContext: false,
  supportsResume: false,
  supportsAdditionalDirectories: false,
  supportsSessionDelete: false,
};

/**
 * Turns a session's negotiated `initialize` capabilities into the flat flag
 * set above. A missing optional field is treated as off, never as an error
 * (issue #180's third acceptance bullet) — this function never throws.
 * Deliberately branding-blind: it reads only the shape of
 * `AcpAgentCapabilities`, never `agentInfo.name`, so a plain generic-ACP
 * session and a Claude Code session that negotiate the same capabilities
 * produce byte-identical flags (issue #180's second acceptance bullet).
 *
 * `supportsResume` reads `sessionCapabilities.resume` — the capability that
 * actually gates the `session/resume` method `AcpClient.resumeSession`
 * calls — not the top-level `loadSession` flag, which gates the separate,
 * older `session/load` method this client never calls (issue #821: the two
 * happen to agree for Codex today, since it sets both, but reading
 * `loadSession` was gating the wrong method in general).
 * `supportsAdditionalDirectories`/`supportsSessionDelete` read
 * `sessionCapabilities.additionalDirectories`/`.delete` — the real nesting
 * (issue #821: previously read invented top-level fields that never
 * existed, so both silently read `undefined` forever).
 */
export function deriveFeatureFlags(
  agentCapabilities: AcpAgentCapabilities | undefined,
): AcpFeatureFlags {
  if (!agentCapabilities) return { ...ALL_OFF };

  const prompt = agentCapabilities.promptCapabilities;
  const session = agentCapabilities.sessionCapabilities;
  return {
    supportsImages: prompt?.image ?? false,
    supportsAudio: prompt?.audio ?? false,
    supportsEmbeddedContext: prompt?.embeddedContext ?? false,
    supportsResume: session?.resume != null,
    supportsAdditionalDirectories: session?.additionalDirectories != null,
    supportsSessionDelete: session?.delete != null,
  };
}
