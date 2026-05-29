require('dotenv').config();

const express  = require('express');
const helmet   = require('helmet');
const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const app = express();
app.get('/admin/dump-pixels', (req, res) => {
  const secret = req.query.secret;
  if (secret !== 'YOUR_SECRET_HERE') return res.status(403).send('Forbidden');
  const pixels = db.prepare('SELECT * FROM pixels ORDER BY placed_at ASC').all();
  res.json(pixels);
});
// Trust the first reverse-proxy hop so req.ip is the real client IP
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdn.tailwindcss.com",
        "https://cdn.jsdelivr.net",
        "https://js.hcaptcha.com",
        "https://newassets.hcaptcha.com",
        "'unsafe-inline'",
        "'unsafe-eval'",
      ],
      // Explicitly block inline event handlers (onsubmit, onclick attrs).
      // index.html no longer uses any, so this is safe.
      scriptSrcAttr: ["'none'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      frameSrc:   ["https://newassets.hcaptcha.com"],
      connectSrc: ["'self'", "https://hcaptcha.com", "https://*.hcaptcha.com"],
      imgSrc:     ["'self'", "data:"],
      fontSrc:    ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}));

// ── Body parsing — hard cap to blunt large-payload floods ────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ── Database & Helpers ────────────────────────────────────────────────────────
const dbFile = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbFile);

const { setDb: setSessionDb, createSession, closeSession, getSession } = require('./src/helpers/session.js');
const { setDb: setCooldownDb }  = require('./src/helpers/cooldown.js');
const { getCooldown } = require('./src/helpers/cooldown.js');
const { setDb: setAntiCheatDb } = require('./src/helpers/AntiCheat.js');
const { hashPassword, verifyPassword } = require('./src/helpers/password.js');
const { requireCaptcha }         = require('./src/helpers/captcha.js');
const { sendVerificationEmail }  = require('./src/helpers/mailer.js');
const { initializeActions }      = require('./src/setup/actions.js');
const { initializeDatabase, runMaintenance } = require('./src/setup/database.js');
const { initializeSSE, broadcastSSE, setDb: setSseDb } = require('./src/setup/sse.js');
const { initializeChat }         = require('./src/setup/chat.js');
const { localBypassMiddleware }  = require('./src/helpers/localBypass.js'); // <-- Added

// ── Local Bypass Middleware ───────────────────────────────────────────────────
app.use(localBypassMiddleware); // <-- Activates req.localBypassUser if valid

// ── Static files ──────────────────────────────────────────────────────────────
const fs        = require('fs');
const indexPath = path.join(__dirname, 'public', 'index.html');

// Cache index.html once at startup — avoids a synchronous fs read on every request.
let cachedIndexHtml = null;
try {
  cachedIndexHtml = fs.readFileSync(indexPath, 'utf8');
} catch (err) {
  console.error('Failed to pre-load index.html:', err);
}

// ── Index route: 120 req / min / IP ─────────────────────────────────────────
// Each hit does string replacement on cached HTML; cheap but still needs a
// tighter bound than the 600/min global limiter. Uses safeIp (IPv6-normalised)
// rather than the raw req.ip to stay consistent with all other limiters.
const indexLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

app.get('/', indexLimiter, (req, res) => {
  if (!cachedIndexHtml) return res.status(500).send('Server error.');
  try {
    let html = cachedIndexHtml.replace('__VITE_HCAPTCHA_SITEKEY__', process.env.HCAPTCHA_SITEKEY || '');

    // Inject bypass flag if middleware detected a private IP + MOBILE_DEBUG=true
    if (req.localBypassUser) {
      html = html.replace('<html lang="en">', '<html lang="en" data-local-bypass="1">');
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Failed to serve index.html:', err);
    res.status(500).send('Server error.');
  }
});
app.use(express.static(path.join(__dirname, 'public')));

// ── DB init & helpers ─────────────────────────────────────────────────────────
initializeDatabase(db);

// ── Scheduled maintenance — runs once on startup then every 6 hours ──────────
// Deletes expired sessions, used/expired tokens, and pixel_counts older than
// 366 days. Keeps the DB lean without touching any live data.
function scheduleMaintenance() {
  try {
    const deleted = runMaintenance(db);
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log('[maintenance] Cleaned up rows:', deleted);
    }
  } catch (err) {
    console.error('[maintenance] Error during maintenance:', err);
  }
  setTimeout(scheduleMaintenance, 6 * 60 * 60 * 1000);
}
scheduleMaintenance();

