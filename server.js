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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc: [
        "'self'",
        // CDN scripts
        "https://cdn.tailwindcss.com",
        "https://cdn.jsdelivr.net",
        "https://js.hcaptcha.com",
        "https://newassets.hcaptcha.com",
        // Alpine.js requires unsafe-inline + unsafe-eval (uses new Function() internally)
        // Note: having a hash alongside unsafe-inline cancels it out per CSP spec — hash removed
        "'unsafe-inline'",
        "'unsafe-eval'",
      ],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      frameSrc:    ["https://newassets.hcaptcha.com"],
      connectSrc:  ["'self'", "https://hcaptcha.com", "https://*.hcaptcha.com"],
      imgSrc:      ["'self'", "data:"],
      fontSrc:     ["'self'"],
    },
  },
}));

const dbFile = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbFile);

const { setDb: setSessionDb, createSession, closeSession, getSession } = require('./src/helpers/session.js');
const { setDb: setCooldownDb } = require('./src/helpers/cooldown.js');
const { setDb: setAntiCheatDb } = require('./src/helpers/AntiCheat.js');
const { hashPassword, verifyPassword } = require('./src/helpers/password.js');
const { requireCaptcha } = require('./src/helpers/captcha.js');
const { sendVerificationEmail } = require('./src/helpers/mailer.js');
const { initializeActions } = require('./src/setup/actions.js');
const { initializeDatabase } = require('./src/setup/database.js');
const { initializeSSE, broadcastSSE, setDb: setSseDb } = require('./src/setup/sse.js');

app.use(express.json({ limit: '10kb' }));

// Serve index.html with hCaptcha sitekey injected from env at request time.
// express.static would serve the raw file with the placeholder still in it.
const fs = require('fs');
const indexPath = path.join(__dirname, 'public', 'index.html');
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace('__VITE_HCAPTCHA_SITEKEY__', process.env.HCAPTCHA_SITEKEY || '');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Failed to serve index.html:', err);
    res.status(500).send('Server error.');
  }
});
app.use(express.static(path.join(__dirname, 'public')));

initializeDatabase(db);

// ── Startup config checks ─────────────────────────────────────────────────────
if (!process.env.APP_BASE_URL) {
  console.warn('[config] WARNING: APP_BASE_URL is not set. Password reset and email verification links will point to http://localhost:3000 which will NOT work in production. Set APP_BASE_URL to your public domain (e.g. https://yourdomain.com).');
}
if (!process.env.RESEND_API_KEY) {
  console.warn('[config] WARNING: RESEND_API_KEY is not set. Emails (verification, password reset) will only be printed to the console.');
}

// Wire the DB into helpers that need it
setSessionDb(db);
setCooldownDb(db);
setSseDb(db);
setAntiCheatDb(db);

// ─── Rate limiters ────────────────────────────────────────────────────────────
// NOTE: must be registered BEFORE initializeActions so /api/pixel is covered.

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);

const pixelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // max 60 pixel placements per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many pixels placed. Slow down.' },
});

initializeActions(app, db, pixelLimiter, broadcastSSE);
initializeSSE(app, db);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP. You can register again in 10 minutes.' },
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

    // Check if a verification email was already sent for this account in the last 60s
    // (guards against double-POST / rapid retry sending duplicate emails)
    const recentSend = db.prepare(
      'SELECT created_at FROM email_verifications WHERE username = ? ORDER BY created_at DESC LIMIT 1 OFFSET 1'
    ).get(username);
    const tooSoon = recentSend && (Date.now() - recentSend.created_at) < 60_000;
    if (!tooSoon) {
      sendVerificationEmail(email, username, verifyToken).catch(err => {
        console.error('[register] Failed to send verification email:', err.message);
      });
    }

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
    const dummyHash = '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV01234';
    const valid = row
      ? await verifyPassword(password, row.password)
      : await verifyPassword(password, dummyHash).then(() => false);

    if (!row) {
      console.log(`[login] Username not found: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (!valid) {
      console.log(`[login] Wrong password for: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = createSession(row.username);
    return res.json({
      username: row.username,
      token,
      emailVerified: !!row.email_verified,
    });
  } catch (err) {
    console.error('[login] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
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
  // Key by session username when available, fall back to IP
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (token) {
      const row = db.prepare('SELECT username FROM sessions WHERE token = ? AND expires_at > ?')
        .get(token, Date.now());
      if (row) return `resend:${row.username}`;
    }
    return `resend:ip:${req.ip}`;
  },
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

// ─── Forgot / Reset password ──────────────────────────────────────────────────

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please wait 15 minutes.' },
});

