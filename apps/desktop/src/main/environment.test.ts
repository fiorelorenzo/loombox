import { describe, expect, it } from 'vitest';

import {
  DESKTOP_ENVIRONMENT_VAR,
  DESKTOP_ENVIRONMENTS,
  resolveDesktopEnvironmentConfig,
  resolveDesktopEnvironmentName,
} from './environment';

describe('resolveDesktopEnvironmentName', () => {
  it('defaults to production when the env var is unset', () => {
    expect(resolveDesktopEnvironmentName({ env: {} })).toBe('production');
  });

  it('defaults to production when the env var is blank', () => {
    expect(resolveDesktopEnvironmentName({ env: { [DESKTOP_ENVIRONMENT_VAR]: '   ' } })).toBe(
      'production',
    );
  });

  it('reads "preview"', () => {
    expect(resolveDesktopEnvironmentName({ env: { [DESKTOP_ENVIRONMENT_VAR]: 'preview' } })).toBe(
      'preview',
    );
  });

  it('reads "production" explicitly', () => {
    expect(
      resolveDesktopEnvironmentName({ env: { [DESKTOP_ENVIRONMENT_VAR]: 'production' } }),
    ).toBe('production');
  });

  it('rejects an unrecognized value instead of silently defaulting — a typo producing a production artifact from a preview invocation is the exact failure this exists to prevent', () => {
    expect(() =>
      resolveDesktopEnvironmentName({ env: { [DESKTOP_ENVIRONMENT_VAR]: 'staging' } }),
    ).toThrow(/production.*preview/i);
  });

  it('falls back to process.env when no options are passed', () => {
    expect(resolveDesktopEnvironmentName()).toBeTruthy();
  });
});

describe('resolveDesktopEnvironmentConfig', () => {
  it('resolves the production config table entry by default', () => {
    expect(resolveDesktopEnvironmentConfig({ env: {} })).toBe(DESKTOP_ENVIRONMENTS.production);
  });

  it('resolves the preview config table entry', () => {
    expect(resolveDesktopEnvironmentConfig({ env: { [DESKTOP_ENVIRONMENT_VAR]: 'preview' } })).toBe(
      DESKTOP_ENVIRONMENTS.preview,
    );
  });
});

// The acceptance criterion this issue names explicitly: every value that
// has to differ between the two installs is asserted here, over the
// resolved config, not eyeballed in electron-builder.yml.
describe('production and preview configs differ in every field issue #866 requires', () => {
  const { production, preview } = DESKTOP_ENVIRONMENTS;

  it('appId — same id means the installer replaces instead of installing side by side', () => {
    expect(preview.appId).not.toBe(production.appId);
    // Same reverse-DNS root; the preview id is a distinguishable child, not
    // a fork onto an unrelated identifier.
    expect(preview.appId.startsWith(production.appId)).toBe(true);
  });

  it('productName — the dock/menu-bar/window-title identity', () => {
    expect(preview.productName).not.toBe(production.productName);
    expect(preview.productName.toLowerCase()).toContain('preview');
  });

  it('userDataDirName — the one that actually bites: shared userData means shared localStorage, a shared bearer token, a shared AMK', () => {
    expect(preview.userDataDirName).not.toBe(production.userDataDirName);
  });

  it('protocolScheme — two installs claiming the same scheme is undefined behaviour', () => {
    expect(preview.protocolScheme).not.toBe(production.protocolScheme);
  });

  it('defaultPwaUrl — preview points at preview.loombox.dev, production at app.loombox.dev', () => {
    expect(production.defaultPwaUrl).toBe('https://app.loombox.dev');
    expect(preview.defaultPwaUrl).toBe('https://preview.loombox.dev');
  });

  it('chromeBadge — production shows no marker, preview always does', () => {
    expect(production.chromeBadge).toBeNull();
    expect(preview.chromeBadge).toBeTruthy();
  });

  it('every differentiator is a non-empty, distinct string across the two environments', () => {
    const fields: Array<keyof typeof production> = [
      'appId',
      'productName',
      'userDataDirName',
      'protocolScheme',
      'defaultPwaUrl',
    ];
    for (const field of fields) {
      const prodValue = production[field];
      const previewValue = preview[field];
      expect(typeof prodValue).toBe('string');
      expect(prodValue).not.toHaveLength(0);
      expect(previewValue).not.toBe(prodValue);
    }
  });

  it('the environment tag on each entry matches its own key in the table, so a lookup can never return the wrong side', () => {
    expect(production.environment).toBe('production');
    expect(preview.environment).toBe('preview');
  });
});
