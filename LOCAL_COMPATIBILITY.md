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
