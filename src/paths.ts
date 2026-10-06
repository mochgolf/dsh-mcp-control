/**
 * Working-directory checks for `session_start`. The path predicate is the one
 * the Workspace Registry canonicalizes with, and the existence check runs
 * before DSH is reached, because Session creation makes a missing directory
 * rather than refusing it. The git layout read here lets the receipt name a
 * linked worktree's main checkout and warn when repository metadata lies
 * outside the directory a workspace-write Session may modify.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

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

/** A linked git worktree: where it lives and the checkout it belongs to. */
export interface WorktreeFacts {
  /** The linked worktree's own root directory. */
  readonly root: string
  /** The main checkout the worktree shares its repository with; null for a bare repository. */
  readonly mainPath: string | null
  /** The checked-out branch; null for a detached HEAD. */
  readonly branch: string | null
}

/** The git repository that owns one working directory. */
export interface GitLayout {
  /** The directory holding the nearest `.git` entry at or above the working directory. */
  readonly root: string
  /** Repository metadata directories that writes such as `git add` and `git commit` modify. */
  readonly metadataDirs: readonly string[]
  /** Present when the working tree is a linked worktree (`git worktree add`). */
  readonly worktree?: WorktreeFacts
}

/** Directory levels searched upward for a `.git` entry. */
const MAX_GIT_SEARCH_DEPTH = 64

/** Read one small git metadata file, or undefined when it is absent. */
async function readGitFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/** The canonical spelling of a path git recorded, or the path itself when it cannot be resolved. */
async function canonicalOr(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** The branch a `HEAD` file names, or null for a detached HEAD. */
async function branchOf(gitDir: string): Promise<string | null> {
  const head = await readGitFile(join(gitDir, 'HEAD'))
  const ref = head?.startsWith('ref: ') === true ? head.slice('ref: '.length) : undefined
  if (ref === undefined) return null
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/**
 * Find the git repository that owns a canonical working directory by reading
 * its `.git` entry directly, without running git. A `.git` directory is an
 * ordinary checkout; a `.git` file whose git directory holds `commondir` is a
 * linked worktree whose index, refs, and objects live in the main repository;
 * any other `.git` file (a submodule or a separate git dir) is reported without
 * worktree facts.
 * @param canonicalCwd - the working directory after `realpath`.
 * @returns the layout, or undefined outside any git working tree.
 */
export async function gitLayoutOf(canonicalCwd: string): Promise<GitLayout | undefined> {
  let dir = canonicalCwd
  for (let depth = 0; depth < MAX_GIT_SEARCH_DEPTH; depth += 1) {
    const entry = join(dir, '.git')
    let isDirectory: boolean | undefined
    try {
      isDirectory = (await stat(entry)).isDirectory()
    } catch {
      isDirectory = undefined
    }
    if (isDirectory === true) return { root: dir, metadataDirs: [await canonicalOr(entry)] }
    if (isDirectory === false) {
      const pointer = await readGitFile(entry)
      if (pointer?.startsWith('gitdir:') !== true) return undefined
      // Git may record a non-canonical spelling, such as /var for /private/var.
      const gitDir = await canonicalOr(resolve(dir, pointer.slice('gitdir:'.length).trim()))
      const common = await readGitFile(join(gitDir, 'commondir'))
      if (common === undefined) return { root: dir, metadataDirs: [gitDir] }
      const commonDir = await canonicalOr(resolve(gitDir, common))
      return {
        root: dir,
        metadataDirs: [gitDir, commonDir],
        worktree: {
          root: dir,
          mainPath: basename(commonDir) === '.git' ? dirname(commonDir) : null,
          branch: await branchOf(gitDir),
        },
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Whether `path` lies inside `root` (or is `root`), on the platform's path rules.
 * @param root - the containing directory.
 * @param path - the candidate path.
 * @returns true when `path` is `root` or a descendant of it.
 */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
