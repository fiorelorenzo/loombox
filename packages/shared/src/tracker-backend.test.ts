import { describe, expect, it } from 'vitest';
import type {
  TrackerBackend,
  TrackerBackendCapabilities,
  TrackerBinding,
  TrackerItemLive,
} from './tracker-backend';

const noCapabilities: TrackerBackendCapabilities = {
  comments: false,
  transitions: false,
  boards: false,
  sprints: false,
  labels: false,
  milestones: false,
  customFields: false,
};

const binding: TrackerBinding = {
  connectionId: 'conn_1',
  target: { owner: 'fiorelorenzo', repo: 'loombox' },
};

const item: TrackerItemLive = {
  externalId: 'issue-1',
  title: 'stub item',
  url: 'https://example.test/issue-1',
  fields: {},
};

/**
 * Type-level contract check for issue #209's explicit acceptance
 * criterion: a stub implementing ONLY the required methods
 * (`listBindings`/`list`/`get`/`create`/`update`) must still `satisfies
 * TrackerBackend` with every optional method (`addComment`/
 * `listTransitions`/`transition`/`listBoards`/`listSprints`/
 * `moveToSprint`) absent. If a future edit to `./tracker-backend.ts`
 * accidentally drops the `?` off one of those optional methods, this
 * object literal stops satisfying the interface and `tsc`/this package's
 * `typecheck` script fail — that is the whole point of this file (no
 * `expectTypeOf`-style helper exists in this repo yet, so this follows the
 * plain-`satisfies`-in-a-test-file convention).
 */
const stubBackend = {
  id: 'github',
  capabilities: noCapabilities,
  listBindings: async () => [binding],
  list: async () => ({ items: [item] }),
  get: async () => item,
  create: async () => item,
  update: async () => item,
} satisfies TrackerBackend;

/**
 * Widened to the interface for the runtime assertions below: `satisfies`
 * deliberately keeps `stubBackend`'s own narrower literal type (that
 * narrowness — no `addComment` key at all, zero-arg method signatures — is
 * exactly what proves optional methods can be genuinely absent, not just
 * `undefined`-valued), so accessing an optional method or calling a
 * required one with its real parameters goes through this `TrackerBackend`-
 * typed view instead.
 */
const backend: TrackerBackend = stubBackend;

describe('TrackerBackend stub (issue #209 type-level check)', () => {
  it('has every optional method absent', () => {
    expect(backend.addComment).toBeUndefined();
    expect(backend.listTransitions).toBeUndefined();
    expect(backend.transition).toBeUndefined();
    expect(backend.listBoards).toBeUndefined();
    expect(backend.listSprints).toBeUndefined();
    expect(backend.moveToSprint).toBeUndefined();
  });

  it('required methods are callable and resolve', async () => {
    await expect(backend.listBindings('conn_1')).resolves.toEqual([binding]);
    await expect(backend.list(binding, {})).resolves.toEqual({ items: [item] });
    await expect(backend.get(binding, 'issue-1')).resolves.toEqual(item);
    await expect(backend.create(binding, { title: 'new' })).resolves.toEqual(item);
    await expect(backend.update(binding, 'issue-1', { title: 'renamed' })).resolves.toEqual(item);
  });
});
