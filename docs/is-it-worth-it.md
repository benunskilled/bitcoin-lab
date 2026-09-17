# Is it worth it?

If you solo mine against your own node, your pool cannot hand out work on a new
block until your node knows the block exists. Every millisecond before that, your
miner is grinding on a block that is already solved.

So the number that matters is how fast a block reaches you — and the only part of
that path you get to choose is which peers carry it.

What I saw on my own node after a week of rotation was fewer stale shares — less
work handed out on a block that was already solved. Bitcoin Lab does not measure
that delay directly; it measures which peers deliver. Stratum Race is the half
that puts milliseconds on it, by timing your own pool against the public ones.

That is one node. Your ISP, where you sit, your Core settings and which peers
happen to be reachable from you all move that number.

If you do not mine, this is a measurement tool and a curiosity rather than a
saving. Worth knowing before you install it.


---

[← back to the README](../README.md)
