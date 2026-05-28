/**
 * src/setup/chat.js
 *
 * Wires the Chat action into the Express app.
 * Call initializeChat() after setAntiCheatDb() in server.js,
 * and pass the same broadcastSSE, chatLimiter, and chatHistoryLimiter.
 *
 * Usage in server.js:
 *   const { initializeChat } = require('./src/setup/chat.js');
 *   // after setAntiCheatDb(db):
 *   initializeChat(app, db, broadcastSSE, chatLimiter, chatHistoryLimiter);
 */

const Chat = require('../actions/Chat.js');

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {(data: object) => void} broadcastSSE
 * @param {import('express').RequestHandler} chatLimiter         - POST rate limiter (keyed by username)
 * @param {import('express').RequestHandler} [chatHistoryLimiter] - GET rate limiter (keyed by IP)
 */
function initializeChat(app, db, broadcastSSE, chatLimiter, chatHistoryLimiter) {
  Chat.setDb(db);
  Chat.setBroadcast(broadcastSSE);

  // POST: username-keyed limiter first, then the Chat handler (which has its
  // own per-user + per-IP burst windows and content validation).
  app.post('/api/chat', chatLimiter, Chat.send);

  // GET: IP-keyed limiter guards against history-scraping DoS.
  // chatHistoryLimiter is optional for backwards compatibility.
  if (chatHistoryLimiter) {
    app.get('/api/chat', chatHistoryLimiter, Chat.history);
  } else {
    app.get('/api/chat', Chat.history);
  }
}

module.exports = { initializeChat };
