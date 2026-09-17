# Peer rotation

Rotation is off until you switch it on.

A switch on the dashboard automates the loop. About every ten minutes it:

1. **Drops a peer that is never first.** Any live outbound peer that has been
   eligible for at least 50 blocks and has never once beaten the others to a
   block gets disconnected.
2. **Parks a manual peer that has been offline too long.** The slot is freed, the
   record is kept.
3. **Puts a parked peer back** the moment it answers again.
4. **Promotes the best candidate.** The highest-ranked peer with a real record
   that is not already manual goes into a free slot — or takes the weakest
   unprotected manual peer's slot, if it clearly beats it.

Two rules keep that from eating itself. A peer that has just taken a slot cannot
be pushed out for its first 50 blocks, and a challenger has to be better by a
margin rather than merely ahead. Without the first, a fresh peer with almost no
record reads as the weakest of the eight, gets displaced by anyone with a longer
history, lands back in the pool where that history wins the slot straight back —
I watched two peers do that to each other every ten minutes for hours. Without
the second, one lucky block in five hundred is enough to tear down a connection
and build another.

Switch it on. Over the 2,207 blocks this node has recorded, Core handed it 846
outbound peers; 275 stayed long enough to be judged, and 17 were promoted into
the eight. Sifting that by hand means reading a table several times a day and
remembering what it said last time.

It stays off until you ask for it because it calls `addnode` and
`disconnectnode`. An app that rearranged your node's connections before anyone
had looked at it would deserve the suspicion.

Every action goes into a rotation log under the switch, with the parked peers
listed beside it. The last thirty are kept.

The rest of this file is why each threshold is where it is. Every number here is
a default and can be changed — see [configuration.md](configuration.md).

## Why 50 blocks before a peer is judged

A peer is not acted on until it has been eligible through 50 blocks, about eight
hours.

Waiting longer would give more confidence, and waiting costs something: an
ordinary outbound peer can be gone before the app is allowed to keep it. This
threshold used to be 144 blocks, a full day, and that was too patient in the
direction that matters. A peer delivering 15% of blocks was watched for twenty
hours and then dropped by Core before the loop was permitted to act — a day spent
watching a good peer it could not touch.

The cost sits at the other end. Kicking gets less patient too: a peer whose true
rate is 5% goes 50 blocks without delivering 7.7% of the time, and 144 blocks
only 0.06% of the time. So the loop will occasionally drop a mid-table peer that
was merely unlucky.

That mistake is cheap and the other one is not. A peer's record is keyed by its
address and survives the disconnect, so if Core dials it again its history
resumes where it left off. A strong peer lost to waiting is gone with nothing
learned.

## Why a newly promoted peer gets its own grace period

A peer that has just taken a manual slot cannot be displaced for its first 50
blocks *in that slot*.

Counting from the promotion, not over the peer's lifetime, is the whole point.
An earlier version effectively used lifetime history as the grace counter, so a
candidate with hundreds of old observations entered its slot with the grace
already spent. On a real node one peer had 900 blocks of history and lost the
slot ten minutes after winning it.

What follows is a loop that runs by itself:

1. peer A wins a manual slot
2. its record *in the slot* is still thin, so it reads as the weakest of the eight
3. peer B displaces it
4. A goes back to the candidate pool, where its long history makes it look strong
5. A displaces B on the next pass

Two peers traded the same slot every ten minutes for hours, and every swap was a
real `disconnectnode` and a real `addnode`.

The grace protects against being beaten by a better peer. It does not hold a slot
open for a peer that will not connect — that is the offline grace below, and it
is separate.

## Why a challenger needs a margin

Being higher is not enough reason to replace a live peer.

At the bottom of a settled set the numbers look like 1.1 / 1.0 / 0.6 / 0.4. A
single block in a 500-block window moves them past each other. Without a
threshold, that noise turns into real churn: disconnect one peer, addnode
another, and quite possibly reverse it an hour later.

So a challenger has to beat the peer it wants to replace by
`MIN_SWAP_MARGIN_PCT`, 0.2 points by default.

Deliberately small. The improvements still worth having at the bottom of a good
set really are fractions of a point, and a large threshold would freeze the
rotation exactly where it still has work to do. Its job is to reject noise, not
to stop the set changing.

## Offline peers are parked, not forgotten

A manual peer going dark raises two separate questions: how long should its slot
stay reserved, and how long is the peer worth remembering at all? They get
separate answers.

### The grace period

A disconnected manual peer keeps its slot for a while bought with its own record:

```
grace_hours = clamp(
  First% × OFFLINE_GRACE_HOURS_PER_PCT,
  OFFLINE_GRACE_MIN_HOURS,
  OFFLINE_GRACE_MAX_HOURS
)
```

With the defaults: 0.8% → 1 hour (the floor), 5% → 5 hours, 12% → 12 hours, 24%
and up → the 24-hour ceiling. A peer with no track record yet gets the floor.

An hour is short, and it is only defensible because of the parking below. The
grace does not have to cover "might come back eventually" — it only has to ride
out the things that fix themselves: the peer's node restarting, a router reboot,
a brief routing problem, a short outage at the other end. Past that, an empty
slot is just an empty slot, and a live candidate could be using it.

