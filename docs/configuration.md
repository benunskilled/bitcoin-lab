# Configuration

Everything is an environment variable. There are no config files to hand-edit,
and the defaults are all in [`src/lib/config.js`](../src/lib/config.js) with the
reasoning written next to them.

On Umbrel the Bitcoin Core settings arrive on their own through the `bitcoin` app
dependency as `APP_BITCOIN_*`. A normal Umbrel install sets none of this by hand.
Outside Umbrel use the plain `BITCOIN_*` equivalents —
[`docker-compose.dev.yml`](../docker-compose.dev.yml) is a working example.

Where a plain name and an `APP_` name both exist, the plain one wins.

## Bitcoin Core

| Variable | Purpose | Default |
|---|---|---|
| `BITCOIN_RPC_HOST` / `APP_BITCOIN_NODE_IP` | RPC host | `127.0.0.1` |
| `BITCOIN_RPC_PORT` / `APP_BITCOIN_RPC_PORT` | RPC port | `8332` |
| `BITCOIN_RPC_USER` / `APP_BITCOIN_RPC_USER` | RPC username | - |
| `BITCOIN_RPC_PASS` / `APP_BITCOIN_RPC_PASS` | RPC password | - |
| `BITCOIN_NETWORK` / `APP_BITCOIN_NETWORK` | Network label shown in the header | `mainnet` |
| `BITCOIN_ZMQ_HOST` / `APP_BITCOIN_NODE_IP` | ZMQ host, when it differs from the RPC host | RPC host |
| `BITCOIN_ZMQ_HASHBLOCK_PORT` / `APP_BITCOIN_ZMQ_HASHBLOCK_PORT` | ZMQ `pubhashblock` port | `28334` |
| `BITCOIN_ZMQ_HASHBLOCK_URL` | Full ZMQ URL, overriding host and port together | - |

`BITCOIN_ZMQ_HASHBLOCK_URL` takes precedence over the host and port settings.

## Storage and dashboard

| Variable | Purpose | Default |
|---|---|---|
| `DATA_DIR` | Persistent data root | `/data` |
| `SQLITE_PATH` | Full path to the database file, overriding `DATA_DIR` | `$DATA_DIR/sqlite/bitcoinlab.db` |
| `DASHBOARD_PORT` | Dashboard HTTP port *inside the container* | `8788` |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | `info` |

`DASHBOARD_PORT` is the port the dashboard listens on inside its container, and
there is rarely a reason to change it. On Umbrel the app is published on **8790**
instead, because 8788 belongs to another app in the official store and two apps
cannot share a port on the host.

## Peer measurement and rotation

| Variable | Purpose | Default |
|---|---|---|
| `MAX_MANUAL_PEERS` | Manual peers `addnode`'d at once | `8` |
| `MIN_ELIGIBLE_FOR_JUDGEMENT` | Blocks a peer must have been eligible for before its First % is acted on | `50` |
| `NEW_MANUAL_PEER_GRACE_BLOCKS` | Blocks a newly promoted manual peer cannot be displaced for | `50` |
| `MIN_SWAP_MARGIN_PCT` | How much better a challenger must be, in points of First %, to take a slot | `0.2` |
| `RECENT_SCORE_WINDOW_BLOCKS` | Blocks the ranking judges a peer on, once it has been around for all of them | `500` |
| `PEER_POLL_INTERVAL_MS` | Peer-profiler session poll interval | `15000` |
| `ROTATION_LOG_ENTRIES` | Rotation-log entries kept, and shown behind "Show all" | `30` |

`MAX_MANUAL_PEERS` mirrors Core's own `MAX_ADDNODE_CONNECTIONS`, which is 8.
Raising it here does not raise Core's limit; it only makes this app try to hold
connections Core will not keep open.

The peer profiler polls for session bookkeeping only. Block timing never touches
this interval — the relay profiler is driven by ZMQ.

## Offline manual peers

| Variable | Purpose | Default |
|---|---|---|
| `OFFLINE_GRACE_MIN_HOURS` | Shortest an offline manual peer keeps its slot, whatever its record | `1` |
| `OFFLINE_GRACE_MAX_HOURS` | Longest, however good its record | `24` |
| `OFFLINE_GRACE_HOURS_PER_PCT` | Hours of grace bought per point of First % | `1` |
| `PARKED_PEER_PROBES_PER_TICK` | Parked peers re-tested per rotation pass | `3` |
| `PARKED_PEER_MIN_PROBE_INTERVAL_MINUTES` | Shortest gap between two tests of the same parked peer | `30` |
| `PARKED_PEER_MAX_PROBE_INTERVAL_HOURS` | Longest gap for a peer at or above the full-speed % | `12` |
| `PARKED_PEER_SLOW_PROBE_INTERVAL_HOURS` | Longest gap for a peer with no record worth chasing | `48` |
| `PARKED_PEER_FULL_SPEED_PCT` | First % from which a parked peer is chased at full speed | `20` |
| `PARKED_PEER_RETENTION_DAYS_PER_PCT` | Days a parked peer is remembered, per point of First % | `5` |
| `PARKED_PEER_MIN_RETENTION_DAYS` | Floor on that | `2` |
| `PARKED_PEER_MAX_RETENTION_DAYS` | Ceiling on that | `180` |

