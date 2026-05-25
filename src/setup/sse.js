/**
 * Server-Sent Events manager.
 *
 * Tracks every connected SSE client and automatically broadcasts the live
 * player count whenever someone connects or disconnects.  Also exposes a
 * `broadcast(data)` helper used by PlacePixel to push pixel events to all
 * connected browsers in real time.
 *
 * Usage (in your Express entry point):
 *
 *   const { initializeSSE, broadcastSSE } = require('./src/setup/sse.js');
 *   initializeSSE(app);
 *   initializeActions(app, db, pixelLimiter, broadcastSSE);
 */

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

/** @type {import('better-sqlite3').Database|null} */
let _db = null;

/**
 * Inject the database so new SSE connections can receive existing pixel history.
 * @param {import('better-sqlite3').Database} db
 */
function setDb(db) {
  _db = db;
}

/**
 * Send a JSON-serialisable object to every connected SSE client.
 * @param {object} data
 */
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Dead connection — will be cleaned up on 'close'
      clients.delete(res);
    }
  }
}

/**
 * Broadcast the current live player count to all connected clients.
 * Called automatically on connect / disconnect.
 */
function broadcastCount() {
  broadcastSSE({ type: 'clients', count: clients.size });
}

/**
 * Register the GET /api/stream endpoint and wire up connect/disconnect
 * tracking so the live count stays accurate.
 *
 * @param {import('express').Application} app
 */
function initializeSSE(app) {
  app.get('/api/stream', (req, res) => {
    // Standard SSE headers
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx proxy buffering
    res.flushHeaders();

    // Register client
    clients.add(res);
    broadcastCount();

    // Send all existing pixels so the new client can paint the canvas immediately
    if (_db) {
      try {
        const pixels = _db.prepare(
          'SELECT username, x, y, color FROM pixels ORDER BY placed_at ASC'
        ).all();
        if (pixels.length > 0) {
          // Send in one batch payload for efficiency
          const payload = `data: ${JSON.stringify({ type: 'init', pixels })}\n\n`;
          res.write(payload);
        }
      } catch (err) {
        console.error('[sse] Failed to load initial pixels:', err);
      }
    }

    // Send a heartbeat comment every 25 s to keep the connection alive through
    // proxies / load balancers that close idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);

    // Deregister on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      broadcastCount();
    });
  });
}

module.exports = { initializeSSE, broadcastSSE, setDb };
