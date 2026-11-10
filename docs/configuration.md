# Configuration

Bitcoin Lab is ready to use with its default settings. On Umbrel, the connection details for Bitcoin Core are supplied automatically.

Slot Fill can add Tor and I2P peers if Core connects out over those networks. On Umbrel: **Bitcoin Node → Settings → Outgoing Peer Connections**.

To customise the app, set environment variables in your Docker Compose configuration. The tables below list the available settings and their defaults.

Where both a `BITCOIN_*` variable and an `APP_BITCOIN_*` equivalent exist, the `BITCOIN_*` value takes precedence. Slot Fill and Stratum Race are switched on in the dashboard.

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

## Peer measurement and Slot Fill

| Variable | Purpose | Default |
|---|---|---|
| `MAX_MANUAL_PEERS` | Maximum size of the saved manual selection; allowed range: 1–8 | `8` |
| `MIN_ELIGIBLE_FOR_JUDGEMENT` | Blocks an outbound peer must have been connected for to count as tested in the Outbound Peers line | `50` |
| `NEW_MANUAL_PEER_GRACE_BLOCKS` | Blocks a new manual peer is safe from being replaced by a peer added by hand | `50` |
| `MANUAL_PER_REGION` | Outbound connections, Core's own included, below which a region (continent, Tor, I2P) counts as missing and may be filled from Core's "new" table | `1` |
| `RECENT_SCORE_WINDOW_BLOCKS` | Recent block window used for scoring; lifetime performance fills any missing observations | `500` |
| `PEER_POLL_INTERVAL_MS` | Peer-profiler session poll interval | `15000` |

`MAX_MANUAL_PEERS` accepts values from 1 to 8, matching Core's maximum of eight simultaneous manual connections. Larger values are rejected at startup.

The peer-profiler interval controls connection bookkeeping. Block observations are triggered separately by ZMQ events.

## Offline manual peers

| Variable | Purpose | Default |
|---|---|---|
| `OFFLINE_GRACE_HOURS` | Hours a manual peer that never delivered a block first may stay offline before it loses its slot | `1` |
| `OFFLINE_GRACE_DELIVERED_HOURS` | The same for a manual peer that delivered at least one block first | `24` |

A padlocked manual peer that Core has connected to at least once never loses its slot to being offline. See [manual slots](manual-slots.md).

## Stratum Race

| Variable | Purpose | Default |
|---|---|---|
| `STRATUM_RACE_TIMEOUT_MS` | Race window, starting with the first pool; a missing matching job counts as a miss | `8000` |
| `STRATUM_IDLE_TIMEOUT_MS` | Socket inactivity timeout before reconnecting | `21600000` (6h) |
| `STRATUM_AUTHORIZE_ADDRESS` | Address sent in `mining.authorize` | `1BitcoinEaterAddressDontSendf59kuE` |
| `STRATUM_HISTORY_RETENTION_DAYS` | How long stratum race history is kept | `365` |

The default authorisation address is a public burn address used to subscribe to pools that require a valid Bitcoin address. Bitcoin Lab does not submit shares or use it to earn mining payouts.

TCP keepalive helps detect broken connections. The socket inactivity timeout provides a separate fallback for a connection that remains silent.

Stratum Race is controlled from the dashboard. Switched off, its pool connections close within half a minute.

## Peer history retention

| Variable | Purpose | Default |
|---|---|---|
| `FEELER_PEER_RETENTION_DAYS` | Retention for inactive, non-manual peers with no recorded relay observations, in days | `14` |
| `NEVER_FIRST_PEER_RETENTION_DAYS` | Retention for inbound peers that were seen at blocks but never delivered one first, in days | `30` |
| `TRAFFIC_FLUSH_MS` | How often gathered traffic is written to the database, in milliseconds | `3600000` |

Peers that delivered a block first, outbound peers, and manual peers keep their delivery and session history. Inactive peers that never appeared in a block observation go after 14 days; inbound peers that appeared at blocks but never delivered one first go, with their observations, after 30 days. No other peer's record changes when they go.

Retention never deletes blocks. The 500-block scoring window controls the ranking, not data retention. You can clear peer measurements from the dashboard's Storage panel while keeping your manual selection.

## Docker and Umbrel networking

| Variable | Purpose | Default |
|---|---|---|
| `DOCKER_PROXY_MASKED_HOST` | The gateway address Docker substitutes for relayed inbound IPv6 peers | `10.21.0.1` |
| `UMBREL_INTERNAL_NETWORK_CIDR` | Range treated as "another app on this Umbrel" rather than a peer | `10.21.0.0/16` |
| `TRUSTED_PROXY_HOST` | Host whose requests may change things (disconnect, reset, switches), besides the Docker gateway; set by the store to the app's own proxy | - |

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

## For a test copy

`LAB_READ_ONLY=1` keeps a second copy of the app from changing Core's peers, and `PEERMAP_LINK_PORT` points its links at a test Peer Map. `PEERMAP_HEALTH_URL`, `SSE_MAX_AGE_MS` and `WRITE_SOURCE_DEBUG` are for development only.

## Changing defaults

The pages linked from the [README](../README.md#documentation) explain the choices behind the defaults.

Numeric settings are validated at startup. Invalid values stop the service with an error naming the setting. In particular, `RECENT_SCORE_WINDOW_BLOCKS` must be at least `MIN_ELIGIBLE_FOR_JUDGEMENT`.

---

[← Back to the README](../README.md)
