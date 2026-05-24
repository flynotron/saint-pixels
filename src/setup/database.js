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

    CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token);

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

    CREATE TABLE IF NOT EXISTS pixels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      color TEXT NOT NULL,
      placed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pixels_username ON pixels(username);
    CREATE INDEX IF NOT EXISTS idx_pixels_placed_at ON pixels(placed_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS cooldowns (
      username TEXT PRIMARY KEY NOT NULL,
      last_pixel_at INTEGER NOT NULL
    );
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
      ];
      db.transaction((colors) => {
        colors.forEach(([label, color]) => insertStmt.run(label, color));
      })(defaultPalette);
    }
  } catch (err) {
    console.error('Failed to populate default palette:', err);
  }
}

module.exports = { initializeDatabase };
