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

![Bitcoin Lab dashboard](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/overview.png)

## Why it exists

A solo pool can only hand out new work once your node has the new block, and
your peers decide how soon that is. Connection count and ping do not show which
peers deliver first; Bitcoin Lab does. You do not need to mine to find that
interesting. [What changed on my node](docs/measured.md) tells the story behind
the project.

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

Bitcoin Lab can only keep clearnet peers as manual connections. If Core makes
its outgoing connections over clearnet only, every one of its ten automatic
outbound slots holds a possible candidate, and the rotation finds good peers
faster. On Umbrel: **Bitcoin Node → Settings → Outgoing Peer Connections**.
Incoming Tor and I2P connections are fine.

See [how peers are judged](docs/how-a-peer-is-judged.md) and [why the rotation works this way](docs/peer-rotation.md).

## What one node recorded

After a fresh start of the measurement on the author's node, inbound
connections delivered almost every block first. Rotation then filled the manual
slots with peers that had proved themselves:

![Who delivered each block first, per day](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/delivery.png)

In the 495 blocks from 22 September on, those few manual peers delivered 75% of
blocks first. Inbound connections, which had brought 98% of blocks first before
rotation, fell to 21%: rotation picked the manual peers for how often they
delivered first, and now they usually get there before the inbound ones. That
is the discovery behind the project: a small set of
connections can matter far more than its size suggests. The share moves from
day to day as peers come and go, and the figures show who delivered first on
one node, not a speed-up you can expect. [The full story and measurements.](docs/measured.md)

## Who mined it

Under the newest block, Bitcoin Lab names the pool that mined it. It matches the
coinbase against a bundled pool list
([bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools), MIT)
on your node, without asking any service. A miner that is not on the list is
shown by the text it wrote into the coinbase.

## What it costs in traffic

The Traffic card shows what your node sent and received today, over 7 and over
30 days, with a chart of the last 30 days. Below it are the hosts that cost the
most this week, next to how often they delivered a block first, so you can see
whether a peer earns its bandwidth. With Peer Map installed, each host opens in
Peer Map. A second Umbrel widget shows today's traffic on the home screen.

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

It is light on the node: on the author's Umbrel its four processes use about
80 MB of RAM together and less than 1% of one CPU core, and its database grows
by about 3 MB a day.

## See the other half with Peer Map

[Peer Map](https://github.com/benunskilled/peer-map) shows the same peers on a
world map, with their hosting providers and software. With both apps installed,
it follows each new block across your node: who mined it, which peers delivered
it and where they sit. If Stratum Race includes your own pool, it also takes the
block's whole route apart — from the first pool's job through your peer, Core and
the block template to your own pool's job — with the time each stretch takes. The last stretch also shows how many
transactions the template carried, because that is what your own pool's time
mostly depends on.

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
