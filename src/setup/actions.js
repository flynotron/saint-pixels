const { PlacePixel } = require('../actions/PlacePixel.js');
const { Leaderboard } = require('../actions/Leaderboard.js');
const { ipCooldownMiddleware } = require('../helpers/AntiCheat.js');

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {Function} [pixelLimiter]
 * @param {Function} [broadcastSSE]
 */
function initializeActions(app, db, pixelLimiter, broadcastSSE) {
  // Inject db into actions that need it
  PlacePixel.setDb(db);
  PlacePixel.setBroadcast(broadcastSSE || (() => {}));
  Leaderboard.setDb(db);

  // ipCooldownMiddleware is applied first — before the per-request rate limiter
  // and before the per-user cooldown check — so multi-account IP bypasses are
  // caught at the earliest possible point.
  const pixelMiddleware = pixelLimiter
    ? [ipCooldownMiddleware, pixelLimiter, PlacePixel.execute]
    : [ipCooldownMiddleware, PlacePixel.execute];

  const eraseMiddleware = pixelLimiter
    ? [ipCooldownMiddleware, pixelLimiter, PlacePixel.erase]
    : [ipCooldownMiddleware, PlacePixel.erase];

  app.post('/api/pixel',              ...pixelMiddleware);
  app.post('/api/erase',              ...eraseMiddleware);
  app.get('/api/leaderboard',         Leaderboard.execute);
  app.get('/api/profile/:username',   Leaderboard.profile);
}

module.exports = { initializeActions };
