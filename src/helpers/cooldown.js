const userCooldowns = new Map(); // @TODO Use KeyVal service for this

/**
 * Returns the remaining cooldown for the user
 * @param {string} username
 * @return {number}
 */
export function getCooldown(username) {
  const now = Date.now();
  const lastTime = userCooldowns.get(username) || 0;
  const remaining = lastTime + 5000 - now;

  return remaining > 0 ? remaining : 0;
}

/**
 * Reset the cooldown timer for the user
 * @param {string} username
 */
export function resetCooldown(username) {
    userCooldowns.set(username, Date.now());
}