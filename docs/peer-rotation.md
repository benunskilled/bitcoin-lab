# How peer rotation works

## Eight places for proven peers

Bitcoin Core provides eight manual connection slots in addition to its usual ten automatic outbound connections. Bitcoin Lab uses those eight slots to keep peers that have earned their place through measured block delivery.

**Your strongest peers are remembered across restarts.** When Core comes back online, Bitcoin Lab restores your saved manual selection so Core can reconnect to those peers straight away. You keep the set you have built instead of starting the search from scratch.

The automatic outbound connections keep the search moving. Once a candidate has been observed for at least 50 blocks without delivering any of them first, rotation disconnects it and Core immediately looks for a replacement. A peer that has delivered first at least once is spared by this rule.

This gives the two groups different jobs: the manual set holds on to proven peers, while the automatic connections keep introducing new candidates.

## Why 50 blocks?

A peer needs enough observations to show what it can do. But waiting too long means a strong candidate may disappear before Bitcoin Lab gets the chance to keep it.

The threshold used to be 144 blocks, roughly a day. On the author's node, a peer delivering 15% of blocks was observed for twenty hours, then dropped by Core before it became eligible for promotion.

The default is now 50 blocks, roughly eight hours. This gives promising peers an earlier chance to earn a manual slot and keeps the search moving when a candidate never delivers first.

An unlucky peer may occasionally be dropped despite having potential. Its history is preserved.

## Give new manual peers time to settle

A newly promoted peer gets a grace period of 50 blocks in its manual slot. During that time, rotation will not replace it with a stronger candidate.

The count starts at promotion. Without this fresh grace period, two closely ranked peers could repeatedly replace each other before either had time to establish its performance in the slot. That happened on the author's node: two peers traded the same place for hours.

The grace period prevents those unnecessary swaps. If the peer goes offline, the separate offline rules determine how long its slot stays reserved.

## A challenger needs a clear lead

Once all eight manual slots are filled, a new candidate has to beat the weakest eligible manual peer by a margin before rotation makes a swap. Protected peers and those still in their grace period are excluded.

The default margin is 0.2 points in the ranking score. This stops small changes in the ranking from triggering repeated swaps, while still allowing gradual improvements to an established set.

## Offline peers are parked, not forgotten

A good peer going offline does not immediately lose its place. Rotation gives it time to return, with the waiting period based on its delivery record.

By default, each percentage point of lifetime First earns one hour, with a minimum of one hour and a maximum of 24 hours. A peer with 5% First keeps its slot for five hours; one with 12% gets twelve.

Once that period ends, rotation parks the peer and frees its slot for another candidate. Its delivery history stays intact. Parked peers are checked periodically, and a reachable peer becomes eligible to compete for a manual slot again.

Protected peers keep their place and are never parked automatically.

## Stronger peers are worth checking for longer

Rotation spends more time trying to recover peers that have contributed more. Their delivery record determines how long they remain on the parked list and how often they are checked.

With the defaults, a peer with 5% lifetime First stays on that list for 25 days. One with 20% stays for 100 days, up to a maximum of 180 days.

Checks become less frequent after repeated failures. Strong performers are checked more often than peers with a weaker record, and only a few parked peers are checked per rotation pass.

## Protected peers stay your choice

Use the star to keep a peer in your manual selection regardless of its ranking. Rotation will neither replace it with a stronger candidate nor park it when it goes offline. Peers you type in are protected automatically.

Protection does not affect measurement or ranking. Click the star again whenever you want rotation to manage that peer's place.

If all eight manual peers are protected, rotation continues searching among automatic outbound connections, but cannot promote a candidate until you release a place.

## Why inbound connections stay untouched

A strong inbound peer has already opened a connection that works well for your node. Adding that host as a manual peer means opening an outgoing connection to its listening port. It does not preserve the original session.

On the author's node, a peer delivered blocks first through its inbound connection, using a temporary source port. A manual connection to the same host on port 8333 or 9333 never delivered first, even while both connections were active.

That experience shaped the rule: rotation measures inbound peers but leaves their connections alone. You can still add one manually if you choose.

## Give the search more candidates

For the best results, configure Core to use only clearnet for outgoing connections. Bitcoin Lab cannot keep Tor or I2P peers as manual connections. Slots occupied by those peers leave fewer places to discover candidates it can keep, slowing the optimisation.

On Umbrel: **Bitcoin Node → Settings → Outgoing Peer Connections**. Incoming Tor and I2P connections are fine.

## Follow the changes

The rotation log shows which peers were promoted, replaced, dropped or parked, with the most recent 30 actions kept for review.

The thresholds described here are defaults. See [Configuration](configuration.md) for the available settings.

---

[← Back to the README](../README.md)