if (!process.env.APP_BASE_URL) {
  console.warn('[config] WARNING: APP_BASE_URL is not set. Email links will point to http://localhost:3000 which will NOT work in production.');
}
if (!process.env.RESEND_API_KEY) {
  console.warn('[config] WARNING: RESEND_API_KEY is not set. Emails will only be printed to the console.');
}

setSessionDb(db);
setCooldownDb(db);
setSseDb(db);
setAntiCheatDb(db);

// ── Safe email validator — O(n), no backtracking, RFC 5321 length cap ────────
function isValidEmail(str) {
  if (!str || typeof str !== 'string' || str.length > 254) return false;
  const at = str.indexOf('@');
  if (at < 1) return false;
  const local  = str.slice(0, at);
  const domain = str.slice(at + 1);
  return (
    local.length > 0 &&
    local.length <= 64 &&
    domain.length > 0 &&
    domain.includes('.') &&
    !domain.startsWith('.') &&
    !domain.endsWith('.') &&
    !/\s/.test(str)
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  RATE LIMITERS & DDOS PROTECTION
// ══════════════════════════════════════════════════════════════════════════════

/** IPv6-safe IP string for use inside custom keyGenerators. */
function safeIp(req) {
  return ipKeyGenerator(req);
}

// ── Global limiter: 600 req / min / IP ───────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.method === 'GET' && req.path === '/api/stream',
});
app.use(globalLimiter);

// ── Pixel limiter: 60 placements / min / IP ───────────────────────────────────
const pixelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many pixels placed. Slow down.' },
});

// ── Auth limiter: 20 login attempts / 15 min / IP ────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many attempts. Please try again later.' },
});

// ── Register limiter: 5 accounts / 10 min / IP ───────────────────────────────
const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many accounts created from this IP. Try again in 10 minutes.' },
});

// ── Resend-verification limiter: 3 / 10 min, keyed by username when available
const resendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (token) {
      try {
        const row = db.prepare('SELECT username FROM sessions WHERE token = ? AND expires_at > ?')
          .get(token, Date.now());
        if (row?.username) return `resend:user:${row.username}`;
      } catch { /* fall through */ }
    }
    return `resend:ip:${safeIp(req)}`;
  },
  message: { error: 'Too many resend requests. Please wait before trying again.' },
});

// ── Forgot-password limiter: 5 / 15 min / IP ─────────────────────────────────
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many reset requests. Please wait 15 minutes.' },
});

// ── Palette limiter: 30 req / min / IP ───────────────────────────────────────
// The palette is a full table scan that almost never changes.
// 120/min invited DB thrash under load; 30/min is more than enough for
// any legitimate client (typically fetched once at startup, then cached).
const paletteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many palette requests. Please slow down.' },
});

// ── Chat POST limiter: 20 messages / min, keyed by username when available ────
// Keyed by username (resolved from the session DB) rather than the raw Bearer
// token: a rotated or freshly-issued token would otherwise start a new bucket,
// letting a script bypass the limit by re-logging in between bursts.
// Falls back to IP so unauthenticated probes are still throttled.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    const [type, token] = auth.split(' ');
    if (type === 'Bearer' && token) {
      try {
        const row = db.prepare(
          'SELECT username FROM sessions WHERE token = ? AND expires_at > ?'
        ).get(token, Date.now());
        if (row?.username) return `chat:user:${row.username}`;
      } catch { /* fall through */ }
    }
    return `chat:ip:${safeIp(req)}`;
  },
  message: { error: 'Sending too fast. Please slow down.' },
});

