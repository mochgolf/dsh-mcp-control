/**
 * `session_start` in git working trees laid out the way Codex and other agents
 * create them: a linked worktree outside the main checkout, one inside it, a
 * detached worktree, and subdirectories of each. A worktree Session must stay in
 * its own directory — never moved into the main checkout's Workspace — while the
 * receipt names the main checkout and warns when commits will be denied.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Client } from '@modelcontextprotocol/client'
import { gitLayoutOf, isWithin } from '../src/paths.ts'
import { textResponse } from './support/mock-adapter.ts'
import { bootHarness, closeAll, connectClient, textJson, type Harness } from './harness.ts'

const harnesses: Harness[] = []
const clients: Client[] = []
const scratch: string[] = []

afterEach(async () => {
  await closeAll(clients.splice(0), harnesses.splice(0))
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function boot(options: Parameters<typeof bootHarness>[0] = {}): Promise<{ harness: Harness; client: Client }> {
  const harness = await bootHarness({ registerWorkspace: true, script: Array.from({ length: 6 }, () => textResponse('ok')), ...options })
  harnesses.push(harness)
  const client = await connectClient(`${harness.baseUrl}/mcp`)
  clients.push(client)
  return { harness, client }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'ignore' })
}

/** Turn the harness workspace into a git repository with one commit. */
function initRepo(repo: string): void {
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'README.md'), 'main checkout\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
}

/** A canonical scratch directory outside the repository, like `~/.codex/worktrees/<id>`. */
function outsideDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-mcp-control-worktrees-')))
  scratch.push(dir)
  return dir
}

async function start(client: Client, cwd: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: 'session_start', arguments: { cwd, prompt: 'work here', ...extra } })
  if (result.isError === true) throw new Error(`session_start failed: ${JSON.stringify(result.structuredContent)}`)
  return textJson(result)
}

describe('git layout detection', () => {
  it('reads ordinary checkouts, linked worktrees, and other .git files without running git', async () => {
    const root = outsideDir()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    initRepo(repo)
    const linked = join(root, 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', linked)
    const detached = join(root, 'detached')
    git(repo, 'worktree', 'add', '-q', '--detach', detached)
    mkdirSync(join(linked, 'pkg'))
    const submodule = join(root, 'submodule')
    mkdirSync(submodule)
    writeFileSync(join(submodule, '.git'), 'gitdir: ../repo/.git/modules/submodule\n')

    expect(await gitLayoutOf(repo)).toEqual({ root: repo, metadataDirs: [join(repo, '.git')] })
    expect(await gitLayoutOf(linked)).toMatchObject({
      root: linked,
      worktree: { root: linked, mainPath: repo, branch: 'feature/x' },
    })
    expect(await gitLayoutOf(join(linked, 'pkg'))).toMatchObject({ root: linked, worktree: { root: linked } })
    expect((await gitLayoutOf(detached))?.worktree?.branch).toBeNull()
    expect((await gitLayoutOf(submodule))?.worktree).toBeUndefined()
    expect(await gitLayoutOf(outsideDir())).toBeUndefined()
  })

  it('compares containment on whole path segments', () => {
    const root = join(tmpdir(), 'repo')
    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(root, join(root, '.git'))).toBe(true)
    expect(isWithin(root, join(root, '..foo'))).toBe(true)
    expect(isWithin(root, join(tmpdir(), 'repo-other'))).toBe(false)
    expect(isWithin(join(root, 'sub'), join(root, '.git'))).toBe(false)
  })
})

