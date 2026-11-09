# network.bin

Which operator (AS number and name) and which country an IP address belongs
to, and the region - the continent - that country is on. The peer rotation
spreads the manual peers over operators and regions with it
(`src/lib/peer-rotation/spread.js`), and the dashboard shows it under each
manual peer.

Built by [`scripts/gennet.py`](../../scripts/gennet.py) from **DB-IP's IP to
ASN Lite and IP to Country Lite** databases, licensed CC BY 4.0
(<https://db-ip.com>). The dashboard footer carries the attribution link the
licence asks for. The `.mmdb` files come from the `latest` release of
<https://github.com/sapics/ip-location-db>, which republishes that data and
rebuilds it daily - not from npm, where the same project says the data has
errors and updates have stopped. Peer Map embeds the same operator table.

The continent of each country comes from `pycountry-convert` at build time.
Current table: database build 2026-11-08, 83,024 networks, 250 countries,
13,788,128 bytes.

## Refresh

```sh
python3 -m venv venv && venv/bin/pip install maxminddb pycountry-convert
base=https://github.com/sapics/ip-location-db/releases/download/latest
for f in dbip-asn-ipv4 dbip-asn-ipv6 dbip-country-ipv4 dbip-country-ipv6; do
  curl -sLO $base/$f.mmdb; done
venv/bin/python scripts/gennet.py . src/data/network.bin test/data/network-vectors.json
npm test
```

This also rewrites `test/data/network-vectors.json`, 600 sample addresses with
the answers the source databases give for them, which `test/network.test.js`
checks the table against.

## What the table cannot answer

IPv6 is keyed on the upper 64 bits; where two networks share one `/64`, only
one of them survives the build. Tor, I2P and CJDNS addresses have no operator
or country; the rotation treats Tor and I2P as regions of their own.
