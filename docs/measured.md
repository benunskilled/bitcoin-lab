# Records from my node

I run Bitcoin Core on Umbrel with `maxconnections=200`, accepting incoming connections over IPv4, IPv6, Tor and I2P – around 190 inbound peers at any time. On 16 September 2026 I started measuring from scratch. These are the records since then: 2,328 blocks up to 2 October.

![Who delivered each block first, per day](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/delivery.png?v=2)

| Period | Blocks | Manual peers¹ | Core's outbound | Inbound |
|---|---:|---:|---:|---:|
| Before rotation, 16–18 Sep | 331 | 0% | 2% | 98% |
| Rotation on, 19 Sep to the restart on 25 Sep | 930 | 61% | 6% | 33% |
| Restart with 8 manual peers, 25 Sep – 1 Oct | 907 | 82% | 1% | 16% |

¹ Every manual peer was found by rotation among Core's own automatic outbound connections. None is an inbound connection turned into a manual one – rotation leaves inbound peers alone.

Core had introduced me to every one of those eight manual peers. Bitcoin Lab's job was to recognise the good ones and keep them.

## Finding the few that make a difference

Of 286 automatic outbound peers that were connected for at least 50 blocks, only 14 ever delivered a block first.

That is what makes the ongoing search useful. Core introduces new candidates; most never beat the connections already in place, but occasionally one earns a place among them.

The inbound peers still contribute. Their share of first deliveries fell from 98% to 16% as the manual selection improved. A lower share does not necessarily mean those peers became slower — they were competing against a stronger set.

## What I noticed while solo mining

After a week of rotation, I saw slightly fewer stale shares in my own mining setup. That gave the peer measurements a practical meaning: less work arriving too late to count.

Bitcoin Lab shows which peers deliver first. Stratum Race adds a comparison with public pools, letting me follow whether my own pool improves as the peer selection changes.

These are observations from my setup. Your location, ISP and connections shape your results — and exploring those results is part of the appeal of running your own node.

## A set of peers worth keeping

Several of my manual peers regularly deliver first. That is what I want to build: a group of connections that contribute, rather than relying on one standout peer.

[Peer Map](https://github.com/benunskilled/peer-map) adds another view of that set, showing how the connections are spread across regions and hosting providers. Bitcoin Lab shows their delivery record; Peer Map helps me understand their distribution.

You do not need to mine to enjoy that process. Watching a new candidate prove itself, earn a manual slot and return after a restart is rewarding in its own right.

---

[← Back to the README](../README.md)
