---
description: "Opt-in MCP control endpoint on the DSH Web listener: start, steer, cancel, list, and read known Sessions from a local MCP client such as Codex."
kind: "package-reference"
---

# @mochgolf/dsh-mcp-control

English | [中文](README.zh.md)

## Summary

`dsh-mcp-control` serves the Model Context Protocol on the DSH Web listener so a same-machine MCP client can drive Sessions it knows by id. Seven tools create or adopt a root Session, submit and cancel work, list its durable subagent tree, deliver to a continuable child, and read the durable event log. Every call uses the native Session Controller, subagent runtime, and Workspace Registry: the endpoint owns no task state, starts no second listener, registers no model-facing tool, and never answers an approval. A deployment inserts it deliberately, and its bearer token is full control of every Session that instance can address.

This repository is tested against DSH `0.1.5-rc.2`. The current released DSH resolver does not yet load this external package, so the overlay below becomes usable after DSH gains external plugin resolution; this repository does not modify an installed DSH runtime.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package when a local tool — Codex, another agent, a script — should control an already-running DSH Web instance instead of typing into its browser UI. Add the overlay to the profile, give the DSH process a bearer token through the environment, and point the client at `http://127.0.0.1:<port>/mcp`.

### Enabling the endpoint

The included overlay [examples/cordis.yml](examples/cordis.yml) inserts the plugin into the Web profile. It carries only the credential *reference*; the token stays in the DSH process environment.

```sh
DSH_MCP_CONTROL_TOKEN=... dsh web --patch examples/cordis.yml --host 127.0.0.1 --port 8931 --no-open
```

Removing the overlay (or restarting without it) disables the endpoint; the Web UI is unaffected either way. The route is the Web listener's, so nothing else may already own `path`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `path` | `/mcp` | Exact route on the shared WebServer; one absolute segment in the canonical URL spelling the WebServer matches, never `/`, `/api`, a trailing slash, a query, or a fragment |
| `tokenRef` | required | Credential reference resolved once per request; never the token itself. A value outside the RFC 6750 Bearer `b64token` alphabet fails plugin activation |
| `defaultMaxEvents` | `128` | Events returned when a page request omits `max_events` |
| `maxEvents` | `512` | Largest `max_events` one page request may ask for |
| `maxRequestBytes` | `1048576` | Ceiling on the bytes actually received for one request body |
| `maxToolResultBytes` | `1048576` | Ceiling on one complete tool result, its JSON text fallback included; minimum `4096` |
| `defaultChunkBytes` | `65536` | Raw event bytes one chunk returns when `max_bytes` is omitted |
| `requestTimeoutMs` | `25000` | Ceiling on one MCP call, excluding work DSH already accepted; at most `2147483647`, the largest delay Node schedules |

The endpoint loads only when the WebServer is bound to `127.0.0.1`, the credential resolves to a non-empty value, the configuration is valid, and no other exact route owns `path`; any other case fails plugin activation instead of degrading to an anonymous or half-configured endpoint.

### Request protection

Each request is checked before any DSH service is reached: the `Host` must name `127.0.0.1` and the listener's own port, an `Origin` must equal the endpoint origin, cross-site fetch metadata and any forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`) are refused, and the bearer token is compared against the credential resolved for that request alone. The body ceiling is measured over the bytes received, so a false or absent `Content-Length` cannot smuggle a larger body past it. The credential is re-resolved on every request, so rotating or removing it takes effect without a restart.

### Client configuration

Give the MCP client the same token through its own environment — setting it only in DSH does not reach an already-running client.

```toml
[mcp_servers.dsh]
url = "http://127.0.0.1:8931/mcp"
bearer_token_env_var = "DSH_MCP_CONTROL_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 30
```

### Tools

