const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

/**
 * Hash a password using bcrypt.
 * Returns a Promise<string>.
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  const pwd = typeof password === 'string' ? password : '';
  return bcrypt.hash(pwd, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
  const pwd = typeof password === 'string' ? password : '';
  return bcrypt.compare(pwd, hash);
}

module.exports = { hashPassword, verifyPassword };
