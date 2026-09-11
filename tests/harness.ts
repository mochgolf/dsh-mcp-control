/**
 * Shared real-runtime harness for the mcp-control suites: the production Agent
 * Loop, Session store, JSONL persistence, Session Controller, subagent runtime
 * and in-process spawn provider, the real WebServer, and the real MCP endpoint.
 * Only the model adapter, the credential value, and the few services the
 * Session Controller needs but this subject does not exercise are supplied by
 * the harness.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { MockAdapter } from './support/mock-adapter.ts'
import { createSessionTestController } from './support/session-controller.ts'
import { seedStoredSession } from './support/persistence.ts'
import { TestSessionQuery } from './support/session-query.ts'
import * as McpControl from '../src/index.ts'
import type { Config } from '../src/config.ts'

/** Scripted model responses the harness adapter replays in order. */
export type Script = ConstructorParameters<typeof MockAdapter>[0]

/** Credential reference the harness configures; nothing reads the process environment. */
export const TEST_TOKEN_REF = 'DSH_MCP_CONTROL_TOKEN'

/** Credential value configured unless a case rotates it. */
export const TEST_TOKEN = 'fixture-token-value'

/**
 * One mcp-control configuration; omitted fields take the production defaults.
 * @param overrides - fields this case changes.
 * @returns the plugin configuration.
 */
export function controlConfig(overrides: Partial<Config> = {}): Config {
  return { path: '/mcp', tokenRef: TEST_TOKEN_REF, ...overrides }
}

/** Everything one booted composition exposes to a suite. */
export interface Harness {
  /** The owning context; disposal cascades to every mounted service. */
  readonly ctx: Context
  /** Listening port of the shared WebServer. */
  readonly port: number
  /** Base URL of the shared WebServer. */
  readonly baseUrl: string
  /** The scripted model adapter driving every Agent in this composition. */
  readonly adapter: MockAdapter
  /** The isolated workspace root used as `cwd` for created Sessions. */
  readonly workspace: string
  /** The JSONL persistence root this instance reads and writes. */
  readonly persistenceRoot: string
  /** Replace the resolvable credential, or remove it entirely. */
  setToken(value: string | undefined): void
  /** Parse the last JSON text part of a tool result. */
  dispose(): Promise<void>
}

/** Options for one harness boot. */
export interface HarnessOptions {
  /** Scripted model responses replayed in order. */
  readonly script?: Script
  /** Deployment configuration overrides for the mcp-control endpoint. */
  readonly config?: Partial<Config>
  /** Mount the endpoint plugin; false leaves the route unregistered. */
  readonly mountControl?: boolean
  /** Persist Session logs to an isolated JSONL root (needed for cold reads). */
  readonly persistence?: boolean
  /** Credential value resolved at load; undefined means the reference is unset. */
  readonly token?: string | undefined
  /** Reuse an existing workspace root instead of creating one (a restarted instance). */
  readonly workspace?: string
  /** Reuse an existing JSONL persistence root instead of creating one (a restarted instance). */
  readonly persistenceRoot?: string
  /** Keep the workspace and persistence roots on dispose, so a restarted instance can reuse them. */
  readonly retainRoots?: boolean
}

/**
 * Boot one full composition and optionally register the control endpoint.
 * @param options - script, endpoint configuration, and mount toggles.
 * @returns handles for the booted composition, including the endpoint URL.
 */
