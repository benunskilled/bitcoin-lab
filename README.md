# Bitcoin Lab

**Eight peers you picked will beat two hundred you did not.**

Bitcoin Lab watches which of your Bitcoin Core peers actually deliver each new
block first, keeps the ones that prove themselves, and — if you want it — times
how quickly mining pools turn those blocks into fresh work.

![Bitcoin Lab dashboard](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/5.png?v=1.16.1)

Over the last 500 blocks on my node:

| Who delivered the block first | Share |
|---|---|
| the eight manual peers Bitcoin Lab picked | 90% |
| Bitcoin Core's own ten outbound connections | 3% |
| around 190 inbound peers, none of them chosen by me | 7% |

Two hundred connections, and eight of them do the work. That is one node over
2,207 blocks rather than a benchmark — [what one node measured](docs/measured.md)
has the rest of the numbers, and the machine they came from.

Three moves follow from it: **keep** a peer that delivers, **drop** one that never
does — Core hands you a fresh random peer in its place, which is the engine of the
whole thing — and **protect** the ones you chose yourself. A switch on the
dashboard makes all three for you every ten minutes, and it stays off until you
ask for it.

## Install

**Umbrel.** Bitcoin Lab ships as an Umbrel Community App. The
[Bitcoin Peer Lab store](https://github.com/benunskilled/bitcoin-lab-community-store)
has the store URL and the steps — and, beside it,
[Peer Map](https://github.com/benunskilled/peer-map), which puts the same peers on
a world map and says what kind of software each one runs. Neither needs the other.

It needs Umbrel's **Bitcoin Node** app and reaches it only over RPC and ZMQ. It
never touches bitcoin.conf, wallet data, block data, or any other state Core
depends on. The dashboard is then at `<your-umbrel>:8790`.

**Anywhere else.** A Docker Compose stack — see [docs/install.md](docs/install.md).

## More about it

| | |
|---|---|
| [What one node measured](docs/measured.md) | the numbers, and the machine behind them |
| [Is it worth it?](docs/is-it-worth-it.md) | the solo-mining case, and when there is none |
| [How a peer is judged](docs/how-a-peer-is-judged.md) | ZMQ timing, First and Eligible, the Wilson bound |
| [What you can do about it](docs/what-you-can-do.md) | the three moves, and the eight slots Core never uses |
| [Peer rotation](docs/peer-rotation.md) | the loop, and why every threshold is where it is |
| [Stratum Race](docs/stratum-race.md) | timing your own pool against the public ones |
| [Architecture](docs/architecture.md) | four processes, one SQLite file, what it costs to run |
| [Configuration](docs/configuration.md) | every environment variable |
| [Known limitations](docs/limitations.md) | what this does not measure and cannot tell you |
| [Security](SECURITY.md) | what it can reach, and how to report something |

## Licence

MIT — see [LICENSE](./LICENSE).
