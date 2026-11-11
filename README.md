# Bitcoin Lab

[![Tests](https://github.com/benunskilled/bitcoin-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/benunskilled/bitcoin-lab/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/benunskilled/bitcoin-lab)](https://github.com/benunskilled/bitcoin-lab/releases)

Every new block reaches your node through one of your peers. Bitcoin Lab notes for every block who was first and ranks your peers by it.

Turn on Slot Fill and your node gets up to eight extra outgoing connections, to peers in places its own connections don't reach. It works without an open port, and Core keeps managing its regular peers. It is off on a fresh install.

Stratum Race times how fast your own pool turns a new block into fresh work, side by side with public solo pools. No miner needed, just a pool app on your Umbrel.

![Bitcoin Lab dashboard](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/overview.png?v=5)

## How Slot Fill works

Core spreads its regular peers over networks, and with asmap over providers, but not over the world. Slot Fill does: a free slot goes to the region where your node has the fewest connections, and to a provider it does not use yet, where it can tell. It picks the peer from Core's address book, and Core tries the connection. A peer that passes keeps its slot. Working peers and Core's own connections are never touched.

The padlock keeps a peer even when it goes offline. If you like, add the fast ones from the ranking yourself. [Details](docs/manual-slots.md)

## Reading the ranking

*First %* is the share of recent blocks a peer brought first, of those it was connected for: 3/102 means three of 102. A green address has brought at least one block first. ⚡ marks your high-bandwidth peers. Core picks up to three of them on its own, the ones that most recently brought it a new block, and asks them to send every new block straight away instead of announcing it first. That gives them a head start. 📡 is the other way round: a peer that picked your node as one of its high-bandwidth peers. Wallets, crawlers and other peers that can never be first are marked "never first", with the reason on hover.

## Who mined it, and your traffic

Under the newest block, Bitcoin Lab names the pool that mined it when it can tell, from a bundled pool list ([bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools), MIT). No outside service is asked.

A traffic panel shows how much your node sent and received, per day and over the last week and month, from Core's own counters.

## Stratum Race

Switch on Stratum Race and add your own pool. If GoBrrr, Bassin, Public Pool, DATUM or Pogolo runs on your Umbrel, Bitcoin Lab offers to add it for you. Eight public solo pools race alongside. No miner needed: install a pool app on your Umbrel and race your own node against the solo pools.

For every new block, the first pool to send fresh work sets the reference time and the others are timed against it. You see who wins, how far behind the rest are, and whether your own pool gets faster as you tune your setup. Bitcoin Lab connects like a miner but never submits shares, so no mining work goes to any pool. Stratum Race is off by default.

## Install

1. Add the [Bitcoin Peer Lab community store](https://github.com/benunskilled/bitcoin-lab-community-store) on Umbrel.
2. Install **Bitcoin Lab**. It requires the official **Bitcoin Node** app.
3. Open it from Umbrel or at `<your-umbrel>:8790`, and let it just watch for a day or so before you change anything, so you know your baseline.

Tested with Bitcoin Core 32.1.

Bitcoin Lab talks to Core through RPC and ZMQ. It changes live connections and the `addnode` list, nothing else: it never touches `bitcoin.conf`, wallets, keys or block files. Remove the app, and after its next restart Core runs as before: the manual peers live only in Core's memory.

## See the other half with Peer Map

[Peer Map](https://github.com/benunskilled/peer-map), in the same store, shows the same peers on a world map and makes a best guess at what each one really is. With both installed, it follows every new block across your node, and, if Stratum Race watches your own pool, all the way to its mining job.

## Documentation

| Guide | What you will find |
|---|---|
| [Manual slots](docs/manual-slots.md) | How Slot Fill picks, tests and frees a slot, and the padlock |
| [Peer scoring](docs/how-a-peer-is-judged.md) | First, Eligible, recent history and sample size |
| [Inbound peers](docs/inbound-peers.md) | Why Slot Fill never picks them |
| [Eclipse attacks](docs/eclipse.md) | Does choosing manual peers make one easier? |
| [Records from my node](docs/measured.md) | The numbers from before Slot Fill, and solo mining |
| [Architecture](docs/architecture.md) | Processes, storage and resource use |
| [Configuration](docs/configuration.md) | Environment variables and defaults |
| [Limitations](docs/limitations.md) | Measurement, networking and storage constraints |
| [Security](SECURITY.md) | Access boundaries and vulnerability reporting |

## Licence

MIT, see [LICENSE](LICENSE).
