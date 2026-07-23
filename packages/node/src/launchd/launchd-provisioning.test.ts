import { describe, expect, it, vi } from 'vitest';

import {
  buildLocalNodeLaunchdAgent,
  DEFAULT_LAUNCHD_LABEL,
  executeLaunchdProvisioning,
  generateLaunchdPlist,
  planLaunchdProvisioning,
  type LaunchdIo,
} from './launchd-provisioning';

/** A fully in-memory `LaunchdIo` fake — no real filesystem or `launchctl` call, matching this
 * module's own doc comment: "there is no Mac here", so every write/load call is injectable. */
function fakeIo(overrides: Partial<LaunchdIo> = {}): LaunchdIo & {
  files: Map<string, string>;
  launchctlCalls: string[][];
} {
  const files = new Map<string, string>();
  const launchctlCalls: string[][] = [];
  return {
    platform: 'darwin',
    homeDir: () => '/Users/lorenzo',
    uid: () => 501,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => {
      files.set(path, content);
    },
    mkdir: () => {
      /* in-memory — no real directory to create */
    },
    launchctl: async (args) => {
      launchctlCalls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    files,
    launchctlCalls,
    ...overrides,
  };
}

describe('generateLaunchdPlist', () => {
  it('renders a RunAtLoad/KeepAlive LaunchAgent plist with the real ExecStart and LOOMBOX_* env', () => {
    const content = generateLaunchdPlist({
      execStart: '/usr/local/bin/node',
      execArgs: ['/Applications/loombox.app/Contents/Resources/node/main.js'],
      workingDirectory: '/Users/lorenzo',
      environment: {
        LOOMBOX_RELAY_URL: 'wss://relay.loombox.dev/ws',
        LOOMBOX_NODE_ID: 'lorenzos-mac',
      },
    });

    expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain('<key>Label</key>');
    expect(content).toContain(`<string>${DEFAULT_LAUNCHD_LABEL}</string>`);
    expect(content).toContain('<key>ProgramArguments</key>');
    expect(content).toContain('<string>/usr/local/bin/node</string>');
    expect(content).toContain(
      '<string>/Applications/loombox.app/Contents/Resources/node/main.js</string>',
    );
    expect(content).toContain('<key>RunAtLoad</key>');
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(content).toContain('<key>KeepAlive</key>');
    expect(content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(content).toContain('<key>WorkingDirectory</key>');
    expect(content).toContain('<string>/Users/lorenzo</string>');
    expect(content).toContain('<key>EnvironmentVariables</key>');
    expect(content).toContain('<key>LOOMBOX_RELAY_URL</key>');
    expect(content).toContain('<string>wss://relay.loombox.dev/ws</string>');
    expect(content).toContain('<key>LOOMBOX_NODE_ID</key>');
    expect(content).toContain('<string>lorenzos-mac</string>');
    expect(content).toContain('</plist>');
  });

  it('honors an explicit label, and runAtLoad/keepAlive false', () => {
    const content = generateLaunchdPlist({
      execStart: '/usr/local/bin/node',
      label: 'dev.loombox.node.test',
      runAtLoad: false,
      keepAlive: false,
    });

    expect(content).toContain('<string>dev.loombox.node.test</string>');
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(content).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it('escapes XML-significant characters in string values', () => {
    const content = generateLaunchdPlist({
      execStart: '/usr/local/bin/node',
      environment: { LOOMBOX_NODE_ID: 'a & b <c> "d" \'e\'' },
    });

    expect(content).toContain('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
    expect(content).not.toContain('a & b <c>');
  });

  it('is deterministic for the same config (used for the noop/update comparison)', () => {
    const config = { execStart: '/usr/local/bin/node', execArgs: ['main.js'] };
    expect(generateLaunchdPlist(config)).toBe(generateLaunchdPlist(config));
  });

  it('omits WorkingDirectory/EnvironmentVariables entirely when not provided', () => {
    const content = generateLaunchdPlist({ execStart: '/usr/local/bin/node' });
    expect(content).not.toContain('WorkingDirectory');
    expect(content).not.toContain('EnvironmentVariables');
  });
});

describe('buildLocalNodeLaunchdAgent', () => {
  it("reuses provision-target.ts's buildResidentNodeEnvironment for the LOOMBOX_* env, keyed to the real node ExecStart", () => {
    const agent = buildLocalNodeLaunchdAgent({
      execStart: '/usr/local/bin/node',
      execArgs: ['/Applications/loombox.app/Contents/Resources/node/main.js'],
      config: {
        relayUrl: 'wss://relay.loombox.dev/ws',
        nodeId: 'lorenzos-mac',
        authToken: 'device-token-abc',
        amk: 'base64amk==',
      },
    });

    expect(agent.execStart).toBe('/usr/local/bin/node');
    expect(agent.execArgs).toEqual(['/Applications/loombox.app/Contents/Resources/node/main.js']);
    // Exactly what `buildResidentNodeEnvironment` (../ssh/provision-target.ts) itself produces —
    // the same LOOMBOX_* vocabulary `main.ts`'s `loadNodeConfig` reads, one mapper reused by both
    // the ssh: systemd path and this local launchd path rather than a second copy of it.
    expect(agent.environment).toEqual({
      LOOMBOX_RELAY_URL: 'wss://relay.loombox.dev/ws',
      LOOMBOX_NODE_ID: 'lorenzos-mac',
      LOOMBOX_AUTH_TOKEN: 'device-token-abc',
      LOOMBOX_AMK: 'base64amk==',
    });

    const content = generateLaunchdPlist(agent);
    expect(content).toContain('<key>LOOMBOX_RELAY_URL</key>');
    expect(content).toContain('<string>wss://relay.loombox.dev/ws</string>');
  });
});

describe('planLaunchdProvisioning', () => {
  it('reports unsupported without touching disk on a non-darwin platform', () => {
    const io = fakeIo({ platform: 'linux' });
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });

    expect(plan.action).toBe('unsupported');
    expect(plan.platformSupported).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it('plans a fresh install under ~/Library/LaunchAgents when nothing is staged yet', () => {
    const io = fakeIo();
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });

    expect(plan.action).toBe('install');
    expect(plan.label).toBe(DEFAULT_LAUNCHD_LABEL);
    expect(plan.plistPath).toBe(
      `/Users/lorenzo/Library/LaunchAgents/${DEFAULT_LAUNCHD_LABEL}.plist`,
    );
    expect(plan.desiredContent).toContain('/usr/local/bin/node');
  });

  it('reports noop when the exact desired content is already staged', () => {
    const io = fakeIo();
    const agent = { execStart: '/usr/local/bin/node' };
    const plan = planLaunchdProvisioning(io, { agent });
    io.files.set(plan.plistPath, plan.desiredContent);

    const replan = planLaunchdProvisioning(io, { agent });
    expect(replan.action).toBe('noop');
  });

  it('reports update when different content is already staged', () => {
    const io = fakeIo();
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });
    io.files.set(plan.plistPath, '<plist>stale</plist>');

    const replan = planLaunchdProvisioning(io, {
      agent: { execStart: '/usr/local/bin/node', execArgs: ['main.js'] },
    });
    expect(replan.action).toBe('update');
  });

  it('honors an explicit agentsDir override', () => {
    const io = fakeIo();
    const plan = planLaunchdProvisioning(io, {
      agent: { execStart: '/usr/local/bin/node' },
      agentsDir: '/tmp/custom-agents-dir',
    });

    expect(plan.plistPath).toBe(`/tmp/custom-agents-dir/${DEFAULT_LAUNCHD_LABEL}.plist`);
  });
});

describe('executeLaunchdProvisioning', () => {
  it('does nothing for a noop plan', async () => {
    const io = fakeIo();
    const result = await executeLaunchdProvisioning(io, {
      label: DEFAULT_LAUNCHD_LABEL,
      plistPath: '/Users/lorenzo/Library/LaunchAgents/x.plist',
      desiredContent: '<plist/>',
      currentContent: '<plist/>',
      platformSupported: true,
      action: 'noop',
      message: 'already up to date',
    });

    expect(result).toEqual({ ok: true, action: 'noop', ranCommands: [] });
    expect(io.launchctlCalls).toEqual([]);
  });

  it('fails without touching disk for an unsupported plan', async () => {
    const io = fakeIo();
    const result = await executeLaunchdProvisioning(io, {
      label: DEFAULT_LAUNCHD_LABEL,
      plistPath: '/Users/lorenzo/Library/LaunchAgents/x.plist',
      desiredContent: '<plist/>',
      currentContent: undefined,
      platformSupported: false,
      action: 'unsupported',
      message: 'launchd is macOS-only',
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('unsupported');
    expect(io.files.size).toBe(0);
    expect(io.launchctlCalls).toEqual([]);
  });

  it('writes the plist and bootstraps + enables it for a fresh install', async () => {
    const io = fakeIo();
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });

    const result = await executeLaunchdProvisioning(io, plan);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('install');
    expect(io.files.get(plan.plistPath)).toBe(plan.desiredContent);
    expect(io.launchctlCalls).toEqual([
      ['bootstrap', 'gui/501', plan.plistPath],
      ['enable', `gui/501/${plan.label}`],
    ]);
  });

  it('boots out the previous copy before reinstalling for an update', async () => {
    const io = fakeIo();
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });
    io.files.set(plan.plistPath, '<plist>stale</plist>');
    const updatePlan = planLaunchdProvisioning(io, {
      agent: { execStart: '/usr/local/bin/node', execArgs: ['main.js'] },
    });

    const result = await executeLaunchdProvisioning(io, updatePlan);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('update');
    expect(io.launchctlCalls).toEqual([
      ['bootout', `gui/501/${updatePlan.label}`],
      ['bootstrap', 'gui/501', updatePlan.plistPath],
      ['enable', `gui/501/${updatePlan.label}`],
    ]);
  });

  it('reports failure and stops when launchctl bootstrap exits non-zero', async () => {
    const io = fakeIo({
      launchctl: vi.fn(async (args: string[]) => {
        if (args[0] === 'bootstrap') {
          return { stdout: '', stderr: 'Bootstrap failed: 5: Input/output error', exitCode: 5 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });

    const result = await executeLaunchdProvisioning(io, plan);

    expect(result.ok).toBe(false);
    expect(result.action).toBe('install');
    expect(result.error).toMatch(/bootstrap failed/i);
    // `enable` never runs once `bootstrap` itself failed.
    expect((io.launchctl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('reports failure when launchctl enable exits non-zero', async () => {
    const io = fakeIo({
      launchctl: vi.fn(async (args: string[]) => {
        if (args[0] === 'enable') {
          return { stdout: '', stderr: 'Could not find service', exitCode: 3 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    const plan = planLaunchdProvisioning(io, { agent: { execStart: '/usr/local/bin/node' } });

    const result = await executeLaunchdProvisioning(io, plan);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/enable failed/i);
  });
});
