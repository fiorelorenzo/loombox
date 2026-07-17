import { EventEmitter } from 'node:events';

import type { AcpConfigOption } from './types';

export interface ConfigOptionChangeEvent {
  sessionId: string;
  options: AcpConfigOption[];
  /**
   * True when this update arrived unprompted — an agent-initiated
   * `config_option_update` the user didn't ask for (e.g. an automatic model
   * fallback after a rate limit) — rather than acking the user's own
   * `select()` call. Flagged separately so the attention-inbox epic can
   * surface it without this store building any inbox UI itself (issue #179's
   * second acceptance bullet).
   */
  unprompted: boolean;
}

/**
 * Per-session config-option state: `model`, `model_config`, `thought_level`,
 * `mode`, and any future category (SPEC.md §7.24 "Model, mode & reasoning
 * effort"; issue #179). The full option list is tracked as one object per
 * session and always replaced wholesale, never patched per-category, so a
 * caller can always re-render the complete control set from one read.
 */
export class ConfigOptionStore extends EventEmitter {
  private readonly bySession = new Map<string, AcpConfigOption[]>();

  /** The full current config-option list for a session (`[]` if none seeded yet). */
  get(sessionId: string): AcpConfigOption[] {
    return cloneOptions(this.bySession.get(sessionId) ?? []);
  }

  /**
   * Replaces the entire option list for a session, wholesale. An
   * unrecognized/future category name is preserved as-is (never dropped),
   * since `AcpConfigOption.category` is an open string, not a closed union.
   * Emits `'changed'` with the `unprompted` flag so a caller can tell a
   * user-driven ack apart from an agent-initiated surprise update.
   */
  setAll(sessionId: string, options: AcpConfigOption[], opts: { unprompted: boolean }): void {
    this.bySession.set(sessionId, cloneOptions(options));
    const event: ConfigOptionChangeEvent = {
      sessionId,
      options: this.get(sessionId),
      unprompted: opts.unprompted,
    };
    this.emit('changed', event);
  }

  /** The current selection for one category, if the session has that category at all. */
  current(sessionId: string, category: string): string | undefined {
    return this.bySession.get(sessionId)?.find((option) => option.category === category)?.current;
  }

  /** Drops all tracked state for a session (e.g. once it's closed). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

function cloneOptions(options: AcpConfigOption[]): AcpConfigOption[] {
  return options.map((option) => ({ ...option, choices: [...option.choices] }));
}
