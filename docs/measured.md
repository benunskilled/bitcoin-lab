# Records from my node

I run Bitcoin Core on Umbrel with `maxconnections=200`. While I measured, it accepted incoming connections over IPv4, IPv6, Tor and I2P, around 190 inbound peers at any time. It no longer listens on IPv6. On 16 September 2026 I started measuring from scratch. These are the records since then: 2,328 blocks up to 2 October. The table below covers whole days up to 1 October.

## Who delivered first

At first I ran Core as it comes. Then I switched on rotation, which keeps proven outbound peers in the manual slots. On 25 September I restarted the node with the eight manual peers it had found.

![Who delivered each block first, per day](https://raw.githubusercontent.com/benunskilled/bitcoin-lab-community-store/main/bitcoinlab-node/delivery.png?v=2)

| Period | Manual peers | Inbound |
|---|---:|---:|
| Before rotation, 16–18 Sep | 0% | 98% |
| Rotation on, 19–25 Sep | 61% | 33% |
| After the restart, 25 Sep – 1 Oct | 82% | 16% |

The rest came from the outbound peers Core picked itself, between 1% and 6%.

Every manual peer was found by rotation among Core's own automatic outbound connections. Inbound peers were never touched.

The restart did not throw the gain away: Bitcoin Lab put the saved manual peers straight back, so the node was strong again right away.

## Finding the few that make a difference

Of 286 automatic outbound peers that were connected for at least 50 blocks, only 14 ever delivered a block first.

That is what makes the ongoing search useful. Core keeps bringing new candidates. Most never beat the connections already in place, but now and then one earns a place among them.

## What I noticed while solo mining

After a week of rotation, I saw slightly fewer stale shares in my own mining setup. That gave the peer measurements a practical meaning: less work arriving too late to count.

These are observations from my setup. Your location, ISP and connections shape your results, and finding out what they are is part of the fun of running your own node.

---

[← Back to the README](../README.md)
