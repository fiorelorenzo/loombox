import { randomUUID } from 'node:crypto';

import { openPortForwardTunnel, type PortForwardTunnel } from './port-forward-tunnel';
import type { PortForwardTransport } from './port-forward-transport';

/**
 * A live port-forward rule for one `ssh:` target — the user-facing lifecycle
 * layer on top of `./port-forward-tunnel.ts`'s tunnel primitive (issue #93,
 * SPEC §7.8). `origin` distinguishes a rule the user created explicitly
 * (`'manual'`, issue #93) from one `./dev-server-detector.ts` created for
 * them after sniffing a dev-server banner (`'auto'`, issue #94) — both ride
 * the exact same {@link PortForwardRuleManager}, since a rule is a rule once
 * it exists; only how it came to exist differs.
 */
export interface PortForwardRule {
  id: string;
  targetId: string;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  origin: 'manual' | 'auto';
  createdAt: number;
}

export interface CreatePortForwardRuleOptions {
  targetId: string;
  /** Remote host to forward to, as resolved by the SSH server. Defaults to `'127.0.0.1'` — the common "forward my dev server" case (a process listening on the remote's own loopback). */
  remoteHost?: string;
  remotePort: number;
  /** Local interface to bind the listener to. Defaults to `'127.0.0.1'`. */
  localHost?: string;
  /** Local port to listen on. Omit (or `0`) to pick a free ephemeral port — read it back from the returned rule's `localPort`. */
  localPort?: number;
  /** Defaults to `'manual'`; `./dev-server-detector.ts` passes `'auto'`. */
  origin?: 'manual' | 'auto';
}

interface ActiveRule {
  rule: PortForwardRule;
  tunnel: PortForwardTunnel;
}

/**
 * Owns every active port-forward rule across this node's `ssh:` targets
 * (issue #93's create/list/remove; issue #94's auto-created rules ride the
 * same manager — see `origin` on {@link PortForwardRule}). A thin lifecycle
 * layer over `openPortForwardTunnel`: `create()` opens a tunnel and records
 * a rule for it, `remove()` closes that tunnel and forgets the rule, `list()`
 * reads the in-memory set back. Rules are node-local and in-memory only —
 * not persisted across a node restart, matching how `SshTransportPool`'s
 * connections themselves don't survive a restart either.
 */
export class PortForwardRuleManager {
  private readonly rules = new Map<string, ActiveRule>();

  /**
   * `getTransport` resolves a target id to the {@link PortForwardTransport}
   * to tunnel over — callers pass `(targetId) => sshTransportPool.get(targetId, ...)`
   * (or an equivalent bound closure) so every rule rides the same pooled,
   * reconnecting connection every other operation on that target already
   * uses, rather than opening a second one.
   */
  constructor(private readonly getTransport: (targetId: string) => Promise<PortForwardTransport>) {}

  /** Opens a tunnel for `options` and records a new rule for it. The local port is reachable immediately once this resolves. */
  async create(options: CreatePortForwardRuleOptions): Promise<PortForwardRule> {
    const transport = await this.getTransport(options.targetId);
    const remoteHost = options.remoteHost ?? '127.0.0.1';

    const tunnel = await openPortForwardTunnel(transport, {
      remoteHost,
      remotePort: options.remotePort,
      localHost: options.localHost,
      localPort: options.localPort,
    });

    const rule: PortForwardRule = {
      id: randomUUID(),
      targetId: options.targetId,
      remoteHost,
      remotePort: options.remotePort,
      localHost: tunnel.localHost,
      localPort: tunnel.localPort,
      origin: options.origin ?? 'manual',
      createdAt: Date.now(),
    };

    this.rules.set(rule.id, { rule, tunnel });
    return rule;
  }

  /** Every active rule, or only `targetId`'s when given. */
  list(targetId?: string): PortForwardRule[] {
    const all = [...this.rules.values()].map((entry) => entry.rule);
    return targetId ? all.filter((rule) => rule.targetId === targetId) : all;
  }

  get(id: string): PortForwardRule | undefined {
    return this.rules.get(id)?.rule;
  }

  /**
   * Finds an already-active rule forwarding this exact
   * `(targetId, remoteHost, remotePort)` tuple, if any — `./dev-server-
   * detector.ts` (issue #94) checks this before creating a new rule, so
   * re-detecting the same banner (a dev server that reprints its own URL, or
   * two banners for the same server) never creates a duplicate tunnel.
   */
  findByRemote(
    targetId: string,
    remoteHost: string,
    remotePort: number,
  ): PortForwardRule | undefined {
    for (const entry of this.rules.values()) {
      if (
        entry.rule.targetId === targetId &&
        entry.rule.remoteHost === remoteHost &&
        entry.rule.remotePort === remotePort
      ) {
        return entry.rule;
      }
    }
    return undefined;
  }

  /** Tears down `id`'s tunnel and forgets the rule. Throws if `id` isn't an active rule. */
  async remove(id: string): Promise<void> {
    const entry = this.rules.get(id);
    if (!entry) {
      throw new Error(`PortForwardRuleManager: no rule with id ${id}`);
    }
    this.rules.delete(id);
    await entry.tunnel.close();
  }

  /** Tears down and forgets every rule for `targetId` — the port-forward half of decommissioning a target (issue #90). A no-op if it has none. */
  async removeAllForTarget(targetId: string): Promise<void> {
    const ids = this.list(targetId).map((rule) => rule.id);
    await Promise.all(ids.map((id) => this.remove(id)));
  }
}
