import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { startRelay } from './relay';

/**
 * Runnable entry point for the v1 relay (SPEC §9's "relay on prodbox").
 * Reads HOST/PORT from the environment; defaults to a loopback bind so the
 * deploy step must opt in explicitly to a public interface.
 */
export async function start(): Promise<StartedRelayHandle> {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ? Number(process.env.PORT) : 8787;

  const { url, close } = await startRelay({ host, port, logger: true });
  console.log(`loombox relay listening on ${url}`);
  return { url, close };
}

interface StartedRelayHandle {
  url: string;
  close: () => Promise<void>;
}

const isMainModule = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (isMainModule) {
  start().catch((error: unknown) => {
    console.error('loombox relay failed to start', error);
    process.exitCode = 1;
  });
}
