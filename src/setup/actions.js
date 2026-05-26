const { PlacePixel } = require('../actions/PlacePixel.js');
const { Leaderboard } = require('../actions/Leaderboard.js');

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

  const pixelMiddleware = pixelLimiter ? [pixelLimiter, PlacePixel.execute] : [PlacePixel.execute];
  const eraseMiddleware = pixelLimiter ? [pixelLimiter, PlacePixel.erase] : [PlacePixel.erase];

  app.post('/api/pixel',              ...pixelMiddleware);
  app.post('/api/erase',              ...eraseMiddleware);
  app.get('/api/leaderboard',         Leaderboard.execute);
  app.get('/api/profile/:username',   Leaderboard.profile);
}

module.exports = { initializeActions };