describe('session_start in git working trees', () => {
  it('keeps a Codex-style worktree Session in the worktree and names its main checkout', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    initRepo(harness.workspace)
    const worktree = join(outsideDir(), basename(harness.workspace))
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/task-1', worktree)
    const main = harness.ctx.workspaceRegistry.list()[0]!

    const receipt = await start(client, worktree, { session_id: 'codex-task' })
    expect(receipt).toMatchObject({
      cwd: worktree,
      workspace: null,
      git_worktree: {
        root: worktree,
        main_path: harness.workspace,
        branch: 'codex/task-1',
        main_workspace: { id: main.id, title: main.title },
      },
      warnings: [{ code: 'git-metadata-outside-cwd' }],
    })
    // Never redirected into the main checkout, whose Workspace would set cwd to it.
    expect(harness.ctx.sessions.get(SessionId('codex-task'))?.header.cwd).toBe(worktree)
    expect(main.sessionIds).toEqual([])
    const paths = (receipt.warnings as Array<{ paths: string[] }>)[0]!.paths
    expect(paths.every(path => isWithin(harness.workspace, path))).toBe(true)
  })

  it('does not group a worktree nested inside the main checkout under the main Workspace', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    initRepo(harness.workspace)
    const nested = join(harness.workspace, '.worktrees', 'wave-1')
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/wave-1', nested)
    const receipt = await start(client, nested, { session_id: 'nested' })
    expect(receipt).toMatchObject({ workspace: null, git_worktree: { root: nested, main_path: harness.workspace } })
    expect(harness.ctx.sessions.get(SessionId('nested'))?.header.cwd).toBe(nested)
  })

  it('warns only when the effective preset is workspace-write', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    initRepo(harness.workspace)
    const worktree = join(outsideDir(), 'repo')
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/presets', worktree)
    for (const preset of ['read-only', 'danger-full-access']) {
      const receipt = await start(client, worktree, { permission_preset: preset, session_id: `preset-${preset}` })
      expect(receipt.warnings, preset).toEqual([])
      expect(receipt.git_worktree, preset).not.toBeNull()
    }
  })

  it('warns for a subdirectory of an ordinary checkout and stays silent at its root or outside git', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    initRepo(harness.workspace)
    const sub = join(harness.workspace, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    expect(await start(client, harness.workspace)).toMatchObject({ git_worktree: null, warnings: [] })
    expect(await start(client, sub)).toMatchObject({
      git_worktree: null,
      warnings: [{ code: 'git-metadata-outside-cwd', paths: [join(harness.workspace, '.git')] }],
    })
    expect(await start(client, outsideDir())).toMatchObject({ git_worktree: null, warnings: [] })
  })
})

describe('autoRegisterWorktrees', () => {
  it('stays off by default', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    initRepo(harness.workspace)
    const worktree = join(outsideDir(), 'repo')
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/off', worktree)
    expect(await start(client, worktree)).toMatchObject({ workspace: null })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
  })

  it('registers the worktree root as its own Workspace once and attaches its Sessions', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ config: { autoRegisterWorktrees: true } })
    initRepo(harness.workspace)
    const worktree = join(outsideDir(), 'repo')
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/task-2', worktree)

    const first = await start(client, worktree, { session_id: 'auto-1' })
    const title = `${basename(harness.workspace)} · codex/task-2`
    expect(first).toMatchObject({ cwd: worktree, workspace: { title }, workspace_created: true })
    const second = await start(client, worktree, { session_id: 'auto-2' })
    expect(second.workspace).toEqual(first.workspace)
    expect(second).not.toHaveProperty('workspace_created')
    const registered = harness.ctx.workspaceRegistry.list().find(entry => entry.title === title)!
    expect(registered.sessionIds).toEqual([SessionId('auto-2'), SessionId('auto-1')])
    expect(harness.ctx.sessions.get(SessionId('auto-1'))?.header.cwd).toBe(worktree)
  })

  it('never registers a subdirectory of a worktree or an ordinary checkout', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ config: { autoRegisterWorktrees: true } })
    initRepo(harness.workspace)
    const worktree = join(outsideDir(), 'repo')
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/sub', worktree)
    const sub = join(worktree, 'src')
    mkdirSync(sub)
    expect(await start(client, sub)).toMatchObject({ workspace: null, git_worktree: { root: worktree } })
    const plain = join(outsideDir(), 'plain')
    mkdirSync(plain)
    initRepo(plain)
    expect(await start(client, plain)).toMatchObject({ workspace: null, git_worktree: null })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
  })

  it('starts the Session ungrouped with a warning when registration fails', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ config: { autoRegisterWorktrees: true } })
    initRepo(harness.workspace)
    const worktree = join(outsideDir(), 'repo')
    git(harness.workspace, 'worktree', 'add', '-q', '-b', 'codex/fails', worktree)
    harness.ctx.workspaceRegistry.create = async () => { throw new Error('storage unavailable') }
    const receipt = await start(client, worktree, { session_id: 'unregistered' })
    expect(receipt).toMatchObject({ accepted: true, workspace: null })
    expect((receipt.warnings as Array<{ code: string }>).map(warning => warning.code)).toContain('workspace-registration-failed')
  })
})
