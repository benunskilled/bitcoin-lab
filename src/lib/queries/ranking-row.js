'use strict';

/**
 * What one row of the peer ranking MEANS - the half of the ranking that is
 * judgement rather than SQL.
 *
 * The query next door returns columns; everything here decides what they say
 * about a peer: which network it is really on, whether it is a peer at all or
 * a neighbouring app on this same host, whether it may be displaced yet, and
 * the two rates it is judged by. Nearly every comment in this file marks a
 * case that was once classified wrong, which is the reason it is worth its own
 * file: the classification is the part that keeps being subtle.
 */

const config = require('../config');
const { ipv4HostFromAddress, ipv4InCidr, unreachableNetwork } = require('../address');
const { peerScore } = require('../score');

// Core's spelling of the network, turned into the display name this app uses.
// Only the three it cannot dial get a name; ipv4, ipv6 and
// not_publicly_routable are the ordinary case and get none, which is what the
// rest of the code means by "no private network".
const CORE_NETWORK_NAMES = { onion: 'Tor', i2p: 'I2P', cjdns: 'CJDNS' };

function networkFromCore(network) {
  return CORE_NETWORK_NAMES[String(network || '').toLowerCase()] || null;
}

// A subver like "/electrs:0.11.1/" -> "electrs" - just enough to name which
// local app a same-host peer connection belongs to.
function localAppNameFromSubver(subver) {
  if (!subver) return null;
  const stripped = String(subver).replace(/^\/+|\/+$/g, '');
  const name = stripped.split(':')[0];
  return name || null;
}

function statusFor(r, trusted) {
  const live = Boolean(r.liveDirection);
  if (trusted && live) return 'MANUAL LIVE';
  if (trusted && !live) return 'MANUAL OFFLINE';
  if (live) return `${(r.liveConnectionType || r.liveDirection || 'LIVE').toUpperCase()}`;
  return 'OFFLINE';
}

