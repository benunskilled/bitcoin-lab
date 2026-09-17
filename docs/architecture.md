# Architecture

Four processes from one image, sharing one SQLite file (WAL mode, 10s busy
timeout), each restarted on its own by Docker:

| Process | Job |
|---|---|
| `dashboard` | HTTP API, static frontend, and the SSE block stream |
| `peer-profiler` | Session bookkeeping, manual/addnode sync, peer rotation |
| `relay-profiler` | The ZMQ block-timing path and First/Eligible recording |
| `stratum-race` | One persistent TCP connection per pool, `mining.notify` timing |

The relay profiler does nothing but sit on its ZMQ socket, so a slow dashboard
request or a stalled pool connection can never delay the one timestamp that has
to be exact. Each worker writes a heartbeat into the shared `meta` table every 30
seconds, and `GET /api/health` reports all four.

Everything reaches Bitcoin Core through its RPC and ZMQ interfaces. Pull this app
off the machine and the node is exactly as it was.

Between them the four processes hold about 80 MB of memory on a live node — a
Node runtime each and almost nothing on top, because everything that grows lives
in SQLite. CPU is idle between blocks. Umbrel puts its own proxy container in
front, which costs about as much again.

## Storage

The dashboard header shows what this app's data takes up on disk, and a panel at
the bottom splits it into the two things that grow: peer measurements and pool
history. Each can be cleared on its own.

Your manual peers are never part of either. They survive a reset, with their
record starting again at zero — which is the point, because by then finding them
has taken months.


---

[← back to the README](../README.md)
