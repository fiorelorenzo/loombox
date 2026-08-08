import { describe, expect, it } from 'vitest';
import { runDiagnostics, type DiagnosticsEnv } from './diagnostics';

function fakeEnv(overrides: Partial<DiagnosticsEnv> = {}): DiagnosticsEnv {
  return {
    isSecureContext: true,
    hasCryptoSubtle: true,
    locationHref: 'https://localhost/',
    localStorageRoundTrip: () => true,
    webSocketCtor: class {},
    ...overrides,
  };
}

describe('runDiagnostics', () => {
  it('passes every check against a secure-context env (the Android https://localhost / iOS capacitor://localhost claim this spike needs to confirm live)', () => {
    const results = runDiagnostics(fakeEnv());
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('fails isSecureContext and crypto.subtle together when the WebView is not a secure context, without masking the other checks', () => {
    const results = runDiagnostics(fakeEnv({ isSecureContext: false, hasCryptoSubtle: false }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.pass]));
    expect(byName['isSecureContext']).toBe(false);
    expect(byName['crypto.subtle present']).toBe(false);
    expect(byName['localStorage round-trip']).toBe(true);
  });

  it('reports localStorage failure independently (e.g. a WebView with storage disabled by policy)', () => {
    const results = runDiagnostics(fakeEnv({ localStorageRoundTrip: () => false }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.pass]));
    expect(byName['localStorage round-trip']).toBe(false);
    expect(byName['isSecureContext']).toBe(true);
  });

  it('always includes the observed origin, pass or fail, since that is what tells capacitor:// apart from https://localhost', () => {
    const results = runDiagnostics(fakeEnv({ locationHref: 'capacitor://localhost/' }));
    expect(results[0]).toEqual({
      name: 'origin',
      pass: true,
      detail: 'capacitor://localhost/',
    });
  });
});
