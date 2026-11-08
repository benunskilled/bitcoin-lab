# Does choosing peers make an eclipse attack easier?

Not that I can see, and rotation even adds a hurdle. An eclipse attack needs every one of your node's connections. Your manual peers come on top of Core's ten automatic outbound connections, and an attacker cannot simply take their places: a peer only earns a manual slot by delivering blocks first more often than the peers already there. A peer that holds blocks back – which is what an eclipse needs – never delivers first, so rotation drops it after 50 blocks. A peer could also deliver well at first and hold back later; then it loses its slot the same way, just not at once. Candidates are only ever peers Core connected to by itself; Bitcoin Lab adds no address you did not type in. Inbound connections are never promoted or replaced, and the two block-relay-only connections Core keeps as anchors are left alone.

One thing does change: because rotation drops automatic peers that deliver nothing first, Core picks new outbound peers more often than usual – on my node around 15 to 20 times a day. Each pick follows Core's own rules, but more picks also give an attacker's addresses more chances to be chosen for a while.

One limit: Core spreads its automatic connections across different networks, rotation does not. In theory several manual peers could belong to the same operator, but they are added connectivity, not a replacement for Core's own.

Your node still checks every block it receives, so a bad peer cannot make it accept an invalid one. What checking cannot do is show your node a chain it never hears about. That is the job of the connections Core picks by itself. Rotation does replace some of them, but Core picks each replacement by its own rules, and the two block-relay-only connections are never touched.

---

[← Back to the README](../README.md)
