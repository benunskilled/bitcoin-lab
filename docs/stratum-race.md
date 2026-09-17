# Stratum Race

Optional, and off until you switch it on.

Peers are only the first half of the path. Once your node has the block, your
pool still has to turn it into work your miner can take.

Each enabled pool gets its own TCP connection and is timed on when its
`mining.notify` carrying a new `prevhash` arrives: `hrtime` on the socket's
`data` event, before any parsing. The first pool to report a given prevhash sets
0 ms and every other pool is measured against it. No pool is special-cased,
including your own. A pool that says nothing inside the timeout window is scored
a miss.

Your own pool goes in with one button: templates for GoBrrr, Bassin and Public
Pool fill in the container name and the port the stratum server listens on
*inside that container* — often not the port your miner connects to.

Per pool you get wins, win %, average / median / P90 latency, races seen and
misses. The eight public solo pools that come pre-configured are the baseline
your own is measured against.

What it answers: whether your own pool keeps up with the public ones, and whether
it gets closer as your peer set improves.

It is off until you switch it on, so a fresh install talks to nothing but your
own node. While it is off no pool socket is open at all, and a pool added in the
meantime is not connected either. Switched on, it subscribes and authorizes but
never submits a share; the address it authorizes with is a well-known burn
address, because many solo pools will not send jobs to a connection that has not
authorized with a valid one.

It times the pool's job propagation, not the whole path from block arrival to an
ASIC actually switching work.


---

[← back to the README](../README.md)
