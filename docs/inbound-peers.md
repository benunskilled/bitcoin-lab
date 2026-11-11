# Why Slot Fill never picks inbound peers

Slot Fill takes its candidates from Core's address book, never from the peers that connected to you. An inbound peer dialled in from a temporary port. Making it a manual peer means a new outgoing connection to its listening port, if it has one, and not the session that worked.

On my node, a peer delivered blocks first through its inbound connection. A manual connection to the same host on port 8333 or 9333 never delivered first, even while both were up.

Inbound peers are still ranked, and you can add one by hand.

---

[← Back to the README](../README.md)
