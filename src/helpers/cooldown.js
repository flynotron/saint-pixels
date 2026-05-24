/** Injected by initializeDatabase / server startup */
let _db = null;

const COOLDOWN_MS = 5000;

/**
 * @param {import('better-sqlite3').Database} db
 */
function setDb(db) {
  _db = db;
}

/**
 * Returns the remaining cooldown in ms for a user (0 if none).
 * @param {string} username
 * @returns {number}
 */
function getCooldown(username) {
  const row = _db.prepare(
    'SELECT last_pixel_at FROM cooldowns WHERE username = ?'
  ).get(username);
  if (!row) return 0;
  const remaining = row.last_pixel_at + COOLDOWN_MS - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Reset the cooldown timer for a user (called after a successful pixel place).
 * @param {string} username
 */
function resetCooldown(username) {
  _db.prepare(`
    INSERT INTO cooldowns (username, last_pixel_at)
    VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET last_pixel_at = excluded.last_pixel_at
  `).run(username, Date.now());
}

module.exports = { setDb, getCooldown, resetCooldown };