Every tool result carries the same object as `structuredContent` and as a `JSON.stringify` text part, and tool-level failures set `isError` with `{ error: { code, message, details } }`. `accepted: true` means DSH admitted the work, never that a turn finished: cancel and interrupt receipts report admission, and unclaimed inbox entries and descendants are left alone.

| Tool | Input | Result |
|---|---|---|
| `session_start` | `cwd`, `prompt`; optional `agent_preset`, `permission_preset`, `session_id`, `request_id` | `session_id`, `request_id`, `accepted`, resolved `cwd`, `workspace`, `agent_preset`, `permission_preset` |
| `session_send` | `session_id`, `message`; optional `delivery` (`queue` or `steer`), `request_id` | `session_id`, `request_id`, `accepted` |
| `session_cancel` | `session_id` | `session_id`, native `accepted` |
| `agents_list` | `root_session_id` | `root_session_id`, native durable `entries` with `parentId` and `depth` |
| `child_send` | `parent_session_id`, `child_session_id`, `message`; optional `delivery`, `request_id` | both ids, `request_id`, `message_id`, `accepted` |
| `child_interrupt` | `parent_session_id`, `child_session_id` | both ids, native `accepted` |
| `events_read` | page or chunk request, below | page or chunk result, below |

`session_start` expects the MCP client's actual project directory as `cwd`: that value selects DSH project context and Workspace grouping, while a temporary directory creates an ungrouped temporary context and does not enforce read-only access. It resolves `cwd` against the existing Workspace Registry before creation. An exact canonical-path match attaches the Session to that Workspace; an unregistered or unavailable directory keeps the Session ungrouped, and the endpoint never creates a Workspace. Omit `agent_preset` to use the deployment default; supply it only as an intentional override. Set `permission_preset` to one of the native names advertised by the tool schema when the new Session needs an explicit policy; for example, `read-only` confines access while keeping the real project `cwd`. The preset is validated before creation and applied before the first prompt. The receipt reports the resolved `cwd`, attached `workspace` or `null`, effective `agent_preset` or `null`, and effective `permission_preset`, so a caller can detect a wrong context immediately. It adopts an existing Session when the supplied `session_id` already exists for that directory, and refuses a conflicting one. It chooses the Session id itself before calling DSH, so a create that outlives the call's deadline still reports that id in `details.session_id` with `stage: "create"`: the Session may exist, and reusing the reported id adopts it instead of starting a second one. A `stage: "permission"` failure identifies a created Session whose prompt was not submitted. Supplying `request_id` links a retry to the message the first attempt persisted, but it is correlation, not an exactly-once guarantee: the plugin never retries on its own. `agents_list` relays native entries unchanged, including diagnostic ones; its `activity: running` means the Session record is resident, not that a model is computing, and it is not a completion state.

### Reading durable events

A page request reads forward from `after_seq` (default `-1`, the first event) for at most `max_events` events:

```json
{"address":{"kind":"session","session_id":"S"},"after_seq":-1,"max_events":128}
```

The address is either `{"kind":"session","session_id":"S"}` or `{"kind":"subagent","parent_session_id":"A","child_session_id":"A2","mode":"continuable"}`, and the subagent form goes through the controller's own parent and mode validation. The result carries `header`, the watermark `head_seq` taken when the read started, `next_seq` pointing at the last event actually delivered, `has_more`, and the events exactly as DSH exposes them — tool results, metadata, `sourceEventSeqs`, and `ignorable` markers included. A cursor past the watermark is refused as `mcp-control/cursor-ahead` rather than wrapped around. The read never activates a cold Session and keeps no listener, cursor, or cache between requests: `after_seq` is the only cursor that exists, so restarting the endpoint changes nothing about how a client continues.

`max_events` bounds the events a page returns, not the bytes the Session Controller reads to locate them: the native history API is message-aligned, so a cursor far into a large log makes one call read the logical prefix that covers it. On a generated 100,000-event log, a page 99,000 events in took about 0.9 s and one native call, with roughly 224 MB of heap live during it. Page forward from the cursor you already hold instead of re-reading from `-1`, and size `requestTimeoutMs` for the log rather than for the event count.

