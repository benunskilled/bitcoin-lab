# Protected peers stay your choice

Use the padlock to keep a peer in your manual selection regardless of its ranking. Rotation will neither replace it with a stronger candidate nor park it when it goes offline. Peers you type in are protected automatically.

Manual peers that were already set in Core, for example in `bitcoin.conf` or in Umbrel's Bitcoin Node settings, are taken over as protected as well. Bitcoin Lab adopts up to eight in total; any beyond that stay in Core's own list and are left untouched.

Protection does not affect measurement or ranking. Click the padlock again whenever you want rotation to manage that peer's place.

If all eight manual peers are protected, rotation continues searching among automatic outbound connections, but cannot promote a candidate until you release a place.

---

[← Back to the README](../README.md)
