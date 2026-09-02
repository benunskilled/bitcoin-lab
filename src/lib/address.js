'use strict';

/**
 * Everything this app knows about the shape of a peer address, in one place.
 *
 * These used to live in three modules that each grew their own parser as it
 * needed one, which is how "what exactly is an address here" stopped having a
 * single answer - and address formats have been the source of real bugs twice:
 * an unbracketed IPv6 literal being mis-split into a bogus host and port, and
 * a stored address that could never match Core's own formatting.
 *
 * The one rule worth remembering: Bitcoin Core writes any address containing a
 * colon in bracket notation - `[2001:db8::1]:8333` (CService::ToStringAddrPort).
 * trusted_peer.address is compared against getpeerinfo's `addr` by string
 * equality, so anything we store or hand to an RPC has to match that exactly.
 */

// Splits a user-supplied host string into { addr, port: number|null }.
//
// This needs more care than a trailing /:(\d+)$/ once IPv6 is in play: an
// unbracketed literal like "2001:db8::86" uses colons as hextet separators, so
// the naive split slices off "86" as a "port" and leaves the mangled
// "2001:db8:" behind as the host - wrong for any IPv6 address whose last
// hextet happens to look like a 2-5 digit decimal number. Bracket notation is
// therefore the only form treated as carrying an explicit port for anything
// IPv6-shaped; a bare address with two or more colons is always a portless
// IPv6 host.
function resolveHostPort(input) {
  const bracketed = input.match(/^\[(.+)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    const [, addr, portStr] = bracketed;
    return { addr, port: portStr ? Number(portStr) : null };
  }
  const colonCount = (input.match(/:/g) || []).length;
  if (colonCount >= 2) {
    return { addr: input, port: null };
  }
  // 1-5 digits, not 2-5: Core reports I2P peers with port 0, and the narrower
  // pattern left ":0" glued to the host. Single-digit ports are not valid for
  // anything anyway - isValidPort rejects them later, with a real message.
  const explicitPortMatch = input.match(/^(.+):(\d{1,5})$/);
  if (explicitPortMatch) {
    return { addr: explicitPortMatch[1], port: Number(explicitPortMatch[2]) };
  }
  return { addr: input, port: null };
}

// The inverse, in Core's own format - see the bracket rule above.
function formatAddress(addr, port) {
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`;
}

// Best-effort host extraction from a Core-style "addr", so a live peer's
// address (possibly carrying an ephemeral inbound port) can be turned back
// into a bare host for re-probing. Falls back to the input unchanged.
function hostFromAddress(address) {
  const bracketed = address.match(/^\[(.+)\]:\d+$/);
  if (bracketed) return bracketed[1];
  const simple = address.match(/^([^:]+):\d+$/);
  if (simple) return simple[1];
  return address;
}

/**
 * The overlay network an address belongs to, when it is one this app cannot
 * dial - or null for an ordinary reachable address.
 *
 * Bitcoin Core speaks to four networks besides IPv4/IPv6, and the app reaches
 * peers exactly one way: a direct TCP connection from inside its own
 * container. That container has no Tor SOCKS proxy, no I2P SAM bridge and no
 * CJDNS interface, and giving it any of them would mean asking for access to
 * the host's networking - which this app deliberately never does.
 *
 * So a peer on one of these networks is perfectly real, ranks normally, and
 * genuinely delivers blocks - it simply cannot be promoted to a manual peer,
 * because promotion needs a handshake to a dialable address and there is none.
 * Naming that up front is the difference between an honest "can't be kept" and
 * a button that fails with "no node answering on 8333 or 9333", which reads as
 * if the peer merely had the wrong port open.
 *
 * Core's own formats: Tor v3 is a 56-character base32 host under .onion, I2P a
 * 52-character base32 host under .b32.i2p (reported with port 0), and CJDNS is
 * an IPv6 address inside fc00::/8.
 */
function unreachableNetwork(address) {
  const value = String(address || '').toLowerCase();
  if (value.includes('.onion')) return 'Tor';
  if (value.includes('.i2p')) return 'I2P';
  // CJDNS: fc00::/8, i.e. an IPv6 literal whose first byte is 0xfc.
  const bracketed = value.match(/^\[([0-9a-f:]+)\]/);
  const host = bracketed ? bracketed[1] : value;
  if (/^fc[0-9a-f]{2}:/.test(host)) return 'CJDNS';
  return null;
}

// Bare IPv4 "host:port" only - used purely to recognize Umbrel's own internal
// Docker network addresses, which are always plain IPv4. Deliberately returns
// null for anything IPv6 or bracketed rather than guessing.
function ipv4HostFromAddress(address) {
  const m = String(address || '').match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : null;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [rangeIp, prefixLenStr] = cidr.split('/');
  const prefixLen = Number(prefixLenStr);
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(rangeIp) & mask);
}

module.exports = {
  resolveHostPort,
  unreachableNetwork,
  formatAddress,
  hostFromAddress,
  ipv4HostFromAddress,
  ipv4InCidr,
};
