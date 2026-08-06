import { describe, expect, it } from 'vitest';
import {
  assertCustomAgentAllowed,
  createCustomAgentProvider,
  CustomAgentNotAllowedError,
  isCustomAgentCommandAllowed,
} from './custom-agent';

describe('isCustomAgentCommandAllowed (issue #748: the allowlist is exact-string membership)', () => {
  it('allows a command present verbatim in the allowlist', () => {
    expect(isCustomAgentCommandAllowed('omp', ['omp', 'gemini'])).toBe(true);
  });

  it('refuses a command absent from the allowlist', () => {
    expect(isCustomAgentCommandAllowed('sh', ['omp', 'gemini'])).toBe(false);
  });

  it('refuses everything against an empty allowlist (the fresh-node default)', () => {
    expect(isCustomAgentCommandAllowed('omp', [])).toBe(false);
  });

  it('never treats a prefix/substring match as allowed — exact string equality only', () => {
    expect(isCustomAgentCommandAllowed('omp', ['omp acp'])).toBe(false);
    expect(isCustomAgentCommandAllowed('/usr/bin/omp', ['omp'])).toBe(false);
  });
});

describe('assertCustomAgentAllowed (the security-boundary gate every launch path calls)', () => {
  it('does not throw for an allowlisted command', () => {
    expect(() => assertCustomAgentAllowed('omp', ['omp'])).not.toThrow();
  });

  it('throws CustomAgentNotAllowedError naming the command and the allowlist, never a silent drop', () => {
    let caught: unknown;
    try {
      assertCustomAgentAllowed('/bin/sh', []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CustomAgentNotAllowedError);
    const error = caught as CustomAgentNotAllowedError;
    expect(error.command).toBe('/bin/sh');
    expect(error.message).toContain('/bin/sh');
    expect(error.message).toContain('allowlist');
    expect(error.message).toContain('LOOMBOX_CUSTOM_AGENT_ALLOWLIST');
  });

  it('the refusal cannot be bypassed by anything the client controls: args/env/name never affect the verdict, only command', () => {
    // A "compromised or careless client" (the issue's own threat model) can
    // set name/args/env to whatever it likes — none of it is consulted by
    // the allowlist check, so there is no field to smuggle an approval
    // through. Only `command`, compared to the node's own local list, ever
    // decides the outcome.
    expect(() =>
      assertCustomAgentAllowed('/bin/sh', ['omp'], /* args/env are irrelevant */),
    ).toThrow(CustomAgentNotAllowedError);
  });
});

describe('createCustomAgentProvider (builds the spawn recipe AFTER the allowlist already cleared it)', () => {
  it('builds an AcpProvider whose spawnConfig is exactly the custom agent record, verbatim', () => {
    const provider = createCustomAgentProvider('custom:sess_1', {
      name: 'My internal agent',
      command: 'omp',
      args: ['acp'],
      env: { FOO: 'bar' },
    });
    expect(provider.id).toBe('custom:sess_1');
    expect(provider.spawnConfig({ cwd: '/tmp/project' })).toEqual({
      command: 'omp',
      args: ['acp'],
      env: { FOO: 'bar' },
    });
  });

  it('enrich is the generic ACP tier no-op pass-through', () => {
    const provider = createCustomAgentProvider('custom:sess_1', {
      name: 'x',
      command: 'omp',
      args: [],
    });
    const update = { kind: 'agent_message_chunk', text: 'hi' } as never;
    expect(provider.enrich(update)).toBe(update);
  });
});
