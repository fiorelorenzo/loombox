import { relayHttpBaseUrl } from '../resolve-account-id';

/** The relay's `POST /account/node-tokens` success body (`@loombox/relay`'s `node-token-routes.ts`). */
interface MintNodeTokenResponse {
  id: string;
  token: string;
  label?: string;
  createdAt: number;
}

export interface MintNodeTokenOptions {
  /** This node's own configured relay URL (ws(s)://...), converted to http(s) via `relayHttpBaseUrl` exactly like `device-login.ts`/`resolve-account-id.ts` do. */
  relayUrl: string;
  /**
   * This (acting) node's OWN bearer token — a Better Auth session token or,
   * per issue #398's whole point, itself a relay-native device token.
   * `POST /account/node-tokens` accepts either, resolved the same way every
   * other authenticated REST route on the relay resolves a bearer.
   */
  authToken: string;
  /** A human-readable label for the freshly-minted token, shown in `GET /account/node-tokens` listings/revocation UI later (SPEC §8's "individually labeled/listable/revocable" mitigation). */
  label?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface MintNodeTokenResult {
  id: string;
  /** The new resident node's own bearer token — hand this to `ResidentNodeConfig.deviceToken` (`LOOMBOX_DEVICE_TOKEN`), never persisted by this module itself. */
  token: string;
}

/**
 * Mints a brand-new node-scoped bearer token for THIS account by calling the
 * relay's authenticated `POST /account/node-tokens` (issue #401/#398) with
 * this node's own `authToken` — the zero-touch pairing step that lets an
 * already-connected node provision a fresh resident node with no RFC 8628
 * `user_code` human-approval round trip for the new device (SPEC §7.23,
 * issue #408's north star). Reuses the relay's existing endpoint verbatim;
 * this module only shapes the one HTTP call and its response, exactly like
 * `resolve-account-id.ts`'s `resolveAccountIdViaRelay`/`device-login.ts`'s
 * `runDeviceLogin` shape their own relay calls.
 *
 * Throws a clear `Error` on any non-2xx response or a network failure —
 * never returns a stub/placeholder token.
 */
export async function mintNodeToken(options: MintNodeTokenOptions): Promise<MintNodeTokenResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = relayHttpBaseUrl(options.relayUrl);
  const url = `${baseUrl}/account/node-tokens`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.authToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(options.label ? { label: options.label } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`mintNodeToken: request to ${url} failed: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`mintNodeToken: ${url} responded with HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`mintNodeToken: ${url} did not return valid JSON`);
  }

  const parsed = body as Partial<MintNodeTokenResponse> | null;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.id !== 'string' ||
    typeof parsed.token !== 'string'
  ) {
    throw new Error(`mintNodeToken: ${url} returned an unexpected response shape`);
  }

  return { id: parsed.id, token: parsed.token };
}
