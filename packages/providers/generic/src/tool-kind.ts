import type { AcpToolCallUpdate, AcpToolKind } from '@loombox/providers-core';

/**
 * The generic ACP fallback tier's `ToolKind`-driven classification (issue
 * #183; SPEC.md §7.24: "A generic `ToolKind`-driven fallback row
 * (`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/
 * `other`) for anything without a bespoke widget"). ACP's own `tool_call`
 * already carries `toolKind` on the wire — this is the one place that rule
 * ("no `toolKind` still renders as something, never as nothing") lives, so
 * a UI's generic fallback row always has a category to key its icon/label
 * off, even for an agent that omits the field entirely.
 */
export function classifyGenericToolKind(update: Pick<AcpToolCallUpdate, 'toolKind'>): AcpToolKind {
  return update.toolKind ?? 'other';
}
