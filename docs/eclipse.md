# Does choosing manual peers make an eclipse attack easier?

Not that I can see. An eclipse attack needs every one of your node's connections. Slot Fill only adds manual peers on top of Core's own outbound peers and leaves those in place. How much the extra peers help against an eclipse depends on who runs them and on the paths to them.

Candidates come first from addresses Core has connected to itself, which takes more than gossip. For a region your node has no connection to and no such address in, Slot Fill takes one other peers reported. That is a rule for spreading, not a security check: being in Core's address book says nothing about whether a peer can be trusted.

Manual connections are exempt from Core's rule that spreads its outbound peers over network groups. Slot Fill keeps its own spread instead: the region with the fewest connections first, and no provider your node already uses where it can tell.

Your node still checks every block it receives, so a bad peer cannot make it accept an invalid one. What checking cannot do is show your node a block that never reaches it.

---

[← Back to the README](../README.md)
