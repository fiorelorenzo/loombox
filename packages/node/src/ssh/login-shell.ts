import { shQuote } from './remote-transport';

/**
 * Fixes the non-interactive-shell PATH problem (issue #73, SPEC §9): a
 * command sent straight to `sshd` for a single command (`ssh host cmd`, or
 * `ssh2`'s `Client.exec`, which is what {@link Ssh2Transport} uses under the
 * hood) runs in a **non-login, non-interactive** shell, which on a headless
 * box does *not* source whatever activates `mise` (or nvm, or any other
 * runtime manager) — so `node`, and the agent CLI it manages, are not on
 * `PATH` even though the exact same command works fine in an interactive SSH
 * session. Two independent fixes, applied together for robustness:
 *
 * 1. **Login-shell sourcing.** The whole script runs under `bash -lc`, which
 *    (unlike a bare `sh -c`) sources `/etc/profile` and the user's
 *    `~/.bash_profile`/`~/.bash_login`/`~/.profile` — exactly what an
 *    interactive login does, and where a runtime manager's activation line
 *    commonly lives.
 * 2. **Explicit mise-activate fallback.** Some setups (this very devbox is
 *    one — see its `~/.bashrc`) gate the activation line behind an
 *    *interactive*-shell guard, which `bash -lc` does not satisfy either (it
 *    is non-interactive, only a login shell). So this also runs
 *    `eval "$(~/.local/bin/mise activate bash)"` directly, guarded by an
 *    existence check so a remote with no mise installed is unaffected.
 *
 * Used by every command {@link Ssh2Transport} sends (`exec`), so it
 * transitively covers everything built on top of it too — `RemoteProcessRunner`'s
 * one-shot setup/launch/attach/stdin/stdout scripts and the detached process
 * they launch (a `setsid`/`tmux`/`screen`-detached child inherits its
 * launching shell's already-activated `PATH`, and keeps it for its own
 * lifetime independent of this SSH session ending) — without any of those
 * callers needing to know this wrapping exists.
 */
export function wrapForLoginShell(command: string): string {
  const script = [
    'if [ -x "$HOME/.local/bin/mise" ]; then eval "$("$HOME/.local/bin/mise" activate bash)"; fi',
    command,
  ].join('\n');
  return `bash -lc ${shQuote(script)}`;
}
