/**
 * hCaptcha server-side verification helper.
 * Docs: https://docs.hcaptcha.com/#server
 */

const https = require('https');
const querystring = require('querystring');

const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';

/**
 * Verify an hCaptcha token sent by the browser.
 *
 * @param {string} token  - The h-captcha-response value from the form
 * @returns {Promise<{ success: boolean, errorCodes?: string[] }>}
 */
function verifyCaptcha(token) {
  return new Promise((resolve) => {
    const secret = process.env.HCAPTCHA_SECRET;

    // If no secret is configured (local dev without .env), skip verification.
    if (!secret) {
      console.warn('[captcha] HCAPTCHA_SECRET not set — skipping captcha verification (dev mode)');
      return resolve({ success: true });
    }

    if (!token) {
      return resolve({ success: false, errorCodes: ['missing-input-response'] });
    }

    const postData = querystring.stringify({ secret, response: token });

    const options = {
      method: 'POST',
      hostname: 'hcaptcha.com',
      path: '/siteverify',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({
            success: !!data.success,
            errorCodes: data['error-codes'] || [],
          });
        } catch {
          resolve({ success: false, errorCodes: ['parse-error'] });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[captcha] hCaptcha request failed:', err.message);
      // Fail open on network error so users aren't blocked by captcha outages.
      resolve({ success: true });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Express middleware — rejects the request with 400 if captcha is invalid.
 * Reads `req.body.captchaToken`.
 */
async function requireCaptcha(req, res, next) {
  const token = req.body?.captchaToken;
  const result = await verifyCaptcha(token);
  if (!result.success) {
    return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
  }
  next();
}

module.exports = { verifyCaptcha, requireCaptcha };
