# How peers are ranked

## First and Eligible

Bitcoin Lab records what happens each time a new block reaches your node. Two numbers form the basis of every peer's record:

- **Eligible:** How many block arrivals the peer was connected for.
- **First:** How many times it was credited with delivering the block first.

**First %** is First divided by Eligible. A peer that delivered first for 20 of its 100 observed blocks has a First rate of 20%.

This measures how often a peer wins against the other connections on your node. The ranking then considers both that performance and how much evidence supports it.

The ranking focuses on the last 500 blocks, so a peer that used to perform well cannot keep its place indefinitely on old results. For peers with fewer observations in that window, lifetime performance fills in the missing history.

## Give the evidence some weight

A peer that wins two of its first ten blocks has a 20% First rate. That looks better than a peer with 75 wins across 500 blocks at 15%, but the second has a much stronger track record.

Bitcoin Lab uses the lower bound of a Wilson confidence interval to account for that difference. In practical terms, a high percentage needs enough observations behind it to earn a high rank.

That is why the order in the table can differ from the raw First percentages: the score considers both the results and the evidence supporting them.

## How block delivery is observed

Bitcoin Lab listens for new blocks through Core's ZMQ interface and records the arrival time immediately. It then checks Core's peer information to identify which connection delivered the new block.

Core updates a peer's `last_block` timestamp when it processes a newly accepted block from that peer. Later copies of the same block from other peers do not update their timestamps. Bitcoin Lab matches this signal to the block event to record First.

Two peers can both be credited: Core notes each peer's last new block only to the second, so Bitcoin Lab credits every peer whose time falls within a short window around the arrival – if another peer's falls there too, both get a First. On my node that happened once in 2,328 blocks (0.04%), and no block was left uncredited. Your own count stands in the dashboard's status line.

Blocks your node fetches while catching up after being offline are not counted: they arrive several a second from many peers and say nothing about who relays a new block quickly.

Core itself favours peers that have just been fast. Under BIP152, it asks up to three peers that recently delivered a new block first to send the next one straight away, without waiting to be asked. A peer that is already ahead keeps that edge more easily – part of why a good manual peer tends to stay good, and why a new candidate needs a few blocks before it shows what it can do.

This builds a record of which connections actually bring new blocks to your node first.

## Not every connection serves the same purpose

Wallets, crawlers and indexers connect to your node for different reasons. They are not necessarily there to deliver blocks, so a zero First rate does not mean they are failing at their job.

Bitcoin Lab marks software categories that are not expected to relay blocks.

## From ranking to selection

The ranking updates as new blocks arrive. With rotation enabled, Bitcoin Lab uses these scores to choose candidates for your manual slots.

See [How peer rotation works](peer-rotation.md) for promotion rules, grace periods and protected peers.

---

[← Back to the README](../README.md)
