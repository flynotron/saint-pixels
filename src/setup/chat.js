/**
 * src/setup/chat.js
 *
 * Wires the Chat action into the Express app.
 * Call initializeChat() after setAntiCheatDb() in server.js,
 * and pass the same broadcastSSE and chatLimiter used elsewhere.
 *
 * Usage in server.js:
 *   const { initializeChat } = require('./src/setup/chat.js');
 *   // after setAntiCheatDb(db):
 *   initializeChat(app, db, broadcastSSE, chatLimiter);
 */

const Chat = require('../actions/Chat.js');

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {(data: object) => void} broadcastSSE
 * @param {import('express').RequestHandler} chatLimiter
 */
function initializeChat(app, db, broadcastSSE, chatLimiter) {
  Chat.setDb(db);
  Chat.setBroadcast(broadcastSSE);

  app.post('/api/chat', chatLimiter, Chat.send);
  app.get('/api/chat',  Chat.history);
}

module.exports = { initializeChat };
