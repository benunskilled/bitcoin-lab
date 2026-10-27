# mining-pools.json

Which pool mined a block is read off the block itself — the coinbase
transaction carries the address the reward is paid to and a short text the
miner writes. Matching either against this list is how it is done without
asking any service; see [`src/lib/pool-id.js`](../lib/pool-id.js).

Source: **[bitcoin-data/mining-pools](https://github.com/bitcoin-data/mining-pools)**,
MIT licensed (© 2019–2021 btc.com, © 2021– 0xB10C and contributors), the
`pools.json` from its `generated` branch, unchanged. It is the list the block
explorers use, it is rebuilt daily, and it is not only the big pools: solo
CKPool, Bitsolo and a handful of individuals who once found a block are in
there too.

Current copy: 174 coinbase tags, 201 payout addresses, 39 KB. Checked against
ten consecutive blocks on one real node in September 2026: ten of ten
attributed — Foundry three times, F2Pool three times, ViaBTC, Braiins, MARA,
SpiderPool. Four of those matched by payout address, six only by tag, which is
why both are used.

## Refresh

```sh
curl -sL -o src/data/mining-pools.json \
  https://raw.githubusercontent.com/bitcoin-data/mining-pools/generated/pools.json
npm test
```

The tests check that the list still holds what it is supposed to: enough
entries to be the real thing, and the pools that find most blocks today.

## What it cannot do

A miner nobody has listed stays unknown, and that is a normal answer rather
than a fault — Bitcoin Lab then shows the text out of the coinbase as the
miner's own words instead of putting a name on it.

The payout address is checked before the tag because it is where the money
actually went, but a pool paying through a third party will not match it. The
tag is text the miner writes himself: good enough to attribute blocks, and
still a claim rather than a measurement.

## mining-pools-extra.json

Coinbase tags the list above does not have yet, kept apart so a refresh never
overwrites them; on the same tag, the extra list wins. Most are pools that run
ckpool, which writes "ckpool" into every coinbase: without a tag of their own,
Braiins Solo, Satoshi Radio or mutatrum would all show as CKPool. The tag of
the longest match wins, so "/braiinssolo/" beats "ckpool" in the same text.

Where each tag comes from:

- Braiins Solo, Parasite, Public Pool, FutureBit Apollo Solo: the tags of
  [mempool/mining-pools](https://github.com/mempool/mining-pools)
  `pools-v2.json` (MIT, © mempool and contributors).
- AtlasPool, Braiins Solo, Satoshi Radio, SoloHash, SoloMining.de, 2Miners,
  Parasite, mutatrum, Blitzpool, MintSolo: the text in a mining job each pool
  handed out to a stratum subscribe, October 2026.

When bitcoin-data/mining-pools takes one of them in, its entry here can go.
