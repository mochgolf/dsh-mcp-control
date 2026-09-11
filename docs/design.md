# Agent Note: MCP control endpoint — drive known DSH Sessions from a local MCP client

Status: implemented

English | [中文](design.zh.md)

## Problem

A same-machine MCP client — Codex, another agent, a maintenance script — needs to start work in an already-running DSH Web instance, watch it, and read its durable history, without a browser and without a second control plane. The harness serves MCP outward (`dsh-mcp-client`) but exposes no MCP interface of its own, so the only ways to drive a Web instance were the browser UI and its `/api` Remote, neither of which an MCP client speaks.

The Session Controller and the subagent runtime already own every operation such a client needs: create and prompt a root Session, cancel its turn, list the durable descendant tree, deliver to a continuable child, interrupt it through its parent, and page the durable event log. The missing piece was a transport that maps MCP calls onto those services without inventing a second source of truth for task state.

## Decision

### Shape

One opt-in plugin, `@mochgolf/dsh-mcp-control`, is designed to run in the DSH Web profile through a patch overlay (`examples/cordis.yml`). It registers one exact route on the shared `ctx.webServer` through `ctx.effect(() => ctx.webServer.register(...))`. There is no daemon, no second `createServer()`, no private wire client, and no stdout scraping; the route follows the Web instance's own host and port, and loading fails when that bind is not loopback.

The plugin injects `webServer`, `sessionController`, `subagents`, `credentials`, and `workspaceRegistry`. It publishes no `./invariant` companion: it holds no durable or in-memory projection that an independent observation could diverge from, so every relation it relays is already observable where DSH owns it.

### Seven tools, no task state

`session_start`, `session_send`, `session_cancel`, `agents_list`, `child_send`, `child_interrupt`, and `events_read` use the Session Controller and subagent methods that own their effects. `child_send` uses `ctx.subagents.prompt` with `mode: continuable` and `child_interrupt` uses `interruptByParent`, so the live-direct-parent requirement and the parent authorization check stay in the services that already enforce them. `agents_list` relays native durable entries, diagnostics included, and never renumbers them. `session_start` accepts exactly the `cwd` values the platform calls absolute, the same `node:path` predicate the Session header validates `cwd` with, so a Windows drive root or UNC path is accepted instead of being refused by a POSIX prefix test. It asks `workspaceRegistry.resolveByPath` for an existing canonical-path owner and passes that owner's id to Session Controller; a lookup miss or path-resolution failure keeps the original `cwd` route, and no Workspace is created. It also chooses the Session id before calling `create`, because a create that outlives the call's deadline can still finish: the client would otherwise hold no way to address the Session, since the interface has no enumeration and a retry would start a second one.

Every receipt reports what the native service reported. `accepted: true` means DSH admitted the work; it never means a turn finished, a queue order was promised, or a child exists. The plugin never retries, never stores a job, never maps a session to a task, and never creates a child — the model's own subagent tool does that, and the endpoint only observes the result.

### Lossless reads without a second tool

`events_read` pages forward from the caller's `after_seq`, which is the only cursor that exists: the plugin keeps no listener, snapshot, or cache between requests, so an endpoint restart changes nothing about how a client continues. A page is bounded by the complete `CallToolResult` byte budget, delivers the largest contiguous prefix that fits, and stops at a fixed watermark taken when the read started. An event too large for one result is reported as `oversized_event` with its byte length and SHA-256 and retrieved through the same tool in `chunk` mode, which never advances the page cursor; the client's cursor moves to the descriptor's `seq` once the reassembled bytes verify, because `next_seq` deliberately stays at the caller's own position. A chunk request larger than the result budget is served as the largest chunk that budget admits: base64 and JSON allocate several times the slice before any size is measured, so the budget has to bound the read rather than only the answer. Around the SDK's own input validation the tool schemas enforce the address, cursor, and digest rules.

### Configuration and protection

`path`, `tokenRef`, the event-count bounds, the request-body and result-byte budgets, the default chunk size, and the per-call timeout are validated deployment fields; the tool set, the loopback bind, and lossless pass-through are fixed. A route path that is not the canonical URL spelling the shared WebServer matches, a per-call timeout above the largest delay Node schedules, or a credential outside the RFC 6750 Bearer `b64token` alphabet fails loading rather than the first request. Admission runs before any DSH service is reachable: the `Host` header must name the listener's own loopback authority, an `Origin` must equal the endpoint origin, cross-site fetch metadata and forwarding headers are refused, the bearer token is compared in constant time against the credential resolved for that request alone, and the body ceiling is measured over the bytes actually received. Admission is part of the plugin's in-flight set, and unloading ends every request still in it — a body still arriving and a response the SDK is still writing to a client that stopped reading both settle from that termination — before it waits for the set and closes the SDK handler, so no request outlives the endpoint and no Agent is stopped.

