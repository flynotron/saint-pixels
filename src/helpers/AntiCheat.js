/**
 * AntiCheat — IP-level pixel rate enforcement.
 *
 * Problem: the per-username cooldown in cooldown.js can be bypassed by
 * registering multiple accounts from the same IP address. Each account has
 * its own cooldown row, so an attacker could round-robin between accounts
 * and place pixels far faster than the 5-second limit allows.
 *
 * Solution: maintain a SECOND cooldown keyed by IP address in-memory and
 * in the DB. A pixel placement (or erase) from ANY account on a given IP
 * resets that IP's timer. If the IP is still within its cooldown window,
 * the request is rejected regardless of which account is making it.
 *
 * Additionally, if we detect that multiple DIFFERENT usernames are sharing
 * the same IP and placing pixels within a short window, we flag the IP as
 * suspicious and apply a stricter (longer) cooldown automatically.
 *
 * Folder: src/helpers/AntiCheat.js
 */

/** @type {import('better-sqlite3').Database|null} */
let _db = null;

/**
 * In-memory set of IPs currently in-flight (between checkIp and recordIp).
 * Closes the race-condition window where two concurrent requests from the same
 * IP both pass checkIp before either has called recordIp.
 * @type {Set<string>}
 */
const _ipInFlight = new Set();

/**
 * Base cooldown in ms — mirrors the per-user cooldown in cooldown.js.
 * Keep these in sync or import from a shared config if you add one.
 */
const BASE_COOLDOWN_MS = 3_000;

/**
 * When 2+ distinct usernames are seen from the same IP within this window,
 * the IP is considered suspicious and gets a stricter cooldown multiplier.
 */
const MULTI_ACCOUNT_WINDOW_MS = 60_000;   // 1 minute lookback
const MULTI_ACCOUNT_THRESHOLD = 2;        // ≥2 different usernames = suspicious
const STRICT_COOLDOWN_MULTIPLIER = 3;     // 3× base = 9 s between pixels when flagged

/**
 * @param {import('better-sqlite3').Database} db
 */
