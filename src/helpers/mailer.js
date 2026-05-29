/**
 * Email helper — sends transactional emails via Resend HTTP API.
 * Uses fetch (Node 18+) over HTTPS port 443, so it works on Railway.
 *
 * Required env vars:
 *   RESEND_API_KEY   your Resend API key (re_xxxxxxxxx)
 *   EMAIL_FROM       e.g. "Saint-Pixels <no-reply@yourdomain.com>"
 *   APP_BASE_URL     e.g. https://yourdomain.com
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * In-process cooldown: tracks the last send time per recipient address.
 * Prevents bursts from rapid double-POSTs or retry loops within the same process.
 * Key: email address (lowercased). Value: timestamp ms of last send.
 * @type {Map<string, number>}
 */
const _lastSentAt = new Map();
const SEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends to the same address

/**
 * Send an email via Resend HTTP API.
 * Throws on failure so callers can surface the error.
 *
 * The in-process cooldown (SEND_COOLDOWN_MS) prevents duplicate sends caused by
 * rapid double-POSTs or retry loops.  Pass `force: true` to bypass it — used by
 * the explicit /api/resend-verification endpoint so a user who registered moments
 * ago can still request a fresh email immediately.
 *
 * @param {{ to: string, subject: string, html: string, text?: string, force?: boolean }} opts
 */
async function sendMail({ to, subject, html, text, force = false }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.EMAIL_FROM || 'Saint-Pixels <no-reply@example.com>';
  const key    = to.toLowerCase();

  // ── In-process rate limit ────────────────────────────────────────────────────
  // Skipped when `force` is true (explicit user-triggered resend).
  if (!force) {
    const last = _lastSentAt.get(key) || 0;
    const sinceLastMs = Date.now() - last;
    if (sinceLastMs < SEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((SEND_COOLDOWN_MS - sinceLastMs) / 1000);
      console.warn(`[mailer] Skipping duplicate send to ${to} — cooldown active (${waitSec}s left)`);
      return; // Silently skip — not an error for fire-and-forget callers (register)
    }
  }
  // Mark immediately so concurrent calls within the same tick are also blocked
  _lastSentAt.set(key, Date.now());

  if (!apiKey) {
    // Dev fallback — print to terminal
    console.warn('[mailer] RESEND_API_KEY not set — email NOT sent, printing to console.');
    console.log(`\n[mailer] ─── EMAIL (dev mode) ────────────────────`);
    console.log(`  From:    ${from}`);
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${text || html}`);
    console.log(`────────────────────────────────────────────────\n`);
    return;
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });

  if (!res.ok) {
    // Reset the cooldown stamp so a genuine retry after fixing config can go through
    _lastSentAt.delete(key);
    const body = await res.text();
    const err = new Error(`Resend API error ${res.status}: ${body}`);
    console.error('[mailer] Failed to send "%s" → %s: %s', subject, to, err.message);
    throw err;
  }

  const data = await res.json();
  console.log(`[mailer] Sent "${subject}" → ${to}  (id: ${data.id})`);
}

/**
 * Send the email-verification message.
 *
 * @param {string} email
 * @param {string} username
 * @param {string} token
 * @param {boolean} [force=false]  Pass true to bypass the in-process send cooldown
 *                                 (used by the explicit resend endpoint).
 */
async function sendVerificationEmail(email, username, token, force = false) {
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const link = `${base}/api/verify-email?token=${encodeURIComponent(token)}`;

  await sendMail({
    to: email,
    force,
    subject: 'Verify your Saint-Pixels account',
    text: `Hi ${username},\n\nClick the link below to verify your email address:\n\n${link}\n\nThe link expires in 24 hours.\n\nIf you did not create a Saint-Pixels account, you can ignore this email.`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:sans-serif;background:#1e1e1f;color:#e2e8f0;padding:32px;">
  <div style="max-width:480px;margin:0 auto;background:#2e2e2f;border-radius:16px;padding:32px;border:1px solid rgba(255,255,255,0.1);">
    <h1 style="margin:0 0 8px;font-size:1.5rem;">Saint-Pixels</h1>
    <p style="color:#94a3b8;margin:0 0 24px;">Verify your email address</p>
    <p>Hi <strong>${username}</strong>,</p>
    <p>Click the button below to confirm your email and activate your account. The link expires in <strong>24 hours</strong>.</p>
    <a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#38bdf8;color:#0f172a;font-weight:700;border-radius:10px;text-decoration:none;">Verify Email</a>
    <p style="font-size:0.82rem;color:#64748b;margin-top:24px;">If the button doesn't work, copy this link:<br/><a href="${link}" style="color:#38bdf8;word-break:break-all;">${link}</a></p>
    <p style="font-size:0.82rem;color:#64748b;">If you didn't create a Saint-Pixels account, ignore this email.</p>
  </div>
</body>
</html>`,
  });
}

module.exports = { sendMail, sendVerificationEmail };
