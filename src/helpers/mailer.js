/**
 * Email helper — sends transactional emails via SMTP (nodemailer).
 * Configure SMTP credentials in .env (see .env.example).
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[mailer] SMTP not configured — emails will be logged to console only.');
    return null;
  }

  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return _transporter;
}

/**
 * Send an email.
 * Falls back to console.log if SMTP is not configured (local dev).
 *
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 */
async function sendMail({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || 'Saint-Pixels <no-reply@example.com>';
  const transporter = getTransporter();

  if (!transporter) {
    // Dev fallback — print to terminal
    console.log(`\n[mailer] ─── EMAIL (dev mode) ────────────────────`);
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${text || html}`);
    console.log(`────────────────────────────────────────────────\n`);
    return;
  }

  await transporter.sendMail({ from, to, subject, html, text });
}

/**
 * Send the email-verification message.
 *
 * @param {string} email
 * @param {string} username
 * @param {string} token  - The verification token stored in the DB
 */
async function sendVerificationEmail(email, username, token) {
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const link = `${base}/api/verify-email?token=${encodeURIComponent(token)}`;

  await sendMail({
    to: email,
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