// ── Chat history (GET) limiter: 60 req / min / IP ────────────────────────────
// Previously unlimited — an attacker could hammer GET /api/chat to force
// repeated full-table scans of chat_messages.
const chatHistoryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many history requests. Please slow down.' },
});

// ── /api/me limiter: 120 req / min / IP ──────────────────────────────────────
// /api/me does two DB lookups per call (session + account row).
// Without a limiter a script can poll it freely to exhaust DB read capacity.
const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

// ── /api/logout limiter: 30 req / min / IP ────────────────────────────────────
// Each logout does a DB DELETE; flooding it is cheap for the attacker but
// non-trivial for SQLite under write contention.
const logoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many requests. Please slow down.' },
});

// ── /api/verify-email limiter: 10 req / 15 min / IP ──────────────────────────
// Unguarded token lookups can be used to enumerate valid tokens via timing.
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many verification attempts. Please try again later.' },
});

// ── /api/reset-password limiter: 5 req / 15 min / IP ─────────────────────────
// CRITICAL: this endpoint calls bcrypt.hash() (expensive CPU) on every request.
// Without a limiter an attacker can trigger sustained bcrypt work to exhaust CPU.
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many reset attempts. Please try again later.' },
});

// ── SSE reconnect-rate limiter: max 20 new connections / 60 s / IP ───────────
const sseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => safeIp(req),
  message: { error: 'Too many stream reconnects. Please wait a moment.' },
});

// ── SSE connection guard: max 10 concurrent SSE connections per IP ────────────
const sseConnectionsPerIp = new Map();
const SSE_MAX_PER_IP = 10;

function sseConnectionGuard(req, res, next) {
  const ip = safeIp(req);
  const current = sseConnectionsPerIp.get(ip) || 0;
  if (current >= SSE_MAX_PER_IP) {
    return res.status(429).json({ error: 'Too many SSE connections from this IP.' });
  }
  sseConnectionsPerIp.set(ip, current + 1);
  res.on('close', () => {
    const c = sseConnectionsPerIp.get(ip) || 1;
    if (c <= 1) sseConnectionsPerIp.delete(ip);
    else sseConnectionsPerIp.set(ip, c - 1);
  });
  next();
}

// ── Actions & SSE ─────────────────────────────────────────────────────────────
initializeActions(app, db, pixelLimiter, broadcastSSE);
app.use('/api/stream', sseLimiter);
initializeSSE(app, db, sseConnectionGuard);

// ── Chat ──────────────────────────────────────────────────────────────────────
initializeChat(app, db, broadcastSSE, chatLimiter, chatHistoryLimiter);

// ══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Register ──────────────────────────────────────────────────────────────────
app.post('/api/register', registerLimiter, requireCaptcha, async (req, res) => {
  const { username, password, email } = req.body || {};
  // Clamp to 45 chars (max IPv6 length) before storing — prevents an oversized
  // X-Forwarded-For value (possible with trust proxy enabled) bloating the DB.
  const ip = (req.ip || safeIp(req) || 'unknown').slice(0, 45);

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, hyphen, underscore.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 256)
    return res.status(400).json({ error: 'Password too long.' });
  if (!isValidEmail(email))
    return res.status(400).json({ error: 'A valid email address is required.' });

  try {
    const usernameTaken = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username);
    const emailTaken    = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.toLowerCase());
    if (usernameTaken || emailTaken)
      return res.status(409).json({ error: 'Username already taken.' });

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
      cooldown: 0 // New users have no initial cooldown
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', authLimiter, requireCaptcha, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const row = db.prepare('SELECT username, password, email_verified FROM accounts WHERE username = ?').get(username);
    const dummyHash = '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV01234';
    const valid = row
      ? await verifyPassword(password, row.password)
      : (await verifyPassword(password, dummyHash).catch(() => {}), false);

    if (!row || !valid)
      return res.status(401).json({ error: 'Invalid credentials.' });

    const token = createSession(row.username);
    const cooldownLeft = getCooldown(row.username); // Fetch current cooldown

    return res.json({ 
      username: row.username, 
      token, 
      emailVerified: !!row.email_verified,
      cooldown: cooldownLeft 
    });
  } catch (err) {
    console.error('[login] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Email verification ────────────────────────────────────────────────────────
app.get('/api/verify-email', verifyEmailLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  try {
    const row = db.prepare('SELECT username, expires_at, used FROM email_verifications WHERE token = ?').get(token);
    if (!row)     return res.status(400).send('Invalid or expired verification link.');
    if (row.used) return res.redirect('/?verified=already');
    if (Date.now() > row.expires_at) return res.status(400).send('This verification link has expired. Please request a new one.');

    db.prepare('UPDATE accounts SET email_verified = 1 WHERE username = ?').run(row.username);
    db.prepare('UPDATE email_verifications SET used = 1 WHERE token = ?').run(token);
    return res.redirect('/?verified=1');
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).send('Server error. Please try again.');
  }
});

