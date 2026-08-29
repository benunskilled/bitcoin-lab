# Bitcoin Lab

Peer relay performance profiler and stratum race for a Bitcoin Core node.

- **Peer Profiler** - historical session tracking (connection type, ping,
  duration, sessions) for every peer, live and past.
- **Relay Profiler** - detects new blocks exclusively via Bitcoin Core ZMQ
  (`pubhashblock`), timestamps with `process.hrtime.bigint()` before any
  other work, and records which currently-connected peers ("Eligible")
  actually delivered the block first ("First"), using Core's own
  `getpeerinfo().last_block` field - no RPC polling on the timing path.
- **Stratum Race** - times how fast each configured mining pool delivers a
  new `mining.notify` job over its own TCP connection, independent of
  Bitcoin Core. Pools (including any local solo pool) are added/removed
  from the dashboard - nothing is hardcoded.

See `../bitcoin-lab-community-store/` for the Umbrel App Store packaging,
and that repo's README for the full first-time setup (GitHub repo, image
build, adding the store to Umbrel).

## Running locally (outside Umbrel)

This app is a normal multi-container Docker Compose stack; Umbrel-specific
wiring only lives in the packaging repo.

```sh
docker compose -f docker-compose.dev.yml up --build
./test/regtest-generate.sh   # mine a regtest block
docker compose -f docker-compose.dev.yml logs -f relay-profiler
```

Dashboard: http://localhost:8788

## Tests

```sh
npm install
npm test
```

## Configuration

All configuration is environment variables (see `src/lib/config.js`) - no
config files to hand-edit, no SSH. On Umbrel these are supplied
automatically via the `bitcoin` app dependency contract
(`APP_BITCOIN_*`); for local/non-Umbrel use, set the plain `BITCOIN_*`
equivalents (see `docker-compose.dev.yml` for a working example).

| Variable | Purpose | Default |
|---|---|---|
| `BITCOIN_RPC_HOST` / `APP_BITCOIN_NODE_IP` | Bitcoin Core RPC + ZMQ host | `127.0.0.1` |
| `BITCOIN_RPC_PORT` / `APP_BITCOIN_RPC_PORT` | RPC port | `8332` |
| `BITCOIN_RPC_USER` / `APP_BITCOIN_RPC_USER` | RPC username | - |
| `BITCOIN_RPC_PASS` / `APP_BITCOIN_RPC_PASS` | RPC password | - |
| `BITCOIN_ZMQ_HASHBLOCK_PORT` / `APP_BITCOIN_ZMQ_HASHBLOCK_PORT` | ZMQ `pubhashblock` port | `28334` |
| `DATA_DIR` | SQLite + config storage root | `/data` |
| `DASHBOARD_PORT` | Dashboard HTTP port | `8788` |
| `STRATUM_RACE_TIMEOUT_MS` | Window a pool has to report before scored a miss | `8000` |
| `PEER_POLL_INTERVAL_MS` | Peer Profiler session poll interval | `15000` |
| `STRATUM_HISTORY_RETENTION_DAYS` | How long stratum race history is kept | `180` |
| `FEELER_PEER_RETENTION_DAYS` | How long sessions of peers with no relay history are kept | `14` |
| `MAX_MANUAL_PEERS` | Manual/addnode connections Core holds open at once | `8` |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | `info` |

## Health and liveness

Three of the four processes have no HTTP port, so each writes a heartbeat
into the shared `meta` table every 30 seconds. Two things read it:

- `GET /api/health` reports this process plus the state of all three
  workers. The dashboard shows a banner when one stops reporting.
- The container `healthcheck` for each worker runs
  `node -e "require('/app/src/lib/health').assertFresh('<service>', 120000)"`,
  which opens the database read-only and exits non-zero on a stale beat.

The heartbeat runs on its own timer rather than as a side effect of work,
because the relay profiler is event-driven: with ~10 minutes between blocks,
"nothing happened recently" is a healthy state and must not read as a fault.

## Live block events

`GET /api/events` is a Server-Sent Events stream. The dashboard process
subscribes to Core's `pubhashblock` topic on its own socket (separate
process, separate socket from the relay profiler, so it cannot perturb what
the profiler measures) and pushes a `block` event when one lands. The
browser therefore does no block polling at all. A slow database-backed
re-check runs alongside it so events still arrive if ZMQ is unavailable to
this process.

## Design principles

Carried over from the project brief, unchanged by the rewrite:

1. Block detection only via ZMQ, never RPC polling.
2. Timestamp captured as early as physically possible.
3. Stratum race judged purely by incoming `mining.notify`, every pool
   treated identically.
4. Peer history and trusted/manual peers persist across container
   rebuilds and updates (`${APP_DATA_DIR}/data`).
5. Bitcoin Core's own automatic outbound peer discovery is never replaced
   by manual peers - both coexist.
6. No IPv6 rewriting/mapping, no fixed container IPs, no SSH, no
   Portainer dependency.
