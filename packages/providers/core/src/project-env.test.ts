import { describe, expect, it } from 'vitest';

import {
  ProjectEnvDeclError,
  ProjectEnvGrantStore,
  ProjectEnvVarMissingError,
  parseProjectEnvVarDecl,
  parseProjectEnvVarDeclList,
  requiredProjectEnvSecrets,
  resolveProjectEnv,
  type ProjectEnvVarDecl,
} from './project-env';

const withSecret: ProjectEnvVarDecl = { name: 'DB_PASSWORD', secret: 'db-password' };
const withLiteral: ProjectEnvVarDecl = { name: 'NODE_ENV', value: 'test' };

describe('ProjectEnvGrantStore (issue #258)', () => {
  it('grants no secret by default', () => {
    const grants = new ProjectEnvGrantStore();
    expect(grants.isGranted('db-password')).toBe(false);
  });

  it('grant() is a distinct explicit action per secret', () => {
    const grants = new ProjectEnvGrantStore();
    grants.grant('db-password');
    expect(grants.isGranted('db-password')).toBe(true);
    expect(grants.isGranted('other-secret')).toBe(false);
  });

  it('revoke() removes only that secret grant, leaving others untouched', () => {
    const grants = new ProjectEnvGrantStore();
    grants.grant('db-password');
    grants.grant('api-key');
    grants.revoke('db-password');
    expect(grants.isGranted('db-password')).toBe(false);
    expect(grants.isGranted('api-key')).toBe(true);
  });

  it('revoking a never-granted secret is a harmless no-op', () => {
    const grants = new ProjectEnvGrantStore();
    expect(() => grants.revoke('never-granted')).not.toThrow();
    expect(grants.isGranted('never-granted')).toBe(false);
  });
});

describe('resolveProjectEnv (issue #258)', () => {
  it('resolves a granted secret and passes a literal value through unchanged', () => {
    const grants = new ProjectEnvGrantStore();
    grants.grant('db-password');
    const env = resolveProjectEnv([withSecret, withLiteral], grants, {
      'db-password': 'hunter2',
    });
    expect(env).toEqual({ DB_PASSWORD: 'hunter2', NODE_ENV: 'test' });
  });

  it('throws ProjectEnvVarMissingError naming the env var + secret when the secret is not granted', () => {
    const grants = new ProjectEnvGrantStore();
    expect(() => resolveProjectEnv([withSecret], grants, { 'db-password': 'hunter2' })).toThrow(
      ProjectEnvVarMissingError,
    );
    try {
      resolveProjectEnv([withSecret], grants, { 'db-password': 'hunter2' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectEnvVarMissingError);
      const missing = error as ProjectEnvVarMissingError;
      expect(missing.variableName).toBe('DB_PASSWORD');
      expect(missing.secretName).toBe('db-password');
    }
  });

  it('throws ProjectEnvVarMissingError when granted but the secret value map has nothing for it', () => {
    const grants = new ProjectEnvGrantStore();
    grants.grant('db-password');
    expect(() => resolveProjectEnv([withSecret], grants, {})).toThrow(ProjectEnvVarMissingError);
  });

  it('fails before producing any output: a later granted var is never partially resolved', () => {
    const grants = new ProjectEnvGrantStore();
    grants.grant('second-secret');
    const decls: ProjectEnvVarDecl[] = [withSecret, { name: 'API_KEY', secret: 'second-secret' }];
    expect(() => resolveProjectEnv(decls, grants, { 'second-secret': 'abc' })).toThrow(
      ProjectEnvVarMissingError,
    );
  });

  it('never includes the secret value in the thrown error message', () => {
    const grants = new ProjectEnvGrantStore();
    try {
      resolveProjectEnv([withSecret], grants, { 'db-password': 'super-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });

  it('resolves an empty decl list to an empty env with no grants needed', () => {
    const grants = new ProjectEnvGrantStore();
    expect(resolveProjectEnv([], grants, {})).toEqual({});
  });

  it('a duplicate name has the later declaration win, same as a plain object literal', () => {
    const grants = new ProjectEnvGrantStore();
    const env = resolveProjectEnv(
      [
        { name: 'GREETING', value: 'first' },
        { name: 'GREETING', value: 'second' },
      ],
      grants,
      {},
    );
    expect(env).toEqual({ GREETING: 'second' });
  });
});

describe('requiredProjectEnvSecrets (issue #258)', () => {
  it('returns the distinct secret names referenced across the list, ignoring literal-value decls', () => {
    expect(
      requiredProjectEnvSecrets([
        withSecret,
        withLiteral,
        { name: 'DUPLICATE', secret: 'db-password' },
      ]),
    ).toEqual(['db-password']);
  });

  it('returns an empty list when nothing references a secret', () => {
    expect(requiredProjectEnvSecrets([withLiteral])).toEqual([]);
  });
});

describe('parseProjectEnvVarDecl / parseProjectEnvVarDeclList (issue #258)', () => {
  it('parses a literal-value decl', () => {
    expect(parseProjectEnvVarDecl({ name: 'NODE_ENV', value: 'test' })).toEqual({
      name: 'NODE_ENV',
      value: 'test',
    });
  });

  it('parses a secret-reference decl', () => {
    expect(parseProjectEnvVarDecl({ name: 'DB_PASSWORD', secret: 'db-password' })).toEqual({
      name: 'DB_PASSWORD',
      secret: 'db-password',
    });
  });

  it('rejects an entry declaring both value and secret', () => {
    expect(() => parseProjectEnvVarDecl({ name: 'A', value: 'x', secret: 'y' })).toThrow(
      ProjectEnvDeclError,
    );
  });

  it('rejects an entry declaring neither value nor secret', () => {
    expect(() => parseProjectEnvVarDecl({ name: 'A' })).toThrow(ProjectEnvDeclError);
  });

  it('rejects a non-object entry', () => {
    expect(() => parseProjectEnvVarDecl('not an object')).toThrow(ProjectEnvDeclError);
  });

  it('parseProjectEnvVarDeclList rejects a non-array', () => {
    expect(() => parseProjectEnvVarDeclList({})).toThrow(ProjectEnvDeclError);
  });

  it('parseProjectEnvVarDeclList rejects a duplicate name within the list', () => {
    expect(() =>
      parseProjectEnvVarDeclList([
        { name: 'A', value: 'x' },
        { name: 'A', secret: 'y' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('parseProjectEnvVarDeclList parses a valid list entry-by-entry', () => {
    expect(
      parseProjectEnvVarDeclList([
        { name: 'NODE_ENV', value: 'test' },
        { name: 'DB_PASSWORD', secret: 'db-password' },
      ]),
    ).toEqual([
      { name: 'NODE_ENV', value: 'test' },
      { name: 'DB_PASSWORD', secret: 'db-password' },
    ]);
  });
});