// ── Resend verification ───────────────────────────────────────────────────────
app.post('/api/resend-verification', resendLimiter, async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const row = db.prepare('SELECT email, email_verified FROM accounts WHERE username = ?').get(session.username);
    if (!row)              return res.status(404).json({ error: 'Account not found.' });
    if (row.email_verified) return res.json({ message: 'Email already verified.' });
    if (!row.email)        return res.status(400).json({ error: 'No email address on file.' });

    db.prepare('UPDATE email_verifications SET used = 1 WHERE username = ? AND used = 0').run(session.username);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO email_verifications (username, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(session.username, token, now, now + 24 * 60 * 60 * 1000);

    // force=true bypasses the in-process 60 s cooldown so an explicit resend
    // always goes out, even if a registration email was sent moments earlier.
    await sendVerificationEmail(row.email, session.username, token, true);
    return res.json({ message: 'Verification email sent. Check your inbox (and Spam folder).' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ error: 'Could not send verification email.' });
  }
});

// ── Forgot / Reset password ───────────────────────────────────────────────────
app.post('/api/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  const OK = { message: 'If that email is registered, a reset link has been sent.' };
  if (!isValidEmail(email)) return res.json(OK);

  try {
    const account = db.prepare('SELECT username FROM accounts WHERE email = ?').get(email.toLowerCase());
    if (!account) return res.json(OK);

    db.prepare('UPDATE password_resets SET used = 1 WHERE username = ? AND used = 0').run(account.username);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO password_resets (username, token, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)')
      .run(account.username, token, now, now + 60 * 60 * 1000);

    const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const link = `${base}/?resetToken=${encodeURIComponent(token)}`;

    const { sendMail } = require('./src/helpers/mailer.js');
    await sendMail({
      to: email.toLowerCase(),
      subject: 'Reset your Saint-Pixels password',
      text: `Hi ${account.username},\n\nReset your password:\n\n${link}\n\nExpires in 1 hour.`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family:sans-serif;background:#1e1e1f;color:#e2e8f0;padding:32px;"><div style="max-width:480px;margin:0 auto;background:#2e2e2f;border-radius:16px;padding:32px;border:1px solid rgba(255,255,255,0.1);"><h1 style="margin:0 0 8px;font-size:1.5rem;">Saint-Pixels</h1><p style="color:#94a3b8;margin:0 0 24px;">Password reset</p><p>Hi <strong>${account.username}</strong>,</p><p>Click the button below to set a new password. The link expires in <strong>1 hour</strong>.</p><a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#38bdf8;color:#0f172a;font-weight:700;border-radius:10px;text-decoration:none;">Reset Password</a><p style="font-size:0.82rem;color:#64748b;margin-top:24px;">If the button doesn't work, copy this link:<br/><a href="${link}" style="color:#38bdf8;word-break:break-all;">${link}</a></p><p style="font-size:0.82rem;color:#64748b;">If you didn't request this, ignore this email.</p></div></body></html>`,
    });

    return res.json(OK);
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }
});

