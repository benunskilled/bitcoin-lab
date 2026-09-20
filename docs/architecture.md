# Architecture

Bitcoin Lab runs four processes from the same container image. They share one SQLite database, and Docker manages each process separately.

| Process | Responsibility |
|---|---|
| `dashboard` | Web interface, API and live block updates |
| `peer-profiler` | Tracks connections, restores the manual selection and runs rotation |
| `relay-profiler` | Receives ZMQ block events and records First and Eligible |
| `stratum-race` | Maintains pool connections and times incoming mining jobs |

The relay profiler runs separately so dashboard requests and pool-message processing do not share its event loop. It captures the block-event timestamp before making RPC calls or writing to the database.

## Shared storage

The four processes share a SQLite database in WAL mode, allowing readers to access it while another process writes. It stores peer observations, rankings, the saved manual selection and Stratum Race history.

The dashboard's Storage panel shows how much space the data uses. Peer measurements and pool history can be cleared separately.

Your saved manual selection survives either reset. Clearing peer measurements starts a fresh delivery record while keeping the peers you have chosen.

## Health and recovery

Each worker writes a heartbeat to the shared database. The dashboard uses these signals to show whether the background services are running, and `/api/health` reports their status.

Docker restarts a process if it exits. When Bitcoin Core returns after a restart, the peer profiler restores the saved manual selection through RPC.

Bitcoin Lab keeps its own state in its database. Core's configuration files remain untouched.

## Stratum Race timing

Each enabled pool has its own connection. A race begins when the first pool sends a mining job referencing a new previous block hash (`prevhash`). That pool sets the reference at 0 ms; every other pool's job for the same hash is timed against it.

Arrival times are captured as data reaches the connection, before the message is parsed. Your own pool is measured by the same rules as the public pools.

A pool that does not report the matching job within the race window receives a miss.

## Resource use

On the author's Umbrel, Bitcoin Lab showed 247 MB of memory use with peer rotation and Stratum Race enabled and 200 peers connected to Bitcoin Core. CPU usage was displayed as 0.00% at the time of the snapshot.

Historical data is stored in SQLite, with disk usage shown in the dashboard.

See [Configuration](configuration.md) for settings and [Limitations](limitations.md) for storage and networking details.

---

[← Back to the README](../README.md)
