# Why rotation never promotes inbound peers

A strong inbound peer has already opened a connection that works well for your node. Adding that host as a manual peer means opening an outgoing connection to its listening port. It does not preserve the original session.

On my node, a peer delivered blocks first through its inbound connection, using a temporary source port. A manual connection to the same host on port 8333 or 9333 never delivered first, even while both connections were active.

That experience shaped the rule: rotation measures inbound peers but never promotes or replaces them. The one exception: if a host is already one of your manual peers, rotation drops its extra inbound session, so that peer's record is not split between two connections. You can still add one manually if you choose.

---

[← Back to the README](../README.md)
