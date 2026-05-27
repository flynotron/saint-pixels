/**
 * src/helpers/localBypass.js
 *
 * mobileDebug local-network auth bypass.
 *
 * ACTIVATION
 * ----------
 * Set  MOBILE_DEBUG=true  in your .env file (which is gitignored).
 * Without that flag every function in this module is a no-op and the
 * bypass is completely inactive — no LAN IP receives any special treatment.
 *
 * WHAT IT DOES (when active)
 * --------------------------
 * Requests arriving from a private/loopback IP are given a synthetic
 * anonymous session so they can place pixels and chat without logging in.
 *
 * The anonymous username is  anon-<last-octet>  for IPv4 addresses and
 * anon-local  for IPv6 loopback / link-local addresses.
 *
 * SECURITY
 * --------
 * • This file is safe to commit — it contains no secrets.
 * • The .env file that enables it is gitignored (see .gitignore).
 * • The bypass is ONLY active when MOBILE_DEBUG=true is explicitly set.
 * • It only affects private RFC-1918 / loopback addresses — public IPs
 *   always go through the normal auth flow regardless of this flag.
 */

'use strict';

// ── Is the feature enabled? ───────────────────────────────────────────────────
const ENABLED = process.env.NODE_ENV !== 'production' && process.env.MOBILE_DEBUG === 'true';

if (ENABLED) {
  console.log('[mobileDebug] Local-network auth bypass is ACTIVE. Do NOT enable in production.');
}

// ── Private / loopback address detection ─────────────────────────────────────
/**
 * Returns true if the given IP string is a loopback or RFC-1918 private address.
 * Handles IPv4, IPv4-mapped IPv6 (::ffff:x.x.x.x), and IPv6 loopback (::1).
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (!ip) return false;

  // Strip IPv4-mapped IPv6 prefix so we can test the IPv4 part normally
  const addr = ip.replace(/^::ffff:/i, '');

  // IPv6 loopback and link-local
  if (addr === '::1') return true;
  if (/^fe80:/i.test(addr)) return true;

  // IPv4 checks
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;

  const [a, b] = parts;
  return (
    a === 127 ||                        // 127.0.0.0/8   loopback
    a === 10 ||                         // 10.0.0.0/8    RFC-1918
    (a === 172 && b >= 16 && b <= 31) ||// 172.16.0.0/12 RFC-1918
    (a === 192 && b === 168)            // 192.168.0.0/16 RFC-1918
  );
}

/**
 * Derive a short anonymous username from an IP address.
 * e.g. "192.168.1.42" → "anon-42"
 *
 * @param {string} ip
 * @returns {string}
 */
function anonUsername(ip) {
  if (!ip) return 'anon-local';
  const clean = ip.replace(/^::ffff:/i, '');
  if (clean === '::1' || /^fe80:/i.test(clean)) return 'anon-local';
  const parts = clean.split('.');
  const last = parts[parts.length - 1];
  return `anon-${last}`;
}

// ── Express middleware ────────────────────────────────────────────────────────
/**
 * Express middleware.  When MOBILE_DEBUG is active and the request comes from
 * a private IP, attaches  req.localBypassUser  (the anonymous username string)
 * to the request object so downstream handlers can skip token validation.
 *
 * When MOBILE_DEBUG is inactive this middleware is a transparent pass-through.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function localBypassMiddleware(req, res, next) {
  if (ENABLED && isPrivateIp(req.ip)) {
    req.localBypassUser = anonUsername(req.ip);
  }
  next();
}

// ── Utility used by getSession and action handlers ────────────────────────────
/**
 * Returns the bypass username if this request should skip token auth,
 * or null if normal auth should be used.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getBypassUser(req) {
  return req.localBypassUser || null;
}

module.exports = { localBypassMiddleware, getBypassUser, isPrivateIp, ENABLED };
