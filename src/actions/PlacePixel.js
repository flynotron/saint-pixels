const { getCooldown, resetCooldown } = require('../helpers/cooldown.js');
const { getSession } = require('../helpers/session.js');
const { recordIp } = require('../helpers/AntiCheat.js');

// Injected by initializeActions
let _db = null;
let _broadcast = () => {};

/**
 * Returns the current day string in UTC-4 (e.g. "2025-05-23")
 * The leaderboard resets at midnight UTC-4.
 * @returns {string}
 */
function getDayUTC4() {
  const now = new Date();
  const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return utc4.toISOString().slice(0, 10);
}

class PlacePixel {
  /**
   * POST /api/pixel — place a coloured pixel
   */
  static execute(req, res) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const cooldownLeft = getCooldown(session.username);
    if (cooldownLeft > 0) {
      return res.status(429).json({ error: 'Cooldown active. Please wait.', cooldown: cooldownLeft });
    }

    resetCooldown(session.username);
    // Record this placement against the IP for anti-cheat enforcement
    recordIp(req.ip || req.socket?.remoteAddress || 'unknown', session.username);

    // Increment this player's pixel count for today (UTC-4 day boundary)
    if (_db) {
      try {
        const day = getDayUTC4();
        _db.prepare(`
          INSERT INTO pixel_counts (username, day, count)
          VALUES (?, ?, 1)
          ON CONFLICT(username, day) DO UPDATE SET count = count + 1
        `).run(session.username, day);
      } catch (err) {
        console.error('Failed to update pixel count:', err);
      }
    }

    // Store the pixel in the pixels history table
    if (_db) {
      try {
        const { x, y, color } = req.body;
        if (typeof x === 'number' && typeof y === 'number' && typeof color === 'string') {
          _db.prepare(`
            INSERT INTO pixels (username, x, y, color, placed_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(session.username, x, y, color.replace(/[^0-9a-fA-F#]/g, '').slice(0, 7), Date.now());
        }
      } catch (err) {
        console.error('Failed to store pixel:', err);
      }
    }

    const safeColor = typeof req.body.color === 'string'
      ? req.body.color.replace(/[^0-9a-fA-F#]/g, '').slice(0, 7)
      : '';
    _broadcast({ type: 'pixel', x: req.body.x, y: req.body.y, color: safeColor, user: session.username });

    return res.json({ success: true });
  }

  /**
   * POST /api/erase — erase a pixel (stored as color='erase' sentinel)
   * Uses the same cooldown as a regular pixel placement.
   */
  static erase(req, res) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const cooldownLeft = getCooldown(session.username);
    if (cooldownLeft > 0) {
      return res.status(429).json({ error: 'Cooldown active. Please wait.', cooldown: cooldownLeft });
    }

    resetCooldown(session.username);
    // Record this erase against the IP for anti-cheat enforcement
    recordIp(req.ip || req.socket?.remoteAddress || 'unknown', session.username);

    // Store erase as a pixel with sentinel color 'erase'
    // When replayed on init, this will clear the pixel correctly
    if (_db) {
      try {
        const { x, y } = req.body;
        if (typeof x === 'number' && typeof y === 'number') {
          _db.prepare(`
            INSERT INTO pixels (username, x, y, color, placed_at)
            VALUES (?, ?, ?, 'erase', ?)
          `).run(session.username, x, y, Date.now());
        }
      } catch (err) {
        console.error('Failed to store erase:', err);
      }
    }

    // Broadcast erase event to all SSE clients
    _broadcast({ type: 'erase', x: req.body.x, y: req.body.y, user: session.username });

    return res.json({ success: true });
  }

  /**
   * Inject the database instance (called from initializeActions)
   * @param {Database} db
   */
  static setDb(db) {
    _db = db;
  }

  /**
   * Inject the SSE broadcast function (called from initializeActions)
   * @param {Function} fn
   */
  static setBroadcast(fn) {
    _broadcast = fn;
  }
}

module.exports = { PlacePixel };