### One result budget over every path

`maxToolResultBytes` is measured over the complete `CallToolResult` — text fallback and `structuredContent` together — and every path answers inside it, including the one result the plugin does not build: the MCP SDK's own input-validation failure, whose text echoes the offending argument. The registered tool schemas are the caller's zod schema behind the official Standard Schema seam, which the SDK still validates and still advertises unchanged, with only the rendered diagnostic capped; a shortened diagnostic states how many bytes it replaced. A native failure whose public details do not fit degrades to `result-too-large` carrying the correlation fields the budget admits and `details.omitted` naming the ones it dropped, so the caller always learns that the payload was bounded and what it lost.

### Boundaries

The endpoint never answers an approval, ask-user, or elicitation request, so a task that needs one is not unattended. A cold direct parent is refused (`subagent/parent-unavailable`) rather than resumed. A page header or descendant tree that alone exceeds the result budget is refused rather than truncated. Registers nothing on `ctx.tools`: the control tools are for the MCP client, never for the model.

## Alternatives considered

**A bridge daemon on its own port.** A separate process could hold the MCP session and proxy to DSH, but it would duplicate lifetime, credentials, and routing that the Web instance already owns, and it would need its own supervision. Serving the existing listener keeps one owner for the port and the process lifecycle.

**A private wire protocol over the existing `/api` Remote.** Reusing the browser's Remote would have made the endpoint depend on client-side wire details and cookies rather than a documented protocol; the plugin instead uses the official MCP v2 server and the native services behind it.

**A job/task state machine with its own database.** Mapping sessions to jobs would give the client a status vocabulary DSH does not have, and every naive version of it lies about cancellation, queueing, and crashes. The endpoint reports native receipts and makes the caller read the session log for outcomes.

**An eighth tool for chunk retrieval.** A separate tool would double the surface and split one addressing scheme across two names. Chunk mode is a second request form of `events_read`, sharing its address and digest rules.

**Publishing the control tools to the model.** Registering them on `ctx.tools` would let the model control Sessions and would enter every request's tool schema. The MCP client is the only intended caller, so the tools exist only on the MCP surface.

**Enabling it in the shipped Web composition.** A default-on control endpoint would give every Web instance a bearer-token-addressable control surface. It stays an overlay that a deployment inserts deliberately.

## Consequences

The bearer token is full control of every Session the instance can address by id: there is no per-token ACL, no cwd allowlist, and the endpoint is not built for remote or multi-user deployment. That is the cost of a small, honest relay that adds no second policy engine.

Because the endpoint keeps no state, it cannot offer what DSH does not: no session enumeration, no parent auto-recovery, no approval answering, no result pagination beyond one oversized event, and no resumption of computation after the process exits. The value it does add is that a local MCP client can drive real Sessions, read their durable logs exactly as DSH exposes them, and reconnect or continue from its own cursor after the plugin reloads — with every effect verifiable from the Session log and the filesystem rather than from the model's own account.

## Testing

Package suites run the endpoint against the real Agent Loop, Session Controller, subagent runtime, JSONL persistence, and shared WebServer, and cover the guards, credential rotation, unload and reload, running-Agent reload, the seven tools' success and refusal paths, cursor semantics, byte budgets, and chunk reassembly. Configuration cases assert the load-time refusals, including a route path the WebServer could never match, a timeout the timer could never schedule, and a credential no request could present; one case drives `session_start` with each spelling the platform predicate separates, so the tool's decision is pinned to `node:path.isAbsolute` on every platform, and another proves a create that outlives its deadline still reports the identity DSH received and that the Session lands under it. The chunk-size bound is asserted directly and end to end, where an unbounded `max_bytes` returns exactly the chunk the result budget admits. Unload is proved against a client that stops reading mid-response: the write hits backpressure, the unload still completes, the shared listener keeps serving its other route, and the Agent running throughout is untouched. Result budgets are proved over HTTP at the minimum allowed budget, including multibyte and escape-heavy correlation values, a diagnostic cut between the halves of a surrogate pair, and an unknown argument key longer than the whole budget; the reassembly example the README publishes is extracted from that README and executed against a live endpoint. The shipped Web profile is exercised end to end with the official MCP client over HTTP, and a recorded-session snapshot (`snapshots/web/mcp-control/`) drives the endpoint through the real `dsh web` profile: a root Session, its natively created continuable child, the child delivery, raw tool events, cursor continuation after a reconnect, and an independent `workspace.expected/` oracle, all replayed keylessly. A restart case proves committed logs stay readable, a cold parent is refused, and the child becomes controllable once the parent is recovered natively; a real-model case covers the file-writing task, native child creation, and child delivery.