app.post('/api/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  // Always respond 200 to avoid leaking whether an email exists
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }

  try {
    const account = db.prepare('SELECT username FROM accounts WHERE email = ?').get(email.toLowerCase());
    if (!account) return res.json({ message: 'If that email is registered, a reset link has been sent.' });

    // Invalidate any existing unused tokens for this user
    db.prepare('UPDATE password_resets SET used = 1 WHERE username = ? AND used = 0').run(account.username);

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO password_resets (username, token, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)')
      .run(account.username, token, now, now + 60 * 60 * 1000); // 1 hour expiry

    const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const link = `${base}/?resetToken=${encodeURIComponent(token)}`;

    const { sendMail } = require('./src/helpers/mailer.js');
    await sendMail({
      to: email.toLowerCase(),
      subject: 'Reset your Saint-Pixels password',
      text: `Hi ${account.username},\n\nClick the link below to reset your password:\n\n${link}\n\nThe link expires in 1 hour.\n\nIf you did not request a password reset, you can ignore this email.`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:sans-serif;background:#1e1e1f;color:#e2e8f0;padding:32px;">
  <div style="max-width:480px;margin:0 auto;background:#2e2e2f;border-radius:16px;padding:32px;border:1px solid rgba(255,255,255,0.1);">
    <h1 style="margin:0 0 8px;font-size:1.5rem;">Saint-Pixels</h1>
    <p style="color:#94a3b8;margin:0 0 24px;">Password reset</p>
    <p>Hi <strong>${account.username}</strong>,</p>
    <p>Click the button below to set a new password. The link expires in <strong>1 hour</strong>.</p>
    <a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#38bdf8;color:#0f172a;font-weight:700;border-radius:10px;text-decoration:none;">Reset Password</a>
    <p style="font-size:0.82rem;color:#64748b;margin-top:24px;">If the button doesn't work, copy this link:<br/><a href="${link}" style="color:#38bdf8;word-break:break-all;">${link}</a></p>
    <p style="font-size:0.82rem;color:#64748b;">If you didn't request this, ignore this email.</p>
  </div>
</body>
</html>`,
    });

    return res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    // Still return 200 — don't leak errors
    return res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  if (typeof token !== 'string' || token.length > 128)
    return res.status(400).json({ error: 'Invalid token.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 256) return res.status(400).json({ error: 'Password too long.' });

  try {
    const row = db.prepare(
      'SELECT username, expires_at, used FROM password_resets WHERE token = ?'
    ).get(token);

    if (!row || row.used) return res.status(400).json({ error: 'Invalid or already-used reset link.' });
    if (Date.now() > row.expires_at) return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });

    const hashed = await hashPassword(password);
    db.prepare('UPDATE accounts SET password = ? WHERE username = ?').run(hashed, row.username);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);
    // Invalidate all active sessions so old password can't be reused
    db.prepare('DELETE FROM sessions WHERE username = ?').run(row.username);

    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Could not reset password.' });
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


// ─── Debug: auth diagnostics (dev/staging only) ───────────────────────────────
//
// GET  /api/debug/auth?username=alice
//   → Shows the stored account row (hash prefix only) + active session count.
//
// POST /api/debug/auth  { "username": "alice", "password": "secret" }
//   → Runs verifyPassword live and tells you exactly why it passed/failed.
//
// NEVER enable this in production — it is blocked by the NODE_ENV guard below.

if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug/auth', (req, res) => {
    const { username } = req.query;

    // No username → list all accounts (redacted) so you can see what exists
    if (!username) {
      try {
        const accounts = db.prepare(
          'SELECT id, username, email, email_verified, ip, created_at, SUBSTR(password, 1, 29) AS hash_prefix FROM accounts ORDER BY id ASC'
        ).all();
        const sessions = db.prepare('SELECT username, COUNT(*) AS count FROM sessions WHERE expires_at > ? GROUP BY username').all(Date.now());
        return res.json({
          note: 'DEV MODE — never exposed in production',
          accounts,           // password column is first-29-chars of bcrypt hash only
          active_sessions: sessions,
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Specific username → detailed info
    try {
      const row = db.prepare(
        'SELECT id, username, email, email_verified, ip, created_at, password FROM accounts WHERE username = ?'
      ).get(username);

      if (!row) {
        return res.json({ found: false, username });
      }

      const { password: hash, ...safeRow } = row;
      return res.json({
        found: true,
        account: {
          ...safeRow,
          hash_prefix: hash.slice(0, 29),   // "$2b$12$<22-char salt>" — safe to expose
          hash_length: hash.length,
          hash_starts_with_2b: hash.startsWith('$2b$'),
          bcrypt_rounds: parseInt(hash.split('$')[2], 10) || null,
        },
        sessions: db.prepare(
          'SELECT token_prefix, created_at, expires_at FROM (SELECT SUBSTR(token,1,8) AS token_prefix, created_at, expires_at FROM sessions WHERE username = ? AND expires_at > ?) ORDER BY created_at DESC LIMIT 5'
        ).all(username, Date.now()),
        hint: 'POST /api/debug/auth with { username, password } to run a live bcrypt check',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/debug/auth', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Provide { username, password } in the JSON body.' });
    }

    try {
      const row = db.prepare('SELECT username, password, email_verified FROM accounts WHERE username = ?').get(username);

      if (!row) {
        return res.json({
          result: 'FAIL',
          reason: 'username_not_found',
          message: `No account with username "${username}" exists in the database.`,
        });
      }

      const { password: hash, ...safeRow } = row;
      const match = await verifyPassword(password, hash);

      return res.json({
        result: match ? 'OK' : 'FAIL',
        reason: match ? 'password_correct' : 'password_mismatch',
        account: {
          ...safeRow,
          hash_prefix: hash.slice(0, 29),
          hash_length: hash.length,
          hash_starts_with_2b: hash.startsWith('$2b$'),
          bcrypt_rounds: parseInt(hash.split('$')[2], 10) || null,
        },
        email_verified: !!row.email_verified,
        message: match
          ? '✅ Password matches — if login still fails, check the captcha or session layer.'
          : '❌ Password does not match the stored hash. The account may have been registered with a different password, or the hash is corrupted.',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message, stack: err.stack });
    }
  });
}

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