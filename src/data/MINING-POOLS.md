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

Coinbase tags and payout addresses the list above does not have yet, kept apart so a refresh never
overwrites them; on the same tag, the extra list wins. Most are pools that run
ckpool, which writes "ckpool" into every coinbase: without a tag of their own,
Braiins Solo, Satoshi Radio or mutatrum would all show as CKPool. The longest
tag wins, so "/braiinssolo/" beats "ckpool" in the same text.

Where each tag comes from:

- Public Pool's tags are the default of its software, so a block from a
  Public Pool someone runs at home carries them too: the name, no link.
- Braiins Solo, Parasite, Public Pool, FutureBit Apollo Solo: the tags of
  [mempool/mining-pools](https://github.com/mempool/mining-pools)
  `pools-v2.json` (MIT, © mempool and contributors).
- AtlasPool, Braiins Solo, Satoshi Radio, SoloHash, SoloMining.de, 2Miners,
  Parasite, mutatrum, Blitzpool, MintSolo: the text in a mining job each pool
  handed out to a stratum subscribe, October 2026.
- F2Pool's lowercase tags "/f2pool/m" and "/f2pool.kz/c" (F2Pool's
  Kazakhstan branch): the list has only "F2Pool", and the match is exact.
  Both pay 546 sat to 1K6KoYC69NnafWJ7YgtrpwJxBLiijWqwa6 like F2Pool's other
  blocks (971868, 883290), and mempool.space names them F2Pool.
- MARA Pool, "Sv2/MARA": block 975369 (11 November 2026) says "Sv2/MARA" followed by
  two US flags, the style of MARA's "MARA Made in USA" tag; its payout address
  32i1m6gNcSHwiPX9nfTNXVjme9j5DU8y5g is in no list, so only the tag is taken.
- NiceHash, bc1q85z0lxe86pkcg2fmppfnykat2375s0pnxjx9sc: block 932129 pays its
  whole reward there and says "/NiceHashMining/" in its coinbase; 971652 and
  971719 pay the same address with no text.
- NiceHash, bc1qevfvr7n7hqu56eu5cqunk22nuwds0dkjgqqxe6: eleven blocks from
  972547 (22 October 2026) on, no text in the coinbase. Transaction
  2dd5141f43db83117ac7149f25206c96e6328ccad174917d9668f3ff9731ec41 (block
  975056) spends six of their rewards together with two from the NiceHash
  address above, so one wallet holds both.
- NiceHash EasyMining, bc1q28d6w54p3xc03a2j5ppmkua09akep9vtke20ny: takes
  exactly 3 % of the reward in blocks 972373, 974087 and 974683, the finder
  the rest. NiceHash announced 972373 and 974087 as EasyMining blocks
  (x.com/NiceHashMining/status/2112875109207724109 and .../2116771269089656836).

When bitcoin-data/mining-pools takes one of them in, its entry here can go.
