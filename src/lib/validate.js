'use strict';

/**
 * Shared input validation for anything that ends up being handed to
 * `net.connect()`.
 *
 * This exists because of a real failure mode, not for tidiness: Node throws
 * ERR_SOCKET_BAD_PORT *synchronously* for a port outside 1-65535, and the
 * stratum-race process calls net.connect() from inside a setInterval. One
 * mistyped port ("333333" instead of "33333") stored as an enabled pool was
 * therefore enough to kill that process on every single tick - including
 * immediately after `restart: on-failure` brought it back, since the bad row
 * is still in the database. That is an unbreakable crash loop no restart can
 * clear. So: validate on the way in, and defend again on the way out (see
 * syncConnections in stratum-race.js).
 */

function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// Hostname or IPv4/IPv6 literal. Deliberately permissive about exotic but
// legal hostnames, strict about what actually breaks net.connect() or makes
// a pool row unusable: empty values, whitespace, control characters, and
// anything carrying a scheme, path or credentials.
const HOST_ALLOWED = /^[a-zA-Z0-9._:[\]-]+$/;

function isValidHost(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (host.length < 1 || host.length > 255) return false;
  return HOST_ALLOWED.test(host);
}

// Returns { ok: true, value } or { ok: false, error } for a pool definition
// arriving from the HTTP API. The label is the only free-text field; it is
// length-capped here and HTML-escaped at render time (see app.js).
function validatePool({ label, host, port }) {
  const cleanLabel = typeof label === 'string' ? label.trim() : '';
  if (!cleanLabel) return { ok: false, error: 'label is required' };
  if (cleanLabel.length > 64) return { ok: false, error: 'label must be 64 characters or fewer' };
  if (!isValidHost(host)) return { ok: false, error: 'host must be a valid hostname or IP address' };
  if (!isValidPort(port)) return { ok: false, error: 'port must be a whole number between 1 and 65535' };
  return { ok: true, value: { label: cleanLabel, host: String(host).trim(), port: Number(port) } };
}

module.exports = { isValidPort, isValidHost, validatePool };
