# Does choosing manual peers make an eclipse attack easier?

Not that I can see. An eclipse attack needs every one of your node's connections. Slot Fill only adds manual peers on top of Core's own outbound peers and never touches those, so Core's own defences stay as they are.

Candidates come first from addresses Core has connected to itself, which takes more than gossip. For a region your node has no connection to and no such address in, Slot Fill takes one other peers reported, at most one per region. Planted addresses could at most win one slot in each region your node had no other candidate for, and never one of Core's own connections.

Manual connections are exempt from Core's rule that spreads its outbound peers over network groups. Slot Fill keeps its own spread instead: the region with the fewest connections first, and no provider your node already uses.

Your node still checks every block it receives, so a bad peer cannot make it accept an invalid one.

---

[← Back to the README](../README.md)