It is still scaled by record, because a returning peer has to beat the current
weakest to get back in and a mid-table peer may not manage it. A better peer gets
more room before it has to fight for its place.

### Parking

When the grace runs out the peer leaves the active set but stays in the
parked-peer table with its delivery history intact. A few parked peers get a TCP
handshake on each rotation pass, and one that answers becomes eligible to reclaim
a slot.

That is why the grace can be short. Long-term recovery is parking's job, and it
does it better.

### Better peers are worth chasing longer

Not every dead address deserves the same attention. A peer that once delivered
30% of your blocks is worth knocking on twice a day for months; one at 0.8% is
not worth a knock every twelve hours for a month, because even if it comes back
it is barely better than whatever Core would have handed you anyway.

So both how often a parked peer is probed and how long it is remembered scale
with its own record:

```
retention_days = clamp(
  First% × PARKED_PEER_RETENTION_DAYS_PER_PCT,
  PARKED_PEER_MIN_RETENTION_DAYS,
  PARKED_PEER_MAX_RETENTION_DAYS
)
```

0.8% → 4 days, 5% → 25 days, 36% and up → the six-month ceiling.

The probe interval backs off with repeated failures, up to a ceiling that works
the same way: full speed from 20% upwards, sliding to the slow ceiling as the
record approaches zero. 40% is probed every 12 hours, 10% about every 30, 1%
about every 46 — never more often than every 30 minutes, and only three peers per
pass, so a table full of dead addresses costs a handful of sockets every ten
minutes.

The same principle runs through all of it: the peer's own measured usefulness is
the only honest answer to how much effort it is worth.

## Protected peers

A peer you protect — the star in the peer list — is exempt from automatic
replacement and from automatic parking. Anything you add by hand comes in
protected; click the star to release it.

It is still measured and still ranked. Protection means *do not let the rotation
remove this peer*. It does not mean *treat this peer as good*.

If all eight manual peers are protected, the rotation keeps measuring and keeps
dropping dead weight among the automatic outbound peers, but it has no slot to
promote anyone into.

## Automatic outbound peers are the search

Core's ordinary outbound peers are the pool this app explores. It does not try to
keep them.

Once one has enough history and has still never delivered a block first, it can
be disconnected. Core replaces it immediately with another peer out of its
address book, and that is the next experiment. A peer that has delivered at least
one block first is never treated as dead weight by this rule.

That one distinction is what lets the automatic set keep searching without
throwing away anything that has already shown it is worth something.

## Inbound peers are measured, and left alone

Inbound peers are ranked exactly like everyone else. The rotation will not touch
them, and that is a correction.

It used to promote them, and doing so destroyed the thing it was rewarding. The
address Core reports for an inbound connection is the source port that peer
dialled out from, not the port its node listens on. So promotion meant probing
for the listening port, dialling out to it, and dropping the session the peer had
opened — leaving a different connection to the same host, under a different
address, with a record starting at zero.

On a real node that replacement then delivered nothing at all. The peer had been
one of the best on the node as long as it was left as it was.

Why the new connection is worse is not established. The likely explanation is
that a long-lived peer which keeps winning has become one of Core's
high-bandwidth compact-block peers — a standing that belongs to the connection,
not to the host, and that a reconnect throws away. What does not need explaining
is that the connection being measured was deliberately severed; that is enough on
its own to stop doing it.

Adding one by hand still works, and the button still does the port probe. The
difference is who decides. A person looking at a peer's record and choosing to
spend a slot on it has weighed something; a loop doing it every ten minutes has
not, and it was spending slots on a trade that did not pay.

An inbound peer that cannot be dialled at all — a node that does not listen, an
address hidden by Docker's IPv6 relay, one reachable only over Tor or I2P — was
never promotable anyway. It still contributes observations while connected.

## Restarts

Core does not write its runtime `addnode` list into bitcoin.conf, and this app
deliberately never edits bitcoin.conf either. So Bitcoin Lab keeps its own record
of the manual set and puts it back when Core returns.

Rotation state stays inside this app. Core's configuration stays untouched.

## Where Core's outbound slots should go

Every block this node has been handed first, in every case the app could label by
network, arrived over clearnet — 1,136 of them. None came over Tor or I2P.

For a node built for latency, that is an argument for giving Core's outbound
capacity to clearnet peers. On Umbrel: Bitcoin Node → Settings → **Outgoing Peer
Connections**. An outbound slot on Tor or I2P is wasted twice there: the peer will
not deliver, and this app could not keep it if it did. Bitcoin Lab dials manual
peers over plain TCP — no Tor proxy, no I2P bridge, no CJDNS interface — so an
onion or I2P address is one it can never call back.

But that is a trade-off, not general advice for running a node. Tor and I2P buy
you privacy and network diversity, and on a normal personal node those may well
be worth more to you than propagation latency. On a dedicated solo-mining node
the balance tips the other way. Your call, and it should be a deliberate one.

Inbound over Tor or I2P is unaffected. Those peers dialled you, and they rank
like everyone else.