An event too large to deliver whole is reported instead of truncated:

```json
{"mode":"page","head_seq":57,"next_seq":41,"has_more":true,"events":[],"oversized_event":{"seq":42,"byte_length":931842,"sha256":"…"}}
```

The client retrieves it through the same tool in chunk mode, concatenating base64 chunks, checking the total length and SHA-256, and parsing the merged bytes as UTF-8 JSON:

```json
{"mode":"chunk","address":{"kind":"session","session_id":"S"},"event_seq":42,"offset":0,"max_bytes":65536,"sha256":"…"}
```

`next_seq` never advances past an event that was not delivered whole, and the chunk result never advances the page cursor. A page that reports `oversized_event` therefore leaves `next_seq` at the caller's own `after_seq`; the client's cursor advances to the descriptor's `seq` only once the reassembled bytes verify. A requested `max_bytes` larger than the result budget is served as the largest chunk that budget admits, never as a reason to encode more of the event than the result can carry. A digest mismatch is refused as `mcp-control/event-changed`; the client re-reads the page for a fresh descriptor.

The repository ships a compact collector at [`examples/collect-turn.mjs`](examples/collect-turn.mjs). Give it the `session_id` and `request_id` returned by `session_start` or `session_send`. It follows every page, verifies every oversized event before advancing, and prints only the target turn's final text, end reason, compact tool-failure diagnostics, and verified cursor. Raw reasoning, tool traces, and unrelated events never enter the caller's context. The exported `createSessionCollector` keeps its cursor private across successive request ids; the executable form starts at the protocol's initial `-1` cursor.

```sh
DSH_MCP_CONTROL_URL=http://127.0.0.1:8931/mcp \
DSH_MCP_CONTROL_TOKEN=... \
DSH_MCP_CONTROL_SESSION_ID=S \
DSH_MCP_CONTROL_REQUEST_ID=R \
node ./examples/collect-turn.mjs
```

A successful result is compact JSON such as `{"session_id":"S","request_id":"R","turn":1,"final_message":"done","reason":{"kind":"completed"},"diagnostics":[],"next_seq":31,"head_seq":31}`. `DSH_MCP_CONTROL_POLL_MS` and `DSH_MCP_CONTROL_TIMEOUT_MS` optionally control polling and the overall wait.

### Failure codes

Native failures keep their DSH code, message, and public details. The endpoint adds `mcp-control/cursor-ahead`, `mcp-control/event-changed`, `mcp-control/result-too-large`, `mcp-control/request-timeout`, `mcp-control/invalid-offset`, and `mcp-control/internal` for an exception with no public mapping. A call whose deadline expires after DSH may already have admitted the work reports `receipt: unknown` instead of a false refusal. Every result is measured by its complete UTF-8 JSON, text fallback and `structuredContent` together: a failure payload that does not fit degrades to `result-too-large` carrying the correlation fields the budget admits plus `details.omitted` naming the ones it dropped, and a rejected argument object is answered inside the same budget even when the offending key itself is longer than the budget — the shortened diagnostic states how many bytes it replaced.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the endpoint and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

