# Bitcoin Lab

**Find the peers that bring you new blocks first. Keep the ones that earn their place.**

Your Bitcoin node may have hundreds of connections. Which ones actually get a
new block to you before the rest?

Bitcoin Lab watches your node, ranks its peers by their observed block delivery,
and helps you build a better set of connections over time. If you run your own
mining pool, the optional Stratum Race compares when fresh work arrives from
your pool and public pools.

Built for Bitcoin enthusiasts who enjoy understanding their setup, trying things
out and seeing what makes a difference on their own node.

![Bitcoin Lab dashboard](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/5.png?v=1.16.1)

## Why it exists

For solo miners using their own node, early block delivery matters: your pool
needs to learn about the new chain tip before it can give miners work on top of
it. Your choice of peers is one part of that path you can influence.

Connection count and ping only tell part of the story. Bitcoin Lab shows you which peers actually deliver each new block first.

There is plenty to explore even if you do not mine: discover your regular block
deliverers, watch new candidates earn their place and see how your peer set
changes over time. [What changed on my node](docs/measured.md) shares the experience behind the project, from choosing peers to solo mining.

## From random connections to a chosen set

Bitcoin Core chooses automatic outbound peers from its address book. Bitcoin Lab
uses those connections to discover candidates for the eight manual connections
available through Core's `addnode` interface.

The loop is straightforward:

1. **Observe.** See which peers deliver each new block first.
2. **Keep good candidates.** Add proven peers to your manual selection so Core maintains connections to them. Bitcoin Lab remembers your selection across restarts and restores it when Core comes back online, so it can reconnect to your chosen peers straight away.
3. **Keep looking.** Disconnect an automatic outbound peer that has had enough opportunities but has never been first. Core will immediately look for another candidate to take its place.

You can manage peers yourself or enable rotation to run this loop automatically. **Rotation is off by default.** Peers you type in are protected from automatic replacement; the star lets you change that protection.

The ranking favours recent performance and discounts small samples. By default, rotation waits for 50 block observations before judging a candidate, and newly promoted peers get their own grace period. With rotation enabled, good peers that go offline will be parked and checked again later, with their history preserved.

**Rotation only manages outgoing connections.** Inbound peers are measured and ranked, but left untouched.

For the best results, configure Bitcoin Core to use only clearnet for outgoing connections. Bitcoin Lab cannot keep Tor or I2P peers as manual connections, so outbound slots occupied by them reduce the number of candidates it can find and keep, slowing the optimisation.

On Umbrel: **Bitcoin Node → Settings → Outgoing Peer Connections**. Incoming Tor and I2P connections are fine.

See [how peers are judged](docs/how-a-peer-is-judged.md) and [why the rotation works this way](docs/peer-rotation.md).

## What one node recorded

In a documented 500-block window on the author's node:

| Connection group | Share of recorded first deliveries |
|---|---:|
| Eight selected manual peers | 90% |
| Core's ten automatic outbound connections | 3% |
| Around 190 inbound connections | 7% |

Eight chosen peers accounted for nine out of ten first deliveries in that
window. That is the discovery behind the project: a small set of connections
can contribute far more than its size suggests.

The figures describe who delivered first on one node, rather than an absolute
speed improvement. Your location, routing and peers make your own results worth
exploring. [Read the full story and measurements.](docs/measured.md)

## Who mined it

Every block names its miner, if you look. The coinbase transaction carries the
address the reward is paid to and a short text the miner writes into it. Bitcoin
Lab matches both against a pool list that ships with the app
([bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools), MIT)
and puts the pool's name under the height of the newest block.

The lookup happens on your node, from the block Core just handed it — no service
is asked. A miner nobody has listed stays unnamed: Bitcoin Lab then shows the
text out of the coinbase in quotes rather than putting a name on it. That is the
normal answer for a solo finder, and for a pool the list has not caught up with.

## Compare your pool with Stratum Race

Enable Stratum Race to compare new mining jobs as they arrive from your own pool and eight preconfigured public solo pools. Templates help with adding your local GoBrrr, Bassin or Public Pool.

For each new block hash reported in a job, the first pool sets the reference time. The others are measured against it. The dashboard shows wins, latency statistics and missed races, giving you a way to follow whether your own pool improves as you change your setup.

Stratum Race is off by default on a fresh install. Enable it whenever you want to start comparing pools. It subscribes to the pools without submitting mining shares, so you can observe the race without directing any mining work to them.

## Install

On **Umbrel**, add the
[Bitcoin Peer Lab community store](https://github.com/benunskilled/bitcoin-lab-community-store)
and install **Bitcoin Lab**. It requires the official **Bitcoin Node** app.
Open it from Umbrel or at `<your-umbrel>:8790`.

Start by watching a few blocks arrive and getting to know the ranking. It grows more useful as observations accumulate. The default 50-block threshold gives rotation roughly eight hours of evidence before it judges a candidate. You can switch rotation on when you are ready.

Bitcoin Lab communicates with Core through RPC and ZMQ. Peer-management actions change live connections and the runtime `addnode` list. It does not edit `bitcoin.conf` or access wallet files, private keys or Core's block files. Remove the app and Core continues running on its own, with its configuration untouched.

## See the other half with Peer Map

[Peer Map](https://github.com/benunskilled/peer-map) puts your peers on a world map and shows their locations, hosting providers, software and advertised services. See at a glance how your peers are spread across regions and providers. Use it alongside Bitcoin Lab to see who delivers your blocks and how your chosen peers are distributed. Both apps work independently. With both installed, Peer Map follows the newest block across your node: who mined it, which peers delivered it and where they sit.

## Documentation

| Guide | What you will find |
|---|---|
| [What changed on my node](docs/measured.md) | Peer-selection results and the experience of solo mining |
| [Peer scoring](docs/how-a-peer-is-judged.md) | First, Eligible, recent history and sample size |
| [Rotation](docs/peer-rotation.md) | Selection, grace periods, parking and connection handling |
| [Architecture](docs/architecture.md) | Processes, storage and resource use |
| [Configuration](docs/configuration.md) | Environment variables and defaults |
| [Limitations](docs/limitations.md) | Measurement, networking and storage constraints |
| [Security](SECURITY.md) | Access boundaries and vulnerability reporting |

## Licence

MIT — see [LICENSE](LICENSE).
