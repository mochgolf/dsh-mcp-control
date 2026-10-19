/** Per-Session model overrides through the real MCP transport and native controller. */
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Client } from '@modelcontextprotocol/client'
import { bootHarness, closeAll, connectClient, textJson, type Harness } from './harness.ts'
import { textResponse } from './support/mock-adapter.ts'

const harnesses: Harness[] = []
const clients: Client[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await closeAll(clients.splice(0), harnesses.splice(0))
})

async function boot(options: Parameters<typeof bootHarness>[0] = {}) {
  const harness = await bootHarness(options)
  harnesses.push(harness)
  const client = await connectClient(`${harness.baseUrl}/mcp`)
  clients.push(client)
  return { harness, client }
}

it('uses the requested route and effort, preserves the default, and reuses an accepted retry', async () => {
  const save = vi.fn(async () => {})
  const { harness, client } = await boot({
    script: [textResponse('selected'), textResponse('default')],
    reasoning: {
      efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('max'), name: 'Max' }],
      defaultEffort: ReasoningEffortId('off'),
    },
    saveDefaultModelSelection: save,
  })
  const select = vi.spyOn(harness.ctx.sessionController, 'selectModel')
  const create = vi.spyOn(harness.ctx.sessionController, 'create')
  const args = { cwd: harness.workspace, prompt: 'selected model', provider: 'mock', model: 'selected', reasoning_effort: 'max', request_id: 'selected-request' }
  const first = await client.callTool({ name: 'session_start', arguments: args })
  expect(first.isError).not.toBe(true)
  const sessionId = SessionId(String(textJson(first).session_id))
  await harness.ctx.agents.get(sessionId)!.whenIdle()
  expect(harness.adapter.requests).toHaveLength(1)
  expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'selected', reasoningEffort: 'max' })
  expect((await harness.ctx.sessionController.inspect(sessionId)).events).toContainEqual(expect.objectContaining({
    type: 'model/selection', data: { provider: 'mock', model: 'selected', reasoningEffort: 'max' },
  }))
  expect(textJson(await client.callTool({ name: 'session_start', arguments: args }))).toEqual(textJson(first))
  expect(select).not.toHaveBeenCalled()
  expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelSelection: { provider: 'mock', model: 'selected', reasoningEffort: 'max' } }))
  expect(save).not.toHaveBeenCalled()

  const other = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'deployment default' } })
  expect(other.isError).not.toBe(true)
  await harness.ctx.agents.get(SessionId(String(textJson(other).session_id)))!.whenIdle()
  expect(harness.adapter.requests).toHaveLength(2)
  expect(harness.adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'mock', reasoningEffort: 'off' })
})

it.each([
  { provider: 'mock' }, { model: 'selected' }, { reasoning_effort: 'max' },
])('refuses incomplete selection %j before creating a Session', async (selection) => {
  const { harness, client } = await boot()
  const create = vi.spyOn(harness.ctx.sessionController, 'create')
  const result = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'x', ...selection } })
  expect(result.isError).toBe(true)
  expect(textJson(result)).toMatchObject({ error: { code: 'gateway/bad-request', details: { stage: 'model' } } })
  expect(create).not.toHaveBeenCalled()
  expect(harness.adapter.requests).toHaveLength(0)
})

it('refuses an old Host before creating a Session or changing its default', async () => {
  const { harness, client } = await boot()
  const descriptor = harness.ctx.typert.local.get('session/create')!
  const originalSchema = JSON.parse(readFileSync(new URL('./fixtures/session-create-0.2.1-rc.2.json', import.meta.url), 'utf8')) as Record<string, unknown>
  vi.spyOn(harness.ctx.typert.local, 'get').mockReturnValue({
    ...descriptor,
    parameters: descriptor.parameters.map(parameter => ({
      ...parameter,
      codec: parameter.codec.mode === 'strict' ? { ...parameter.codec, jsonSchema: originalSchema } : parameter.codec,
    })),
  })
  const create = vi.spyOn(harness.ctx.sessionController, 'create')
  const select = vi.spyOn(harness.ctx.sessionController, 'selectModel')
  const result = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'x', provider: 'mock', model: 'selected' } })
  expect(result.isError).toBe(true)
  expect(textJson(result)).toMatchObject({ error: { code: 'session/model-selection-unsupported', details: { stage: 'model' } } })
  expect(create).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  expect(harness.adapter.requests).toHaveLength(0)
})

it.each([
  { provider: 'missing', model: 'selected' },
  { provider: 'mock', model: 'missing' },
  { provider: 'mock', model: 'selected', reasoning_effort: 'invalid' },
])('refuses unavailable selection %j without admitting a prompt', async (selection) => {
  const save = vi.fn(async () => {})
  const { harness, client } = await boot({ saveDefaultModelSelection: save })
  const result = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'x', ...selection } })
  expect(result.isError).toBe(true)
  expect(textJson(result)).toMatchObject({ error: { code: 'session/model-unavailable', details: { stage: 'model' } } })
  expect(harness.adapter.requests).toHaveLength(0)
  expect(save).not.toHaveBeenCalled()
})

