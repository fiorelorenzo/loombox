/**
 * Resolves each of a session's live config-option categories against a
 * project override (`config-option-overrides.ts`) and an account-wide
 * remembered value (`config-option-defaults.ts`) — decision D4-3 of the
 * Zed-parity review (`docs/superpowers/specs/2026-08-05-zed-parity-decisions.md`
 * §4, issue #753): project beats account beats the agent's own default.
 *
 * A remembered/overridden value the agent no longer offers for that
 * category — not present in its current `choices` — is dropped rather
 * than resolved: the same "never send an unsupported value" rule issue
 * #718 already established for `RelayClient.setConfigOption` (it rejects
 * one, so this must never let one reach that call in the first place).
 * Dropping falls all the way through to `'default'`, never partway to the
 * account value when the project override alone was stale — a category
 * whose project override is stale is not "one layer down", it is exactly
 * as unset as if no override existed, so the account value underneath it
 * still gets its normal shot.
 *
 * `source` is also what `ConfigBar` surfaces per category — the D4-3
 * acceptance's named cost: "whichever surface ships this has to show
 * which one is currently winning". `resolveConfigOptionSource` computes
 * it by reading `options` itself (does the CURRENT value equal the
 * project override, then the account default, else it's the agent's own
 * default) rather than remembering how a value got there, so it stays
 * correct even for a value nobody here ever applied — an unprompted
 * agent-initiated change, or a value read before this session's own
 * `applyRememberedConfigOptions` round trip has completed.
 */

import type { AcpConfigOption } from '@loombox/providers-core/browser';
import type { RememberedConfigOptionValues } from './config-option-defaults';

export type ConfigOptionSource = 'project' | 'account' | 'default';

export interface ConfigOptionResolution {
  category: string;
  source: ConfigOptionSource;
  /** The value a caller should switch to — `undefined` when `source` is `'default'` (nothing to apply; the agent's own current selection stands untouched). */
  optionId: string | undefined;
}

/**
 * The remembered value each of `options`' categories should be switched
 * to on a brand-new session. Never assumes the caller will skip a
 * category whose resolution already equals `option.current` — that
 * redundant-round-trip check belongs to the caller issuing
 * `setConfigOption` (`+page.svelte`'s `applyRememberedConfigOptions`),
 * not to this pure resolution.
 */
export function resolveConfigOptionDefaults(
  options: readonly AcpConfigOption[],
  projectOverrides: RememberedConfigOptionValues,
  accountDefaults: RememberedConfigOptionValues,
): ConfigOptionResolution[] {
  return options.map((option) => {
    const projectValue = projectOverrides[option.category];
    if (projectValue !== undefined && option.choices.some((choice) => choice.id === projectValue)) {
      return { category: option.category, source: 'project', optionId: projectValue };
    }
    const accountValue = accountDefaults[option.category];
    if (accountValue !== undefined && option.choices.some((choice) => choice.id === accountValue)) {
      return { category: option.category, source: 'account', optionId: accountValue };
    }
    return { category: option.category, source: 'default', optionId: undefined };
  });
}

/**
 * Every category's current source, keyed by category — what `ConfigBar`
 * renders per the file doc comment's acceptance note. Unlike
 * {@link resolveConfigOptionDefaults}, this never proposes a value to
 * switch to; it only explains the value `options` already carries.
 */
export function resolveConfigOptionSources(
  options: readonly AcpConfigOption[],
  projectOverrides: RememberedConfigOptionValues,
  accountDefaults: RememberedConfigOptionValues,
): Record<string, ConfigOptionSource> {
  const result: Record<string, ConfigOptionSource> = {};
  for (const option of options) {
    if (option.current !== undefined && option.current === projectOverrides[option.category]) {
      result[option.category] = 'project';
    } else if (
      option.current !== undefined &&
      option.current === accountDefaults[option.category]
    ) {
      result[option.category] = 'account';
    } else {
      result[option.category] = 'default';
    }
  }
  return result;
}
