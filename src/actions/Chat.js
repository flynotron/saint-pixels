/**
 * src/actions/Chat.js
 *
 * POST /api/chat  — send a message
 * GET  /api/chat  — load history (last 200, oldest-first)
 *
 * DDoS / abuse protections layered here (on top of server.js chatLimiter):
 *  • Per-user in-memory cooldown  : 2 s between messages
 *  • Per-user burst window        : max 10 messages in any 30-second window
 *  • Per-IP shadow window         : shared across all users on the same IP
 *  • Message content validation   : type check, length, Unicode control-char strip
 *  • Duplicate suppression        : same text twice in a row → rejected
 *
 * Security hardening (v2):
 *  • require() hoisted out of hot path (was called on every request)
 *  • Explicit typeof check rejects Array/Object bodies before .toString()
 *  • Unicode control characters and zero-width joiners stripped server-side
 *    so invisible / spoofed messages cannot be stored or broadcast
 */

'use strict';

// ── Hoisted require — not inside the hot handler ─────────────────────────────
const { getSession } = require('../helpers/session.js');

const MAX_MESSAGE_LENGTH = 200;
const CHAT_HISTORY_LIMIT = 200;

// Per-user cooldown (ms between any two messages)
const USER_COOLDOWN_MS   = 2_000;
// Burst limit: max N messages in BURST_WINDOW_MS
const BURST_LIMIT        = 10;
const BURST_WINDOW_MS    = 30_000;
// Per-IP burst (stricter — catches multi-account flooding)
const IP_BURST_LIMIT     = 20;
const IP_BURST_WINDOW_MS = 30_000;

/** @type {import('better-sqlite3').Database|null} */
let _db        = null;
/** @type {((data: object) => void)|null} */
let _broadcast = null;

// ── In-memory rate tracking ───────────────────────────────────────────────────

/** username → { lastAt: number, timestamps: number[], lastMsg: string } */
const _userState = new Map();
/** ip       → { timestamps: number[] } */
const _ipState   = new Map();

function getUserState(username) {
  if (!_userState.has(username)) {
    _userState.set(username, { lastAt: 0, timestamps: [], lastMsg: '' });
  }
  return _userState.get(username);
}

function getIpState(ip) {
  if (!_ipState.has(ip)) _ipState.set(ip, { timestamps: [] });
  return _ipState.get(ip);
}

/** Prune timestamps older than windowMs from an array (mutates in place). */
function pruneWindow(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

// Clean up stale entries every 5 minutes to avoid unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - Math.max(BURST_WINDOW_MS, IP_BURST_WINDOW_MS) * 2;
  for (const [k, v] of _userState) {
    if (v.lastAt < cutoff) _userState.delete(k);
  }
  for (const [k, v] of _ipState) {
    pruneWindow(v.timestamps, IP_BURST_WINDOW_MS * 2);
    if (v.timestamps.length === 0) _ipState.delete(k);
  }
}, 5 * 60 * 1_000);

// ── Content sanitisation ──────────────────────────────────────────────────────

/**
 * Strip Unicode control characters, zero-width spaces/joiners, and other
 * invisible characters that can be used to craft blank-looking or spoofed
 * messages.  Printable ASCII and all normal Unicode text passes through.
 *
 * Removed ranges:
 *   U+0000–U+001F  C0 controls (except U+000A newline which is harmless)
 *   U+007F         DEL
 *   U+0080–U+009F  C1 controls
 *   U+00AD         Soft hyphen (invisible)
 *   U+200B–U+200F  Zero-width space/non-joiner/joiner/LTR/RTL marks
 *   U+2028–U+2029  Line/paragraph separators
 *   U+202A–U+202E  Bidirectional override characters  ← can spoof text direction
 *   U+2060–U+2064  Word joiner and invisible operators
 *   U+FEFF         BOM / zero-width no-break space
 *   U+FFF9–U+FFFF  Interlinear annotation / specials
 */
