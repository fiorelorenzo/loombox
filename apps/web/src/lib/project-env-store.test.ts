import { describe, expect, it } from 'vitest';

import { ProjectEnvDeclError } from '@loombox/providers-core/browser';
import {
  addProjectEnvVarDecl,
  createInMemoryProjectEnvStorage,
  createLocalStorageProjectEnvStorage,
  removeProjectEnvVarDecl,
  requiredSecretName,
  type ProjectEnvDeclStorage,
} from './project-env-store';

const withSecret = { name: 'DB_PASSWORD', secret: 'db-password' };
const withLiteral = { name: 'NODE_ENV', value: 'test' };

function fakeLocalStorage(): Storage {
  const memory = new Map<string, string>();
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe('project-env-store (issue #258)', () => {
  it('starts empty', () => {
    const storage = createInMemoryProjectEnvStorage();
    expect(storage.get()).toEqual([]);
  });

  it('addProjectEnvVarDecl adds a decl', () => {
    const storage = createInMemoryProjectEnvStorage();
    const result = addProjectEnvVarDecl(storage, withSecret);
    expect(result).toEqual([withSecret]);
    expect(storage.get()).toEqual([withSecret]);
  });

  it('addProjectEnvVarDecl rejects a duplicate env var name', () => {
    const storage = createInMemoryProjectEnvStorage();
    addProjectEnvVarDecl(storage, withSecret);
    expect(() => addProjectEnvVarDecl(storage, { name: 'DB_PASSWORD', value: 'x' })).toThrow(
      ProjectEnvDeclError,
    );
  });

  it('addProjectEnvVarDecl accepts a literal-value decl alongside a secret-reference one', () => {
    const storage = createInMemoryProjectEnvStorage();
    addProjectEnvVarDecl(storage, withSecret);
    addProjectEnvVarDecl(storage, withLiteral);
    expect(storage.get()).toEqual([withSecret, withLiteral]);
  });

  it('removeProjectEnvVarDecl removes by name and is a no-op for an unknown name', () => {
    const storage = createInMemoryProjectEnvStorage();
    addProjectEnvVarDecl(storage, withSecret);
    addProjectEnvVarDecl(storage, withLiteral);

    expect(removeProjectEnvVarDecl(storage, 'DB_PASSWORD')).toEqual([withLiteral]);
    expect(removeProjectEnvVarDecl(storage, 'NEVER_DECLARED')).toEqual([withLiteral]);
  });

  it('requiredSecretName returns the secret name for a secret-reference decl, and undefined for a literal one', () => {
    expect(requiredSecretName(withSecret)).toBe('db-password');
    expect(requiredSecretName(withLiteral)).toBeUndefined();
  });

  it('createLocalStorageProjectEnvStorage persists across a fresh storage handle for the same project (localStorage-like round trip)', () => {
    const storageBacking = fakeLocalStorage();

    const first: ProjectEnvDeclStorage = createLocalStorageProjectEnvStorage(
      '/home/user/project-a',
      storageBacking,
    );
    addProjectEnvVarDecl(first, withSecret);

    const second = createLocalStorageProjectEnvStorage('/home/user/project-a', storageBacking);
    expect(second.get()).toEqual([withSecret]);
  });

  it('createLocalStorageProjectEnvStorage scopes storage per project path', () => {
    const storageBacking = fakeLocalStorage();

    const projectA = createLocalStorageProjectEnvStorage('/home/user/project-a', storageBacking);
    addProjectEnvVarDecl(projectA, withSecret);

    const projectB = createLocalStorageProjectEnvStorage('/home/user/project-b', storageBacking);
    expect(projectB.get()).toEqual([]);
  });

  it('createLocalStorageProjectEnvStorage degrades a corrupted stored value to an empty list rather than throwing', () => {
    const storageBacking = fakeLocalStorage();
    storageBacking.setItem('loombox:project-env:/home/user/project-a', 'not json{{{');

    const storage = createLocalStorageProjectEnvStorage('/home/user/project-a', storageBacking);
    expect(storage.get()).toEqual([]);
  });

  it('createLocalStorageProjectEnvStorage drops a single corrupted entry rather than the whole list', () => {
    const storageBacking = fakeLocalStorage();
    storageBacking.setItem(
      'loombox:project-env:/home/user/project-a',
      JSON.stringify([withSecret, { name: 'BAD', value: 'x', secret: 'y' }]),
    );

    const storage = createLocalStorageProjectEnvStorage('/home/user/project-a', storageBacking);
    expect(storage.get()).toEqual([withSecret]);
  });
});
