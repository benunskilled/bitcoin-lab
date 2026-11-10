# Manual slots

Core keeps up to eight manual connections on top of its own outbound peers. It never fills them by itself. Slot Fill does, and you can too.

## How a slot is filled

Slot Fill looks every ten minutes, and every minute while a candidate is being tested. If a slot is free, it picks a candidate:

- **The region with the fewest connections goes first.** The regions are the six continents, Tor and I2P. Core's connected outbound peers count, and so do your saved manual peers, offline ones included. Within a region, a country the manual peers do not have yet goes first.
- **No provider your node already uses**, by Core's own outbound peers or a manual one, where the bundled table can tell the provider. Tor and I2P peers have none, so they never clash. Peers you add yourself may share one.
- **Tor and I2P only if Core uses them**, meaning Core may connect over that network and holds an outbound connection over it right now. Where clearnet works, your node keeps at most one Tor and one I2P connection, Core's own counted. A node that uses only Tor gets only Tor peers, all eight if need be.
- **From Core's address book.** First from the addresses Core has connected to before. If a region with no connection at all has none there that the provider rule lets in, from addresses other peers reported as seen within the last day. Without Core's `getrawaddrman`, Slot Fill picks no one. Banned addresses are skipped, and so is any address that failed a trial in the last week.

## How a candidate is tested

One candidate at a time. It takes the slot as "testing": Bitcoin Lab adds it with `addnode`, and Core has a few minutes to connect to it: 5 for a normal address, 10 for Tor, 15 for I2P. The peer has to offer blocks and segwit, and it has to have announced your chain's tip. If it does, it keeps the slot. If not, it is taken out and the next one is tried right away.

Slot Fill never swaps a working manual peer for another, and it never touches Core's own connections.

## When a slot comes free

- You remove a manual peer.
- A manual peer without the padlock stays offline for an hour, or for a day if it ever brought a block first. This only happens while Slot Fill is on.

## The padlock

A locked peer keeps its slot even while it is offline, once Core has connected to it as a manual peer. Every peer you add by hand gets the padlock, typed in or with **Add as Manual** in the ranking, and so do peers already set in Umbrel's Bitcoin Node settings. With all eight locked, Slot Fill cannot add anyone.

If all eight slots are taken when you add a peer by hand, it replaces the unlocked peer the spread misses least: one from the new peer's own region, otherwise one from a region your node reaches more than once, Core's own peers counted too, then any other. Tor and I2P go last. Within each step the lowest score goes. A peer added in the last 50 blocks is not replaced, and if no peer may go, the add is refused. If Core is already connected to the new peer some other way, that connection is dropped so Core dials it again as a manual peer.

## After a restart

When Core or Bitcoin Lab restarts, Bitcoin Lab hands all saved manual peers back to Core, which connects to them again, so your node does not start from scratch.

## The log

The Slot Fill log keeps the last 30 entries: a peer added or removed by Slot Fill, and a peer added, removed or disconnected by hand.

---

[← Back to the README](../README.md)
