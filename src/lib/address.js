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
  const bracketed = input.match(/^\[(.+)\](?::(\d{2,5}))?$/);
  if (bracketed) {
    const [, addr, portStr] = bracketed;
    return { addr, port: portStr ? Number(portStr) : null };
  }
  const colonCount = (input.match(/:/g) || []).length;
  if (colonCount >= 2) {
    return { addr: input, port: null };
  }
  const explicitPortMatch = input.match(/^(.+):(\d{2,5})$/);
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
  formatAddress,
  hostFromAddress,
  ipv4HostFromAddress,
  ipv4InCidr,
};
