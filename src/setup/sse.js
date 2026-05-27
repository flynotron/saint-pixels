/**
 * Server-Sent Events manager.
 *
 * initializeSSE(app, db, guardMiddleware?)
 *   - app            Express application
 *   - db             better-sqlite3 Database (optional — can also be set via setDb)
 *   - guardMiddleware Optional Express middleware to run before accepting the
 *                     SSE connection (e.g. sseConnectionGuard in server.js)
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
      clients.delete(res);
    }
  }
}

/**
 * Broadcast the current live player count to all connected clients.
 */
function broadcastCount() {
  broadcastSSE({ type: 'clients', count: clients.size });
}

/**
 * Register the GET /api/stream endpoint.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} [db]  — optional, can be set via setDb()
 * @param {Function} [guardMiddleware]               — optional Express middleware
 */
function initializeSSE(app, db, guardMiddleware) {
  // Allow db to be injected via this call too
  if (db) _db = db;

  const handler = (req, res) => {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    clients.add(res);
    broadcastCount();

    // Send all existing pixels on connect so the new client can paint immediately
    if (_db) {
      try {
        const pixels = _db.prepare(
          'SELECT username, x, y, color FROM pixels ORDER BY placed_at ASC'
        ).all();
        if (pixels.length > 0) {
          res.write(`data: ${JSON.stringify({ type: 'init', pixels })}\n\n`);
        }
      } catch (err) {
        console.error('[sse] Failed to load initial pixels:', err);
      }
    }

    // Heartbeat every 25 s keeps the connection alive through proxies
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      broadcastCount();
    });
  };

  if (typeof guardMiddleware === 'function') {
    app.get('/api/stream', guardMiddleware, handler);
  } else {
    app.get('/api/stream', handler);
  }
}

module.exports = { initializeSSE, broadcastSSE, setDb };
