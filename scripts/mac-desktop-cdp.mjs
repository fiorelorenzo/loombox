#!/usr/bin/env node
//
// CDP driver for `scripts/mac-desktop.sh --debug` / `--reload`.
//
// Talks to the Electron renderer's Chrome DevTools Protocol endpoint that
// `--debug` forwards from the Mac, so the desktop window is drivable from the
// devbox without a browser here.
//
//   node scripts/mac-desktop-cdp.mjs <port> navigate [url]
//   node scripts/mac-desktop-cdp.mjs <port> settle <url>
//
// `navigate` loads a URL (default: whatever the window is already on).
// `settle` asserts the window is actually showing the app rather than an error
// page, navigating (up to 3 times) until it is. It exists so a launch that
// reports success has actually been checked, instead of leaving a broken view on
// screen for someone to discover later.
//
// Why `Page.navigate` and never `Page.reload`: measured on macOS 26 / Electron 43,
// `Page.reload` (even with `ignoreCache: true`) leaves a rendered error page in
// place, while navigating to the same URL re-renders it properly.

const [, , portArg, mode, urlArg] = process.argv;
const port = Number(portArg);
if (!port || !mode) {
  console.error('usage: mac-desktop-cdp.mjs <port> navigate|settle [url]');
  process.exit(2);
}

/** SvelteKit's default error page, e.g. "500\n\nInternal Error". */
const ERROR_PAGE = /^\s*\d{3}\s*Internal Error/;

/**
 * Nothing here may wait forever. A debug helper that hangs is worse than one
 * that fails: it blocks whatever invoked it with no output to explain why. So
 * every await is bounded, and the whole run has a ceiling on top of that.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 45_000;

const runDeadline = setTimeout(() => {
  console.error(`!! timed out after ${RUN_TIMEOUT_MS / 1000}s talking to CDP on ${port}`);
  process.exit(1);
}, RUN_TIMEOUT_MS);
runDeadline.unref?.();

/** Rejects `promise` if it has not settled within `ms`. */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

async function pageTarget() {
  const res = await withTimeout(
    fetch(`http://127.0.0.1:${port}/json/list`),
    REQUEST_TIMEOUT_MS,
    'GET /json/list',
  );
  const targets = await res.json();
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error(`no page target on CDP port ${port}`);
  return target;
}

/** One short-lived CDP session; `send` resolves with the matching reply. */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(
    new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not open the CDP websocket'));
    }),
    REQUEST_TIMEOUT_MS,
    'CDP websocket open',
  );

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else settle.resolve(message.result);
  };

  return {
    send(method, params = {}) {
      const id = ++nextId;
      return withTimeout(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        }),
        REQUEST_TIMEOUT_MS,
        method,
      );
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `document.body.innerText`, or `null` when the renderer will not answer.
 *
 * Non-fatal on purpose. A renderer left wedged by an earlier CDP client that
 * detached mid-flight still serves `Page.*` while `Runtime.evaluate` never
 * replies at all (observed: `Target.getTargetInfo` and
 * `Page.getNavigationHistory` fine, `Runtime.evaluate` silent). Navigating
 * unwedges it, so "cannot read the page" has to mean "navigate", not "give up" -
 * otherwise the one situation this helper exists to fix is the one it dies on.
 */
async function bodyText(session) {
  try {
    const { result } = await session.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText.slice(0, 200) : ""',
      returnByValue: true,
    });
    return typeof result.value === 'string' ? result.value : '';
  } catch {
    return null;
  }
}

async function navigate(session, url) {
  await session.send('Page.navigate', { url });
  // Page.navigate resolves on commit, not on render; give the app a beat to
  // paint before anything reads the DOM back.
  await sleep(2500);
}

let session;
try {
  const target = await pageTarget();
  session = await connect(target);
  const url = urlArg || target.url;

  if (mode === 'navigate') {
    await navigate(session, url);
    console.log(`>> loaded ${url}`);
  } else if (mode === 'settle') {
    const needsNavigate = (text) => text === null || text === '' || ERROR_PAGE.test(text);
    let text = await bodyText(session);
    for (let attempt = 0; attempt < 3 && needsNavigate(text); attempt += 1) {
      await navigate(session, url);
      text = await bodyText(session);
    }
    if (text === null) {
      console.log('   !! the renderer never answered Runtime.evaluate, even after navigating');
      console.log('      relaunch the app if the window looks wrong');
    } else if (ERROR_PAGE.test(text)) {
      console.log(
        `   !! window still on an error page after 3 navigations: ${text.split('\n')[0]}`,
      );
      console.log('      the dev server may be genuinely failing - check its log');
    } else {
      console.log(`   window rendering: ${text.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
    }
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} catch (error) {
  // One line, not a stack: the caller is a shell script, and the useful part is
  // always what could not be reached.
  console.error(`!! ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  session?.close();
  clearTimeout(runDeadline);
}