const STRIP_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF\uFFF9-\uFFFF]/g;

function sanitiseMessage(raw) {
  return raw.replace(STRIP_RE, '').trim();
}

// ── DB setup ──────────────────────────────────────────────────────────────────

function setDb(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT    NOT NULL,
      message  TEXT    NOT NULL,
      sent_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sent_at ON chat_messages(sent_at);
  `);
}

function setBroadcast(fn) {
  _broadcast = fn;
}

// ── POST /api/chat ────────────────────────────────────────────────────────────

async function send(req, res) {
  if (!_db) return res.status(500).json({ error: 'Database not ready.' });

  // ── Auth ───────────────────────────────────────────────────────────────────
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  const { username } = session;
  const ip = req.ip || 'unknown';

  // ── Input type check ───────────────────────────────────────────────────────
  // Reject arrays, objects, numbers — only plain strings are valid.
  const rawBody = req.body?.message;
  if (rawBody === undefined || rawBody === null || typeof rawBody !== 'string') {
    return res.status(400).json({ error: 'Message must be a string.' });
  }

  // ── Sanitise & validate ────────────────────────────────────────────────────
  const message = sanitiseMessage(rawBody);

  if (!message)
    return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.length > MAX_MESSAGE_LENGTH)
    return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars).` });

  // ── Duplicate suppression ──────────────────────────────────────────────────
  const uState = getUserState(username);
  if (message === uState.lastMsg)
    return res.status(429).json({ error: 'No duplicate messages.' });

  // ── Per-user cooldown ──────────────────────────────────────────────────────
  const remaining = uState.lastAt + USER_COOLDOWN_MS - Date.now();
  if (remaining > 0)
    return res.status(429).json({ error: 'Slow down!', cooldownMs: remaining });

  // ── Per-user burst window ──────────────────────────────────────────────────
  pruneWindow(uState.timestamps, BURST_WINDOW_MS);
  if (uState.timestamps.length >= BURST_LIMIT)
    return res.status(429).json({ error: `Max ${BURST_LIMIT} messages per 30 seconds.` });

  // ── Per-IP burst window ────────────────────────────────────────────────────
  const ipState = getIpState(ip);
  pruneWindow(ipState.timestamps, IP_BURST_WINDOW_MS);
  if (ipState.timestamps.length >= IP_BURST_LIMIT)
    return res.status(429).json({ error: 'Too many messages from this connection.' });

  // ── Commit ─────────────────────────────────────────────────────────────────
  const now = Date.now();
  uState.lastAt = now;
  uState.lastMsg = message;
  uState.timestamps.push(now);
  ipState.timestamps.push(now);

  let rowId;
  try {
    const info = _db.prepare(
      'INSERT INTO chat_messages (username, message, sent_at) VALUES (?, ?, ?)'
    ).run(username, message, now);
    rowId = info.lastInsertRowid;
  } catch (err) {
    console.error('[chat] DB insert error:', err);
    return res.status(500).json({ error: 'Could not save message.' });
  }

  const payload = { type: 'chat', id: rowId, username, message, sent_at: now };
  if (_broadcast) _broadcast(payload);

  return res.json({ ok: true, ...payload });
}

// ── GET /api/chat ─────────────────────────────────────────────────────────────

function history(req, res) {
  if (!_db) return res.status(500).json({ error: 'Database not ready.' });
  try {
    const rows = _db.prepare(`
      SELECT id, username, message, sent_at
      FROM   chat_messages
      ORDER  BY sent_at DESC
      LIMIT  ?
    `).all(CHAT_HISTORY_LIMIT);
    rows.reverse(); // oldest first for the UI
    return res.json({ messages: rows });
  } catch (err) {
    console.error('[chat] history error:', err);
    return res.status(500).json({ error: 'Could not load chat history.' });
  }
}

module.exports = { setDb, setBroadcast, send, history };
