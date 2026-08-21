import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Where a session's work happens.
 *
 * One implementation today: a configured directory, shared by every session. The
 * interface exists anyway because the alternative -- a git worktree per session --
 * changes when a directory comes into existence and who is allowed to delete it,
 * and retrofitting that means touching every call site that assumed a path was
 * just a string in the config.
 */

export interface Workspace {
  /** Stable across restarts. Derived from the resolved path, not minted. */
  id: string;
  kind: 'plain-dir' | 'git-worktree';
  /** Absolute and realpath-resolved. */
  cwd: string;
}

export interface WorkspaceProvider {
  readonly kind: Workspace['kind'];
  acquire(sessionId: string): Promise<Workspace>;
  /** Idempotent, and must not throw. Nothing may depend on it having run. */
  release(sessionId: string): Promise<void>;
}

/**
 * Every session works in one configured directory.
 *
 * Concurrent sessions therefore share a working tree, which is a real limitation
 * and stated here rather than discovered: two agents editing the same files will
 * interleave their edits. It is the honest starting point -- the isolation story is
 * worktrees, and pretending a plain directory provides any is worse than the
 * limitation.
 */
export class PlainDirWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;
  readonly #configured: string;
  #resolved: Workspace | undefined;

  constructor(dir: string) {
    if (!isAbsolute(dir)) {
      // Relative paths resolve against the gateway's cwd, which is whatever the
      // service manager happened to set. That makes the workspace depend on how
      // the process was launched.
      throw new Error(`workspace dir must be absolute, got ${JSON.stringify(dir)}`);
    }
    this.#configured = dir;
  }

  async acquire(_sessionId: string): Promise<Workspace> {
    const cached = this.#resolved;
    if (cached !== undefined) return cached;

    // realpath once, then reuse. Pinning the resolved path means a symlink swapped
    // underneath us later cannot silently redirect an agent with write access to a
    // different tree.
    const cwd = await realpath(this.#configured);
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error(`workspace ${cwd} is not a directory`);

    const workspace: Workspace = {
      id: `plain-dir:${createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, 16)}`,
      kind: this.kind,
      cwd,
    };
    this.#resolved = workspace;
    return workspace;
  }

  async release(_sessionId: string): Promise<void> {
    // Nothing to release: the directory is the user's and outlives every session.
    // Deleting it here would be the single most destructive thing this codebase
    // could do.
  }
}
