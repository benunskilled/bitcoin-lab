# How a peer is judged

Not by ping.

A new block is picked up **only** from Core's ZMQ `pubhashblock` topic, and the
time is taken before anything else happens, so no RPC call and no database write
ever sits on the timing path. One `getpeerinfo` snapshot follows straight after.
Every peer connected at that moment counts as **Eligible**. The one that actually
delivered the block counts as **First**.

Not everything that counts as Eligible was ever in the running. A phone wallet,
a network crawler, an address indexer: software like that passes no blocks on at
all, so it can never be First, and a zero beside its name says nothing about its
quality. Those peers are marked in red rather than counted quietly among the
competition. Over 2,270 peers on this node, 688 ran software like that; between
them they produced 790 observations and not one first. Block-relay-only peers
are the opposite case and stay green — they refuse transactions and relay
blocks, which is exactly the job being measured.

The rank comes from the last 500 blocks — about three and a half days. Inside
that window the number is `First / Eligible`, but taken as a Wilson lower bound,
so a peer is ranked by what its record can prove rather than by what it happened
to do. A thin record is discounted, not ignored, and a peer that has not been
around for the whole window is judged on its lifetime for the part it missed.

Those are two different questions, kept apart on purpose: the 500-block window
asks how good this peer is *now*, and the Wilson bound asks how much evidence
there is for the answer.

The lifetime figures stay in the table. They just stopped deciding the order.

A peer is not acted on at all until it has been eligible through 50 blocks, which
is about eight hours. So for the first day the ranking is nearly empty and the
rotation, if you switched it on, does nothing. That is correct, not broken.


---

[← back to the README](../README.md)
