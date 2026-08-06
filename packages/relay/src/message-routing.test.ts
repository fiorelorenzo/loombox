import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wireMessageV1 } from '@loombox/protocol';
import { describe, expect, it } from 'vitest';
import { MESSAGE_ROUTES } from './message-routing';

/**
 * Issue #691: a wire message type missing from `relay.ts`'s routing
 * switches is dropped with no error, no warning and no log — the compiler
 * and the unit tests both stay green, and only a real end-to-end round trip
 * (which most feature tests don't do) ever notices.
 *
 * `MESSAGE_ROUTES` (see `message-routing.ts`) is a mapped type over
 * `WireMessageV1['type']`, so a new wire message type without a matching
 * entry there fails `tsc`. This file is the runtime half of the same
 * guarantee: it reads `relay.ts`'s own source and checks every switch's
 * actual `case` labels against what `MESSAGE_ROUTES` claims, in both
 * directions — so an entry that's wrong (not just missing) fails here too.
 */
const relaySource = readFileSync(fileURLToPath(new URL('./relay.ts', import.meta.url)), 'utf8');

/** Every `type` discriminator the live `wireMessageV1` zod union actually accepts — the same source of truth `parseWireMessageV1` uses on the wire. */
const allWireTypes = wireMessageV1.options.map((option) => option.shape.type.value);

/** Slices `relaySource` between two literal anchors — throws (naming the missing anchor) rather than silently scanning empty or wrong text if `relay.ts` is restructured. */
function section(startAnchor: string, endAnchor: string): string {
  const start = relaySource.indexOf(startAnchor);
  if (start === -1) {
    throw new Error(
      `message-routing.test.ts: could not find "${startAnchor}" in relay.ts — did the handler move, get renamed, or get reformatted? Update this test's anchors.`,
    );
  }
  const end = relaySource.indexOf(endAnchor, start);
  if (end === -1) {
    throw new Error(
      `message-routing.test.ts: could not find "${endAnchor}" after "${startAnchor}" in relay.ts — did the handler move, get renamed, or get reformatted? Update this test's anchors.`,
    );
  }
  return relaySource.slice(start, end);
}

/** Every `case '<type>':` label directly inside a source slice. */
function caseTypes(source: string): Set<string> {
  return new Set([...source.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]));
}

const deviceSwitchCases = caseTypes(
  section('async function handleDeviceMessage(', 'async function handleBlobDownload('),
);
const nodeSwitchCases = caseTypes(
  section('async function handleNodeMessage(', 'async function handleClientMessage('),
);
const clientSwitchCases = caseTypes(
  section('async function handleClientMessage(', '\n  function dropConnection('),
);

describe('MESSAGE_ROUTES (issue #691)', () => {
  it('has an entry for every member of the live wireMessageV1 union', () => {
    // Redundant with the `{ [T in WireMessageV1['type']]: MessageRoute }` mapped type in
    // message-routing.ts (that's what actually fails `tsc` on a new, unrouted member) — this
    // re-asserts it at `pnpm test` time too, so a `pnpm typecheck` skipped in a hurry (or an
    // entry smuggled in with `as any`) doesn't silently lose the guarantee.
    expect(new Set(Object.keys(MESSAGE_ROUTES))).toEqual(new Set(allWireTypes));
  });

  it('sanity-checks its own source scan before trusting it', () => {
    // Guards against relay.ts's handler signatures changing shape and this suite going
    // green because the regex silently stopped matching anything at all.
    expect(deviceSwitchCases.has('ping')).toBe(true);
    expect(nodeSwitchCases.has('target_announce')).toBe(true);
    expect(clientSwitchCases.has('target_list_request')).toBe(true);
  });

  it.each(allWireTypes)(
    '%s is routed (or explicitly not) exactly as relay.ts actually cases it',
    (type) => {
      const route = MESSAGE_ROUTES[type];
      const inDevice = deviceSwitchCases.has(type);
      const inNode = nodeSwitchCases.has(type);
      const inClient = clientSwitchCases.has(type);

      const expectDevice = route.routed === 'device';
      const expectNode = route.routed === 'node' || route.routed === 'node-and-client';
      const expectClient = route.routed === 'client' || route.routed === 'node-and-client';

      expect(
        { inDevice, inNode, inClient },
        `MESSAGE_ROUTES['${type}'] says routed=${route.routed}`,
      ).toEqual({ inDevice: expectDevice, inNode: expectNode, inClient: expectClient });

      if (route.routed === 'not-routed') {
        expect(
          route.reason.trim(),
          `MESSAGE_ROUTES['${type}'] is not-routed but has no reason`,
        ).not.toBe('');
      }
    },
  );
});
