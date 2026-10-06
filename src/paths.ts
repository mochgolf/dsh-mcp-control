/**
 * Working-directory checks for `session_start`. The path predicate is the one
 * the Workspace Registry canonicalizes with, and the existence check runs
 * before DSH is reached, because Session creation makes a missing directory
 * rather than refusing it.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Whether a path names one fixed location without the process cwd or the
 * current Windows drive. On Windows this refuses root-relative spellings such
 * as `\repo` or `/home/me/repo` that `path.isAbsolute` accepts, and drive-relative
 * `C:repo`; drive-qualified and UNC paths remain valid.
 * @param path - candidate working directory.
 * @param platform - host platform; injectable so both rules are testable on one host.
 * @returns whether the path is fully qualified on that platform.
 */
export function isFullyQualifiedPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/** Failure codes for a working directory that cannot host a Session. */
export type CwdFailureCode = 'mcp-control/cwd-not-found' | 'mcp-control/cwd-not-directory' | 'mcp-control/cwd-unavailable'

/** Outcome of checking one requested working directory. */
export type CwdCheck =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly code: CwdFailureCode; readonly message: string; readonly reason?: string }

/** The errno code of a filesystem failure, when it carries one. */
function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Check that a fully qualified working directory exists and is a directory, and
 * resolve its canonical spelling.
 * @param path - fully qualified working directory requested by the client.
 * @returns the canonical path, or the reason the directory cannot host a Session.
 */
export async function checkCwd(path: string): Promise<CwdCheck> {
  try {
    const stats = await stat(path)
    if (!stats.isDirectory()) {
      return { ok: false, code: 'mcp-control/cwd-not-directory', message: 'cwd exists but is not a directory' }
    }
    return { ok: true, canonical: await realpath(path) }
  } catch (error: unknown) {
    const reason = errnoOf(error)
    if (reason === 'ENOENT' || reason === 'ENOTDIR') {
      return { ok: false, code: 'mcp-control/cwd-not-found', message: 'cwd does not exist; DSH would otherwise create an empty directory there' }
    }
    return {
      ok: false,
      code: 'mcp-control/cwd-unavailable',
      message: 'cwd could not be inspected',
      ...(reason === undefined ? {} : { reason }),
    }
  }
}