it('refuses model inputs on a Session without an initial selection', async () => {
  const { harness, client } = await boot({ script: [textResponse('first')] })
  const first = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'first' } })
  const sessionId = String(textJson(first).session_id)
  await harness.ctx.agents.get(SessionId(sessionId))!.whenIdle()
  const select = vi.spyOn(harness.ctx.sessionController, 'selectModel')
  const result = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'second', session_id: sessionId, provider: 'mock', model: 'selected' } })
  expect(result.isError).toBe(true)
  expect(textJson(result)).toMatchObject({ error: { code: 'mcp-control/model-conflict', details: { stage: 'model' } } })
  expect(select).not.toHaveBeenCalled()
  expect(harness.adapter.requests).toHaveLength(1)
})

it.each([
  { model: 'mock' }, { provider: 'different' }, { reasoning_effort: 'off' },
])('refuses changed selection on an accepted retry: %j', async (changed) => {
  const { harness, client } = await boot({ script: [textResponse('selected')] })
  const args = { cwd: harness.workspace, prompt: 'first', provider: 'mock', model: 'selected', request_id: 'model-retry' }
  const first = await client.callTool({ name: 'session_start', arguments: args })
  expect(first.isError).not.toBe(true)
  await harness.ctx.agents.get(SessionId(String(textJson(first).session_id)))!.whenIdle()
  const result = await client.callTool({ name: 'session_start', arguments: { ...args, ...changed } })
  expect(result.isError).toBe(true)
  expect(textJson(result)).toMatchObject({ error: { code: 'mcp-control/model-conflict', details: { stage: 'model' } } })
  expect(harness.adapter.requests).toHaveLength(1)
})

it('publishes the model before a concurrent session_send can observe the Session', async () => {
  const { harness, client } = await boot({ script: [textResponse('first'), textResponse('second')] })
  let concurrent: ReturnType<Client['callTool']> | undefined
  const published: unknown[] = []
  const off = harness.ctx.on('agent/created', ({ agent }) => {
    published.push(harness.ctx.sessionProjections.snapshot(agent.session).values.modelSelection?.next)
    concurrent = client.callTool({ name: 'session_send', arguments: { session_id: agent.id, message: 'concurrent prompt' } })
  })
  try {
    const result = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'start prompt', provider: 'mock', model: 'selected' } })
    expect(result.isError).not.toBe(true)
    expect(concurrent).toBeDefined()
    expect((await concurrent)!.isError).not.toBe(true)
    await harness.ctx.agents.get(SessionId(String(textJson(result).session_id)))!.whenIdle()
    expect(published).toEqual([{ provider: 'mock', model: 'selected' }])
    expect(harness.adapter.requests).toHaveLength(2)
    for (const request of harness.adapter.requests) expect(request).toMatchObject({ provider: 'mock', model: 'selected' })
  } finally {
    off()
    await concurrent
  }
})

it('refuses adding a model override to an accepted start even after a later native switch', async () => {
  const { harness, client } = await boot({ script: [textResponse('default')] })
  const args = { cwd: harness.workspace, prompt: 'first', request_id: 'default-retry' }
  const first = await client.callTool({ name: 'session_start', arguments: args })
  expect(first.isError).not.toBe(true)
  const sessionId = SessionId(String(textJson(first).session_id))
  await harness.ctx.agents.get(sessionId)!.whenIdle()
  await harness.ctx.sessionController.selectModel({ sessionId, provider: 'mock', model: 'selected' })
  const result = await client.callTool({ name: 'session_start', arguments: { ...args, provider: 'mock', model: 'selected' } })
  expect(result.isError).toBe(true)
  expect(textJson(result)).toMatchObject({ error: { code: 'mcp-control/model-conflict', details: { stage: 'model' } } })
  expect(harness.adapter.requests).toHaveLength(1)
})

it('continues a matching initialized Session without changing its model', async () => {
  const { harness, client } = await boot({ script: [textResponse('first'), textResponse('second')] })
  const args = { cwd: harness.workspace, prompt: 'first', provider: 'mock', model: 'selected' }
  const first = await client.callTool({ name: 'session_start', arguments: args })
  expect(first.isError).not.toBe(true)
  const sessionId = SessionId(String(textJson(first).session_id))
  await harness.ctx.agents.get(sessionId)!.whenIdle()
  const create = vi.spyOn(harness.ctx.sessionController, 'create')
  const select = vi.spyOn(harness.ctx.sessionController, 'selectModel')
  const second = await client.callTool({ name: 'session_start', arguments: { ...args, prompt: 'second', session_id: sessionId } })
  expect(second.isError).not.toBe(true)
  await harness.ctx.agents.get(sessionId)!.whenIdle()
  expect(create).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  expect(harness.adapter.requests).toHaveLength(2)
  for (const request of harness.adapter.requests) expect(request).toMatchObject({ provider: 'mock', model: 'selected' })
})

it('adopts a blank Session with a matching native GUI selection', async () => {
  const save = vi.fn(async () => {})
  const { harness, client } = await boot({ script: [textResponse('selected')], saveDefaultModelSelection: save })
  const created = await harness.ctx.sessionController.create({ cwd: harness.workspace })
  await harness.ctx.sessionController.selectModel({ sessionId: created.sessionId, provider: 'mock', model: 'selected' })
  save.mockClear()
  const create = vi.spyOn(harness.ctx.sessionController, 'create')
  const select = vi.spyOn(harness.ctx.sessionController, 'selectModel')
  const result = await client.callTool({ name: 'session_start', arguments: { cwd: harness.workspace, prompt: 'adopt', session_id: created.sessionId, provider: 'mock', model: 'selected' } })
  expect(result.isError).not.toBe(true)
  await harness.ctx.agents.get(created.sessionId)!.whenIdle()
  expect(create).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'selected' })
})