- **The endpoint owns no state.** Sessions, subagent relationships, inboxes, and event logs belong to the Session Controller, subagent runtime, and Session persistence. The plugin holds only a route registration, the MCP SDK handler, and the request-lifecycle handles needed to unload cleanly.
- **One listener.** The route registers on the shared `ctx.webServer` through `ctx.effect(() => ctx.webServer.register(...))`; there is no second `createServer()`, no daemon, and no private wire client.
- **Native authority decides.** `child_send` goes through `ctx.subagents.prompt` with `mode: continuable` and `child_interrupt` through `interruptByParent`, so the live-direct-parent requirement and the addressing check stay where DSH already enforces them. The endpoint never resumes a parent, lists what it cannot address, or renumbers native entries.
- **Unload ends this plugin's requests.** Disposal unregisters the route, aborts the plugin's own signal, ends every request still in flight — a body still arriving and a response the SDK is still writing to a client that stopped reading both settle that way — waits for those requests, and closes the SDK handler. Ending a request drops its connection; it does not undo work DSH already accepted, close the shared WebServer, dispose the Session Controller, or stop any Agent.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: route registration, unload lifecycle, request admission |
| [`src/config.ts`](src/config.ts) | Deployment configuration schema and cross-field validation |
| [`src/http.ts`](src/http.ts) | Authority, origin, bearer-token, and bounded-body checks |
| [`src/tools.ts`](src/tools.ts) | The seven tools and their native service calls |
| [`src/events.ts`](src/events.ts) | `events_read` paging, byte budgets, and chunk reassembly |
| [`src/result.ts`](src/result.ts) | Result, failure, and per-call deadline handling |
| [`examples/collect-turn.mjs`](examples/collect-turn.mjs) | Compact final-answer collection with private cursor and verified chunks |
| — | No runtime invariant companion is published: the plugin stores no durable or in-memory projection of its own, so every relationship it relays is already observable through the Session Controller, subagent runtime, and Session persistence it calls. |

### Request lifecycle

The route handler admits a request in order — authority and origin, the credential resolved for this request, the bounded body — and only then hands it to the MCP SDK. Admission is part of the plugin's in-flight set, and unloading aborts its own signal, ends each in-flight request's socket, and only then waits for the set to drain before closing the SDK handler, so no request can outlive the endpoint even when its client stopped reading. A plugin reload is therefore the MCP-restart boundary: a client reconnects and continues from its own `after_seq`, while a whole-process exit leaves only what the Session log already committed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the endpoint to the services it calls and the guide that enables it.

- [User guide](docs/usage.md) — enabling the overlay, the client configuration, and the shortest verification path.
- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md) — the create, prompt, cancel, and history operations every root tool maps onto.
- [Subagent runtime](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/README.md) — the descendant listing, continuable prompt, and parent-authorized interrupt behind the child tools.
- [WebServer](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md) — exact-route registration and the shared listener this endpoint serves on.
- [Credentials](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials/README.md) — `credentialRef()` and the per-request `resolve()` behind the bearer token.
- [Defensive patterns](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/defensive-patterns.md) — the request-lifecycle and teardown rules this endpoint follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as this endpoint registers nothing on `ctx.tools` and contributes no prompt, tool schema, or message to any model request; it is reached by a local MCP client, not by the model.

#### KV Cache effect

None; the plugin neither assembles nor sends a provider request, so it cannot change a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what this endpoint deliberately cannot do and when it needs operational care. They are current package constraints, not a task backlog.

- **The bearer token is full control of the instance** — every Session this DSH instance can address by id is reachable; there is no per-token Session ACL, no cwd allowlist, and no remote, multi-user, or reverse-proxied deployment. Keep the client-side environment as protected as the DSH process itself.
- **Only known ids can be controlled** — no Session enumeration, search, rename, delete, fork, model switch, queue edit, or history rewrite; a client must already hold the id it wants.
- **Approvals stay in the Web UI** — the endpoint never answers an approval, ask-user, or elicitation request, so a task that needs one waits for a human and is not unattended.
- **A cold direct parent blocks child control** — `child_send` refuses `subagent/parent-unavailable` rather than resuming the parent; recovering it through its own entry point is the caller's step.
- **A result that cannot fit is refused, not paginated** — an event larger than the result budget is retrieved through chunk mode, but a page header or an `agents_list` tree that alone exceeds the budget returns `mcp-control/result-too-large`; the tree has no paging mode.
- **A process exit stops computation** — durability is the Session log's; restarting reads what was committed, and work that was running is not resumed by the endpoint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
