const crypto = require('crypto');

/** Sessions TTL: 30 days in milliseconds */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Injected by initializeDatabase / server startup */
let _db = null;

/**
 * Call once at startup to wire up the database.
 * @param {import('better-sqlite3').Database} db
 */
function setDb(db) {
  _db = db;
}

/**
 * Create a new session for the given username.
 * Returns the Bearer token string.
 * @param {string} username
 * @returns {string}
 */
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  _db.prepare(
    'INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, username, now, now + SESSION_TTL_MS);

  // Opportunistically prune expired sessions (1-in-50 chance to keep it cheap)
  if (Math.random() < 0.02) {
    _db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  return token;
}

/**
 * Destroy a session by token.
 * @param {string} token
 * @returns {boolean}
 */
function closeSession(token) {
  if (!token) return false;
  const info = _db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return info.changes > 0;
}

/**
 * Look up a valid (non-expired) session from a request.
 * Returns { username, created_at } or null.
 * @param {import('express').Request} req
 * @returns {{ username: string, created_at: number } | null}
 */
function getSession(req) {
  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type !== 'Bearer' || !token) return null;

  const row = _db.prepare(
    'SELECT username, created_at FROM sessions WHERE token = ? AND expires_at > ?'
  ).get(token, Date.now());

  return row || null;
}

module.exports = { setDb, createSession, closeSession, getSession };
