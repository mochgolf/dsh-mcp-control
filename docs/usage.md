# Control DSH from a local MCP client

English | [中文](usage.zh.md)

This default-off overlay serves the Model Context Protocol on a DSH Web instance's own loopback listener, so a same-machine MCP client — Codex, another agent, a script — can start Sessions, send to them, cancel them, list their subagent tree, and read their durable event log by id.

The endpoint is a thin relay over the Session Controller and subagent services. It starts no second listener and no daemon, keeps no task database, and registers nothing the model can see.

This repository is tested against DSH `0.1.5-rc.2`. The released DSH resolver cannot yet load this external package; the commands below apply after DSH gains that minimal integration.

## Enable it

Save this overlay as a file on the machine — an installed `dsh` publishes no example file — and pass it to the Web profile, giving the DSH process the bearer token through its environment:

```yaml
- insert:
    - id: mcp-control
      name: '@mochgolf/dsh-mcp-control'
      config:
        tokenRef: DSH_MCP_CONTROL_TOKEN
```

```sh
DSH_MCP_CONTROL_TOKEN=... dsh web --patch ./mcp-control.cordis.yml --host 127.0.0.1 --port 8931 --no-open
```

The overlay carries only the credential *reference* (`tokenRef: DSH_MCP_CONTROL_TOKEN`); the token itself never enters YAML. Pick any free port — 8931 is an example, and the endpoint always follows the Web instance's own port. A source checkout includes the same overlay at [`examples/cordis.yml`](../examples/cordis.yml), so it can be passed directly from the repository root.

Starting without `--patch` disables the endpoint; so does removing the overlay from a user patch layer. The Web UI is unaffected either way. To keep it enabled across runs, merge the overlay's single `insert` patch into `$DSH_HOME/profiles/<name>/cordis.patch.yml` for one profile, or `$DSH_HOME/cordis.patch.yml` for every profile on the machine, without overwriting an existing file.

## Configure the client

Give the MCP client the same token through its own environment: setting the variable only in DSH does not reach an already-running client.

```toml
[mcp_servers.dsh]
url = "http://127.0.0.1:8931/mcp"
bearer_token_env_var = "DSH_MCP_CONTROL_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 30
```

The client lists seven tools: `session_start`, `session_send`, `session_cancel`, `agents_list`, `child_send`, `child_interrupt`, and `events_read`. The [package README](../README.md) owns their inputs, results, error codes, and the page/chunk form of `events_read`.

`accepted: true` means DSH admitted the work — not that a turn finished. A `child_send` needs the child's direct parent to be live; the endpoint refuses a cold parent instead of resuming it.

## Verify the path

A first check confirms the endpoint serves only the seven tools and that a Session reaches disk:

1. The client completes the MCP handshake against `http://127.0.0.1:8931/mcp` and `tools/list` returns exactly the seven tools above.
2. `session_start` with an absolute `cwd` and a prompt returns `session_id` and `accepted: true` immediately, before the turn finishes; when that path already belongs to a Workspace, the new Session appears there, while any other path remains ungrouped.
3. `events_read` for that id returns a page whose `events` include the native `turn/start` and `agent/inbox/spliced` records, and repeating the read returns the same events.
4. Let the model create a child through its own subagent tool, then `agents_list` shows that child with its `parentId` and `depth`.
5. `child_send` returns a `message_id`, and the child's own log shows the message and its answer after the delivery.
6. Restart the DSH process with the same `DSH_HOME`: `events_read` still returns the committed events and `agents_list` still lists the child.

Steps 2 and 3 need no API key; the remaining steps need a working model route.

## Security

The token is full control of every Session this DSH instance can address by id — treat it like local shell access. The endpoint refuses any request that does not come from `127.0.0.1` on the Web instance's own port with the current credential, rejects forwarding headers and foreign origins, and never answers an approval, ask-user, or elicitation request. It is not built for remote, multi-user, or reverse-proxied exposure; keep the client-side environment as protected as the DSH process.

## Limits

- Only known Session ids can be controlled: there is no enumeration, search, rename, delete, fork, model switch, or history rewrite.
- A task that needs an approval still waits for a human in the Web UI.
- A cold direct parent blocks child control until it is recovered through its own entry point.
- A page header or a full descendant tree that alone exceeds the configured result budget is refused with `mcp-control/result-too-large`; only a single oversized event has a chunk mode.
- A page far into a large log reads the logical prefix that covers its cursor, not just the events it returns: one page 99,000 events into a generated 100,000-event log took about 0.9 s and 224 MB of heap. Continue from the cursor you already hold instead of re-reading from `-1`.
- Stopping the DSH process stops running work; restarting reads what the Session log committed.
