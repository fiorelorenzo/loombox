import { test as base, expect, type Page } from '@playwright/test';
import { generateAmk } from '@loombox/crypto';
import {
  amkToStorageValue,
  announceSession,
  FakeNode,
  randomBase64,
  signUpTestUser,
  startE2eRelay,
  type AnnouncedSession,
  type E2eRelay,
} from './harness/relay-harness';

/**
 * The Playwright fixture every spec under `tests-e2e/` builds on (issue
 * #192): a fresh, throwaway `@loombox/relay` instance, a freshly signed-up
 * account on it, and one `FakeNode` "device" already connected and having
 * announced one session — everything a spec needs to drive the real app
 * through a real browser against a real (if disposable) backend, mirroring
 * `apps/web/src/lib/relay-client.test.ts`'s hermetic pattern one layer up.
 */
export interface LoomboxFixture {
  relay: E2eRelay;
  accountId: string;
  token: string;
  amk: Uint8Array;
  /** The one "device" (fake encrypted node) this fixture already connected and announced `session` on — a spec can send further `session_update`/`permission_request` traffic on it, or connect additional `FakeNode`s of its own. */
  node: FakeNode;
  session: AnnouncedSession;
}

let userCounter = 0;

/**
 * Bridges the relay's Better Auth routes (`/api/auth/*`) across the
 * browser's own-origin CORS check. `packages/relay` (out of scope for this
 * PR — see `AGENTS.md`'s hard rule) has no CORS layer of its own, since v1
 * self-hosting always fronts both the web app and the relay behind one
 * reverse-proxied origin (SPEC §10); a bare Playwright `preview` server and
 * a bare relay process are deliberately two different origins/ports here,
 * so `AuthStore.restoreSession()`'s real `getSession()` fetch would
 * otherwise be blocked by the browser's own CORS enforcement before it
 * ever reaches the relay. This intercepts only that relay-origin traffic
 * and replays the REAL response (via `route.fetch()`, an actual network
 * call, never a stub) with an added `Access-Control-Allow-*` header set —
 * the request/response themselves are untouched.
 */
async function bridgeRelayCors(page: Page, relayHttpBaseUrl: string): Promise<void> {
  await page.route(`${relayHttpBaseUrl}/**`, async (route) => {
    const request = route.request();
    const origin = (await request.headerValue('origin')) ?? '*';
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
        },
      });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'access-control-allow-origin': origin,
      },
    });
  });
}

export const test = base.extend<{ loombox: LoomboxFixture }>({
  loombox: async ({ page }, use) => {
    const relay = await startE2eRelay();
    await bridgeRelayCors(page, relay.httpBaseUrl);

    userCounter += 1;
    const email = `e2e-${Date.now()}-${userCounter}@example.com`;
    const { token, accountId } = await signUpTestUser(relay.httpBaseUrl, email);
    const amk = generateAmk();

    // Seeded BEFORE the app's first navigation (`page.addInitScript` runs
    // ahead of any page script on every subsequent `page.goto`), so
    // `AuthStore.restoreSession()` finds a real, resolvable session on
    // mount and `loadOrCreateAmk` finds this exact AMK rather than
    // generating a mismatched one — no UI sign-in click is simulated here
    // (GitHub OAuth cannot be driven hermetically, see `auth-store.ts`'s
    // own doc comment); this is the client-storage half of the same
    // real-HTTP-auth escape hatch `signUpTestUser` used server-side.
    await page.addInitScript(
      (seed) => {
        window.localStorage.setItem(
          'loombox:auth-session',
          JSON.stringify({ token: seed.token, accountId: seed.accountId }),
        );
        window.localStorage.setItem(`loombox:amk:${seed.accountId}`, seed.amkBase64);
        window.localStorage.setItem('loombox:relay-url', seed.relayUrl);
      },
      { token, accountId, amkBase64: amkToStorageValue(amk), relayUrl: relay.url },
    );

    const node = new FakeNode(relay.url, {
      deviceId: 'e2e-node',
      devicePublicKey: randomBase64(),
      authToken: token,
    });
    await node.ready;

    const session = await announceSession(node, {
      amk,
      accountId,
      sessionId: `sess_e2e_${userCounter}_${Date.now()}`,
      nodeId: 'e2e-node-daemon',
      targetId: 'local',
      provider: 'claude',
      title: 'E2E session',
      projectPath: '/workspace/e2e-project',
    });

    await use({ relay, accountId, token, amk, node, session });

    node.close();
    await relay.close();
  },
});

export { expect };
export {
  announceSession,
  FakeNode,
  nodeOpen,
  sendPermissionRequest,
  sendSessionUpdate,
} from './harness/relay-harness';
