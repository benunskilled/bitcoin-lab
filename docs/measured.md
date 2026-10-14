# Records from my node

I run Bitcoin Core on Umbrel with `maxconnections=200`, accepting incoming connections over IPv4, IPv6, Tor and I2P – around 190 inbound peers at any time. On 16 September 2026 I started measuring from scratch. These are the records since then: 2,328 blocks up to 2 October.

## Finding the few that make a difference

Of 286 automatic outbound peers that were connected for at least 50 blocks, only 14 ever delivered a block first.

That is what makes the ongoing search useful. Core introduces new candidates; most never beat the connections already in place, but occasionally one earns a place among them.

A lower share for the inbound peers does not necessarily mean those peers became slower — they were competing against a stronger set.

## What I noticed while solo mining

After a week of rotation, I saw slightly fewer stale shares in my own mining setup. That gave the peer measurements a practical meaning: less work arriving too late to count.

These are observations from my setup. Your location, ISP and connections shape your results — and exploring those results is part of the appeal of running your own node.

---

[← Back to the README](../README.md)
