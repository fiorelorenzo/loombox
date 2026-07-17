/**
 * The runtime WebCrypto `CryptoKey` type, resolved by inference off the
 * global `crypto.subtle` rather than a direct type import from Node's
 * `crypto` builtin (issue #324: this package must never reference a Node
 * builtin, so Vite does not externalize anything out from under the browser
 * build). Node 22
 * and every browser both expose `crypto.subtle` as an ambient global — this
 * alias just names whatever `CryptoKey` shape that global's own types
 * already resolve to in the consuming project's tsconfig (Node's `webcrypto.
 * CryptoKey` here, lib.dom's `CryptoKey` in a browser-lib consumer like
 * apps/web), so it needs no import at all.
 */
export type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
