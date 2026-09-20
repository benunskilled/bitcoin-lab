# What changed on my node

I run Bitcoin Core on Umbrel with `maxconnections=200`, accepting incoming connections over IPv4, IPv6, Tor and I2P. Bitcoin Lab helped me see which of those connections actually brought new blocks first.

In a recorded 500-block window, the eight manual peers selected by Bitcoin Lab delivered 90% of blocks first. Core's ten automatic outbound connections accounted for 3%, and around 190 inbound connections for 7%.

Core had introduced me to every one of those eight manual peers. Bitcoin Lab's job was to recognise the good ones and keep them.

## Finding the few that make a difference

Across 2,207 recorded blocks, 1,982 reached my node first through a manual peer. Of 275 automatic outbound peers observed long enough to be judged, only 19 ever delivered a block first.

That is what makes the ongoing search useful. Core introduces new candidates; most never beat the connections already in place, but occasionally one earns a place among them.

The inbound peers still contribute. Their share of first deliveries fell from 15% in the first 500 recorded blocks to 7% in the later window as the manual selection improved. A lower share does not necessarily mean those peers became slower — they were competing against a stronger set.

## What I noticed while solo mining

After a week of rotation, I saw fewer stale shares in my own mining setup. That gave the peer measurements a practical meaning: less work arriving too late to count.

Bitcoin Lab shows which peers deliver first. Stratum Race adds a comparison with public pools, letting me follow whether my own pool improves as the peer selection changes.

These are observations from my setup. Your location, ISP and connections shape your results — and exploring those results is part of the appeal of running your own node.

## A set of peers worth keeping

Several of my manual peers regularly deliver first. That is what I want to build: a group of connections that contribute, rather than relying on one standout peer.

Peer Map adds another view of that set, showing how the connections are spread across regions and hosting providers. Bitcoin Lab shows their delivery record; Peer Map helps me understand their distribution.

You do not need to mine to enjoy that process. Watching a new candidate prove itself, earn a manual slot and return after a restart is rewarding in its own right.

---

[← Back to the README](../README.md)
