# Eight places for proven peers

Bitcoin Core provides eight manual connection slots in addition to its usual ten automatic outbound connections. Bitcoin Lab uses those eight slots to keep peers that have earned their place through measured block delivery.

**Your strongest peers are remembered across restarts.** When Core comes back online, Bitcoin Lab restores your saved manual selection so Core can reconnect to those peers straight away. You keep the set you have built instead of starting the search from scratch.

The automatic outbound connections keep the search moving: rotation disconnects candidates that never deliver first, and Core looks for replacements. See [Why 50 blocks?](why-50-blocks.md) for the rule.

This gives the two groups different jobs: the manual set holds on to proven peers, while the automatic connections keep introducing new candidates.

---

[← Back to the README](../README.md)
