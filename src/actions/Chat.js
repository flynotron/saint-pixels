/**
 * src/actions/Chat.js
 *
 * POST /api/chat  — send a message
 * GET  /api/chat  — load history (last 200, oldest-first)
 *
 * DDoS / abuse protections layered here (on top of server.js chatLimiter):
 *  • Per-user in-memory cooldown    : 2 s between messages
 *  • Per-user burst window          : max 10 messages in any 30-second window
 *  • Per-IP shadow window           : shared across all users on the same IP
 *  • Per-IP concurrent in-flight    : rejects a second POST while one is processing
 *  • Message content validation     : type check, length, Unicode control-char strip
 *  • HTML / script tag stripping    : removes any <…> markup before storage
 *  • URL/link filtering             : rejects messages containing bare URLs or hrefs
 *  • Homoglyph / repeated-char spam : rejects messages that are >70% one character
 *  • Duplicate suppression          : same text twice in a row → rejected
 *  • Suspicious-pattern detection   : blocks common script-injection probe strings
 *
 * Security hardening (v3):
 *  • require() hoisted out of hot path
 *  • Explicit typeof check rejects Array/Object bodies before .toString()
 *  • Unicode control characters and zero-width joiners stripped server-side
 *  • HTML tags stripped server-side even though the client uses textContent
 *    (defence-in-depth: protects any future non-textContent consumer)
 *  • URL detection blocks phishing / spam links
 *  • Per-IP in-flight set closes the race window for concurrent POST bursts
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
const IP_BURST_LIMIT     = 15;
const IP_BURST_WINDOW_MS = 30_000;

/** @type {import('better-sqlite3').Database|null} */
let _db        = null;
/** @type {((data: object) => void)|null} */
let _broadcast = null;

// ── In-memory rate tracking ───────────────────────────────────────────────────

/** username → { lastAt: number, timestamps: number[], lastMsg: string } */
const _userState = new Map();
/** ip → { timestamps: number[] } */
const _ipState   = new Map();
/**
 * IPs currently processing a POST /api/chat request.
 * Closes the race-condition window where two concurrent requests from the
 * same IP both pass all checks before either has committed to the DB.
 * @type {Set<string>}
 */
const _ipInFlight = new Set();

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
 *   U+0000–U+001F  C0 controls (except U+000A newline, kept as space)
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
const STRIP_CTRL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF\uFFF9-\uFFFF]/g;

/**
 * Strip any HTML / XML tags from the message.
 * Defence-in-depth: the client already uses textContent, but this ensures
 * nothing tag-shaped ever reaches the database or the SSE broadcast.
 */
const STRIP_TAGS_RE = /<[^>]*>/g;

/**
 * URL / link detection — rejects messages that contain bare URLs, href= values,
 * or common phishing schemes.  Covers:
 *   • http:// and https:// prefixes
 *   • www. followed by a dot-separated hostname
 *   • javascript: and data: URI schemes (XSS vectors)
 *   • href= attribute syntax
 *   • discord.gg invite links (spam vector)
 * Case-insensitive.
 */
const URL_RE = /(?:https?:\/\/|www\.[a-z0-9-]+\.|javascript:|data:|href=|discord\.gg\/)/i;

/**
 * Suspicious-pattern blocklist — rejects messages that look like injection
 * probes or obvious scripting attempts.  This is a last-resort net; the
 * tag-stripping above already neutralises the actual payload.
 *
 * Patterns blocked:
 *   <script, <iframe, <img, <svg, <object, <embed, <link, <meta  (tag openers)
 *   on* =  (event handler attributes)
 *   eval(, setTimeout(, setInterval(, Function(                  (JS eval sinks)
 *   document.cookie, document.write, window.location             (DOM abuse)
 *   base64,  (often used to smuggle payloads)
 */
const SUSPICIOUS_RE = /(?:<(?:script|iframe|img|svg|object|embed|link|meta)[\s/>]|on\w+\s*=|eval\s*\(|set(?:timeout|interval)\s*\(|function\s*\(|document\.(?:cookie|write)|window\.location|base64,)/i;

/**
 * Repeated-character spam detector.
 * Rejects a message if a single character makes up >70% of its content
 * (e.g. "aaaaaaaaaaaaaaaaaaaaaa", "!!!!!!!!!!!!!!!!!!!!!").
 * Short messages (≤ 4 chars) are exempt to avoid false positives on
 * things like "lol" or "!!!".
 */
function isSpammy(msg) {
  if (msg.length <= 4) return false;
  const freq = {};
  for (const ch of msg) freq[ch] = (freq[ch] || 0) + 1;
  const maxFreq = Math.max(...Object.values(freq));
  return maxFreq / msg.length > 0.70;
}

function sanitiseMessage(raw) {
  return raw
    .replace(STRIP_CTRL_RE, '') // strip invisible Unicode
    .replace(STRIP_TAGS_RE, '') // strip HTML/XML tags
    .trim();
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

  // ── Per-IP concurrent in-flight gate ──────────────────────────────────────
  // Prevents two simultaneous POSTs from the same IP both passing the burst
  // checks before either has incremented the counters.
  if (_ipInFlight.has(ip)) {
    return res.status(429).json({ error: 'Request already in progress. Please wait.' });
  }
  _ipInFlight.add(ip);
  // Always release — whether we return early or the handler completes.
  res.on('finish', () => _ipInFlight.delete(ip));
  res.on('close',  () => _ipInFlight.delete(ip));

  // ── Input type check ───────────────────────────────────────────────────────
  // Reject arrays, objects, numbers — only plain strings are valid.
  const rawBody = req.body?.message;
  if (rawBody === undefined || rawBody === null || typeof rawBody !== 'string') {
    return res.status(400).json({ error: 'Message must be a string.' });
  }

  // ── Sanitise ───────────────────────────────────────────────────────────────
  const message = sanitiseMessage(rawBody);

  // ── Validate length ────────────────────────────────────────────────────────
  if (!message)
    return res.status(400).json({ error: 'Message cannot be empty.' });
  if (message.length > MAX_MESSAGE_LENGTH)
    return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars).` });

  // ── Script / injection pattern check ──────────────────────────────────────
  if (SUSPICIOUS_RE.test(rawBody)) {
    return res.status(400).json({ error: 'Message contains disallowed content.' });
  }

  // ── URL / link check ──────────────────────────────────────────────────────
  if (URL_RE.test(message)) {
    return res.status(400).json({ error: 'Links are not allowed in chat.' });
  }

  // ── Spam pattern check ─────────────────────────────────────────────────────
  if (isSpammy(message)) {
    return res.status(400).json({ error: 'Message looks like spam.' });
  }

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
