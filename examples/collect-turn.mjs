/** Compactly collect one accepted prompt's final answer from `events_read`. */

import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer at least ${minimum}`)
  }
  return value
}

function pageOf(value, cursor) {
  const page = record(value, 'events_read page')
  if (page.mode !== 'page' || !Array.isArray(page.events) || typeof page.has_more !== 'boolean') {
    throw new Error('events_read returned an invalid page')
  }
  integer(page.head_seq, 'page.head_seq', -1)
  integer(page.next_seq, 'page.next_seq', -1)
  if (page.next_seq < cursor || page.next_seq > page.head_seq) {
    throw new Error('events_read returned an invalid page cursor')
  }
  return page
}

async function oversizedEvent(callTool, address, descriptorValue) {
  const descriptor = record(descriptorValue, 'oversized_event')
  const seq = integer(descriptor.seq, 'oversized_event.seq')
  const byteLength = integer(descriptor.byte_length, 'oversized_event.byte_length', 1)
  if (typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) {
    throw new Error('oversized_event.sha256 is invalid')
  }

  const blocks = []
  let offset = 0
  while (offset < byteLength) {
    const chunk = record(await callTool({
      mode: 'chunk',
      address,
      event_seq: seq,
      offset,
      sha256: descriptor.sha256,
    }), 'events_read chunk')
    if (chunk.mode !== 'chunk' || chunk.encoding !== 'base64' || chunk.event_seq !== seq
      || chunk.offset !== offset || chunk.byte_length !== byteLength || chunk.sha256 !== descriptor.sha256
      || typeof chunk.data !== 'string' || typeof chunk.done !== 'boolean') {
      throw new Error('events_read returned an inconsistent chunk')
    }
    const block = Buffer.from(chunk.data, 'base64')
    const nextOffset = integer(chunk.next_offset, 'chunk.next_offset')
    if (nextOffset !== offset + block.byteLength || nextOffset > byteLength
      || chunk.done !== (nextOffset === byteLength) || (block.byteLength === 0 && !chunk.done)) {
      throw new Error('events_read chunk made invalid progress')
    }
    blocks.push(block)
    offset = nextOffset
  }

  const bytes = Buffer.concat(blocks)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== byteLength || digest !== descriptor.sha256) {
    throw new Error('the oversized event failed length or SHA-256 verification')
  }
  const event = record(JSON.parse(bytes.toString('utf8')), 'reassembled event')
  if (event.seq !== seq) throw new Error('the reassembled event has the wrong sequence')
  return event
}

function textOf(event) {
  const data = record(event.data, 'assistant/message.data')
  const message = record(data.message, 'assistant/message.data.message')
  if (!Array.isArray(message.content)) throw new Error('assistant message content must be an array')
  const text = message.content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => {
      if (typeof block.text !== 'string') throw new Error('assistant text block is invalid')
      return block.text
    })
  return text.length === 0 ? undefined : text.join('')
}

function observe(state, eventValue, requestId) {
  const event = record(eventValue, 'session event')
  const seq = integer(event.seq, 'event.seq')
  if (typeof event.type !== 'string') throw new Error('event.type must be a string')
  const data = record(event.data, `${event.type}.data`)

  if (event.type === 'turn/start') state.openTurn = integer(data.turn, 'turn/start.data.turn', 1)
  if (event.type === 'user/message') {
    const source = record(data.source, 'user/message.data.source')
    if (source.kind === 'user' && source.rpcId === requestId) {
      if (state.openTurn === undefined) throw new Error('the target prompt is outside an open turn')
      state.targetTurn = state.openTurn
    }
  }
  if (event.type === 'assistant/message' && data.turn === state.targetTurn) {
    state.finalMessage = textOf(event) ?? state.finalMessage
  }
  if (event.type === 'tool/result' && data.turn === state.targetTurn && data.error !== undefined) {
    state.diagnostics.push({ seq, type: event.type, error: data.error })
  }
  if (event.type === 'turn/end') {
    const turn = integer(data.turn, 'turn/end.data.turn', 1)
    if (turn === state.openTurn) state.openTurn = undefined
    if (turn === state.targetTurn) {
      const reason = record(data.reason, 'turn/end.data.reason')
      state.reason = reason
      state.ended = true
      if (reason.kind !== 'completed') state.diagnostics.push({ seq, type: event.type, reason })
    }
  }
}

async function collectTurn(callTool, address, requestId, options, initialCursor) {
  const pollMs = integer(options.pollMs ?? 250, 'pollMs')
  const timeoutMs = integer(options.timeoutMs ?? 600_000, 'timeoutMs', 1)
  const deadline = Date.now() + timeoutMs
  const state = { diagnostics: [], ended: false }
  let cursor = initialCursor
  let headSeq = -1

  for (;;) {
    const page = pageOf(await callTool({ address, after_seq: cursor }), cursor)
    headSeq = page.head_seq
    let expected = cursor + 1
    for (const event of page.events) {
      const seq = integer(record(event, 'session event').seq, 'event.seq')
      if (seq !== expected) throw new Error(`event sequence ${seq} followed ${expected - 1}`)
      observe(state, event, requestId)
      expected += 1
    }
    if (page.events.length > 0) {
      if (page.next_seq !== expected - 1) throw new Error('page.next_seq does not name its last event')
      cursor = page.next_seq
    } else if (page.next_seq !== cursor) {
      throw new Error('an empty page advanced its cursor')
    }

    if (page.oversized_event !== undefined) {
      if (page.events.length !== 0) throw new Error('a page mixed events with an oversized descriptor')
      const descriptor = record(page.oversized_event, 'oversized_event')
      if (descriptor.seq !== cursor + 1) throw new Error('oversized_event is not the next event')
      const event = await oversizedEvent(callTool, address, descriptor)
      observe(state, event, requestId)
      cursor = descriptor.seq
    }

    if (state.ended) {
      return {
        request_id: requestId,
        turn: state.targetTurn,
        final_message: state.finalMessage ?? null,
        reason: state.reason,
        diagnostics: state.diagnostics,
        next_seq: cursor,
        head_seq: headSeq,
      }
    }
    if (page.has_more) {
      if (cursor >= headSeq) throw new Error('page.has_more did not leave unread events')
      continue
    }
    if (cursor !== headSeq) throw new Error('a terminal page did not reach its watermark')
    if (Date.now() >= deadline) throw new Error(`turn for request ${requestId} did not finish within ${timeoutMs}ms`)
    await delay(pollMs)
  }
}

/**
 * Create a per-session turn collector whose cursor cannot be supplied by the
 * caller. Each call returns only the target turn's final text, failure facts,
 * and the last verified cursor; later calls continue from that cursor.
 */
export function createSessionCollector(callTool, address, options = {}) {
  let cursor = -1
  return async (requestId) => {
    const result = await collectTurn(callTool, address, requestId, options, cursor)
    cursor = result.next_seq
    return result
  }
}

/** Build the small raw-HTTP adapter used by this executable example. */
export function createHttpToolCaller(url, token) {
  let id = 0
  return async (args) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name: 'events_read', arguments: args },
      }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body}`)
    const data = body.split('\n').findLast(line => line.startsWith('data:'))
    const message = record(JSON.parse(data === undefined ? body : data.slice(5)), 'JSON-RPC response')
    const result = record(message.result, 'JSON-RPC result')
    if (result.isError === true) throw new Error(JSON.stringify(result.structuredContent))
    return result.structuredContent
  }
}

async function main() {
  const url = process.env.DSH_MCP_CONTROL_URL
  const token = process.env.DSH_MCP_CONTROL_TOKEN
  const sessionId = process.env.DSH_MCP_CONTROL_SESSION_ID
  const requestId = process.env.DSH_MCP_CONTROL_REQUEST_ID
  if (!url || !token || !sessionId || !requestId) {
    throw new Error('set DSH_MCP_CONTROL_URL, DSH_MCP_CONTROL_TOKEN, DSH_MCP_CONTROL_SESSION_ID, and DSH_MCP_CONTROL_REQUEST_ID')
  }
  const pollMs = Number(process.env.DSH_MCP_CONTROL_POLL_MS ?? 250)
  const timeoutMs = Number(process.env.DSH_MCP_CONTROL_TIMEOUT_MS ?? 600_000)
  const collect = createSessionCollector(
    createHttpToolCaller(url, token),
    { kind: 'session', session_id: sessionId },
    { pollMs, timeoutMs },
  )
  const result = await collect(requestId)
  console.log(JSON.stringify({ session_id: sessionId, ...result }))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
