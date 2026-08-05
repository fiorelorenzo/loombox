/**
 * dev-browser-seed.mjs — makes a headless browser on THIS box a signed-in,
 * AMK-holding device on the local dev loop (`scripts/dev.sh`), so verifying
 * the PWA no longer needs the Electron app on the Mac (issue #726).
 *
 * Why this exists. A headless Chrome tab on `http://localhost:5173` is a
 * perfectly good loombox client: localhost is a secure context, so
 * `crypto.subtle` exists and the E2E crypto (SPEC §8) works with no TLS cert
 * and no Chromium flags — the same reason `.env.dev.example` gives for
 * registering the OAuth callback on localhost. What a fresh browser profile
 * does NOT have is a session (login is GitHub OAuth, which nobody can click
 * in a headless browser) or an AMK (a fresh origin is a new device, so every
 * launch would mean hand-walking the recovery-code screen — which also echoes
 * the code into an agent's transcript through the input's ARIA value).
 *
 * So this resolves both, exactly the way the real clients do:
 *
 *   - the bearer token the app keeps in `localStorage` under
 *     `loombox:auth-session` (NOT a cookie — see `apps/web`'s `auth-store.ts`
 *     and `tests-e2e/fixtures.ts`, which seeds the same pair): the newest
 *     live Better Auth session for the dev account, or a freshly minted one.
 *   - the account AMK, via `@loombox/node`'s own
 *     `bootstrapAmkFromRecoveryCode` against the relay's escrow — the same
 *     round trip and the same crypto path the app's new-device flow drives,
 *     with `LOOMBOX_RECOVERY_CODE` from `.env.dev.local`. Nothing is faked;
 *     a wrong code fails the AES-GCM tag check like it would in the app.
 *
 * The pair lands in `~/.loombox/dev-browser-seed.json` (0600, outside the
 * repo, next to the dev node's own state dir) and NOT on stdout: an agent's
 * browser tool reads that file inside its own code, so neither the token nor
 * the recovery code is ever printed into a transcript. stdout carries only
 * non-secret facts plus the snippet that applies the seed.
 *
 * Usage:
 *   pnpm dev:browser-seed                      # reuse a live session if there is one
 *   pnpm dev:browser-seed --force-new-session  # mint a fresh session token anyway
 *
 * Deliberately NOT here: creating the account. Right after `scripts/dev.sh
 * --fresh` the dev database has no user at all, and the only thing that
 * creates one is a real GitHub OAuth sign-in in a real browser (SPEC §8
 * scopes login to Google/GitHub; `packages/relay`'s `emailAndPassword` is a
 * test-only escape hatch and stays off in the dev relay). This says so
 * instead of inventing a user.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapAmkFromRecoveryCode } from '@loombox/node';

// Fixed to match scripts/dev.sh's own port map and compose project — that
// script explains why those are literals rather than env-overridable.
const WEB_URL = 'http://localhost:5173';
const RELAY_HTTP_URL = 'http://127.0.0.1:8790';
const RELAY_WS_URL = 'ws://localhost:8790/ws';
const COMPOSE_FILE = 'deploy/dev/docker-compose.yml';
const COMPOSE_PROJECT = 'loombox-dev';
const ENV_FILE = '.env.dev.local';
/** How long a session this script mints itself lasts. Better Auth's own default is 7 days; matching it keeps a minted token indistinguishable from a real login's. */
const MINTED_SESSION_DAYS = 7;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(homedir(), '.loombox');
const seedPath = path.join(stateDir, 'dev-browser-seed.json');
const devicePath = path.join(stateDir, 'dev-browser-device.json');

function fail(message, hint) {
  console.error(`!! ${message}`);
  if (hint) console.error(hint.replace(/^/gm, '   '));
  process.exit(1);
}