function setDb(db) {
  _db = db;

  // Ensure the ip_cooldowns table exists.
  // Uses a separate table so it doesn't pollute the existing cooldowns schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_cooldowns (
      ip   TEXT PRIMARY KEY NOT NULL,
      last_pixel_at INTEGER NOT NULL,
      last_username TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ip_pixel_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ip         TEXT NOT NULL,
      username   TEXT NOT NULL,
      placed_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ip_pixel_log_ip_time
      ON ip_pixel_log(ip, placed_at);
  `);
}

/**
 * Check whether a given IP is allowed to place a pixel right now.
 *
 * Returns an object:
 *   { allowed: true }                         — go ahead
 *   { allowed: false, cooldown: <ms>, reason: <string> }  — blocked
 *
 * @param {string} ip
 * @param {string} username  The username making the request
 * @returns {{ allowed: boolean, cooldown?: number, reason?: string }}
 */
function checkIp(ip, username) {
  if (!_db) return { allowed: true }; // fail open if DB not wired up yet

  const now = Date.now();

  // ── 1. Check IP-level cooldown ──────────────────────────────────────────────
  const row = _db.prepare(
    'SELECT last_pixel_at, last_username FROM ip_cooldowns WHERE ip = ?'
  ).get(ip);

  if (row) {
    // Determine if this IP looks like a multi-account operation
    const isMultiAccount = _isMultiAccountIp(ip, username, now);
    const cooldownMs = isMultiAccount
      ? BASE_COOLDOWN_MS * STRICT_COOLDOWN_MULTIPLIER
      : BASE_COOLDOWN_MS;

    const remaining = row.last_pixel_at + cooldownMs - now;
    if (remaining > 0) {
      const reason = isMultiAccount
        ? 'Multiple accounts detected from this IP. Extended cooldown applied.'
        : 'IP cooldown active.';
      return { allowed: false, cooldown: remaining, reason };
    }
  }

  return { allowed: true };
}

/**
 * Record a successful pixel placement for this IP + username.
 * Call this AFTER the per-user cooldown check passes and the pixel is accepted.
 *
 * @param {string} ip
 * @param {string} username
 */
function recordIp(ip, username) {
  if (!_db) return;

  const now = Date.now();

  // Upsert the IP cooldown timestamp
  _db.prepare(`
    INSERT INTO ip_cooldowns (ip, last_pixel_at, last_username)
    VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      last_pixel_at = excluded.last_pixel_at,
      last_username = excluded.last_username
  `).run(ip, now, username);

  // Append to the log for multi-account detection
  _db.prepare(
    'INSERT INTO ip_pixel_log (ip, username, placed_at) VALUES (?, ?, ?)'
  ).run(ip, username, now);

  // Prune old log entries opportunistically (1-in-20 chance) to keep the table small
  if (Math.random() < 0.05) {
    _db.prepare(
      'DELETE FROM ip_pixel_log WHERE placed_at < ?'
    ).run(now - MULTI_ACCOUNT_WINDOW_MS * 2);
  }
}

/**
 * Returns true if 2 or more DIFFERENT usernames have placed pixels from
 * this IP within MULTI_ACCOUNT_WINDOW_MS, AND the current username is
 * different from the most recently seen one.
 *
 * @param {string} ip
 * @param {string} username
 * @param {number} now
 * @returns {boolean}
 */
function _isMultiAccountIp(ip, username, now) {
  try {
    const rows = _db.prepare(`
      SELECT DISTINCT username FROM ip_pixel_log
      WHERE ip = ? AND placed_at > ?
    `).all(ip, now - MULTI_ACCOUNT_WINDOW_MS);

    const distinctUsers = new Set(rows.map(r => r.username));
    // Always include the current user in the set (they may not be in the log yet)
    distinctUsers.add(username);

    return distinctUsers.size >= MULTI_ACCOUNT_THRESHOLD;
  } catch {
    return false; // fail open
  }
}

/**
 * Express middleware — rejects the request if the IP is on cooldown.
 * Attach BEFORE the per-user cooldown check in PlacePixel / Erase handlers,
 * or use directly in the route middleware chain.
 *
 * Reads the real IP from req.ip (requires `app.set('trust proxy', 1)` in
 * server.js, which is already set).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function ipCooldownMiddleware(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const username = _getUsernameFromReq(req) || '__unknown__';

  // If this IP already has a request in-flight, reject immediately.
  // This closes the race where two concurrent requests both pass checkIp
  // before either has called recordIp.
  if (_ipInFlight.has(ip)) {
    return res.status(429).json({
      error: 'IP cooldown active.',
      cooldown: BASE_COOLDOWN_MS,
    });
  }

  const result = checkIp(ip, username);
  if (!result.allowed) {
    return res.status(429).json({
      error: result.reason,
      cooldown: result.cooldown,
    });
  }

  // Reserve this IP slot for the duration of the request
  _ipInFlight.add(ip);
  // Always release — whether the handler succeeds, throws, or responds early
  res.on('finish', () => _ipInFlight.delete(ip));
  res.on('close',  () => _ipInFlight.delete(ip));

  next();
}

/**
 * Lightweight username extraction from the Bearer token (no session import).
 * Returns null if the token is missing or the DB lookup fails.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function _getUsernameFromReq(req) {
  if (!_db) return null;
  try {
    const auth = req.headers.authorization || '';
    const [type, token] = auth.split(' ');
    if (type !== 'Bearer' || !token) return null;
    const row = _db.prepare(
      'SELECT username FROM sessions WHERE token = ? AND expires_at > ?'
    ).get(token, Date.now());
    return row?.username || null;
  } catch {
    return null;
  }
}

module.exports = { setDb, checkIp, recordIp, ipCooldownMiddleware };
