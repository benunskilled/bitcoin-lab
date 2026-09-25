# Configuration

Bitcoin Lab is ready to use with its default settings. On Umbrel, the connection details for Bitcoin Core are supplied automatically.

For the best results with peer rotation, set Bitcoin Core's outgoing connections to clearnet only. Tor and I2P peers occupy outbound slots but cannot be kept as manual peers by Bitcoin Lab, slowing the search for stronger candidates.

On Umbrel: **Bitcoin Node → Settings → Outgoing Peer Connections**. Incoming Tor and I2P connections are fine.

To customise the app, set environment variables in your Docker Compose configuration. The tables below list the available settings and their defaults.

Where both a `BITCOIN_*` variable and an `APP_BITCOIN_*` equivalent exist, the `BITCOIN_*` value takes precedence. Peer rotation and Stratum Race are enabled through the dashboard.

Apply shared settings consistently to the services that use them, then recreate the affected containers. See [docker-compose.dev.yml](../docker-compose.dev.yml) for a Compose example and [src/lib/config.js](../src/lib/config.js) for the configuration source.

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

`BITCOIN_ZMQ_HASHBLOCK_URL` takes precedence over the ZMQ host and port settings. Without it, the ZMQ host is selected from `BITCOIN_ZMQ_HOST`, then `APP_BITCOIN_NODE_IP`, then the resolved RPC host.

## Storage and dashboard

| Variable | Purpose | Default |
|---|---|---|
| `DATA_DIR` | Persistent data root | `/data` |
| `SQLITE_PATH` | Full path to the database file, overriding `DATA_DIR` | `$DATA_DIR/sqlite/bitcoinlab.db` |
| `DASHBOARD_PORT` | Dashboard HTTP port *inside the container* | `8788` |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | `info` |

On Umbrel, the dashboard is available at `<your-umbrel>:8790`. The default `8788` is its internal container port.

## Peer measurement and rotation

| Variable | Purpose | Default |
|---|---|---|
| `MAX_MANUAL_PEERS` | Maximum size of the saved manual selection; allowed range: 1–8 | `8` |
| `MIN_ELIGIBLE_FOR_JUDGEMENT` | Minimum lifetime Eligible count for automatic outbound judgement and promotion | `50` |
| `NEW_MANUAL_PEER_GRACE_BLOCKS` | Grace against replacement by a stronger candidate, counted from entry into the manual selection | `50` |
| `MIN_SWAP_MARGIN_PCT` | Required lead in ranking-score points for a challenger to take a slot | `0.2` |
| `RECENT_SCORE_WINDOW_BLOCKS` | Recent block window used for scoring; lifetime performance fills any missing observations | `500` |
| `PEER_POLL_INTERVAL_MS` | Peer-profiler session poll interval | `15000` |
| `ROTATION_LOG_ENTRIES` | Rotation-log entries kept, and shown behind "Show all" | `30` |

`MAX_MANUAL_PEERS` accepts values from 1 to 8, matching Core's maximum of eight simultaneous manual connections. Larger values are rejected at startup.

The peer-profiler interval controls connection bookkeeping. Block observations are triggered separately by ZMQ events.

## Offline manual peers

| Variable | Purpose | Default |
|---|---|---|
| `OFFLINE_GRACE_MIN_HOURS` | Minimum offline grace before automatic parking | `1` |
| `OFFLINE_GRACE_MAX_HOURS` | Maximum offline grace before automatic parking | `24` |
| `OFFLINE_GRACE_HOURS_PER_PCT` | Hours of offline grace per percentage point of lifetime First | `1` |
| `PARKED_PEER_PROBES_PER_TICK` | Maximum parked candidates considered for probing per rotation pass | `3` |
| `PARKED_PEER_MIN_PROBE_INTERVAL_MINUTES` | Shortest gap between two tests of the same parked peer | `30` |
| `PARKED_PEER_MAX_PROBE_INTERVAL_HOURS` | Backoff ceiling for peers at or above the full-speed First threshold | `12` |
| `PARKED_PEER_SLOW_PROBE_INTERVAL_HOURS` | Backoff ceiling at 0% lifetime First | `48` |
| `PARKED_PEER_FULL_SPEED_PCT` | Lifetime First % at which the faster backoff ceiling applies | `20` |
| `PARKED_PEER_RETENTION_DAYS_PER_PCT` | Days a parked peer is retained per percentage point of lifetime First | `5` |
| `PARKED_PEER_MIN_RETENTION_DAYS` | Minimum parked retention in days | `2` |
| `PARKED_PEER_MAX_RETENTION_DAYS` | Maximum parked retention in days | `180` |

Offline grace and parked retention use lifetime First %, within their configured minimum and maximum values.

| Lifetime First | Offline grace | Parked retention |
|---|---:|---:|
| 0.8% | 1 hour | 4 days |
| 5% | 5 hours | 25 days |
| 12% | 12 hours | 60 days |
| 24% | 24 hours | 120 days |
| 36% | 24 hours | 180 days |

Probe intervals increase with repeated failures. With the defaults, the backoff ceiling is 12 hours for peers at 20% lifetime First or above, 30 hours at 10%, and about 46 hours at 1%. These are ceilings, not fixed intervals from the first probe; checks are scheduled during rotation passes.

See [How peer rotation works](peer-rotation.md) for protection, parking and recovery rules.

## Stratum Race

| Variable | Purpose | Default |
|---|---|---|
| `STRATUM_RACE_TIMEOUT_MS` | Race window, starting with the first pool; a missing matching job counts as a miss | `8000` |
| `STRATUM_IDLE_TIMEOUT_MS` | Socket inactivity timeout before reconnecting | `21600000` (6h) |
| `STRATUM_AUTHORIZE_ADDRESS` | Address sent in `mining.authorize` | `1BitcoinEaterAddressDontSendf59kuE` |
| `STRATUM_HISTORY_RETENTION_DAYS` | How long stratum race history is kept | `365` |

The default authorisation address is a public burn address used to subscribe to pools that require a valid Bitcoin address. Bitcoin Lab does not submit shares or use it to earn mining payouts.

TCP keepalive helps detect broken connections. The socket inactivity timeout provides a separate fallback for a connection that remains silent.

Stratum Race is controlled from the dashboard. While it is off, no pool connection is open.

## Peer history retention

| Variable | Purpose | Default |
|---|---|---|
| `FEELER_PEER_RETENTION_DAYS` | Retention for inactive, non-manual peers with no recorded relay observations, in days | `14` |
| `TRAFFIC_PEER_RETENTION_DAYS` | How long traffic per peer is kept, in days. The node's daily totals are kept for good | `7` |
| `TRAFFIC_FLUSH_MS` | How often gathered traffic is written to the database, in milliseconds | `3600000` |

Peers with recorded relay observations retain their delivery and session history. The shorter retention period removes inactive peers that never appeared in a block observation; manually selected peers are also retained.

Relay observations are not deleted automatically by age. The 500-block scoring window controls the ranking, not data retention. You can clear peer measurements from the dashboard's Storage panel while keeping your manual selection.

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

## Changing defaults

The rotation settings work together: observation thresholds, grace periods, swap margins and parking determine how quickly candidates are tried and how long proven peers are retained. [How peer rotation works](peer-rotation.md) explains the choices behind the defaults.

Numeric settings are validated at startup. Invalid values stop the service with an error naming the setting. In particular, minimum grace and retention values must not exceed their maximums, and `RECENT_SCORE_WINDOW_BLOCKS` must be at least `MIN_ELIGIBLE_FOR_JUDGEMENT`.

---

[← Back to the README](../README.md)
