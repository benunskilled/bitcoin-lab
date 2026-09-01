# Bitcoin Lab

Find your fastest Bitcoin peers, keep them, and see whether your mining pool
actually got faster because of it.

Which peer hands your node a new block first decides how long your pool keeps
handing out work on a block that has already been solved — and every second of
that is hashrate spent on nothing. Bitcoin Core picks its peers for network
health, not for your latency, so that set is random and stays random. Bitcoin
Lab measures which peers actually deliver first, over hundreds of blocks, lets
you keep the winners, and then measures whether your pool got faster as a
result.

![Bitcoin Lab dashboard](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/1.png)

## Install

Bitcoin Lab ships as an Umbrel Community App — see
[bitcoin-lab-community-store](https://github.com/benunskilled/bitcoin-lab-community-store)
for the store URL and the installation steps. It also runs as a plain Docker
Compose stack outside Umbrel; see [Running locally](#running-locally).

## What it measures

### Peer relay ranking

A new block is detected **only** over Bitcoin Core's ZMQ `pubhashblock` topic,
and timestamped with `process.hrtime.bigint()` before anything else happens —
no RPC call sits on the timing path, so nothing this app does can skew the
measurement it is taking.

Exactly one `getpeerinfo` snapshot follows. Every peer connected at that moment
counts as **Eligible** for that block; every peer whose `last_block` timestamp
falls inside the detection window counts as **First**. A peer's lifetime
`First / Eligible` percentage is the ranking key — a percentage rather than a
raw count, so a peer that has merely been connected forever doesn't outrank a
genuinely fast one.

Two details make that number trustworthy. Core only sets `last_block` when the
block was new to it — `if (new_block) { node.m_last_block_time = ... }` in its
own net_processing.cpp — so a peer that relays a block we already have is not
credited, and for any given block exactly one peer normally is: the one that
actually got it to us first. And the comparison uses a window of a couple of
seconds rather than an exact match, because `last_block` has one-second
resolution while the ZMQ timestamp is millisecond-precise, so the second
boundary can fall anywhere inside our detection instant.

Two peers are therefore only ever credited for the same detection window in the
rare case where two blocks are accepted within it — competing blocks at the same
height, or two blocks in quick succession.

Acting on the ranking is where the speed actually comes from:

- **Trust a good peer** and it is registered via `addnode`, so Core keeps it
  instead of letting it rotate out. Core maintains up to 8 such connections
  (`MAX_ADDNODE_CONNECTIONS` in its own net.h) — a pool of its own, not a share
  of the automatic outbound slots.
- **Disconnect a peer that never delivers** and Core replaces that outbound
  connection with a fresh, randomly chosen one, which then gets ranked the same
  way. Repeat, and your peer set improves instead of staying whatever Core
  happened to pick.

Inbound peers are ranked too and can be promoted, with one wrinkle: their
`getpeerinfo` address carries the peer's *ephemeral outbound source port*, not
the port their node listens on. Bitcoin Lab re-derives the real listening port
with a TCP handshake (8333, then 9333) before trusting anything. Not every
inbound peer listens; those simply cannot be promoted.

Trying one costs nothing, deliberately. Nothing is written and no connection is
touched until that handshake has succeeded *and* a manual slot is confirmed
available — so an inbound peer can be tried without putting the peer set you
already have at risk. If all eight slots are taken, the weakest is dropped to
make room and the answer says which, by address and by record. The dashboard's
**Test** button asks the reachability question entirely on its own, with no
consequences at all.

Manual peers survive everything, and that takes deliberate work: the addnode
list Core builds at runtime lives only in its memory. A `bitcoind` restart
wipes it, and Core re-reads only what is in bitcoin.conf — which this app never
touches. Bitcoin Lab keeps its own persisted copy and re-asserts it at startup
and every ten minutes, so a restart does not cost you the peers you spent days
identifying.

### Stratum Race

Each configured pool gets its own TCP connection and is timed purely on when
its `mining.notify` carrying a new `prevhash` arrives — `hrtime` on the
socket's `data` event, before any parsing. The first pool to report a given
prevhash sets 0 ms, and every other pool is measured relative to it. No pool is
special-cased, including your own. A pool that does not report within the
timeout window is scored a miss for that race.

Per pool: wins, win %, average / median / P90 latency, races seen, misses. The
public pools are there as the baseline your own pool's number is measured
against — a pool racing alone would trivially "win" every time.

### What this is worth

Worth saying plainly: this is a game of tens to a few hundred milliseconds per
block. Small — but it is exactly the window in which a miner is working on a
block that can no longer win, and it is the only part of that window a node
operator can actually do something about.

## Peer rotation (optional, off by default)

A toggle on the dashboard automates the loop above. Every ~10 minutes it:

1. **Kicks dead weight** — disconnects any live outbound peer that has been
   eligible for at least `MIN_ELIGIBLE_FOR_JUDGEMENT` blocks (144, roughly a
   day) and has never once delivered a block first. Manual and inbound peers
   are never kicked: Core only backfills a dropped *outbound* connection with a
   fresh random peer, which is the entire mechanism this relies on.
2. **Retires a manual peer that isn't there any more** — a manual peer that has
   been offline longer than its own record has earned gives its slot up. The
   grace period is bought with performance, roughly six hours per point of
   First %, floored at 6 hours and capped at a week: a peer at 0.8% is barely
   better than the random peer Core would have given you anyway and should not
   sit on a slot for a day; one at 40% is worth waiting a week for. Without
   this pass the manual set could only ever be improved by a better live
   candidate, so eight peers that all went dark held the whole list hostage.
3. **Lets a parked peer back in** — retiring is not deleting. Every retired
   peer's address is parked and re-probed a few at a time each pass (one TCP
   handshake to the port that answered last time, backing off as failures
   accumulate), and the first one that answers takes its slot straight back if
   it is free, or beats the weakest manual peer for it. This is what makes a
   short grace period safe: the cost of being too quick is a peer that returns
   on its own within a few ticks, not a peer lost.

   How hard a parked peer is chased, and for how long it is remembered at all,
   scale with its record too — in the direction that costs least for the least
   reward. A peer at 30% is knocked on every twelve hours for five months; one
   at 1% every other day for five days, because even a successful answer from
   it barely beats the random peer Core would have supplied anyway. The first
   knock comes on the next pass either way: the backoff starts at 30 minutes
   and climbs to that ceiling over roughly the first day.
4. **Promotes one candidate** — takes the best-performing non-manual peer with
   a real track record and either fills a free manual slot with it, or swaps it
   for the weakest current manual peer, but only if it is strictly better.

At most one peer joins the manual set per pass, revival or promotion, so the
set drifts toward the best peers instead of churning. Every action is written
to a rotation log shown under the toggle, with the parked peers listed beside
it — "where did my peer go?" should have an answer on the same screen that took
it away.

## Architecture

Four processes from one image, sharing one SQLite file (WAL mode, 10s busy
timeout), each restarted independently by Docker:

| Process | Job |
|---|---|
| `dashboard` | HTTP API, static frontend, and the SSE block stream |
| `peer-profiler` | Session bookkeeping, manual/addnode sync, peer rotation |
| `relay-profiler` | The ZMQ block-timing path and First/Eligible recording |
| `stratum-race` | One persistent TCP connection per pool, `mining.notify` timing |

The split is deliberate rather than cosmetic: the relay profiler does nothing
but sit on its ZMQ socket, so a slow dashboard request or a stalled pool
connection can never delay the one timestamp that has to be exact. The
dashboard subscribes to ZMQ on its own separate socket for live block events,
for the same reason.

The three workers have no HTTP port, so each writes a heartbeat into the shared
`meta` table every 30 seconds. `GET /api/health` reports all four, and each
worker's container healthcheck reads that heartbeat back read-only. The
heartbeat runs on its own timer rather than as a side effect of work, because
with ~10 minutes between blocks "nothing happened recently" is a healthy state
and must not read as a fault.

Everything reaches Bitcoin Core through its RPC and ZMQ interfaces and nothing
else. This app does not read or write bitcoin.conf, touch host configuration,
or hold any state Core depends on — pull it off the machine and the node is
exactly as it was.

## Running locally

A normal multi-container Docker Compose stack; the Umbrel-specific wiring lives
only in the packaging repo.

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

All configuration is environment variables (see `src/lib/config.js`) — no
config files to hand-edit, no SSH. On Umbrel these are supplied automatically
via the `bitcoin` app dependency contract (`APP_BITCOIN_*`); for local use set
the plain `BITCOIN_*` equivalents (`docker-compose.dev.yml` is a working
example).

| Variable | Purpose | Default |
|---|---|---|
| `BITCOIN_RPC_HOST` / `APP_BITCOIN_NODE_IP` | Bitcoin Core RPC + ZMQ host | `127.0.0.1` |
| `BITCOIN_RPC_PORT` / `APP_BITCOIN_RPC_PORT` | RPC port | `8332` |
| `BITCOIN_RPC_USER` / `APP_BITCOIN_RPC_USER` | RPC username | - |
| `BITCOIN_RPC_PASS` / `APP_BITCOIN_RPC_PASS` | RPC password | - |
| `BITCOIN_ZMQ_HASHBLOCK_PORT` / `APP_BITCOIN_ZMQ_HASHBLOCK_PORT` | ZMQ `pubhashblock` port | `28334` |
| `DATA_DIR` | SQLite storage root | `/data` |
| `DASHBOARD_PORT` | Dashboard HTTP port | `8788` |
| `STRATUM_RACE_TIMEOUT_MS` | Window a pool has to report before it is scored a miss | `8000` |
| `PEER_POLL_INTERVAL_MS` | Peer Profiler session poll interval | `15000` |
| `STRATUM_HISTORY_RETENTION_DAYS` | How long stratum race history is kept | `180` |
| `FEELER_PEER_RETENTION_DAYS` | How long sessions of peers with no relay history are kept | `14` |
| `MAX_MANUAL_PEERS` | Manual peers addnode'd at once — mirrors Core's `MAX_ADDNODE_CONNECTIONS` | `8` |
| `MIN_ELIGIBLE_FOR_JUDGEMENT` | Blocks a peer must have been eligible for before its First % is acted on | `144` |
| `OFFLINE_GRACE_MIN_HOURS` | Shortest an offline manual peer keeps its slot, whatever its record | `6` |
| `OFFLINE_GRACE_MAX_HOURS` | Longest, however good its record | `168` |
| `OFFLINE_GRACE_HOURS_PER_PCT` | Hours of grace bought per point of First % | `6` |
| `PARKED_PEER_PROBES_PER_TICK` | Retired peers re-tested per rotation pass | `3` |
| `PARKED_PEER_MAX_PROBE_INTERVAL_HOURS` | Longest gap between tests for a peer at or above full-speed % | `12` |
| `PARKED_PEER_SLOW_PROBE_INTERVAL_HOURS` | Longest gap for a peer with no record worth chasing | `48` |
| `PARKED_PEER_FULL_SPEED_PCT` | First % from which a parked peer is chased at full speed | `20` |
| `PARKED_PEER_RETENTION_DAYS_PER_PCT` | Days a parked peer is remembered, per point of First % | `5` |
| `PARKED_PEER_MIN_RETENTION_DAYS` / `_MAX_` | Floor and ceiling on that | `2` / `180` |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | `info` |

## Known limitations

- **Inbound IPv6 peers show no address.** Docker can only hand an inbound IPv6
  connection to an IPv4-only container by relaying it through docker-proxy,
  which re-originates the connection from the Docker bridge gateway. Core never
  learns the peer's real address, so there is nothing for this app to recover or
  act on — those rows are labelled honestly instead of showing a meaningless
  local IP.
- **Relay observations are never pruned.** They *are* the ranking, so they are
  kept regardless of age. Their growth is bounded on its own terms (one race per
  block, a handful of rows each); transient peer sessions are what get a
  retention window.

## Licence

MIT — see [LICENSE](./LICENSE).
