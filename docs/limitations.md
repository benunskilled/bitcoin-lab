# Known limitations

- **The numbers here are from one node.** They are what happened on the machine
  this app was built on. They are not a controlled benchmark and not a prediction
  for yours.
- **Inbound IPv6 peers show no address.** Docker can only hand an inbound IPv6
  connection to an IPv4-only container by relaying it through docker-proxy, which
  re-originates the connection from the Docker bridge gateway. Core never learns
  the peer's real address, so there is nothing for this app to recover or act on.
  Those rows are labelled honestly instead of showing a meaningless local IP.
- **Relay observations are never pruned.** They *are* the ranking, so they are
  kept whatever their age — about four megabytes a day on a node with a couple of
  hundred peers, one and a half gigabytes a year. The Storage panel shows what it
  currently costs and lets you delete it if you want the space back.
- **Core has to share this app's clock.** Point it at a node on a different
  machine and the two clocks have to agree to within about two seconds. Otherwise
  no peer is ever credited, First % stays at 0, and nothing in the log says why.


---

[← back to the README](../README.md)
