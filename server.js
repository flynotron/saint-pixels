require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();

// Trust the first hop (reverse proxy: Nginx, Cloudflare, Railway, Fly.io…)
// Required for express-rate-limit to see the real client IP.
app.set('trust proxy', 1);

// Security headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet());

const dbFile = path.join(__dirname, 'database.sqlite');
const db = new Database(dbFile);

const { setDb: setSessionDb, createSession, closeSession, getSession } = require('./src/helpers/session.js');
const { setDb: setCooldownDb } = require('./src/helpers/cooldown.js');
const { hashPassword, verifyPassword } = require('./src/helpers/password.js');
const { requireCaptcha } = require('./src/helpers/captcha.js');
const { sendVerificationEmail } = require('./src/helpers/mailer.js');
const { initializeActions } = require('./src/setup/actions.js');
const { initializeDatabase } = require('./src/setup/database.js');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

initializeDatabase(db);

// Wire the DB into helpers that need it
setSessionDb(db);
setCooldownDb(db);

initializeActions(app, db);

// ─── Rate limiters ────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations from this IP. Please try again later.' },
});

// ─── Register ─────────────────────────────────────────────────────────────────

app.post('/api/register', registerLimiter, requireCaptcha, async (req, res) => {
  const { username, password, email } = req.body || {};
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, hyphen, underscore.' });

  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'A valid email address is required.' });

  try {
    if (db.prepare('SELECT id FROM accounts WHERE username = ?').get(username))
      return res.status(409).json({ error: 'Username already taken.' });

    if (db.prepare('SELECT id FROM accounts WHERE email = ?').get(email))
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hashed = await hashPassword(password);
    db.prepare('INSERT INTO accounts (username, password, ip, created_at, email, email_verified) VALUES (?, ?, ?, ?, ?, 0)')
      .run(username, hashed, ip, Date.now(), email.toLowerCase());

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO email_verifications (username, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(username, verifyToken, now, now + 24 * 60 * 60 * 1000);

    sendVerificationEmail(email, username, verifyToken).catch(err => {
      console.error('[register] Failed to send verification email:', err.message);
    });

    const token = createSession(username);
    return res.json({
      username,
      token,
      emailVerified: false,
      message: 'Account created! Check your email to verify your address.',
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

app.post('/api/login', authLimiter, requireCaptcha, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const row = db.prepare('SELECT username, password, email_verified FROM accounts WHERE username = ?')
      .get(username);

    // Always run verifyPassword even on no-match to prevent timing attacks
    const dummyHash = '$2b$12$invalidhashpaddingtomatchbcryptlength000000000000000000000';
    const valid = row
      ? await verifyPassword(password, row.password)
      : await verifyPassword(password, dummyHash).then(() => false);

    if (!row || !valid)
      return res.status(401).json({ error: 'Invalid credentials.' });

    const token = createSession(row.username);
    return res.json({
      username: row.username,
      token,
      emailVerified: !!row.email_verified,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Database error.' });
  }
});

// ─── Email verification ───────────────────────────────────────────────────────

app.get('/api/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  try {
    const row = db.prepare(
      'SELECT username, expires_at, used FROM email_verifications WHERE token = ?'
    ).get(token);

    if (!row)
      return res.status(400).send('Invalid or expired verification link.');

    if (row.used)
      return res.redirect('/?verified=already');

    if (Date.now() > row.expires_at)
      return res.status(400).send('This verification link has expired. Please request a new one.');

    db.prepare('UPDATE accounts SET email_verified = 1 WHERE username = ?').run(row.username);
    db.prepare('UPDATE email_verifications SET used = 1 WHERE token = ?').run(token);

    return res.redirect('/?verified=1');
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).send('Server error. Please try again.');
  }
});

const resendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many resend requests. Please wait before trying again.' },
});

app.post('/api/resend-verification', resendLimiter, async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const row = db.prepare('SELECT email, email_verified FROM accounts WHERE username = ?')
      .get(session.username);

    if (!row) return res.status(404).json({ error: 'Account not found.' });
    if (row.email_verified) return res.json({ message: 'Email already verified.' });
    if (!row.email) return res.status(400).json({ error: 'No email address on file.' });

    db.prepare('UPDATE email_verifications SET used = 1 WHERE username = ? AND used = 0')
      .run(session.username);

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO email_verifications (username, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(session.username, token, now, now + 24 * 60 * 60 * 1000);

    await sendVerificationEmail(row.email, session.username, token);

    return res.json({ message: 'Verification email sent.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ error: 'Could not send verification email.' });
  }
});

// ─── Session ──────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  const row = db.prepare('SELECT email_verified FROM accounts WHERE username = ?')
    .get(session.username);

  return res.json({
    username: session.username,
    emailVerified: row ? !!row.email_verified : false,
  });
});

app.post('/api/logout', (req, res) => {
  const [, token] = (req.headers.authorization || '').split(' ');
  res.json({ success: closeSession(token) });
});

// ─── Palette ──────────────────────────────────────────────────────────────────

const paletteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/palette', paletteLimiter, (req, res) => {
  try {
    const colors = db.prepare('SELECT id, label, color FROM palette ORDER BY id ASC').all();
    res.json({ colors });
  } catch (err) {
    console.error('Palette fetch error:', err);
    return res.status(500).json({ error: 'Could not load palette.' });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send('Not found'));

// ─── Start ────────────────────────────────────────────────────────────────────
const desiredPort = process.env.PORT ? Number(process.env.PORT) : 0;
const server = app.listen(desiredPort, () => {
  const addr = server.address();
  const boundPort = typeof addr === 'string' ? addr : addr.port;
  console.log(`Saint Pixels server running on http://localhost:${boundPort}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port already in use. Try setting PORT environment variable to a free port.');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
