# Why 50 blocks?

Once a candidate has been observed for at least 50 of the last 500 blocks without delivering any of them first, rotation disconnects it and Core immediately looks for a replacement. A peer that has delivered first at least once in its last 500 blocks is spared by this rule. Only automatic full-relay peers are replaced this way. The two block-relay-only connections that Core keeps as anchors against eclipse attacks are left alone.

A peer needs enough observations to show what it can do. But waiting too long means a strong candidate may disappear before Bitcoin Lab gets the chance to keep it.

The threshold used to be 144 blocks, roughly a day. On my node, a peer delivering 15% of blocks was observed for twenty hours, then dropped by Core before it became eligible for promotion.

The default is now 50 blocks, roughly eight hours. This gives promising peers an earlier chance to earn a manual slot and keeps the search moving when a candidate never delivers first.

An unlucky peer may occasionally be dropped despite having potential. Its history is preserved.

The thresholds described here are defaults. See [Configuration](configuration.md) for the available settings.

---

[← Back to the README](../README.md)
