# Does choosing peers make an eclipse attack easier?

Not that I can see, and rotation even adds a hurdle. An eclipse attack needs every one of your node's connections. Your manual peers come on top of Core's ten automatic outbound connections, and an attacker cannot simply take their places: a peer only earns a manual slot by delivering blocks first more often than the peers already there. A peer that holds blocks back – which is what an eclipse needs – never delivers first, so rotation drops it after 50 blocks. Candidates are only ever peers Core connected to by itself; Bitcoin Lab adds no address you did not type in. Inbound connections are never promoted or replaced, and the two block-relay-only connections Core keeps as anchors are left alone.

One thing does change: because rotation drops automatic peers that deliver nothing first, Core picks new outbound peers more often than usual – on my node around 15 to 20 times a day. Each pick follows Core's own rules, but more picks also give an attacker's addresses more chances to be chosen for a while.

Your node still checks every block it receives. A bad peer can hold a block back, but it cannot make your node accept an invalid one. At worst, a weak manual set brings you blocks later, not a different chain.

---

[← Back to the README](../README.md)