Both the grace and the retention are bought with the peer's own record and then
clamped. With the defaults:

```
grace       0.8% -> 1h (the floor)    5% -> 5h     12% -> 12h    24%+ -> 24h
retention   0.8% -> 4 days            5% -> 25 days             36%+ -> 180 days
```

Probing backs off as a peer keeps failing to answer, and the ceiling it backs off
to depends on the same record: full speed from `PARKED_PEER_FULL_SPEED_PCT`
upwards, sliding to the slow ceiling as the record approaches zero — 40% is
knocked on every 12 hours, 10% about every 30, 1% about every 46. Only a few
parked peers are tested per pass, so this never turns into a scan.

The reasoning behind all of it is in [peer-rotation.md](peer-rotation.md).

## Stratum Race

| Variable | Purpose | Default |
|---|---|---|
| `STRATUM_RACE_TIMEOUT_MS` | Window a pool has to report a new prevhash before it is scored a miss | `8000` |
| `STRATUM_IDLE_TIMEOUT_MS` | Silence after which a pool connection is considered dead and reopened | `21600000` (6h) |
| `STRATUM_AUTHORIZE_ADDRESS` | Address sent in `mining.authorize` | `1BitcoinEaterAddressDontSendf59kuE` |
| `STRATUM_HISTORY_RETENTION_DAYS` | How long stratum race history is kept | `365` |

The authorize address is not a payout address and never receives anything — this
app does not submit shares. It is there because many solo pools run ckpool-solo,
which validates the username as a real Bitcoin address and simply never sends
`mining.notify` to a connection that failed to authorize.

The idle timeout is a last-resort backstop, not how a dead socket is normally
noticed; TCP keepalive does that in minutes. Six hours is deliberately far past
what the block-interval maths says is possible, because this node has seen long
gaps more than once and a spurious reconnect would cost a false miss.

The master switch for Stratum Race lives on the dashboard, not here. While it is
off, no pool socket is open.

## Peer history retention

| Variable | Purpose | Default |
|---|---|---|
| `FEELER_PEER_RETENTION_DAYS` | How long sessions of peers that were never around for a block are kept | `14` |

A peer that has ever appeared in a relay observation — connected at the moment a
block landed, even once — is part of the ranking and is never pruned, whatever
its age. Crawlers, one-off probes, feelers and addr-fetch connections that came
and went without ever being present for a block have no analytical value here,
and keeping their session history for months was the real source of unbounded
growth.

Relay observations themselves are never time-pruned at all. They *are* the
ranking. You can delete them from the Storage panel if you want the space back.

## Docker and Umbrel networking

| Variable | Purpose | Default |
|---|---|---|
| `DOCKER_PROXY_MASKED_HOST` | The gateway address Docker substitutes for relayed inbound IPv6 peers | `10.21.0.1` |
| `UMBREL_INTERNAL_NETWORK_CIDR` | Range treated as "another app on this Umbrel" rather than a peer | `10.21.0.0/16` |

The defaults match Umbrel's normal internal network. The first exists because
Docker can only hand an inbound IPv6 connection to an IPv4-only container by
relaying it through docker-proxy, which re-originates it from the bridge gateway
— so Core sees that gateway instead of the peer. The second keeps sibling Umbrel
apps that talk to Core's P2P port, like electrs and mempool's indexer, out of
peer-management decisions.

## Manual peer ports

When you type in a bare IP, or when an inbound peer has to be checked for a
reachable listening port, Bitcoin Lab tries `8333` and then `9333`. That list is
in `src/lib/config.js` and is not an environment variable.

## About changing these

The rotation defaults were picked from what this app actually did on a live node,
and they lean on each other: acting soon enough to keep a good outbound peer
before Core rotates it away, not letting a freshly promoted peer lose its slot
straight away, not swapping over a difference that is noise, freeing an offline
slot quickly without forgetting a peer that was worth something, and keeping
probe traffic for dead addresses down to nothing.

Changing them is supported. Changing one hard is worth thinking through against
the rest.
