# Bitcoin Lab

[![Tests](https://github.com/benunskilled/bitcoin-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/benunskilled/bitcoin-lab/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/benunskilled/bitcoin-lab)](https://github.com/benunskilled/bitcoin-lab/releases)

Every new block reaches your node through one of your peers. Some peers are first again and again, others never. Bitcoin Lab notes for every block who was first and ranks your peers by it. Keep the fast ones as manual peers, drop the ones that never deliver and get fresh ones to rank, or let rotation do it for you.

Rotation only works on the outbound peers Core picks for you. Inbound peers are ranked too, but never kept or dropped automatically. Many of them don't accept connections at all, and the port you see is only the one they called from, so there is no address to dial back.

Mining solo? Stratum Race times how fast your own pool turns a new block into fresh work, side by side with public pools.

![Bitcoin Lab dashboard](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/overview.png?v=2)

## Why it matters

Core picks its peers at random and keeps them as long as they behave, without checking whether they are fast. For most nodes that is fine. If you mine solo, it matters: your pool can only hand out new work once your node has the block, and until then your miner keeps working on a block someone else already found.

## What I saw on my node

My node has an open port, so many peers connect to it. Before rotation, nearly every block came first through one of those inbound peers. A few days after I switched rotation on, the outbound peers it kept as manual peers brought most blocks first. After a restart, Bitcoin Lab puts all eight manual peers straight back, so your node does not start from scratch.

![Who delivered each block first, per day](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/delivery.png?v=2)

[The numbers, and what I noticed while solo mining.](docs/measured.md)

## How rotation works

Core has eight manual slots that it never fills on its own, so on most nodes they sit empty. Bitcoin Lab puts them to work:

1. **Watch.** See which peers bring each new block first.
2. **Keep.** Put a proven peer into a [manual slot](docs/manual-slots.md). Core holds on to it, and Bitcoin Lab puts it back after a restart.
3. **Keep looking.** Drop an automatic outbound peer that has gone [50 blocks](docs/why-50-blocks.md), roughly eight hours, without being first. Core finds a new one to try.

Core's two block-relay-only peers are ranked but left alone. They are there to guard against eclipse attacks.

![Peer rotation: from one kept peer to a full manual set](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/rotation.gif)

*Rotation as an animation, from a single kept peer to a full manual set. Simulated peers, the real rules. [Watch the full video](https://github.com/user-attachments/assets/72281912-4d8e-4498-bece-fb6cc5080155).*

You can do all of this by hand, or switch rotation on. **It is off by default.** The ranking [favours recent blocks and distrusts small samples](docs/how-a-peer-is-judged.md). A new peer gets a [grace period](docs/grace-period.md), a challenger needs a [clear lead](docs/swap-margin.md), and good peers that go offline are [parked](docs/parking.md) and tried again later. Peers you add yourself, here or in Umbrel's Bitcoin Node settings, are [protected](docs/protected-peers.md), and the padlock lets you change that. The rotation log shows every peer it kept, dropped or parked. Worried that choosing peers makes an eclipse attack easier? [Not that I can see.](docs/eclipse.md)

Bitcoin Lab can only keep clearnet peers. Rotation finds good ones faster if Core makes its outgoing connections over clearnet only. On Umbrel: **Bitcoin Node → Settings → Outgoing Peer Connections**. Incoming Tor and I2P connections are fine.

## Reading the ranking

A green address has brought at least one block first. ⚡ marks your high-bandwidth peers. Core picks up to three of them on its own, the ones that most recently brought it a new block, and asks them to send every new block straight away instead of announcing it first. That gives them a head start. 📡 is the other way round: a peer that picked your node as one of its high-bandwidth peers. Wallets, crawlers and other peers that can never be first are marked "never first", with the reason on hover.

## Who mined it, and your traffic

Under the newest block, Bitcoin Lab names the pool that mined it, from a bundled pool list ([bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools), MIT). No outside service is asked.

A traffic panel shows how much your node sent and received, per day and over the last week and month, from Core's own counters.

## Stratum Race

Switch on Stratum Race and add your own pool. If GoBrrr, Bassin, Public Pool, DATUM or Pogolo runs on your Umbrel, Bitcoin Lab offers to add it for you. Eight public solo pools race alongside.

For every new block, the first pool to send fresh work sets the reference time and the others are timed against it. You see who wins, how far behind the rest are, and whether your own pool gets faster as you tune your setup. Bitcoin Lab only listens: it never submits shares, so no mining work goes to any pool. Stratum Race is off by default.

## Install

Add the [Bitcoin Peer Lab community store](https://github.com/benunskilled/bitcoin-lab-community-store) on Umbrel and install **Bitcoin Lab**. It requires the official **Bitcoin Node** app. Tested with Bitcoin Core 31.1. Open it from Umbrel or at `<your-umbrel>:8790`.

Let it just watch for a day or so before you change anything, so you know your baseline.

Bitcoin Lab talks to Core through RPC and ZMQ. It changes live connections and the `addnode` list, nothing else: it never touches `bitcoin.conf`, wallets, keys or block files. Remove the app and Core runs on as before.

## See the other half with Peer Map

[Peer Map](https://github.com/benunskilled/peer-map), in the same store, shows the same peers on a world map and makes a best guess at what each one really is. With both installed, it follows every new block across your node, and, if Stratum Race watches your own pool, all the way to its mining job.

## Documentation

| Guide | What you will find |
|---|---|
| [Records from my node](docs/measured.md) | The numbers, and the experience of solo mining |
| [Peer scoring](docs/how-a-peer-is-judged.md) | First, Eligible, recent history and sample size |
| [Manual slots](docs/manual-slots.md) | The eight places for proven peers, kept across restarts |
| [Why 50 blocks?](docs/why-50-blocks.md) | When rotation drops a candidate that never delivers first |
| [Grace period](docs/grace-period.md) | Why a newly promoted peer is left alone for a while |
| [Clear lead](docs/swap-margin.md) | The margin a challenger needs to take a slot |
| [Parking](docs/parking.md) | What happens to good peers that go offline |
| [Protected peers](docs/protected-peers.md) | The padlock, and peers already set in Core |
| [Inbound peers](docs/inbound-peers.md) | Why rotation never promotes them |
| [Eclipse attacks](docs/eclipse.md) | Does choosing peers make one easier? |
| [Architecture](docs/architecture.md) | Processes, storage and resource use |
| [Configuration](docs/configuration.md) | Environment variables and defaults |
| [Limitations](docs/limitations.md) | Measurement, networking and storage constraints |
| [Security](SECURITY.md) | Access boundaries and vulnerability reporting |

## Licence

MIT, see [LICENSE](LICENSE).