app.post('/api/reset-password', resetPasswordLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  if (typeof token !== 'string' || token.length > 128) return res.status(400).json({ error: 'Invalid token.' });
  if (password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 256) return res.status(400).json({ error: 'Password too long.' });

  try {
    const row = db.prepare('SELECT username, expires_at, used FROM password_resets WHERE token = ?').get(token);
    if (!row || row.used)         return res.status(400).json({ error: 'Invalid or already-used reset link.' });
    if (Date.now() > row.expires_at) return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });

    const hashed = await hashPassword(password);
    db.prepare('UPDATE accounts SET password = ? WHERE username = ?').run(hashed, row.username);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);
    db.prepare('DELETE FROM sessions WHERE username = ?').run(row.username);
    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Could not reset password.' });
  }
});

// ── Session ───────────────────────────────────────────────────────────────────
app.get('/api/me', meLimiter, (req, res) => {
  if (req.localBypassUser) {
    return res.json({ username: req.localBypassUser, emailVerified: true, cooldown: 0 });
  }

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  
  const row = db.prepare('SELECT email_verified FROM accounts WHERE username = ?').get(session.username);
  const cooldownLeft = getCooldown(session.username); // Get remaining time from DB
  
  return res.json({ 
    username: session.username, 
    emailVerified: row ? !!row.email_verified : false,
    cooldown: cooldownLeft 
  });
});

app.post('/api/logout', logoutLimiter, (req, res) => {
  const [, token] = (req.headers.authorization || '').split(' ');
  res.json({ success: closeSession(token) });
});

// ── Palette ───────────────────────────────────────────────────────────────────
app.get('/api/palette', paletteLimiter, (req, res) => {
  try {
    const colors = db.prepare('SELECT id, label, color FROM palette ORDER BY id ASC').all();
    res.json({ colors });
  } catch (err) {
    console.error('Palette fetch error:', err);
    return res.status(500).json({ error: 'Could not load palette.' });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send('Not found'));

// ── Start ─────────────────────────────────────────────────────────────────────
const desiredPort = process.env.PORT ? Number(process.env.PORT) : 3000;
// Binding to '0.0.0.0' allows connections from both localhost and your local Wi-Fi IP
const server = app.listen(desiredPort, '0.0.0.0', () => {
  console.log(`Saint Pixels server running on http://localhost:${desiredPort}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${desiredPort} is already in use.`);
  } else {
    console.error('Server error:', err);
  }
});

// ── Slowloris / slow-header attack mitigation ─────────────────────────────────
// Without these a client can hold a TCP connection open indefinitely by sending
// headers extremely slowly, exhausting the server's connection pool.
//
//   headersTimeout  — max time (ms) to receive the full HTTP request headers
//   requestTimeout  — max time (ms) for the entire request (headers + body)
//   keepAliveTimeout — how long an idle keep-alive connection is held open
//
// Values are intentionally conservative: legitimate browsers finish headers in
// well under 10 s; the defaults (0 = unlimited) invite abuse.
server.headersTimeout  = 10_000;   // 10 s to finish sending headers
server.requestTimeout  = 30_000;   // 30 s for full request (covers slow bodies)
server.keepAliveTimeout = 65_000;  // slightly above typical proxy idle timeout

// ── Global Express error handler ─────────────────────────────────────────────
// Catches any error thrown synchronously inside a route handler that wasn't
// caught by the handler's own try/catch.  Without this, Express would call
// next(err) → default handler which sends a stack trace to the client and,
// in some Node versions, can crash the process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled route error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Unhandled rejection / exception safety net ────────────────────────────────
// Prevents a single unhandled async throw from silently killing the process.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Give in-flight requests a moment to drain before exiting — avoids a hard kill
  // that would leave SSE clients with broken connections and no error.
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5_000).unref();
});
