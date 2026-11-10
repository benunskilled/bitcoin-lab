# Manual slots

Core keeps up to eight manual connections on top of its own outbound peers. It never fills them by itself. Slot Fill does, and you can too.

## How a slot is filled

Slot Fill looks every ten minutes. If a slot is free, it picks a candidate:

- **The region with the fewest connections goes first.** The regions are the six continents, Tor and I2P, and Core's own outbound peers count as much as the manual ones. Within a region, a country the manual peers do not have yet goes first.
- **No provider your node already uses**, by Core's own outbound peers or a manual one. Tor and I2P peers have no provider, so they never clash. Peers you add yourself may share one.
- **Tor and I2P only if Core uses them**, meaning Core may connect over that network and holds an outbound connection over it right now. A node that uses only Tor gets only Tor peers, all eight if need be.
- **From Core's address book.** First from the addresses Core has connected to before. If a region with no connection at all has none there, from addresses other peers reported as seen within the last day. Banned addresses are skipped, and so is any address that failed a trial in the last week.

## How a candidate is tested

One candidate at a time. Bitcoin Lab adds it with `addnode`, and Core has about 15 to 20 minutes to hold a connection to it. The peer has to offer blocks and segwit, and it has to have announced your chain's tip. If it does, it keeps the slot. If not, it is taken out and the next one is tried. An address Core has only heard of and cannot connect to at all is given up at the next look, after ten minutes.

Slot Fill never swaps a working manual peer for another, and it never touches Core's own connections.

## When a slot comes free

- You remove a manual peer.
- A manual peer without the padlock stays offline for an hour, or for a day if it ever brought a block first. This only happens while Slot Fill is on.

## The padlock

A locked peer keeps its slot even while it is offline, once Core has connected to it as a manual peer. Peers you type in, and peers already set in Umbrel's Bitcoin Node settings, get the padlock. With all eight locked, Slot Fill cannot add anyone.

**Add as Manual** in the ranking adds a peer without the padlock. If all eight slots are taken, it replaces the unlocked peer the spread misses least: one from the new peer's own region, otherwise one from a region your node reaches more than once, Core's own peers counted too, then any other. Tor and I2P go last. Within each step the lowest score goes. A peer added in the last 50 blocks is not replaced, and if no peer may go, the add is refused. If Core is already connected to the new peer some other way, that connection is dropped so Core dials it again as a manual peer.

## After a restart

When Core or Bitcoin Lab restarts, Bitcoin Lab puts all manual peers straight back, so your node does not start from scratch.

## The log

The Slot Fill log keeps the last 30 entries: a peer added or removed by Slot Fill, a peer added by hand and a peer disconnected by hand.

---

[← Back to the README](../README.md)
