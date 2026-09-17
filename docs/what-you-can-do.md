# What you can do about it

Three moves. Make them yourself on the dashboard, or switch the rotation on and
let it make them for you.

- **Keep a good peer.** It goes in through `addnode`, so Core holds on to it
  instead of rotating it away.
- **Drop a peer that never delivers.** Core replaces a dropped *outbound*
  connection immediately with a fresh random one, which then gets measured like
  everyone else. That replacement is the engine of the whole thing.
- **Protect a peer.** Anything you type in by hand comes in protected — that is
  the star in the peer list — and the rotation leaves it alone: never swapped out
  for a better peer, never parked when it goes offline. Click the star to release
  it. It is still measured and still ranked, it is only exempt from being
  replaced.

Core allows eight manual connections at once (`MAX_ADDNODE_CONNECTIONS`). They
are not slots you take from somebody; they are connections you already could have
and are not using — on nearly every node all eight sit empty, because Core never
uses `addnode` on its own. With all eight filled you have 18 outbound connections
and you chose eight of them.

Inbound peers are ranked too, and the rotation leaves them alone. Keeping one
means dialling out to the port it listens on and dropping the session it opened,
so the connection that earned the record is gone and what replaces it starts at
zero — which, on this node, then delivered nothing. You can still add one by
hand, and the button does the port probe for you. That is a decision made with
the number in front of you, which is a different thing from a loop making it.


---

[← back to the README](../README.md)
