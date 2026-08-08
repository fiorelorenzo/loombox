import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadJsonFile } from './json-store';

class FakeStoreError extends Error {
  constructor(message: string) {
    super(`fake store: ${message}`);
    this.name = 'FakeStoreError';
  }
}

let stateDir: string;
let filePath: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-json-store-test-'));
  filePath = path.join(stateDir, 'fake.json');
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('loadJsonFile', () => {
  it('returns the default value when the file does not exist, without calling parse', () => {
    let parseCalls = 0;
    const result = loadJsonFile(
      filePath,
      { entries: [] as string[] },
      (parsed) => {
        parseCalls += 1;
        return parsed as { entries: string[] };
      },
      (message) => new FakeStoreError(message),
    );
    expect(result).toEqual({ entries: [] });
    expect(parseCalls).toBe(0);
  });

  it('parses a well-formed file and hands the caller its own filePath alongside the parsed value', async () => {
    await writeFile(filePath, JSON.stringify({ entries: ['a', 'b'] }), 'utf8');
    let receivedPath: string | undefined;
    const result = loadJsonFile(
      filePath,
      { entries: [] as string[] },
      (parsed, fp) => {
        receivedPath = fp;
        return parsed as { entries: string[] };
      },
      (message) => new FakeStoreError(message),
    );
    expect(result).toEqual({ entries: ['a', 'b'] });
    expect(receivedPath).toBe(filePath);
  });

  it('throws the caller-constructed error, wording the failure as "file ... is not valid JSON", on a corrupt file', async () => {
    await writeFile(filePath, '{not json', 'utf8');
    expect(() =>
      loadJsonFile(
        filePath,
        { entries: [] as string[] },
        (parsed) => parsed as { entries: string[] },
        (message) => new FakeStoreError(message),
      ),
    ).toThrow(FakeStoreError);

    try {
      loadJsonFile(
        filePath,
        { entries: [] as string[] },
        (parsed) => parsed as { entries: string[] },
        (message) => new FakeStoreError(message),
      );
      expect.unreachable('loadJsonFile should have thrown on corrupt JSON');
    } catch (error) {
      expect(error).toBeInstanceOf(FakeStoreError);
      expect((error as Error).message).toContain(`file "${filePath}" is not valid JSON:`);
      expect((error as Error).message).not.toContain('config file');
    }
  });

  it('propagates a schema-validation error thrown by parse() unchanged, never wrapped by makeError', async () => {
    await writeFile(filePath, JSON.stringify({ entries: 'not-an-array' }), 'utf8');
    class SchemaError extends Error {}
    expect(() =>
      loadJsonFile(
        filePath,
        { entries: [] as string[] },
        () => {
          throw new SchemaError('entries must be an array');
        },
        (message) => new FakeStoreError(message),
      ),
    ).toThrow(SchemaError);
  });
});
