import { EventEmitter } from 'node:events';

import type { AcpAvailableCommand } from './types';

export interface AvailableCommandsChangeEvent {
  sessionId: string;
  commands: AcpAvailableCommand[];
}

/**
 * Per-session available-command state: the agent's own declared `/`-command
 * catalog (SPEC.md §7.24's slash-command surface; issue #741, built once for
 * #743's composer picker and #754's MCP-prompt commands). Same shape as
 * `ConfigOptionStore` (`config-options.ts`) on purpose — one object per
 * session, always replaced wholesale, never patched — since ACP's
 * `available_commands_update` carries no per-command patch notification
 * either, only a full re-declaration.
 *
 * Unlike `ConfigOptionStore.setAll`, there is no `unprompted` flag: every
 * `available_commands_update` is the agent volunteering its own catalog —
 * there is no client-driven "set a command" request for this to be an ack
 * of, so the user-driven/agent-initiated distinction `ConfigOptionChangeEvent`
 * needs doesn't apply here.
 */
export class AvailableCommandsStore extends EventEmitter {
  private readonly bySession = new Map<string, AcpAvailableCommand[]>();

  /** This session's currently declared commands (`[]` if the agent has never sent `available_commands_update` — issue #741's "declares none" acceptance: an empty list, not an error). */
  get(sessionId: string): AcpAvailableCommand[] {
    return cloneCommands(this.bySession.get(sessionId) ?? []);
  }

  /** Replaces the entire command list for a session, wholesale. An unrecognized/future field on any one command is preserved as-is (never dropped) — see `AcpAvailableCommand`'s own doc comment. */
  setAll(sessionId: string, commands: AcpAvailableCommand[]): void {
    this.bySession.set(sessionId, cloneCommands(commands));
    const event: AvailableCommandsChangeEvent = { sessionId, commands: this.get(sessionId) };
    this.emit('changed', event);
  }

  /** Drops all tracked state for a session (e.g. once it's closed). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

function cloneCommands(commands: AcpAvailableCommand[]): AcpAvailableCommand[] {
  return commands.map((command) => ({ ...command }));
}
