# DSH 0.2.1-rc.2 compatibility maintenance

Base: upstream commit `dbfb0d32cb9a1a8d5f812453a6ea73ec9a4178e9`.

This revision updates the first-party API requirements, rejects an unbound WebServer,
and preserves the MCP `session_start` contract after native `create()` changed to
reuse only blank conversations. Existing named sessions are inspected and resumed;
working-directory and preset conflicts are refused. Per-context creation slots keep
concurrent retries and work that outlives an HTTP deadline from minting duplicate
sessions. The ordinary DSH prompt API still owns message-id deduplication.

The fixtures now mount the native controller with its declared dependencies, wait
for plugin activation, and use `startActivation` for children. Assertions distinguish
the caller's accepted message from runtime context messages and wait for its durable
append rather than assuming acceptance is a synchronous disk write.

Loopback binding, Bearer authentication, same-origin checks, request limits, and
native permission enforcement remain covered by the complete test suite.

## Session-only model selection

Explicit `session_start` model inputs require native `session/create` support for
`modelSelection`. The original published `0.2.1-rc.2` controller lacks that input.
The MCP endpoint checks the running Host's public Typert request descriptor and
refuses the new inputs before creating a Session. Starts without them retain
native selection behavior.

This checkout's `pnpm-workspace.yaml` applies the native backport in `patches/` for
development and acceptance tests. The native controller validates the model and
effort and installs the durable selection during Agent setup, before publication.
It never saves the deployment default. Native create disables blank-Session reuse
when an initial model is supplied; MCP retries instead inspect and adopt their
existing identity after checking the stored initial choice.

The patch is generated from the companion native source build, including its
public declarations and generated request codecs. It does not alter an existing
DSH installation and is not applied by installing the MCP npm package. Deployment
needs the equivalent native Host change as well as this MCP change; package version
equality alone is insufficient. The old-create descriptor fixture in `tests/fixtures/`
is captured from the published controller's public Typert projection.

Companion native source: [pre-publication model initialization](https://github.com/mochgolf/deepseek-harness/commit/7940902abe8d9fce316e9b6d91858a4504aa6f4c).