export async function bootHarness(options: HarnessOptions = {}): Promise<Harness> {
  const ownedWorkspace = options.workspace === undefined
  const ownedPersistence = options.persistenceRoot === undefined
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), 'dsh-mcp-control-ws-'))
  const persistenceRoot = options.persistenceRoot ?? mkdtempSync(join(tmpdir(), 'dsh-mcp-control-log-'))
  const ctx = new Context()
  /** Remove the roots this boot created; a root supplied by the caller is never this boot's to remove. */
  const removeOwnedRoots = (): void => {
    if (ownedWorkspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    if (ownedPersistence) rmSync(persistenceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
    if (options.persistence !== false) {
      await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
    }
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const adapter = new MockAdapter(options.script ?? [])
    ctx.llm.registerAdapter(['mock'], adapter)

    let token: string | undefined = options.token === undefined && 'token' in options ? undefined : options.token ?? TEST_TOKEN
    ctx.provide('credentials', {
      resolve: async () => (token === undefined ? undefined : { value: token, source: 'test' }),
    } as never)

    // The Service constructor registers `sessionController` on this context.
    createSessionTestController(ctx, {
      defaultModelSelection: (): ModelSelection => ({ provider: 'mock', model: 'mock' }),
      cwd: workspace,
    })

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    if (options.mountControl !== false) {
      await ctx.plugin(McpControl, controlConfig({ path: '/mcp', ...options.config }))
    }
    const port = ctx.webServer.port
    const retainRoots = options.retainRoots === true
    let disposed = false
    return {
      ctx,
      port,
      persistenceRoot,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      adapter,
      workspace,
      setToken(value: string | undefined) { token = value },
      async dispose() {
        if (disposed) return
        disposed = true
        try {
          await ctx.fiber.dispose()
        } finally {
          // A retained root outlives this composition so a restarted instance
          // can read the same durable state; the suite removes it at the end.
          if (!retainRoots) removeOwnedRoots()
        }
      },
    }
  } catch (error: unknown) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // The boot failure is the diagnostic the caller needs; disposing a
      // half-mounted composition must not replace it.
    }
    removeOwnedRoots()
    throw error
  }
}

/**
 * Connect the official v2 MCP client over Streamable HTTP.
 * @param url - the endpoint URL.
 * @param token - bearer token presented on every request.
 * @returns a connected client the caller closes.
 */
export async function connectClient(url: string, token: string = TEST_TOKEN): Promise<Client> {
  const client = new Client({ name: 'mcp-control-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

/** The JSON text part of a tool result, parsed. */
export function textJson(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content
  if (!Array.isArray(content)) throw new Error('tool result carried no content array')
  const first = content[0] as { type?: string; text?: string } | undefined
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('tool result did not start with a text part')
  }
  return JSON.parse(first.text) as Record<string, unknown>
}

/**
 * Close every connected client and dispose every booted composition. All
 * closers run before the failures are reported together: a first rejection must
 * not leave a listener, port, or temporary root behind for the next case.
 * @param clients - the clients this case connected.
 * @param harnesses - the compositions this case booted.
 * @throws {AggregateError} when one or more closers rejected.
 */
export async function closeAll(clients: readonly Client[], harnesses: readonly Harness[]): Promise<void> {
  const closed = await Promise.allSettled(clients.map(async client => client.close()))
  const disposed = await Promise.allSettled(harnesses.map(async harness => harness.dispose()))
  const failures: unknown[] = []
  for (const result of [...closed, ...disposed]) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'mcp-control test teardown failed')
}

/**
 * Start one live root Agent through the production loop.
 * @param harness - the booted composition.
 * @param id - shared Agent and Session identity.
 * @returns the published Agent.
 */
export async function startRootAgent(harness: Harness, id: string): Promise<Agent> {
  return await harness.ctx.agentLoop.create(
    SessionId(id),
    { provider: 'mock', model: 'mock' },
    { cwd: harness.workspace },
  )
}


/** Header metadata for a harness-seeded durable Session. */
function seededHeader(harness: Harness, id: SessionId): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1_700_000_000_000,
    isSeeded: false,
    cwd: harness.workspace,
  }
}

/**
 * Build one detached Session log and write it to the harness's real JSONL
 * persistence, so the endpoint reads a genuinely cold durable Session that no
 * Agent owns.
 * @param harness - the booted composition.
 * @param id - durable Session identity.
 * @param build - appends the log through the production Session API, optionally returning the exact
 *   stored list (for events outside the compile-time event map).
 * @returns the exact stored event list.
 */
export async function seedSession(
  harness: Harness,
  id: string,
  // oxlint-disable-next-line typescript/no-invalid-void-type -- the callback either returns the stored list or returns nothing
  build: (session: Session) => void | readonly SessionEvent[],
): Promise<readonly SessionEvent[]> {
  const session = Session.create(SessionId(id), undefined, seededHeader(harness, SessionId(id)))
  const returned = build(session)
  const events = returned ?? session.snapshotEvents()
  await seedStoredSession(harness.ctx.sessionPersistence, session.header, events)
  return events
}
