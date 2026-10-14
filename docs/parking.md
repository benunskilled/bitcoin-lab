# Offline peers are parked, not forgotten

A good peer going offline does not immediately lose its place. Rotation gives it time to return, with the waiting period based on its delivery record.

By default, each percentage point of lifetime First earns one hour, with a minimum of one hour and a maximum of 24 hours. A peer with 5% First keeps its slot for five hours; one with 12% gets twelve.

Once that period ends, rotation parks the peer and frees its slot for another candidate. Its delivery history stays intact. Parked peers are checked periodically, and a reachable peer becomes eligible to compete for a manual slot again.

Protected peers keep their place and are not parked when they go offline. The one exception is an address Core has never managed to hold as a manual connection: after its waiting period, it is parked like any other, so an address that does not work cannot block a slot for good.

## Stronger peers are worth checking for longer

Rotation spends more time trying to recover peers that have contributed more. Their delivery record determines how long they remain on the parked list and how often they are checked.

With the defaults, a peer with 5% lifetime First stays on that list for 25 days. One with 20% stays for 100 days, up to a maximum of 180 days.

Checks become less frequent after repeated failures. Strong performers are checked more often than peers with a weaker record, and only a few parked peers are checked per rotation pass.

When a parked peer answers again and beats the weakest manual peer, the two change places. The peer that makes room is parked only if it is offline itself; one that is still connected simply goes back to competing as a candidate.

The thresholds described here are defaults. See [Configuration](configuration.md) for the available settings.

---

[← Back to the README](../README.md)
