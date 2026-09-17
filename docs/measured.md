# What one node measured

Every number in this project comes from one machine. This is that machine, and
what it recorded.

Over the last 500 blocks on my node:

| Who delivered the block first | Share |
|---|---|
| the eight manual peers Bitcoin Lab picked | 90% |
| Bitcoin Core's own ten outbound connections | 3% |
| around 190 inbound peers, none of them chosen by me | 7% |

Two hundred connections, and eight of them do the work. By the usual way of
counting that is a well-connected node. It is not one, and until this app I had
no way of telling which eight mattered.

Not because the other hundred and ninety are useless. Because they are outrun —
every block has exactly one first, so take the eight away and somebody in that
crowd is first instead. My node has been in both states: over the first 500
blocks it ever recorded, when the manual set was still a rough draft, the inbound
crowd took 15% of them. Now it takes 7%. What changed is not them.

More connections do give you more chances, and I am not claiming they are
worthless. Over my whole record the peers that dialled in delivered 7.4% of
blocks, most of it from before the eight were curated, when there was still
something left for them to win. It is a real effect. It is just a small one next
to picking eight peers on evidence.

The count is not what gets you to the front. The choosing is.

My eight manual slots, at the 1,882-block mark. My node listens, so these eight
compete with everything that dials in:

```
             First % (last 500)     ping
peer 1          46.8 %   234/500    15 ms
peer 2          11.2 %    56/500    34 ms
peer 3          14.3 %    14/98     20 ms
peer 4           8.4 %    42/500   100 ms
peer 5           7.2 %    36/500    17 ms
peer 6           7.2 %    36/500    17 ms
peer 7           6.8 %    34/500    19 ms
peer 8           2.2 %    11/500   106 ms
```

The order is not the raw percentage you can read off it. Peer 3 shows 14.3%, more
than peer 2's 11.2%, but it has 98 blocks of record against 500 — and once both
are taken as Wilson bounds, peer 2 comes out at 8.73 against peer 3's 8.70. That
is the whole idea in one row.

Over the whole record, 1,982 of 2,207 blocks — almost nine in ten — reached me
through a manual peer. Core connected me to every one of the current eight at
some point; the measurement decided which of them stayed. Of 275 random outbound
peers that stayed long enough to be judged, 19 ever delivered a block first.
Finding those few before Core rotates them away is the job.

What you want out of this is not one great peer kept forever. Blocks are not
found in one place, and a peer that sits next to a large miner in one country is
no use when the next block turns up on the other side of the world. You want a
set where *several* peers deliver, from different directions. One peer in ten
delivering just means the other nine are slower.

The ping column is there because people expect it, not because it decides
anything. Where a peer sits relative to where blocks are made is what counts — a
100 ms peer can beat a 17 ms one — and a peer that sits well today will probably
still sit well tomorrow.

**Where these numbers come from.** One node: a first-generation Lenovo ThinkCentre
with an i7, running Umbrel, listening on IPv4 and IPv6 with Tor and I2P switched
on, `maxconnections=200`. Not a controlled study, and not a promise about your
node.

It is worth knowing which way that cuts. Two hundred connections — and a fair
share of them wallets, crawlers and research scanners that never relay a block
to anybody. The comparison that counts is Core's own ten outbound peers: real
nodes, picked at random, doing the same job. They delivered 3%. The eight I
picked took almost nine in ten. A node
with no forwarded port has ten outbound connections and few inbound ones — fill
the eight manual slots there and that becomes eighteen, eight of them chosen on
evidence. The same eight slots count for more, not less. I cannot measure that
second node from here. A friend runs this on a node without a forwarded port and
is happy with it.


---

[← back to the README](../README.md)