function mapRankingRow(now, recent = new Map(), graceFrom = 0) {
  return (r) => {
    // "Trusted" isn't only what's in our own trusted_peer table - Core
    // itself reports connection_type 'manual' for ANY addnode'd peer,
    // including ones added outside this app entirely (bitcoin-cli addnode,
    // -addnode= in bitcoin.conf, or a peer added before this table
    // existed). Treating those as untrusted was the bug behind a manual
    // peer showing up in the Outbound panel with an "Add as Manual" button
    // instead of "Remove" - Core already considers it manual, so we should
    // too, immediately, without waiting for the background adoption sync
    // (see peer-sync.js adoptExternalManualPeers) to catch up.
    const trusted = Boolean(r.trusted) || r.liveConnectionType === 'manual';
    // An inbound IPv6 peer relayed through Docker's docker-proxy shows up in
    // Core's own getpeerinfo as the Docker bridge gateway address, not the
    // peer's real one - Core itself never learns the true source, so there
    // is no real address for us to recover or act on here (see config.js).
    // Flag it so the UI can label it honestly instead of displaying (or
    // letting the user try to manually add/probe) a meaningless local IP.
    const sourceObscured = r.address.startsWith(`${config.dockerProxyMaskedAddressHost}:`);
    // Tor / I2P / CJDNS: a real peer that ranks normally and really does
    // deliver blocks, but that this app can never dial, so it can never be
    // promoted. Carried on the row so the dashboard can say so instead of
    // offering an action that always fails, and so the rotation loop can skip
    // it rather than spending a probe on it every pass.
    //
    // Core's own answer first, the address only as a fallback for sessions
    // written before that was recorded. The address is not a reliable source:
    // an INBOUND Tor peer reaches Core through the local Tor proxy and carries
    // that proxy's plain address, so every one of them read as an ordinary
    // local peer - see the localUmbrelPeer note below, which is what they were
    // being mistaken for.
    const privateNetwork = networkFromCore(r.coreNetwork) ?? unreachableNetwork(r.address);
    const recentRow = recent.get(r.id);
    // Everything else inside Umbrel's shared internal Docker network isn't
    // an external peer at all - it's another app on the same host (electrs,
    // mempool's indexer, etc.) connecting to Core's P2P port directly, the
    // same way a real peer would. Its address is perfectly real (unlike
    // sourceObscured above), just not "a peer" in any useful sense - it's
    // already connected via the host's own network, so there's nothing to
    // manually add and nothing worth disconnecting on purpose either.
    //
    // A peer on one of the three networks above is excluded even though its
    // address falls in that range: an inbound Tor or I2P connection arrives
    // from a sibling container (Umbrel's Tor proxy) and is therefore addressed
    // like a local app, while being a genuine external peer.
    const ipv4Host = ipv4HostFromAddress(r.address);
    const localUmbrelPeer = !sourceObscured
      && privateNetwork == null
      && ipv4Host != null
      && ipv4InCidr(ipv4Host, config.umbrelInternalNetworkCidr);
    // The same range, but for a peer Core has already named as Tor, I2P or
    // CJDNS: it dialled IN through this Umbrel's own proxy container, so the
    // address Core reports is that container's. Real, and useless - it names
    // a neighbour of ours, not the peer. An OUTBOUND connection on one of
    // those networks carries the address Core dialled (a .onion, say), which
    // IS the peer's own and worth showing, so the range test separates them.
    //
    // Without this the row fell through to its raw address. That is not the
    // old mislabelling - the network comes from Core now, so it is no longer
    // filed as a local app - but a bare 10.21.22.10:57844 tells a reader
    // nothing, and the only place the word Tor appeared was a note over in
    // the actions column.
    const proxiedPrivatePeer = privateNetwork != null
      && ipv4Host != null
      && ipv4InCidr(ipv4Host, config.umbrelInternalNetworkCidr);
    return {
      address: r.address,
      sourceObscured,
      localUmbrelPeer,
      privateNetwork,
      proxiedPrivatePeer,
      localAppName: localUmbrelPeer ? localAppNameFromSubver(r.client) : null,
      trusted,
      trustedLabel: r.trustedLabel,
      // When this address entered our own trusted_peer table. Null for a peer
      // Core alone calls 'manual' (an addnode issued outside this app that the
      // adoption sync has not picked up yet). The offline-grace rule needs it:
      // a manual peer that has never once connected has no offlineSinceMs to
      // measure from, so its grace runs from when it was added instead.
      trustedSince: r.trustedSince ?? null,
      // Protected by hand: the rotation must not displace or park it. Only
      // meaningful on a manual peer; false everywhere else.
      kept: Boolean(r.kept),
      // Still inside the grace a new slot holder gets before it can be
      // displaced. Measured from when this peer entered the manual set, which
      // is what the dashboard has always claimed ("safe for its first 50
      // blocks") - the rule used to read the peer's LIFETIME block count
      // instead, so a peer with any history at all was displaceable the
      // second it was promoted. That is how a peer promoted at 5h43m lost its
      // slot again ten minutes later on a real node.
      withinNewManualGrace: r.trustedSince != null && r.trustedSince > graceFrom,
      everManual: Boolean(r.everManual),
      eligible: r.eligible,
      first: r.first,
      firstPct: r.eligible > 0 ? (100 * r.first) / r.eligible : null,
      // The same two counts over the recent window only, and the score that
      // weighs them against the lifetime pair (see score.js). firstPct stays
      // exactly what it was - the lifetime rate, shown in the table and used
      // for everything that asks what a peer has been worth over its life: its
      // offline grace, how long it is kept parked, how often it is re-probed.
      // The score answers a different question - who should hold a slot right
      // now - and only the rotation's ordering uses it.
      recentEligible: recentRow ? recentRow.eligible : 0,
      recentFirst: recentRow ? recentRow.first : 0,
      score: peerScore({
        first: r.first,
        eligible: r.eligible,
        recentFirst: recentRow ? recentRow.first : 0,
        recentEligible: recentRow ? recentRow.eligible : 0,
      }),
      live: Boolean(r.liveDirection),
      direction: r.liveDirection,
      connectionType: r.liveConnectionType,
      client: r.client || null,
      currentSessionMs: r.liveDirection ? now - r.liveStartedAt : null,
      // How long a trusted-but-not-currently-live peer has been offline -
      // Core reconnects manuals on its own, but that can fail silently
      // (peer went dark, network hiccup, slot contention) and a peer that's
      // been offline for hours is worth surfacing, not just a flat pill.
      // Only meaningful for a trusted peer that isn't live and has actually
      // had a session before (never null-vs-0 ambiguity: a peer trusted but
      // never yet seen connecting has no latestEndedAt at all).
      offlineSinceMs: !r.liveDirection && r.latestEndedAt != null ? now - r.latestEndedAt : null,
      minPingMs: r.liveMinPingMs,
      lastPingMs: r.liveLastPingMs,
      sessionsCount: r.sessionsCount,
      totalConnectionMs: r.totalMs,
      status: statusFor(r, trusted),
      // Connection-type-only status, ignoring the manual/trusted override -
      // used where "MANUAL LIVE" would just be redundant noise (e.g. the
      // Outbound Peers panel, which already implies live).
      connectionStatus: r.liveDirection ? (r.liveConnectionType || r.liveDirection).toUpperCase() : 'OFFLINE',
    };
  };
}

module.exports = { mapRankingRow };
