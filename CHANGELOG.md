# Changelog

The release notes of every Bitcoin Lab version published on GitHub, newest first, as on the [releases page](https://github.com/benunskilled/bitcoin-lab/releases). GitHub releases start at 1.13.0.

## 2.0.3 – 2026-10-20

Fixes the phone and tablet view: First % is no longer cut off, the rotation log fits in three short lines and the type pill stays on narrower tables. A block that two peers seem to have delivered at almost the same time, often right after a restart, now credits neither peer; the status line counts these as "unclear" instead of "ties". Shorter texts for the rotation, Add a Peer and Traffic.

## 2.0.2 – 2026-10-18

Fixes a block wave that could stop after many tabs had been opened. Tables now fit narrower windows and phones. Only Storage folds; parked peers are shorter.

## 2.0.1 – 2026-10-17

Bitcoin Lab 2.0.1 shows a single number under First %: the rate over the last 500 blocks, which the ranking sorts by. The lifetime rate is still there on hover, and in the rotation log.

## 2.0.0 – 2026-10-17

Bitcoin Lab 2.0.0 has a new design: four tiles in the header, calmer tables that turn into cards on narrow screens instead of scrolling sideways, and "never first" instead of a strike-through. The ranking marks with ⚡ the peers Core has chosen right now to send it new blocks without asking (BIP152 high-bandwidth). Peers that have delivered a block first show their address in green. Removed or disconnected peers leave the tables at once, and the rotation log shows the recent record that decided a swap. Links between Bitcoin Lab and Peer Map reuse one window per app; on phones they open in the same tab and land on the peer.

## 1.26.0 – 2026-10-12

Bitcoin Lab now notices pool apps installed on your Umbrel. With Stratum Race on, if it finds GoBrrr, Bassin, Public Pool, DATUM or Pogolo and they are not in Stratum Race yet, it offers to add them, once in each browser. The quick-fill buttons stay for later, now including DATUM and Pogolo. Finding them is only a name lookup: nothing connects to a pool until you add it.

## 1.25.8 – 2026-10-07

Bitcoin Lab 1.25.8 closes a gap and makes rotation more careful with your choices. The dashboard now only accepts changes from its own page, so another website you have open can no longer reset your data or disconnect peers through your Umbrel login. Manual peers you set in Core yourself, for example in Umbrel's Bitcoin Node settings, are now protected, a reset keeps manual peers that are offline, and after Core restarts your manual peers are back within seconds. Typing in a peer never pushes out a protected one, and the same node written two ways now counts once. Without Stratum Race switched on, Bitcoin Lab no longer asks Core for a block template on every block.

## 1.25.7 – 2026-10-02

**Catching up no longer skews the ranking.** Blocks your node fetches after being offline arrive several a second from many peers; they used to be scored like new blocks and credited whoever served the backlog. They are now left out, and only blocks that reach the tip are counted.

**Opening a peer from Peer Map lands on it.** Inbound peers outside the top ten of the live ranking had no row to mark, so the link opened Bitcoin Lab as if nothing had been asked. The list now opens for that peer, and the page moves to it right away.

## 1.25.6 – 2026-10-01

**Quiet outbound peers are replaced again.** Rotation now judges an outbound peer on the last 500 blocks, the same window the dashboard shows. A former manual peer that once delivered first used to be spared for good, even after a week without delivering anything, and kept one of Core's outbound slots from finding new candidates.

## 1.25.5 – 2026-10-01

**Swaps connect the new peer right away.** When rotation replaced a manual peer, the displaced one stayed connected and kept one of Core's eight manual slots, so the new peer could not connect until the old one dropped by itself. The displaced peer is now disconnected; it keeps its record and can win a slot back like any other peer.

## 1.25.4 – 2026-09-30

**Core's anchors stay put.** Rotation no longer disconnects or promotes block-relay-only peers, the two connections Bitcoin Core keeps as anchors against eclipse attacks. They are still measured and ranked, and you can still add one by hand. A new section in the docs answers whether choosing peers makes an eclipse attack easier. Peers that offer no services are now struck through, as in Peer Map.

## 1.25.3 – 2026-09-27

**Peer kinds.** Recognises more crawlers, other chains and Kyoto light clients, the same way Peer Map does.

## 1.25.2 – 2026-09-26

**Manual peers.** A padlock marks the peers the rotation keeps.

## 1.25.1 – 2026-09-25

**Traffic.** Only the node's daily totals now; the table per peer is gone, and so is its data.

## 1.25.0 – 2026-09-25

**Traffic.** See what your node sent and received per day, and which peers used the most. Plus a second widget for today's traffic.

## 1.24.0 – 2026-09-25

**Faster, and it writes less.** The peer ranking no longer walks your whole history to read its 500-block window: on a node with two million recorded observations that took 3.7 s, and now takes 32 ms. The dashboard only writes a peer's session when something actually changed, which saves roughly 100 MB of database log a day.

**Fixes.** IPv6 peers are no longer counted twice, and every step of the outbound funnel now counts the same peers. Stratum Race no longer charges a pool with a miss for the moment it takes us to connect. The dashboard sends the same security headers as Peer Map and turns malformed actions away instead of passing them on to Core. Both apps now run in a tighter container.

Bitcoin Lab also counts the transactions in each block template, so **Peer Map** can show why your pool took longer on one block than the next.

## 1.23.0 – 2026-09-22

Bitcoin Lab now tells **Peer Map** which of your connections have ever

delivered a block first, so the map can mark them. It is the record the

ranking is already built on, sent along with the newest block: no extra

request, worked out once per block.

## 1.22.0 – 2026-09-21

The Peer Map route of a block now splits the stretch from Core to your pool

in two: **how long Core takes to build the next block template**, and how long

your pool takes to turn it into a job. For that, Bitcoin Lab asks Core for a

template itself the moment a block arrives — the same request every pool on

the node makes then — and times it. Measured on one node: 75 to 91 ms right

after a block.

It costs one template per block; a pool on the same node already asks about

thirty times as often. Core builds one template at a time and keeps it for a

few seconds, so this can make your pool faster, never slower.

The delivering peer's ping is now stored with each block, from the moment it

arrived. And for every stop of the route Bitcoin Lab works out the median over

the last hundred blocks, so a change you make shows up as a shorter stretch.

All of this is measured at every block, whether Peer Map is open or not.

## 1.21.0 – 2026-09-20

Two peers can be credited with the same block, and the dashboard now says how

often that happens on your node. **First** comes from Core's `last_block`, a

timestamp in whole seconds: two connections that hand the same block over

inside one second cannot be told apart, so both keep the credit. The status

line carries the count beside the network and the database size — "2 ties in

2,206 blocks".

How often it happens is a property of your node rather than of this app. It

depends on how tightly the first copies of a block arrive, which is a question

of where the node sits and who it is connected to. On the node this app is

built against it is close to never — twice in 2,206 blocks over sixteen days,

with no block left uncredited — but there is no reason to think that number

travels, which is why yours is counted rather than assumed.

A lifetime count rather than the 500-block window the ranking uses: at this

rate a recent window would read zero almost every day, and a number that never

says anything else is not worth its space. A fresh install shows nothing at all

until it has recorded a block.

It is affordable because of a new partial index over the credited rows only —

one per block instead of one per peer per block. The count takes 0.26 ms

instead of 104 ms on a node with a fortnight of history, for 28 KB and a one-off

18 ms the next time the app starts.

## 1.20.0 – 2026-09-20

Every block now says who found it. The **pool that mined the newest block**

stands under its height, read off the block itself: the coinbase carries the

address the reward is paid to and a short text the miner writes, and both are

matched against a list that ships with the app. Nothing is asked of any

service. On ten consecutive blocks on one real node, ten of ten were

attributed — four by payout address, six only by tag, which is why both are

used.

A miner nobody has listed is not an empty field. What he wrote into his own

coinbase is shown instead, in quotes, because it is his claim and not a name

this app put on him.

The cost is deliberately small and deliberately late: the lookup runs after the

block race has been recorded, never before. Measured on the same node, 15.4 ms

and 0.8 ms of RPC once every ten minutes — nowhere near the timing that

matters.

**Peer Map**, in the same store, reads the whole story of a block from here

now: which pool mined it, which of your peers delivered it first, and where the

Stratum race put your own pool. Joining a mining job to a block needed care,

because pools send the previous block hash in whichever byte order they like.

Of 200 races checked against this node's own history, 200 found their block.

## 1.19.0 – 2026-09-17

Peer Map, from the same store, is the other half of this pair, and the two apps now know about each other. If Peer Map is installed on the same node, the header carries a link to it and every peer address in the ranking becomes a jump to that peer on the map — the same peer, the other question. Whether it is installed is a question this app's own process answers, not your browser; the answer is kept for five minutes, and a node without Peer Map sees nothing at all: no link, no error, nothing in the log.

Colour means one thing now, in both windows. Manual is blue, inbound a yellow that leans green, outbound a sea green — the same three here and in Peer Map, so a peer looks the same wherever you meet it. The set was measured rather than picked by eye: its worst pair separates at ΔE 12.6 for readers with protanopia, against 9.4 for the set it replaces, and every colour clears 3:1 contrast against the panel.

Nothing in the app is red any more. The red "cannot relay" pill from 1.18.0 failed the same measurement — ΔE 14.8 against the orange manual pill in normal vision, below the floor of 15, and 2.8 against the old inbound colour for readers with deuteranopia. Two meanings on one colour is one too many, so it is a strikethrough instead, which survives being printed in grey. What it marks is unchanged: on one node, 688 of 2,270 peers ran software that passes no blocks on at all — 790 observations between them, not one block delivered first.

The README is a front door of 460 words now instead of 3,291. Everything that stood on that page is in `docs/` beside it, whole; nothing was deleted.

## 1.18.0 – 2026-09-17

The dashboard has moved to port 8790. Port 8788 belongs to another app in the official store, Enclosed, and two apps cannot share one — installing both meant one of them silently failing to start. Nothing else changes: the same address, a different number after the colon, and Umbrel's own tile takes you there either way.

A peer that cannot deliver a block now says so in colour. Phone wallets, light clients, address indexers, network crawlers, research scanners, clients of other chains — they connect, they count, and they can never win a block, because their software does not pass blocks on at all. Measured over 2,270 peers on one node: 688 of them ran software like that, 790 observations between them, and not one block delivered first. Their status is red instead of green and the reason is in the tooltip; nothing else changes, they are still measured, still ranked, still shown. Block-relay-only peers stay green on purpose — they refuse transactions and pass blocks on, which is the opposite thing.

Underneath, three more facts are written down for every connection: whether a peer advertises any services at all, whether it asked for transactions, and whether Bitcoin Core has ever learned which chain it is on. Nothing reads them yet. They are there because a name is worth very little — on the node this app is built against, four connections called themselves Bitcoin Core with a zero in place of the o — and because deciding what to do about a peer like that deserves data rather than an argument.

**Image:** `ghcr.io/benunskilled/bitcoin-lab:1.18.0`

**Digest:** `sha256:23d324736b4f1766642ed3c99d898170103dc695c7bfe697411a4f512d2c5c3b`

## 1.17.1 – 2026-09-16

The rotation no longer keeps inbound peers, and that is a correction rather than a feature removed. Promoting one meant dialling out to the port it listens on and dropping the session it had opened — so the connection whose record earned the slot was gone, replaced by a different one starting at zero. On the node this was found on, that replacement then delivered nothing at all, after the peer had been one of the best on the node for as long as it was left alone. You can still keep an inbound peer yourself, and the button still finds its listening port; the difference is that a person doing it has looked at the number first.

Three things that used to fail in silence now say so. If Bitcoin Core's clock and this app's disagree by more than a couple of seconds, no peer is ever credited with a block and First % sits at 0 forever — that is now read straight off Core and reported before the damage, rather than guessed at afterwards. If no block arrives for six hours, that is reported too: a ZMQ subscription pointed at nothing looks exactly like a quiet network, so blocks arriving is the only evidence there is. And if nobody is credited for three blocks running, the dashboard says so instead of leaving a table that fills up with zeroes.

A pool that says something malformed is now cut off rather than believed, and a configuration with a typo in it stops the app with a message naming the variable instead of starting it with a number that is not a number. A restart no longer records a miss against every pool that had not answered yet, which was a small but permanent bias in the pool statistics.

Nothing new to learn and nothing to switch on. Under the hood the ranking rule was measured against 2,206 recorded blocks instead of argued for — it came out ahead, and stays as it was — and there is now a test that runs two real Bitcoin Core nodes and checks that the peer which delivered a block is the peer this app credits.

**Image:** `ghcr.io/benunskilled/bitcoin-lab:1.17.1`

**Digest:** `sha256:e9ef1e4c8cabfcadd868bc8b587ebccd4b8a9203a8c194824f9f426948b186c2`

## 1.16.3 – 2026-09-11

Stratum Race can be switched off completely. Somebody who wants the peer half of this app and not the pool half had no way of saying so: disabling all eight pools by hand came close, but it was eight clicks, the card still sat there as if it were measuring, and the next pool anyone added started connecting again. There is a switch on the card now, the same as the rotation's. Off means no TCP connection to any pool, public or your own, and nothing measured — a pool added while it is off is not connected either. Everything measured so far is kept; the pool history still only goes if you delete it under Storage.

A fresh install now starts with it off, so nothing here reaches out to anyone but your own node until you ask it to. An install that has been running is switched on as it was — the update does not take away something that has been measuring since the day you installed it.

The home-screen widget was still ranking peers the way 1.15 did. It read the raw lifetime rate, which is what the ranking used before 1.16.0 moved to the last 500 blocks as a Wilson lower bound; the widget was never moved with it, so the same peer could show 46.8% in the table and 29.5% on the home screen. It now scores peers exactly as the ranking does.

Under the hood, the app's two largest source files were split up along what they actually do, without a single line of logic changing, and the image stopped shipping 23 MB it can never load: prebuilt binaries for Windows, macOS and musl that a Debian Linux container has no use for.

Image: ghcr.io/benunskilled/bitcoin-lab:1.16.3@sha256:6b0475113d089f0d71e342336be01628a7dfb180c362d15044b055c14a7887f6

## 1.16.2 – 2026-09-10

**The button beside a peer no longer protects it from the rotation.** Add & Keep was meant for one thing: an address you type in yourself. It ended up on the button next to every peer in every table, because both paths run through the same function and the star was hardcoded there — under a comment claiming every caller was a person typing an address in. It was not.

That did the most damage where it was least visible. The ten ordinary outbound peers *are* the pool the rotation promotes from. Clicking that button on one of them took it out of that pool for good: never displaced by a better candidate, never parked when it went offline. Eight of those and the loop has nothing left to work with — the exact failure the caution note on the Add a Peer card warns about, reachable in one click from a table that said nothing.

The distinction the star exists for still holds. A hand-typed address may name a peer this node has never seen, so there is no record to judge it on, and the first candidate with any history would displace it before you ever saw it work. A peer picked out of the ranking is the opposite case: it is in that list *because* the app measured it, so promoting it by hand is the same judgement the rotation makes, only sooner.

So the button in the tables reads "Add as Manual" again and adds without the star. Only the Add a Peer box still stars what it adds. Freeing a slot when all eight are full is unchanged for both — clicking a row is still a deliberate choice, it just does not need protecting from the measurement.

**A Tor or I2P row is quieter.** Where the button goes, those peers printed "Tor only" — a word about the peer standing in a place that otherwise holds an action or the reason there is none, and since 1.16.1 the address cell already names them, so the row said Tor twice. The slot is now simply empty, the same as for the two other kinds of peer this app can do nothing with, and the reason moved into the address cell's tooltip.

**The documentation caught up with the node.** The multi-first measurement in the code now covers 1,487 races instead of 1,029: 1,486 with exactly one peer inside the detection window, one with two, none with zero — and across the 458 extra blocks the second number did not move at all. The README gained the sharper half of the same evening's data: over the last 500 blocks, 189 peers dialling in delivered three of them between them, while the eight chosen ones delivered 476.

## 1.16.1 – 2026-09-08

Four fixes to what 1.16.0 introduced, all found by looking at a running dashboard rather than at the tests.

**The First % column now shows the number the ranking actually sorts by.** Since 1.16.0 a peer is ranked on the last 500 blocks, but the column still showed its whole-life rate — so the order looked wrong and nothing on the page could explain it. Two manual peers sat at 21.2% and 37.5%, in that order, because across the window they were 33.8% and 33.4%, which is level. The heading names the window now, the cell carries it, and the lifetime pair moved into the cell's tooltip. The parked list and the rotation log still show the lifetime rate, because their own rules are scaled by it.

**Tor, I2P and CJDNS peers are named in the address column.** 1.16.0 stopped mislabelling them as a local app but put nothing in its place, so the row showed a bare `10.21.22.10:57844` — your own proxy container, which names nothing anyone can use. It says "Tor peer" now, with the real address in the tooltip. A peer your node dialled out to over Tor still shows its own .onion address.

**The rotation no longer swaps a peer out and straight back in.** A displaced peer was disconnected and parked, and parked peers return on their lifetime record — the very number the peer had just been displaced despite, because displacement goes by the recent window. On a real node that cost two disconnects and two addnodes in ten minutes for no change. A displaced peer now keeps its connection, drops back to being an ordinary outbound peer, and earns a slot again like everyone else. Only a peer that is actually offline is parked.

**And a new slot holder really is safe for its first 50 blocks.** That was implemented as "has this peer been eligible for 50 blocks", which is a question about its whole life — so a peer with 900 blocks of history walked into its slot already past a grace it had never had.

## 1.16.0 – 2026-09-08

A peer is now ranked on the last 500 blocks — about three and a half days — and falls back on its whole record only for the part of that window it has not been around for. Both halves go through a Wilson lower bound, so four deliveries out of fifty no longer outrank sixty out of nine hundred.

The lifetime figure had no decay at all, so a peer whose routing changed months ago kept the record it earned before that while delivering nothing today. This node produced the case on its own: the peer with the best lifetime record of the eight, 28.5% across 1,388 blocks, has delivered 9.8% across the last 500. A lifetime ranking puts it first; the window puts it fourth.

This started as a fixed 60/40 blend, and that blend failed the exact case it was written for — the decayed peer still won, 7.3 to 5.2. It only turns over above a weight of 0.687, and nothing derives 0.7 rather than 0.6. The knob is gone and `RECENT_SCORE_WEIGHT` with it.

**Peers you add by hand are protected from the rotation.** Add as Manual is now Add & Keep, and anything typed in arrives with a star: it is neither displaced by a better candidate nor parked when it goes offline. Click the star to release it. What the rotation promotes itself arrives unstarred, or the loop would freeze itself out of every slot it filled.

**Tor, I2P and CJDNS peers are labelled correctly.** The network was read off the address string, and an inbound Tor peer arrives from Umbrel's own Tor container under that container's plain local address — so every Tor peer was filed as another app on this host. Core reports the network itself in `getpeerinfo`, and that is what is stored and shown now, with the old guess kept only for sessions recorded before this version.

**Adding a peer that is already connected inbound now works.** The inbound session is dropped before the addnode, not after: an inbound peer's address carries a throwaway source port, so the old order left the original connection in place and the manual one was never established. If you added a good inbound peer and it stayed inbound, this was why.

## 1.15.12 – 2026-09-04

The shortened block hash under the big number is gone. It named the block the ranking had just scored, which the ranking itself already shows, and nothing on the page acted on it.

Its line also carried the state before Core has answered, so that moves into the number's own slot. The height is Core's own getblockcount and is there from the first status response — it never waited for a block, the hash did — so the only case with no height is Core not answering, and the card now says that in small type instead of showing a 42px dash.

## 1.15.11 – 2026-09-04

The note above the Outbound Peers table is shorter, and the sentence counting how many of the current peers arrive over Tor or I2P has gone. Those peers already say so in their own row, where a badge names the network and its tooltip explains why this app can never dial them back — a second copy above the table added a number and no meaning.

## 1.15.10 – 2026-09-04

The Outbound Peers card now carries four numbers over the whole history rather than the current snapshot: how many outbound peers Bitcoin Core has handed this node, how many stayed connected long enough to be judged, how many ever delivered a block first, and how many were kept. The table underneath shows what is connected right now; these say what those rows are a sample of.

On the node this was built against it reads 74 tested and 12 delivered — five outbound peers in six never deliver a block at all. All four are counted by IP, so a host that reconnected, or was kept under a second address, counts once. Existing installs are back-filled from the peers they already keep, so the numbers are there on first load rather than starting at zero.

## 1.15.9 – 2026-09-04

A peer had to be connected through 144 blocks — a full day — before the rotation was allowed to judge it. That is a long time to watch a peer deliver blocks without being permitted to keep it, and Bitcoin Core drops peers on its own schedule in the meantime: one delivering 15% of blocks was watched for twenty hours and then lost. The bar is now 50 blocks, about eight hours.

The same threshold decides when a peer that never delivers is dropped, so that happens sooner too — occasionally to a peer that was merely unlucky, which is the deliberate trade. A dropped peer keeps its record and resumes it if it comes back; a peer lost to waiting is gone with nothing learned.

## 1.15.8 – 2026-09-04

Two explanations in the dashboard were longer than they needed to be, and one of them was out of date. The note above the outbound table said to avoid leaving the setting on "both" — Umbrel has three toggles, Clearnet, Tor and I2P, and all three are on by default — and it named the setting wrongly. It now says what matters at that table in three lines: a Tor or I2P peer is never first and cannot be kept as a manual peer, while inbound connections over either are perfectly normal. The rotation panel lost about a third of its words without losing anything it said.

## 1.15.7 – 2026-09-03

Fixes a rotation loop that could swap the same two peers back and forth every ten minutes, for hours. A peer that had just taken a manual slot was judged on the empty record it starts with under its new address, so the peer it had just replaced won the slot straight back. A peer that has just taken a slot now keeps it for its first 50 blocks, and a challenger has to beat the weakest manual peer by more than 0.2 points of First % before it can displace anyone.

Block hashes arriving over ZMQ were byte-reversed a second time. Core's publisher already writes them in display order, so the app was undoing that and storing hashes that matched nothing.

The rotation log no longer grows without limit: the five most recent actions are shown, the rest sit behind a button, and thirty are kept.

New Storage panel — what the database occupies, split into peer measurement data and pool history, each with its own reset that names the row count and the megabytes first. Manual peers survive both. Stratum race history is now kept for a year instead of half of one.

better-sqlite3 moves to 12.11.1, so a local checkout builds on Node 26.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.7@sha256:890184db256ec6d3ebeb2aedf5738e88df139a4e2acee5eccb7125f252167bbb`

## 1.15.6 – 2026-09-02

Bitcoin Core reaches peers over four networks besides IPv4/IPv6. This app reaches them exactly one way: a direct TCP connection out of its own container, which has no Tor SOCKS proxy, no I2P SAM bridge and no CJDNS interface — and giving it any of those would mean asking for access to the host's networking, which this app deliberately never does.

So a Tor, I2P or CJDNS peer can never be promoted to a manual connection. It was nonetheless offered an **Add as Manual** button, which probed 8333 and 9333, failed, and reported `no node answering on 8333 or 9333` — phrasing that suggests the peer merely has the wrong port open. It does not. There is no address to dial and there never will be.

### What changed

Those peers now carry a label in the Actions column — `Tor only`, `I2P only`, `CJDNS only` — with the reason in its tooltip, instead of a button that always fails. The rotation loop skips them as promotion candidates rather than spending a probe failing on the same address every single pass.

**Nothing else about them changes.** They rank normally, earn First % normally, and genuinely deliver blocks; one of them may well be your best-performing peer. Inbound Tor and I2P connections are entirely normal even with outgoing connections set to clearnet only — those peers dialled you, and they are welcome.

The note above the outbound table now counts them by network rather than lumping them together:

> Right now 2 on I2P, 1 on Tor — those peers rank normally but cannot be kept as manual connections.

"3 on I2P" tells you which setting is involved. "9 unreachable" tells you nothing.

### Two smaller fixes found on the way

- `resolveHostPort` matched only 2-to-5-digit ports, so Core's I2P addresses — reported with port `0` — kept `:0` glued to the host.
- The new label was first given `class="action-slot"`, which carries `visibility: hidden` for the empty action placeholders. Present in the DOM, invisible on screen; caught by looking at the rendered page rather than the markup.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.6@sha256:f02856378de0ecfe63e8226ebac75d9444ce94a62eabebd96235483761e07d81`

## 1.15.5 – 2026-09-02

A full review of the code and both repositories, with every finding above "medium" reproduced as a running test before it was believed. Five of the defects were introduced in the 1.15.x releases themselves.

### The rotation loop was eating itself

`offlineForMs()` measured a manual peer's absence from the end of its last closed session, without asking whether it had been re-added since. So retiring parked a peer, the revival pass found it answering and put it straight back, and the next tick read the same stale session end and retired it again — park, revive, park, revive, every ten minutes indefinitely. Because only one peer may join the manual set per tick, that loop consumed the tick's one move every single time, so **no genuine candidate was ever promoted while it ran**. Four consecutive ticks with a 90%-first candidate waiting:

```

rt1/rv1/p0   rt1/rv1/p0   rt1/rv1/p0   rt1/rv1/p0

90% candidate promoted: false

```

The same line meant a peer added by hand could be retired seconds later, before Core had a chance to dial it. The clock now starts at whichever is later: the last session's end, or joining the manual set.

### A refused `addnode` destroyed data

`addTrustedPeer` wrote the trusted row and deleted the parked entry *before* calling `addnode`. A refusal rolled back only the row, so the peer ended up in neither table — months of ranking data gone to one failed RPC call, which is precisely the loss parking exists to prevent. Separately, at capacity the eviction ran first, so a refused add left the manual set one peer smaller with nothing said about it anywhere.

`addnode` now goes first, before anything of ours moves. A refusal changes nothing at all.

### A manual peer Core never connects was invisible

`peerRanking()` is driven `FROM peer`, and that table is filled only from `getpeerinfo`. A `trusted_peer` row with no peer row could not be seen by any rotation pass — never retired however long it had been gone, never considered the weakest, never displayed — while still counting against the eight-slot cap. One address that answers a TCP probe but that Core never connects (a non-Bitcoin service on 8333, a peer that rejects you) cost a slot permanently. Both creation paths now create the peer row, and a migration backfills the ones already in installed databases.

### Performance that only bites an aging node

- `peerRanking`'s filter was applied *after* the join, so SQLite scanned the whole `peer` table — which by design never shrinks — to return ~200 rows. Measured with 60k peer rows: **16.8ms → 1.56ms**, byte-identical output.
- The weekly `VACUUM` rewrote the entire file to reclaim a measured **zero** pages (this database is append-only where it matters), holding an exclusive lock past the `busy_timeout` that exists because of it — long enough to lose a block's race. It now asks the file whether there is anything to reclaim.
- `getOrCreatePeer` recompiled two statements on every call: 200 times per peer poll and 200 more inside the per-block write transaction.

### Frontend

`table-layout: fixed` with `width: 100%` meant the tables shrank instead of scrolling. At 390px all nine cells were clipped and four columns overprinted each other (`16.2ms1.2h1d 1`). The "Show all" toggle was blocked by the defer gate meant to protect interactions *from* polls: during a six-second port probe the button did nothing, and two clicks cancelled each other out permanently. One `innerHTML` interpolation went in unescaped.

### Clearnet only

A `.onion` peer can never be promoted — the port probe has no address to dial — and over Tor the latency measured is circuit variance rather than peer speed. Set Bitcoin Core's outgoing connections to **clearnet only**, not "both": Core will otherwise keep filling outbound slots over Tor, and those slots are exactly what this loop exists to improve. Now stated in the README, on the store page, and under Outbound Peers where it shows — with a live count of how many of your current peers are on Tor.

### Tests that could not fail

Three passed with the behaviour they were named for removed, confirmed by mutation:

- **migration idempotence** — guarding a migration that runs `DELETE FROM stratum_observation`. Had that guard regressed, every container restart would have wiped the entire Stratum Race history, silently, with the test still green.
- **seed-once** — a count that `INSERT OR IGNORE` produces either way.
- **the ping tiebreaker** — whose fixture's alphabetical order already produced the asserted result, so deleting both ping clauses from the query changed nothing.

All three now fail when mutated. Added coverage for the twelve untested API routes, `liveSummary()`, and the weakest-peer tiebreak. Two tests asserting opposite outcomes for the same scenario are reconciled, and the upsert branch that is no longer reachable is documented as such rather than left implying otherwise.

### Also

Nine undocumented environment variables; a README that contradicted itself sixty lines apart on whether the loop makes one change or many; the eight pool connections a fresh install opens without mentioning it; an undisclosed dependency of the whole ranking on the container and Core agreeing about the wall clock to within ~2.5 seconds; a widget example showing a state the app never produces; `RELEASING.md` describing a process that was not the one being followed; a `workflow_dispatch` that could overwrite `:latest` with an untagged build; and a lockfile version stuck at 1.14.2.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.5@sha256:d92a892306abb7877a12a9322f705d47dd4a7481e100eb8af38716e36d2280a9`

## 1.15.4 – 2026-09-01

Shortening the rotation explanation in [v1.15.3](https://github.com/benunskilled/bitcoin-lab/releases/tag/v1.15.3) cost it its point.

The step that makes a well-performing peer manual — the reason the whole loop exists — had been compressed to "Puts the best peer available into a free slot". That says neither which peer nor why, and read quickly the three bullets made the toggle look like it only *drops* peers. Everything the app is for is in the promotion.

It now leads:

> Makes a peer that really delivers blocks manual, so Core holds on to it - the best one available, into a free slot or in place of a weaker manual peer.

Deliberately not "outbound": a well-placed inbound peer is promotable too, and on a real node one is often near the top of the ranking. The other two bullets are unchanged.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.4@sha256:3ac8a24c7b1dbb0a0fb718e412a37bef4487ce69558e6190df74f1f662ec5325`

## 1.15.3 – 2026-09-01

The explanation under the rotation toggle had been grown a sentence at a time with every feature it gained. It ended up as a single paragraph carrying three em-dash asides, a chain of subordinate clauses, and the phrase "an hour per point of its own First %" buried in the middle. Accurate, and nobody was going to read it.

**Before**

> Every ~10 minutes: drops outbound peers that have had a full day to prove themselves and never delivered a block first - Core replaces each with a fresh, random one - and reclaims the slot of any manual peer that has gone offline, after an hour per point of its own First %, at most a day. Reclaiming early is safe because it is reversible: those peers are parked below, re-tested for as long as their record deserves, and take a slot back as soon as they answer. Whatever slot is free then goes to the best candidate available - one peer joins the manual set per pass.

**After**

> Every ~10 minutes, one change at a time:

> - Drops an outbound peer that has been connected a whole day without ever delivering a block first. Core replaces it with a new random one.

> - Frees the slot of a manual peer that has gone offline. Good peers get longer: an hour per point of First %, up to a day.

> - Puts the best peer available into a free slot.

>

> Losing a slot is not losing the peer. It is parked below, tested regularly, and takes a slot back as soon as it answers again.

Each sentence does one thing. The detailed rules stay in the README, where someone who wants them is actually looking; what belongs beside a switch is what it does and what it costs you. The Parked table's subtitle got the same treatment.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.3@sha256:33aad291d5349a98189471f2cd12b393bea0763978504f84c4791cf08f0797d3`

## 1.15.2 – 2026-09-01

Two things that were only ever visible in a screenshot.

### The rotation explanation had a third of the card

It sat as a flex sibling of the toggle label, so a paragraph that reads as six lines got squeezed into roughly a 400px column and ran to eight, with the rest of the row blank. Same text, its own line under the toggle, at a proper reading measure.

### The demo data behind the store screenshots now has a real node's shape

It was a dozen invented peers with identical session lengths, ping values and history depth down every column — which is exactly what makes seeded data look seeded. It is now modelled on an actual long-running node: 206 connections, 188 of them inbound, 18 outbound of which 8 are the manual set, with lifetime records taken from a real ranking (42.7% at the top down to 0.4%) and a full outbound table of 0.0% peers with wildly different amounts of time to have proved otherwise.

That scale is not vanity. The two things the ranking is actually about only become visible there: that it has a long tail worth filtering ("showing 10 of 206"), and that the automatic outbound set is mostly peers waiting to be replaced. Every peer now gets its own ping, session length and history, so no two rows read alike.

`scripts/screenshot.js` also refreshes the demo heartbeats before shooting. They go stale two minutes after seeding, at which point the dashboard correctly reports "3 background services are not reporting in" — true of a demo stack running no workers, false of the app, and it had already shipped that way in the store's first screenshot.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.2@sha256:db0ec0be73635a5e3f47eeca69abc839d34be730801e455af016bff2c25a0782`

## 1.15.1 – 2026-09-01

Manual peers are the eight connections Bitcoin Core will hold open on request (`MAX_ADDNODE_CONNECTIONS`). This release is about making those eight slots worth something — completing the work v1.15.0 started, whose two halves were not yet talking to each other.

### Adding a peer decides everything before it changes anything

The cap is checked first, and at capacity the weakest peer is dropped to make room — named in the response, with its record, rather than silently. The peer's existing connection is disconnected **only once it is genuinely in the manual list**, and a refused `addnode` rolls the row back instead of leaving a manual peer Core was never told about.

So trying an inbound peer that turns out not to be listening costs nothing at all: no row, no `addnode`, no dropped connection. A new **Test** button asks "is anyone actually listening there, and on which port" with no consequences whatsoever.

### An offline manual peer's slot is reclaimed in hours, not days

v1.15.0 already parked a retired peer instead of deleting it — the address is kept with its record, re-probed, and takes its slot straight back when it answers. But the wait before retiring was still sized as if giving up were permanent: six hours at the floor, a week at the ceiling.

It does not need to be. The wait only has to cover the outages that fix themselves — a node restarting, a network blip — because "might be back next week" is parking's job now, and parking does it better. So it is **an hour per point of First %, floored at an hour and capped at a day**. Past that, an empty slot is just an empty slot while a live candidate could be using it.

The chase afterwards scales too, in the direction that spends least for the least reward: the re-probe ceiling is 12h from 20% First % upwards, sliding to 48h as the record approaches zero, and a parked peer is remembered for five days per point (2-day floor, 180-day ceiling) rather than a flat month.

| First % | keeps its slot for | then re-tested every | remembered for |

|---|---|---|---|

| 0.8% | 1 hour | ~47 hours | 4 days |

| 5% | 5 hours | ~39 hours | 25 days |

| 12% | 12 hours | ~26 hours | 60 days |

| 30% | 24 hours (max) | 12 hours (max speed) | 150 days |

The early backoff is the same for everyone — first knock on the next pass, then 30m, 1h, 2h, 4h, 8h — so a returning peer of any strength is noticed quickly on day one. The scaling only decides what happens after that.

Without this, the manual set could only ever be improved by a better *live* candidate, so eight peers that all went dark held the whole list hostage while Core kept redialling addresses that were not answering.

### Dashboard

- **Live Peer Ranking** no longer has an outer collapse that hid the whole table. Collapsing means going back to the top ten — where it started — and the page scrolls back to the card instead of leaving you stranded below it.
- **Add a Peer** moved out of that card into its own section, next to the Manual Peers panel it writes into, with the Test button beside it.
- A **Parked** table under the rotation toggle shows which peers are being waited for, how often they are tested, and for how much longer.
- The browser tab finally shows the Bitcoin Lab flask instead of a blank page icon.

At most one peer joins the manual set per rotation pass — revival or promotion — so the set still drifts toward the best peers rather than churning.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.1@sha256:f0716b1175230102b9f0889648aa93407c46d8801a6c339e52df928115aaaddf`

## 1.15.0 – 2026-09-01

Adding a peer as manual now decides everything before it changes anything.

Bitcoin Core holds eight manual connections at once (`MAX_ADDNODE_CONNECTIONS`), and a ninth used to be written down and then quietly queued forever — a peer the app listed as manual that Core had never been told about. The cap is now checked first and the weakest peer is dropped to make room, and the response says which one and what its record was.

**Trying an inbound peer is free.** The existing connection is only disconnected once the peer is genuinely in the manual list, so a peer that turns out not to be listening costs nothing at all — no row, no `addnode`, no dropped connection. A refused `addnode` rolls the row back rather than leaving a manual peer Core never heard of. And a new **Test** button answers "is anyone actually listening there, and on which port" with no consequences whatsoever.

**An offline manual peer now gives its slot up** — after a grace period bought with its own performance, rather than the same wait for every peer: that was treating the two ends of the manual list as if they were the same peer. (The exact timings were shortened considerably in [v1.15.1](https://github.com/benunskilled/bitcoin-lab/releases/tag/v1.15.1), once parking made losing a slot reversible — see there for the current numbers.)

What makes the shorter wait safe is that giving up is no longer permanent. **Retired peers are parked, not deleted**: their address is re-probed a few at a time on each rotation pass (one TCP handshake to the port that answered last time, backing off as failures accumulate), and the first one that answers takes its slot straight back — free, or by beating the current weakest. The parked peers are listed under the rotation toggle, so "where did my peer go?" has an answer on the same screen that took it away.

Before this, the manual set could only ever be improved by a better *live* candidate, so eight peers that all went dark held the whole list hostage.

### Dashboard

- The **Live Peer Ranking** panel no longer has an outer collapse that hid the whole table. Collapsing means going back to the top ten — where it started — and the page scrolls back to the card instead of leaving you stranded somewhere below it.
- **Add a Peer** moved out of the Live Peer Ranking card into its own section, next to the Manual Peers panel it actually writes into.
- The browser tab finally shows the Bitcoin Lab flask instead of a blank page icon.

At most one peer joins the manual set per rotation pass, revival or promotion, so the set still drifts toward the best peers rather than churning.

Image: `ghcr.io/benunskilled/bitcoin-lab:1.15.0@sha256:a190c2e9c10d72d8833510ed355e401fc92b2dfa1e4d9d21b3acca066856f7e2`

## 1.14.2 – 2026-09-01

**Corrects what First % measures.** The explanation shipped in 1.14.0 was wrong, and it was wrong in three places at once — the README, the store description and the column tooltip.

They claimed that Core timestamps block arrival to the second, so "several peers routinely share the same block", and that First % therefore means *how often a peer was in the fastest group*. Both halves are wrong. Core sets a peer's `last_block` only when the block was new to the node:

```cpp

bool new_block{false};

m_chainman.ProcessNewBlock(block, force_processing, min_pow_checked, &new_block);

if (new_block) {

node.m_last_block_time = GetTime<std::chrono::seconds>();

```

A peer relaying a block you already have is not credited, so for any given block exactly one peer normally is — the one that actually delivered it. **First % means what it looks like it means.** Two peers land in the same detection window only when two blocks are accepted inside it: competing blocks at the same height, or two in quick succession.

The one-second resolution is real, but it explains something else — it is why the comparison uses a window of a couple of seconds rather than an exact match, since the ZMQ timestamp is millisecond-precise and the second boundary can fall anywhere inside it.

**No measurement changed.** The recording logic is untouched since the initial commit; only the description of it was wrong.

## 1.14.1 – 2026-09-01

**Fixes the home-screen widget from 1.14.0, which stayed empty.**

The widget pointed at the dashboard by container name (`bitcoinlab-node_dashboard_1:8788`), which is what `app_proxy`'s `APP_HOST` takes — but Umbrel resolves a widget `endpoint` by *service* name. The official bitcoin app uses `app:3000/api/widget/stats`, mempool uses `widget-server:3000/...`. Ours is now `dashboard:8788/api/widget/stats`.

**Public Pool** joins GoBrrr and Bassin in the local-pool quick-fill, so all three solo pools available in the Umbrel app store are covered.

It also breaks an assumption the old help text made: Public Pool's stratum server listens on **2018** and publishes it unchanged, while GoBrrr and Bassin both run ckpool on container-internal 3333 behind a different external port. The port field's tooltip said "usually 3333"; it now explains the distinction and names both cases.

## 1.14.0 – 2026-09-01

Bitcoin Lab now has an Umbrel home-screen widget: live peers, your best-performing peer, the fastest pool, and how many of your manual peers are actually connected — without opening the app. The endpoint behind it had existed since v1.6.0, but an Umbrel app only gets a widget if the manifest declares one, and ours never did.

> **Correction (see v1.14.2):** this release also added an explanation of `First %` that was wrong — it claimed several peers routinely share a block and that the percentage means "in the fastest group". Core credits only the peer whose block was new to the node, so each block has exactly one first. Fixed in v1.14.2.

**Wording**

- `First Seen %` is now `First %` in all three peer tables. The old label read like "when was this peer first seen", which is close to the opposite of what it means.
- The empty Manual Peers table pointed at "the manual-add field" — not the name of any button on the page.

**Documentation**

The README lost its API table (twelve endpoints with no consumer outside this repo's own frontend) and its Design principles list, a leftover from the original project brief. The two facts in that list that carried real weight — Core's addnode list lives only in memory, and this app only ever talks RPC and ZMQ — now sit where they explain something. The store page, this README and the store repo's README had all grown into full descriptions of the app, so every wording change had to be made three times; the store description is now the single place that does that job.

**Also**

- The release workflow printed a path that has not existed since the app folder was renamed.
- The dev stack's Bitcoin Core image is an overridable variable now, with an honest note that its pinned version is from 2022.
- The store's version number always matches the app version from here on. It had drifted to 1.12.19 while installs were running 1.12.8.

## 1.13.0 – 2026-09-01

A correctness and clean-up release.

**Peer rotation** — two bugs, both shipped in v1.12.7, neither of which had fired yet:

- The manual-slot cap counted only *connected* manual peers, so a single offline one left a slot that looked free but Core could not fill. Every pass promoted one more peer — around 144 rows a day — and the swap branch, the only thing that ever removes a manual peer, became unreachable.
- Candidates were filtered as untrusted on the ranking address but promoted under the resolved one. For an inbound peer those differ, so a peer already manual under its listening address was "promoted" again on every pass, spending the single promotion each pass allows.

**Other bugs**

- Deleting a pool made the next race's whole miss transaction fail on a foreign key, losing the misses for every other pool too — the same Win%/Miss bias an earlier migration existed to erase.
- A peer that reconnected within the 15-second poll window was written into the old session row: session count frozen, downtime counted as connected time, history relabelled.
- An out-of-range port in the Add Peer field surfaced as a 500 instead of a message.
- On a fresh install the four processes could kill each other on first boot.
- `getaddednodeinfo` swallowed every error, making both "skip this round" paths unreachable.
- "First" was implemented twice in the relay profiler, and the copy used for logging had lost its upper bound.

**Efficiency**

The peer ranking query had no `WHERE` and returned every peer ever seen — a table that by design never shrinks — to render ten rows. The home widget built two full rankings for four numbers. One `getaddednodeinfo` per sync tick instead of two, block height off the SSE event instead of a 20-second RPC poll, and two redundant indexes dropped.

**Dashboard**

Table re-renders are held while an action is in flight or the focus is in the table, so a poll can no longer swallow a click. The rotation toggle could revert itself from an in-flight request; the pool checkbox had no protection at all. Failed refreshes are visible instead of silently showing stale numbers.
