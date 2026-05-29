/**
 * @param {import('better-sqlite3').Database} db
 */
function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      ip TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_email_verifications_token    ON email_verifications(token);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_expires  ON email_verifications(expires_at);

    CREATE TABLE IF NOT EXISTS palette (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pixel_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(username, day)
    );

    -- One row per board cell — UPSERT keeps only the latest state.
    -- Eliminates the unbounded append-log that was the #1 storage killer.
    CREATE TABLE IF NOT EXISTS pixels (
      username TEXT NOT NULL,
      x        INTEGER NOT NULL,
      y        INTEGER NOT NULL,
      color    TEXT NOT NULL,
      placed_at INTEGER NOT NULL,
      PRIMARY KEY (x, y)
    );

    CREATE INDEX IF NOT EXISTS idx_pixels_username  ON pixels(username);
    CREATE INDEX IF NOT EXISTS idx_pixels_placed_at ON pixels(placed_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_username   ON sessions(username);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS cooldowns (
      username TEXT PRIMARY KEY NOT NULL,
      last_pixel_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_password_resets_token   ON password_resets(token);
    CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);

    -- Append-log of every pixel/erase event ever made — used by timelapse.js.
    -- Unlike 'pixels' (which is an upsert table storing only current state),
    -- this table grows indefinitely and is never pruned.
    -- color = hex string (no #) OR the sentinel value 'erase'.
    CREATE TABLE IF NOT EXISTS pixel_history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT    NOT NULL,
      x         INTEGER NOT NULL,
      y         INTEGER NOT NULL,
      color     TEXT    NOT NULL,
      placed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ph_placed_at ON pixel_history(placed_at);
    CREATE INDEX IF NOT EXISTS idx_ph_username  ON pixel_history(username);
  `);

  // ── Column migrations (SQLite doesn't support IF NOT EXISTS on ALTER TABLE) ──
  try {
    const cols = db.pragma('table_info(accounts)').map(c => c.name);
    if (!cols.includes('email')) {
      db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
    }
    if (!cols.includes('email_verified')) {
      db.exec('ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    }
  } catch (err) {
    console.error('Migration error (accounts):', err);
  }

  // ── pixels table migration: old schema had id PK + no UNIQUE(x,y) ────────────
  // If the old append-log table exists, compact it in-place:
  //   1. Keep only the most-recent row per (x,y).
  //   2. Drop the old id-based primary key index.
  // This runs once and is idempotent — safe to leave in.
  try {
    const pixelCols = db.pragma('table_info(pixels)').map(c => c.name);
    if (pixelCols.includes('id')) {
      console.log('[db] Migrating pixels table from append-log to upsert model…');
      db.exec(`
        -- Keep only the latest row per cell (max id = most recent insert)
        DELETE FROM pixels
        WHERE id NOT IN (
          SELECT MAX(id) FROM pixels GROUP BY x, y
        );

        -- Rebuild as a proper keyed table without the autoincrement id
        CREATE TABLE IF NOT EXISTS pixels_new (
          username  TEXT    NOT NULL,
          x         INTEGER NOT NULL,
          y         INTEGER NOT NULL,
          color     TEXT    NOT NULL,
          placed_at INTEGER NOT NULL,
          PRIMARY KEY (x, y)
        );
        INSERT OR REPLACE INTO pixels_new (username, x, y, color, placed_at)
          SELECT username, x, y, color, placed_at FROM pixels;
        DROP TABLE pixels;
        ALTER TABLE pixels_new RENAME TO pixels;
        CREATE INDEX IF NOT EXISTS idx_pixels_username  ON pixels(username);
        CREATE INDEX IF NOT EXISTS idx_pixels_placed_at ON pixels(placed_at);

        VACUUM;
      `);
      console.log('[db] pixels table migration complete.');
    }
  } catch (err) {
    console.error('Migration error (pixels):', err);
  }

  // ── Default palette ───────────────────────────────────────────────────────────
  try {
    const result = db.prepare('SELECT COUNT(*) AS count FROM palette').get();
    if (result.count === 0) {
      const insertStmt = db.prepare('INSERT INTO palette (label, color) VALUES (?, ?)');
      const defaultPalette = [
        ['Black',  '000000'],
        ['White',  'ffffff'],
        ['Red',    'ef4444'],
        ['Orange', 'fb923c'],
        ['Yellow', 'facc15'],
        ['Green',  '22c55e'],
        ['Cyan',   '06b6d4'],
        ['Blue',   '3b82f6'],
        ['Indigo', '6366f1'],
        ['Violet', '8b5cf6'],
        ['Pink',   'ec4899'],
        ['Light Brown', 'a0785a'],
        ['Beige',  'f5deb3'],
      ];
      db.transaction((colors) => {
        colors.forEach(([label, color]) => insertStmt.run(label, color));
      })(defaultPalette);
    }
  } catch (err) {
    console.error('Failed to populate default palette:', err);
  }
}

/**
 * Periodic maintenance — deletes genuinely expired/used rows that accumulate
 * silently.  Safe to call at any time; runs inside a single transaction.
 *
 * Cleans up:
 *   • expired sessions          (expires_at < now)
 *   • used/expired email tokens (used OR expires_at < now)
 *   • used/expired pw resets    (used OR expires_at < now)
 *   • old pixel_counts rows     (day < 366 days ago — keeps a full year for
 *                                 leaderboard history, deletes the rest)
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ sessions: number, emailVerifications: number, passwordResets: number, pixelCounts: number }}
 */
function runMaintenance(db) {
  const now = Date.now();
  // Keep pixel_counts for the last 366 days (full year + 1 day buffer)
  const cutoffDay = new Date(now - 366 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const results = db.transaction(() => {
    const s  = db.prepare('DELETE FROM sessions           WHERE expires_at < ?').run(now);
    const ev = db.prepare('DELETE FROM email_verifications WHERE used = 1 OR expires_at < ?').run(now);
    const pr = db.prepare('DELETE FROM password_resets     WHERE used = 1 OR expires_at < ?').run(now);
    const pc = db.prepare('DELETE FROM pixel_counts        WHERE day < ?').run(cutoffDay);
    return {
      sessions:           s.changes,
      emailVerifications: ev.changes,
      passwordResets:     pr.changes,
      pixelCounts:        pc.changes,
    };
  })();

  return results;
}

module.exports = { initializeDatabase, runMaintenance };
