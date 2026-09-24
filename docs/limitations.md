# Practical limitations

## History grows over time

Peer observations are kept so delivery history remains available. The 500-block ranking window does not limit how much history is stored.

On the author's node with around 200 peers, this data grew by about 3 MB per day, or roughly 1.1 GB per year (measured in September 2026). The Storage panel shows current usage and lets you clear measurements while keeping your manual selection.

## Running Core on another machine

On Umbrel, Bitcoin Lab and Bitcoin Core share the same system clock.

If you connect Bitcoin Lab to Core on another machine, keep both clocks synchronised. The dashboard warns when it detects a time difference that could interfere with First attribution.

## Addresses Bitcoin Lab cannot dial

Tor, I2P and CJDNS peers are measured, but Bitcoin Lab cannot add them as manual connections. The same applies to inbound IPv6 peers whose real address is hidden by Docker on Umbrel.

These peers remain part of the ranking while connected. See [Configuration](configuration.md#docker-and-umbrel-networking) for the networking settings.

---

[← Back to the README](../README.md)