/** Minimal `KEY=VALUE` reader for `.env.dev.local` — the same file `scripts/dev.sh` sources with `set -a`, so it only ever holds plain assignments. */
function loadEnvFile(filePath) {
  const env = {};
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/**
 * One `psql` round trip against the dev Postgres, through docker compose so
 * the container name is never hardcoded. `vars` are passed as psql variables
 * and referenced as `:'name'` in `sql`, which is what quotes/escapes them —
 * never string-interpolated into the statement.
 *
 * The statement goes in on STDIN, not via `-c`: psql only interpolates its
 * variables while lexing script input, so a `-c` string keeps `:'uid'`
 * verbatim and the server rejects it (`syntax error at or near ":"`).
 */
function psql(sql, vars = {}) {
  const varArgs = Object.entries(vars).flatMap(([name, value]) => ['-v', `${name}=${value}`]);
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      '-p',
      COMPOSE_PROJECT,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'loombox',
      '-d',
      'loombox',
      '-qtAX',
      ...varArgs,
    ],
    { cwd: repoRoot, encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

/**
 * This browser client's own device identity, generated once and reused, so
 * repeat runs re-register the SAME device rather than piling up rows in the
 * account's device list. It is a real device in SPEC §8's sense (a client
 * that holds the AMK), just an unattended one, hence the honest id.
 */
function loadOrCreateDeviceIdentity() {
  if (existsSync(devicePath)) return JSON.parse(readFileSync(devicePath, 'utf8'));
  const identity = {
    deviceId: 'devbox-headless-browser',
    devicePublicKey: randomBytes(32).toString('base64'),
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(devicePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(devicePath, 0o600);
  return identity;
}

const forceNewSession = process.argv.includes('--force-new-session');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--force-new-session') fail(`unknown flag: ${arg} (known: --force-new-session)`);
}

const envPath = path.join(repoRoot, ENV_FILE);
if (!existsSync(envPath)) {
  fail(
    `no ${ENV_FILE} — this box has never run the dev loop`,
    'run scripts/dev.sh once: it creates the file and tells you what to fill in.',
  );
}
const env = loadEnvFile(envPath);
const recoveryCode = env.LOOMBOX_RECOVERY_CODE;
if (!recoveryCode) {
  fail(
    `${ENV_FILE} has no LOOMBOX_RECOVERY_CODE, so this account's AMK cannot be recovered`,
    'sign in at http://localhost:5173, set up a Recovery Code (Settings > Recovery Code),\n' +
      `and paste it into ${ENV_FILE} as LOOMBOX_RECOVERY_CODE.`,
  );
}

try {
  const health = await fetch(`${RELAY_HTTP_URL}/health`);
  if (!health.ok) throw new Error(`status ${health.status}`);
} catch (error) {
  fail(
    `the dev relay is not answering on ${RELAY_HTTP_URL}/health (${error instanceof Error ? error.message : String(error)})`,
    'bring the loop up first: scripts/dev.sh (or scripts/dev.sh --no-mac).',
  );
}

let accountId;
let accountEmail;
try {
  // Newest session first so a multi-account dev database resolves to the one
  // actually being used, falling back to the only/oldest user otherwise.
  const row = psql(
    'select u.id, u.email from "user" u left join session s on s."userId" = u.id ' +
      'group by u.id, u.email, u."createdAt" order by max(s."createdAt") desc nulls last, u."createdAt" asc limit 1',
  );
  [accountId, accountEmail] = row.split('|');
} catch (error) {
  fail(
    `could not query the dev Postgres (${error instanceof Error ? error.message : String(error)})`,
    'it runs under docker compose as part of scripts/dev.sh; check: docker compose ' +
      `-f ${COMPOSE_FILE} -p ${COMPOSE_PROJECT} ps`,
  );
}
if (!accountId) {
  fail(
    'the dev database has no user yet, so there is no account to seed a browser with',
    'sign in once with GitHub in a browser you can actually click (the desktop app on the\n' +
      'Mac, scripts/mac-desktop.sh --dev, or a forwarded http://localhost:5173) — that is the\n' +
      'only thing that creates the account. Every later headless run reuses it.',
  );
}

let token = forceNewSession
  ? ''
  : psql(
      'select token from session where "userId" = :\'uid\' and "expiresAt" > now() ' +
        'order by "expiresAt" desc limit 1',
      { uid: accountId },
    );
const reusedSession = token !== '';
if (!reusedSession) {
  // Better Auth's bearer plugin looks the raw `session.token` up directly (no
  // signature wrapper — `packages/relay`'s auth.test.ts uses the very same
  // `set-auth-token` value as a Bearer token), so a row with a random token
  // IS a usable session. Minted here rather than through Better Auth's own
  // API because every API path that issues one requires a login this box
  // cannot perform.
  token = randomBytes(24).toString('base64url');
  psql(
    'insert into session (id, token, "userId", "expiresAt", "createdAt", "updatedAt", "userAgent") ' +
      `values (:'id', :'token', :'uid', now() + interval '${MINTED_SESSION_DAYS} days', now(), now(), :'ua')`,
    {
      id: randomBytes(16).toString('base64url'),
      token,
      uid: accountId,
      ua: 'loombox dev-browser-seed (headless devbox browser)',
    },
  );
}
const expiresAt = psql('select "expiresAt" from session where token = :\'token\'', { token });

const identity = loadOrCreateDeviceIdentity();
let amk;
try {
  amk = await bootstrapAmkFromRecoveryCode({
    relayUrl: RELAY_WS_URL,
    accountId,
    authToken: token,
    deviceId: identity.deviceId,
    devicePublicKey: identity.devicePublicKey,
    recoveryCode,
  });
} catch (error) {
  fail(
    `could not recover the AMK from LOOMBOX_RECOVERY_CODE (${error instanceof Error ? error.message : String(error)})`,
    'either the code in .env.dev.local does not belong to this account, or this account has\n' +
      'never escrowed an AMK (set up a Recovery Code in the app once — SPEC §8 path 2).',
  );
}

mkdirSync(stateDir, { recursive: true });
writeFileSync(
  seedPath,
  `${JSON.stringify(
    {
      webUrl: WEB_URL,
      relayUrl: RELAY_WS_URL,
      accountId,
      token,
      amkBase64: Buffer.from(amk).toString('base64'),
      writtenAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
chmodSync(seedPath, 0o600);

console.log(`>> seed written to ${seedPath} (0600)`);
console.log(`     account       ${accountId}${accountEmail ? ` (${accountEmail})` : ''}`);
console.log(
  `     session       ${reusedSession ? 'reused an existing one' : 'minted a new one'}, expires ${expiresAt}`,
);
console.log(`     device        ${identity.deviceId}`);
console.log(`     amk           recovered from LOOMBOX_RECOVERY_CODE via the relay escrow`);
console.log(`
   Apply it in a headless tab (the browser tool's own code reads the file, so
   nothing secret is printed):

     const seed = JSON.parse(require('node:fs').readFileSync('${seedPath}', 'utf8'));
     await tab.goto(seed.webUrl);
     await tab.evaluate((s) => {
       localStorage.setItem('loombox:auth-session', JSON.stringify({ token: s.token, accountId: s.accountId }));
       localStorage.setItem('loombox:relay-url', s.relayUrl);
       localStorage.setItem(\`loombox:amk:\${s.accountId}\`, s.amkBase64);
     }, seed);
     await tab.goto(seed.webUrl);
`);
