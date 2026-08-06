#!/usr/bin/env node
/**
 * One-time (or rotate-on-demand) Ed25519 keypair generator for signing
 * `@loombox/supervisor` release artifacts (issue #817, SPEC §16's
 * "minisign (pinned Ed25519 key)"). Run it, then:
 *
 *   1. Store the PRIVATE key as the `SUPERVISOR_SIGNING_KEY` GitHub Actions
 *      secret (`gh secret set SUPERVISOR_SIGNING_KEY`) — `.github/workflows/
 *      release-node.yml` reads it to sign every artifact it publishes.
 *      Never commit it.
 *   2. Paste the PUBLIC key into `apps/desktop/src/main/provisioning/
 *      provision-target-bridge.ts`'s `PINNED_SUPERVISOR_PUBLIC_KEY_B64`
 *      constant (that's the pinned key every node checks a fetched
 *      artifact's signature against — SPEC §16's "the node ships a pinned
 *      public key").
 *
 * Both keys print as base64. Rotating: generate a new pair, ship the new
 * public key in a node release *before* signing anything with the new
 * private key (an already-deployed node with the old pinned key would
 * otherwise refuse every new artifact it fetches).
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });

if (typeof publicJwk.x !== 'string' || typeof privateJwk.d !== 'string') {
  throw new Error('generate-supervisor-signing-key: unexpected Ed25519 JWK shape');
}

const publicKeyB64 = Buffer.from(publicJwk.x, 'base64url').toString('base64');
const privateKeyPkcs8B64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

console.log('# Supervisor release signing key (issue #817, SPEC §16)');
console.log('#');
console.log('# PUBLIC key (raw 32 bytes, base64) — paste into');
console.log('# apps/desktop/.../provision-target-bridge.ts PINNED_SUPERVISOR_PUBLIC_KEY_B64:');
console.log(publicKeyB64);
console.log('#');
console.log('# PRIVATE key (PKCS8 DER, base64) — store as the SUPERVISOR_SIGNING_KEY GitHub');
console.log('# secret. Never commit this line.');
console.log(privateKeyPkcs8B64);
