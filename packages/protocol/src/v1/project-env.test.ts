import { describe, expect, it } from 'vitest';

import { projectEnvVarDeclV1 } from './project-env';

describe('projectEnvVarDeclV1 (issue #258)', () => {
  it('accepts a literal value', () => {
    expect(projectEnvVarDeclV1.parse({ name: 'NODE_ENV', value: 'test' })).toEqual({
      name: 'NODE_ENV',
      value: 'test',
    });
  });

  it('accepts a secret reference', () => {
    expect(projectEnvVarDeclV1.parse({ name: 'DB_PASSWORD', secret: 'db-password' })).toEqual({
      name: 'DB_PASSWORD',
      secret: 'db-password',
    });
  });

  it('rejects both a value and a secret on the same entry', () => {
    expect(
      projectEnvVarDeclV1.safeParse({ name: 'A', value: 'x', secret: 'db-password' }).success,
    ).toBe(false);
  });

  it('rejects neither a value nor a secret', () => {
    expect(projectEnvVarDeclV1.safeParse({ name: 'A' }).success).toBe(false);
  });

  it('rejects an empty env var name', () => {
    expect(projectEnvVarDeclV1.safeParse({ name: '', value: 'x' }).success).toBe(false);
  });

  it('rejects an empty secret name', () => {
    expect(projectEnvVarDeclV1.safeParse({ name: 'A', secret: '' }).success).toBe(false);
  });
});
