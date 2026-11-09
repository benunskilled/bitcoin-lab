"""Build src/data/network.bin - which operator and which country an address
belongs to - from ip-location-db's DB-IP Lite databases (CC BY 4.0,
https://db-ip.com). See src/data/NETWORK.md.

    python3 -m venv venv && venv/bin/pip install maxminddb pycountry-convert
    base=https://github.com/sapics/ip-location-db/releases/download/latest
    for f in dbip-asn-ipv4 dbip-asn-ipv6 dbip-country-ipv4 dbip-country-ipv6; do
      curl -sLO $base/$f.mmdb; done
    venv/bin/python scripts/gennet.py . src/data/network.bin test/data/network-vectors.json

The rotation spreads the manual peers over operators and regions, and needs
both answers for any peer without asking a service. Peer Map embeds the same
operator table (its asn.bin); this adds the country, and the continent the
country is on as the region.

Layout (big-endian):
    "BLNET1"
    nAS uint32, then per AS: number uint32, name length uint8, name UTF-8
    n4 uint32, n4 x uint32 range start, n4 x uint32 AS index
    n6 uint32, n6 x uint64 range start (upper 64 bits), n6 x uint32 AS index
    nCC uint16, then per country: 2 bytes ISO code, 1 byte region index
    c4 uint32, c4 x uint32 range start, c4 x uint16 country index
    c6 uint32, c6 x uint64 range start (upper 64 bits), c6 x uint16 country index
Index 0 is "unknown" in both tables and fills the gaps between ranges, so a
lookup never falls through into the next range. Adjacent ranges with the same
answer are merged. Regions: 0 unknown, 1 AF, 2 AS, 3 EU, 4 NA, 5 OC, 6 SA.
"""
import ipaddress
import json
import os
import random
import struct
import sys

import maxminddb
import pycountry_convert

REGIONS = ["", "AF", "AS", "EU", "NA", "OC", "SA"]


def ranges(path, v6, key):
    """Sorted (start, value) with gaps marked as None, merged."""
    db = maxminddb.open_database(path)
    rows = []
    for net, rec in db:
        value = key(rec) if rec else None
        if value is None:
            continue
        net = ipaddress.ip_network(net)
        start, end = int(net.network_address), int(net.broadcast_address)
        if v6:
            start >>= 64
            end >>= 64
        rows.append((start, end, value))
    db.close()
    rows.sort(key=lambda r: (r[0], r[1]))
    out = []
    prev_end = -1
    for start, end, value in rows:
        if prev_end >= 0 and start > prev_end + 1:
            out.append((prev_end + 1, None))
        if out and out[-1][1] == value:
            prev_end = max(prev_end, end)
            continue
        if out and out[-1][0] == start:
            out[-1] = (start, value)  # collapsed onto the same 64-bit start: the later one wins
        else:
            out.append((start, value))
        prev_end = max(prev_end, end)
    if out and prev_end < (1 << (64 if v6 else 32)) - 1:
        out.append((prev_end + 1, None))  # nothing after the last range either
    return out


def region_of(cc):
    try:
        return REGIONS.index(pycountry_convert.country_alpha2_to_continent_code(cc))
    except (KeyError, ValueError):
        return 0


def main(src, out_path, vectors_path):
    names = {}

    def asn(rec):
        num = rec.get("autonomous_system_number")
        if num is None:
            return None
        name = (rec.get("autonomous_system_organization") or "").strip()
        if name and (num not in names or len(name) < len(names[num])):
            names[num] = name
        names.setdefault(num, "")
        return num

    def country(rec):
        cc = rec.get("country_code") or (rec.get("country") or {}).get("iso_code")
        return cc if cc and len(cc) == 2 else None

    a4 = ranges(os.path.join(src, "dbip-asn-ipv4.mmdb"), False, asn)
    a6 = ranges(os.path.join(src, "dbip-asn-ipv6.mmdb"), True, asn)
    c4 = ranges(os.path.join(src, "dbip-country-ipv4.mmdb"), False, country)
    c6 = ranges(os.path.join(src, "dbip-country-ipv6.mmdb"), True, country)

    numbers = sorted(names)
    as_index = {num: i + 1 for i, num in enumerate(numbers)}
    codes = sorted({cc for _, cc in c4 + c6 if cc})
    cc_index = {cc: i + 1 for i, cc in enumerate(codes)}

    u32, u16 = struct.Struct(">I"), struct.Struct(">H")
    parts = [b"BLNET1", u32.pack(len(numbers) + 1), u32.pack(0) + bytes([0])]
    for num in numbers:
        name = names[num].encode()[:255]
        parts.append(u32.pack(num) + bytes([len(name)]) + name)

    def block(rows, start_fmt, index, idx):
        s = struct.Struct(start_fmt)
        parts.append(u32.pack(len(rows)))
        parts.append(b"".join(s.pack(start) for start, _ in rows))
        parts.append(b"".join(idx.pack(index.get(v, 0)) for _, v in rows))

    block(a4, ">I", as_index, u32)
    block(a6, ">Q", as_index, u32)
    parts.append(u16.pack(len(codes) + 1) + b"\0\0" + bytes([0]))
    for cc in codes:
        parts.append(cc.encode() + bytes([region_of(cc)]))
    block(c4, ">I", cc_index, u16)
    block(c6, ">Q", cc_index, u16)

    blob = b"".join(parts)
    with open(out_path, "wb") as fh:
        fh.write(blob)
    print(f"{out_path}: {len(blob):,} bytes - {len(numbers):,} networks, {len(codes)} countries, "
          f"{len(a4):,}/{len(a6):,} operator and {len(c4):,}/{len(c6):,} country ranges (IPv4/IPv6)")

    # Addresses with the answer the source databases give for them directly,
    # for test/network.test.js to check the table against.
    rnd = random.Random(1)
    dbs = {k: maxminddb.open_database(os.path.join(src, f"dbip-{k}.mmdb"))
           for k in ("asn-ipv4", "asn-ipv6", "country-ipv4", "country-ipv6")}
    vectors = []
    while len(vectors) < 600:
        v6 = len(vectors) % 3 == 0
        if v6:
            addr = str(ipaddress.IPv6Address((0x2000 << 112) | rnd.getrandbits(125)))
        else:
            addr = str(ipaddress.IPv4Address(rnd.getrandbits(32)))
        a = dbs["asn-ipv6" if v6 else "asn-ipv4"].get(addr)
        c = dbs["country-ipv6" if v6 else "country-ipv4"].get(addr)
        if not a and not c:
            continue
        vectors.append({
            "ip": addr,
            "asn": (a or {}).get("autonomous_system_number", 0),
            "country": country(c) if c else "",
        })
    with open(vectors_path, "w") as fh:
        json.dump(vectors, fh, indent=0)


if __name__ == "__main__":
    main(*sys.argv[1:4])
