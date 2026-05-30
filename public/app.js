// ═══════════════════════════════════════════════════════════════════
// Alpine.js component data is inlined directly in the <body x-data="...">
// attribute in index.html — no alpine:init registration needed.
// The canvas engine dispatches `sp-state-change` custom events;
// Alpine picks them up via @sp-state-change.window on <body>.
// ═══════════════════════════════════════════════════════════════════

// Helper: send reactive state updates to Alpine without touching the DOM
function dispatchStateChange(detail) {
  window.dispatchEvent(new CustomEvent('sp-state-change', { detail }));
}


document.addEventListener('DOMContentLoaded', () => {
// Prevent default form submission (replaces the removed onsubmit="return false;" attr,
// which was blocked by Content-Security-Policy script-src-attr 'none').
document.getElementById('authForm')?.addEventListener('submit', e => e.preventDefault());

const canvas = document.getElementById('canvas');
const overlay = document.getElementById('overlay');
const gridCanvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');
const overlayCtx = overlay.getContext('2d');
const gridCtx = gridCanvas.getContext('2d');
const viewport = document.getElementById('viewport');
const zoomInput = document.getElementById('zoom');
const toggleGridBtn = document.getElementById('toggle-grid');
const clearCanvasButton = document.getElementById('clear-canvas');
const exportButton = document.getElementById('export-png');
const paletteEl = document.getElementById('palette');
const colorInput = document.getElementById('color');
const toolButtons = document.querySelectorAll('[data-tool]');
const coordLabel = document.getElementById('coord');
const authOverlay = document.getElementById('authOverlay');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const authEmail = document.getElementById('authEmail');
const authEmailLabel = document.getElementById('authEmailLabel');
const authLoginButton = document.getElementById('authLogin');
const authRegisterButton = document.getElementById('authRegister');
const authMessage = document.getElementById('authMessage');
const addColorButton = document.getElementById('add-color');
const cooldownBar = document.getElementById('cooldownBar');
const cooldownFill = document.getElementById('cooldownFill');
const cooldownBarLabel = document.getElementById('cooldownBarLabel');

const CANVAS_WIDTH = 2000;
const CANVAS_HEIGHT = 2000;
// Visible board dimensions (grid and placement area)
const BOARD_WIDTH = 1920;
const BOARD_HEIGHT = 1080;
const DEFAULT_PALETTE = [
  { id: 0, label: 'Black', color: '#000000' },
  { id: 1, label: 'White', color: '#ffffff' },
  { id: 2, label: 'Red', color: '#ef4444' },
  { id: 3, label: 'Orange', color: '#fb923c' },
  { id: 4, label: 'Yellow', color: '#facc15' },
  { id: 5, label: 'Green', color: '#22c55e' },
  { id: 6, label: 'Cyan', color: '#06b6d4' },
  { id: 7, label: 'Blue', color: '#3b82f6' },
  { id: 8, label: 'Indigo', color: '#6366f1' },
  { id: 9, label: 'Violet', color: '#8b5cf6' },
  { id: 10, label: 'Pink', color: '#ec4899' },
  { id: 11, label: 'Light Brown', color: '#a0785a' },
  { id: 12, label: 'Beige', color: '#f5deb3' },
  { id: 13, label: 'Gray', color: '#888888' }
];
const paletteColors = [];
const CUSTOM_PALETTE_KEY = 'sp_customPalette';
const TOKEN_KEY = 'sp_token';
const EVENT_KEY = 'sp_last_event';
const PIXEL_HISTORY_KEY = 'sp_pixel_history';
// Declared here (top of DOMContentLoaded) so clearToken(), updateAuthState(),
// and checkVerifiedParam() can all reference it without a TDZ ReferenceError.
const EMAIL_VERIFIED_KEY = 'sp_email_verified';
const COOLDOWN_MS = 3000;
/** Max zoom as UI scale (1 = 100%, 50 = 5000%) */
const MAX_ZOOM_SCALE = 50;
/** Slow OS key-repeat for arrow nudging (ms between steps while key is held) */
const ARROW_KEY_REPEAT_MS = 110;
/** Ignore small mouse jitter after arrow moves until pointer moves this far (px). */
const MOUSE_CURSOR_ARMOR_PX = 36;
/** Grid corner dots — screen pixels per dot (was 1×1). */
const GRID_DOT_SCREEN_PX = 3;

// ── SSE real-time sync ──────────────────────────────────────────────────────
// Connects to /api/stream and applies pixels placed by other users instantly.
let _sseSource = null;

// Batch rapid incoming remote pixels into a single rAF redraw.
// When many players are painting simultaneously the SSE stream can deliver
// dozens of pixel events per frame; calling redraw() for each one wastes CPU.
let _remoteRedrawPending = false;
function scheduleRemoteRedraw() {
  if (_remoteRedrawPending) return;
  _remoteRedrawPending = true;
  requestAnimationFrame(() => {
    _remoteRedrawPending = false;
    redraw();
  });
}

function connectSSE() {
  if (_sseSource) { _sseSource.close(); }
  const token = getStoredToken();
  const url = token ? `/api/stream?token=${encodeURIComponent(token)}` : '/api/stream';
  _sseSource = new EventSource(url);

  _sseSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'init') {
        // Server sent the full canvas history — paint all pixels on connect
        if (Array.isArray(event.pixels)) {
          event.pixels.forEach(p => {
            if (typeof p.x === 'number' && typeof p.y === 'number') {
              if (p.color === 'erase') {
                paintPixel(p.x, p.y, 1, 'eraser', null);
              } else if (typeof p.color === 'string') {
                paintPixel(p.x, p.y, 1, 'brush', p.color.startsWith('#') ? p.color : '#' + p.color);
              }
            }
          });
          redraw();
        }
      } else if (event.type === 'pixel') {
        if (event.user !== currentUser) {
          applyRemotePixel(event);
          scheduleRemoteRedraw();
        }
        // Notify leaderboard of any pixel placed (own or other players)
        window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
      } else if (event.type === 'erase') {
        if (event.user !== currentUser) {
          paintPixel(event.x, event.y, 1, 'eraser', null);
          scheduleRemoteRedraw();
        }
      } else if (event.type === 'clients') {
        // Update live player count from server SSE (authoritative count)
        dispatchStateChange({ liveCount: event.count });
      } else if (event.type === 'chat') {
        // Forward chat messages to the chat panel (chat.js)
        if (typeof window.__chatIncoming === 'function') window.__chatIncoming(event);
      }
    } catch { /* ignore malformed events */ }
  };

  _sseSource.onerror = () => {
    // Auto-reconnect after 3 seconds on connection drop
    setTimeout(connectSSE, 3000);
  };
}

const bufferCanvas = document.createElement('canvas');
bufferCanvas.width = CANVAS_WIDTH;
bufferCanvas.height = CANVAS_HEIGHT;
const bufferCtx = bufferCanvas.getContext('2d');

let scale = 1;
let offsetX = 0;
let offsetY = 0;
// Track the last values used to draw the grid so we only redraw it when
// the viewport actually changes (prevents the flash on every cursor move).
let lastGridScale = null;
let lastGridOffsetX = null;
let lastGridOffsetY = null;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let dragStart = null;
/** Long-press-to-pan: timer ID and anchor coords for the pending long press */
let _longPressPanTimer = null;
let _longPressAnchorX = 0;
let _longPressAnchorY = 0;
/** px of movement allowed before the long-press is cancelled */
const LONG_PRESS_MOVE_THRESHOLD = 6;
/** ms to hold before panning starts */
const LONG_PRESS_PAN_DELAY_MS = 400;
let gridEnabled = true;
let tool = 'brush';
/** Set to true when the eyedropper fires on mobile so the same touchend that
 * triggered the pick doesn't also place a pixel after switching to brush. */
let _eyedropperJustFired = false;
let color = '#000000';
let pixelSize = 1;
let isMouseDown = false;
let cursorPosition = { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
let currentUser = null;
let lastPlaceAt = 0;
let customPalette = [];
let lastArrowKeyMoveAt = 0;
let lastPointerClientX = 0;
let lastPointerClientY = 0;
/** After arrow keys, tiny mouse moves won't snap the board cursor until you move farther. */
let keyboardCursorArmored = false;
let mouseArmorAnchorX = 0;
let mouseArmorAnchorY = 0;
/** Index of the palette slot most recently activated by the user — eyedropper prefers this slot on ties. */
let lastUsedPaletteIdx = -1;

function safeParse(value, fallback) {
  try {
    return JSON.parse(value) || fallback;
  } catch (error) {
    return fallback;
  }
}

function getCustomPalette() {
  const raw = safeParse(localStorage.getItem(CUSTOM_PALETTE_KEY), []);
  if (!Array.isArray(raw)) return [];
  return raw.map(entry =>
    normalizeHexColor(typeof entry === 'string' ? entry : String(entry?.color ?? ''))
  );
}

function saveCustomPalette(list) {
  localStorage.setItem(CUSTOM_PALETTE_KEY, JSON.stringify(list));
}

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_VERIFIED_KEY);
}

function normalizeHexColor(value) {
  if (!value && value !== '') return '#000000';
  let hex = String(value).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    hex = hex.split('').map(ch => ch + ch).join('');
  }
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : '#000000';
}

function asPaletteEntry(entry) {
  if (typeof entry === 'string') {
    return { id: null, label: normalizeHexColor(entry), color: normalizeHexColor(entry) };
  }
  return {
    id: entry.id != null ? entry.id : null,
    label: entry.label || normalizeHexColor(entry.color),
    color: normalizeHexColor(entry.color)
  };
}

async function loadServerPalette() {
  try {
    const response = await fetch('/api/palette');
    if (!response.ok) {
      throw new Error('Palette API failed');
    }
    const data = await response.json();
    if (Array.isArray(data.colors)) {
      paletteColors.length = 0;
      data.colors.forEach(item => paletteColors.push(asPaletteEntry(item)));
      // Ensure the standard rainbow colors are present in the loaded palette
      ensureRainbowInPalette(paletteColors);
      return;
    }
  } catch (error) {
    console.warn('Unable to load palette from API, using defaults.', error);
  }
  paletteColors.length = 0;
  DEFAULT_PALETTE.forEach(item => paletteColors.push(asPaletteEntry(item)));
  // Ensure the defaults include rainbow colors (safety)
  ensureRainbowInPalette(paletteColors);
}

/**
 * Ensure the palette contains the seven rainbow colors (red, orange, yellow,
 * green, blue, indigo, violet). If any are missing, append them from
 * DEFAULT_PALETTE so the user always has the full rainbow available.
 * Also ensures any other DEFAULT_PALETTE entries (e.g. Light Brown, Beige)
 * that the server palette omits are appended.
 */
function ensureRainbowInPalette(list) {
  if (!Array.isArray(list)) return;
  const present = new Set(list.map(e => normalizeHexColor(e.color)));
  // Add every DEFAULT_PALETTE entry that's missing from the loaded palette
  DEFAULT_PALETTE.forEach(entry => {
    const norm = normalizeHexColor(entry.color);
    if (!present.has(norm)) {
      list.push(asPaletteEntry(entry));
      present.add(norm);
    }
  });
}

async function updateAuthState() {
  const token = getStoredToken();
  if (!token) {
    currentUser = null;
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
    return;
  }

  try {
    const response = await fetch('/api/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      clearToken();
      currentUser = null;
      dispatchStateChange({ currentUser: null, emailVerified: false });
      document.body.classList.add('auth-open');
      authUsername.focus();
      return;
    }

    const data = await response.json();
    currentUser = data.username;
    
    // Sync local cooldown timer with server remaining time
    if (data.cooldown && data.cooldown > 0) {
      lastPlaceAt = Date.now() - (COOLDOWN_MS - data.cooldown);
    } else {
      lastPlaceAt = 0; // Ready to place
    }

    // If the server says unverified but the user just clicked the link this session,
    // trust localStorage — the DB may lag slightly behind the redirect.
    const locallyVerified = localStorage.getItem(EMAIL_VERIFIED_KEY) === '1';
    const emailVerified = !!data.emailVerified || locallyVerified;
    if (data.emailVerified) {
      // DB confirms verified — keep the flag in sync
      localStorage.setItem(EMAIL_VERIFIED_KEY, '1');
    }
    // Expose auth state for chat.js
    window.__username  = data.username;
    window.__authToken = token;
    dispatchStateChange({ currentUser: data.username, emailVerified });
    document.body.classList.remove('auth-open');
    authMessage.textContent = '';
    updateCooldownLabel();
  } catch (error) {
    currentUser = null;
    window.__username  = null;
    window.__authToken = null;
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
  }
}

function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function setCurrentUser(username, emailVerified = false, cooldown = 0) {
  currentUser = username;
  
  // Sync local cooldown timer with server remaining time
  if (cooldown && cooldown > 0) {
    lastPlaceAt = Date.now() - (COOLDOWN_MS - cooldown);
  } else {
    lastPlaceAt = 0; // Ready to place
  }

  // Expose auth state for chat.js
  window.__username  = username;
  window.__authToken = getStoredToken();
  dispatchStateChange({ currentUser: username, emailVerified: !!emailVerified });
  document.body.classList.remove('auth-open');
  showAuthMessage('');
  updateCooldownLabel();
}

async function handleLogout() {
  const token = getStoredToken();
  if (token) {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    } catch (e) {
      // ignore network errors
    }
  }
  clearToken();
  currentUser = null;
  // Clear auth globals used by chat.js
  window.__username  = null;
  window.__authToken = null;
  
  // Reset placement cooldown on logout
  lastPlaceAt = 0; 
  
  dispatchStateChange({ currentUser: null });
  showAuthMessage('Logged out', false);
  updateCooldownLabel();
}

async function handleLogin(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) {
    showAuthMessage('Enter username and password.');
    return;
  }

  const captchaToken = getCaptchaToken();
  if (!captchaToken) {
    showAuthMessage('Please complete the captcha.');
    return;
  }

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, captchaToken })
    });

    const data = await response.json();
    if (!response.ok) {
      resetCaptcha();
      showAuthMessage(data.error || 'Login failed.');
      return;
    }

    resetCaptcha();
    saveToken(data.token);
    // Pass the cooldown data to setCurrentUser
    setCurrentUser(data.username, data.emailVerified, data.cooldown);
  } catch (error) {
    resetCaptcha();
    showAuthMessage('Unable to reach server.');
  }
}

async function handleRegister(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  const email = authEmail ? authEmail.value.trim() : '';

  if (!username || !password) {
    showAuthMessage('Enter username and password.');
    return;
  }
  if (!email) {
    showAuthMessage('Enter your email address.');
    return;
  }

  const authRulesCheck = document.getElementById('authRulesCheck');
  if (!authRulesCheck || !authRulesCheck.checked) {
    showAuthMessage('Please read and agree to the community rules.');
    return;
  }

  const captchaToken = getCaptchaToken();
  if (!captchaToken) {
    showAuthMessage('Please complete the captcha.');
    return;
  }

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email, captchaToken })
    });

    const data = await response.json();
    if (!response.ok) {
      resetCaptcha();
      showAuthMessage(data.error || 'Registration failed.');
      return;
    }

    // Save token and update auth state so the overlay closes immediately
    saveToken(data.token);
    await updateAuthState(); 
    // Fallback: ensure UI shows the new username and syncs cooldown
    setCurrentUser(data.username, data.emailVerified, data.cooldown);
    if (data.message) showAuthMessage(data.message, false);
  } catch (error) {
    showAuthMessage('Unable to reach server.');
  }
}

let _cooldownRafId = null;
function updateCooldownLabel() {
  if (!cooldownBar || !cooldownFill || !cooldownBarLabel) return;
  if (!currentUser) {
    cooldownBar.classList.add('cooldown-bar--guest');
    cooldownBar.classList.remove('cooldown-bar--cooling');
    cooldownFill.style.width = '100%';
    cooldownBarLabel.textContent = 'Sign in to place pixels';
    if (_cooldownRafId) { cancelAnimationFrame(_cooldownRafId); _cooldownRafId = null; }
    return;
  }
  cooldownBar.classList.remove('cooldown-bar--guest');
  const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - lastPlaceAt));
  const recharged = 1 - remaining / COOLDOWN_MS;
  cooldownFill.style.width = `${Math.max(0, Math.min(100, recharged * 100))}%`;
  if (remaining > 0) {
    cooldownBar.classList.add('cooldown-bar--cooling');
    cooldownBarLabel.textContent = `Cooldown · ${Math.ceil(remaining / 1000)}s`;
    // Drive smooth updates via rAF while cooling
    if (!_cooldownRafId) {
      const tick = () => {
        const rem = Math.max(0, COOLDOWN_MS - (Date.now() - lastPlaceAt));
        const pct = (1 - rem / COOLDOWN_MS) * 100;
        cooldownFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        if (rem > 0) {
          cooldownBarLabel.textContent = `Cooldown · ${Math.ceil(rem / 1000)}s`;
          _cooldownRafId = requestAnimationFrame(tick);
        } else {
          cooldownFill.style.width = '100%';
          cooldownBar.classList.remove('cooldown-bar--cooling');
          cooldownBarLabel.textContent = 'Ready to place';
          _cooldownRafId = null;
        }
      };
      _cooldownRafId = requestAnimationFrame(tick);
    }
  } else {
    cooldownBar.classList.remove('cooldown-bar--cooling');
    cooldownBarLabel.textContent = 'Ready to place';
    if (_cooldownRafId) { cancelAnimationFrame(_cooldownRafId); _cooldownRafId = null; }
  }
}

function canPlacePixel() {
  return !!currentUser && Date.now() - lastPlaceAt >= COOLDOWN_MS;
}

// ─── Grid: corner dots drawn in viewport space ───────────────────────────────
// One dot at every board-pixel corner visible on screen. Canvas is always
// viewport-sized; offsetX/Y baked in directly — no CSS translate tricks.
// ─────────────────────────────────────────────────────────────────────────────
function drawGrid() {
  const dpr = window.devicePixelRatio || 1;

  gridCanvas.width  = canvas.width;
  gridCanvas.height = canvas.height;

  gridCtx.setTransform(1, 0, 0, 1, 0, 0);
  gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);

  if (!gridEnabled || scale < 4) return;

  const vpW = canvas.width  / dpr;
  const vpH = canvas.height / dpr;

  gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const boardScreenR = offsetX + Math.round(BOARD_WIDTH  * scale);
  const boardScreenB = offsetY + Math.round(BOARD_HEIGHT * scale);

  const clipL = Math.max(0, offsetX);
  const clipT = Math.max(0, offsetY);
  const clipR = Math.min(vpW, boardScreenR);
  const clipB = Math.min(vpH, boardScreenB);
  if (clipR <= clipL || clipB <= clipT) return;

  const startCol = Math.max(0, Math.floor((clipL - offsetX) / scale));
  const startRow = Math.max(0, Math.floor((clipT - offsetY) / scale));
  const endCol   = Math.min(BOARD_WIDTH,  Math.ceil((clipR - offsetX) / scale));
  const endRow   = Math.min(BOARD_HEIGHT, Math.ceil((clipB - offsetY) / scale));

  // Collect unique x positions (duplicate-pixel guard for awkward zoom levels)
  const xs = [];
  let lastX = -Infinity;
  for (let col = startCol; col <= endCol; col++) {
    const x = Math.floor(col * scale + offsetX);
    if (x === lastX || x < clipL || x > clipR) continue;
    lastX = x;
    xs.push(x);
  }

  const ys = [];
  let lastY = -Infinity;
  for (let row = startRow; row <= endRow; row++) {
    const y = Math.floor(row * scale + offsetY);
    if (y === lastY || y < clipT || y > clipB) continue;
    lastY = y;
    ys.push(y);
  }

  // Cross markers at every corner: each arm extends 25% into the adjacent cell.
  const armX = Math.min(scale * 0.25, 6);
  const armY = Math.min(scale * 0.25, 6);
  const thick = Math.min(Math.max(scale * 0.15, 1), 2);

  gridCtx.fillStyle = 'rgba(0,0,0,0.18)';
  for (const y of ys) {
    for (const x of xs) {
      gridCtx.fillRect(x - armX, y - thick / 2, armX * 2, thick);
      gridCtx.fillRect(x - thick / 2, y - armY, thick, armY * 2);
    }
  }

  // Board border
  gridCtx.strokeStyle = 'rgba(0,0,0,0.6)';
  gridCtx.lineWidth = 1;
  gridCtx.strokeRect(
    offsetX + 0.5, offsetY + 0.5,
    Math.round(BOARD_WIDTH * scale),
    Math.round(BOARD_HEIGHT * scale)
  );
}

function drawGridIfDirty() {
  const scaleChanged  = scale   !== lastGridScale;
  const offsetChanged = offsetX !== lastGridOffsetX || offsetY !== lastGridOffsetY;
  if (!scaleChanged && !offsetChanged) return;
  lastGridScale   = scale;
  lastGridOffsetX = offsetX;
  lastGridOffsetY = offsetY;
  drawGrid();
}

function toggleGrid() {
  gridEnabled = !gridEnabled;
  toggleGridBtn.classList.toggle('active', gridEnabled);
  // Force a full grid redraw since gridEnabled changed
  lastGridScale = null;
  redraw();
}

let isRedrawPending = false;

function redraw() {
  if (isRedrawPending) return;
  isRedrawPending = true;

  requestAnimationFrame(() => {
    isRedrawPending = false;
    clampOffsets();
    
    const dpr = window.devicePixelRatio || 1;
    
    // offsetX/Y are always whole numbers (rounded at every write site),
    // so no rounding is needed here — just use them directly.
    const ox = offsetX;
    const oy = offsetY;
    
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Keep pixels crisp at any zoom level
    ctx.imageSmoothingEnabled = false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    const boardW = Math.round(BOARD_WIDTH * scale);
    const boardH = Math.round(BOARD_HEIGHT * scale);
    
    // Draw the white board background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox, oy, boardW, boardH);

    // ── Occlusion culling ──────────────────────────────────────────────
    // Compute the visible board region in board-pixel coordinates so we
    // only blit the portion of the buffer that's actually on screen.
    const vpW_css = canvas.width / dpr;
    const vpH_css = canvas.height / dpr;

    // Board rect in viewport-CSS pixels
    const bLeft   = ox;
    const bTop    = oy;
    const bRight  = ox + boardW;
    const bBottom = oy + boardH;

    // Visible intersection (viewport is 0,0 → vpW,vpH)
    const visL = Math.max(0, bLeft);
    const visT = Math.max(0, bTop);
    const visR = Math.min(vpW_css, bRight);
    const visB = Math.min(vpH_css, bBottom);

    if (visR > visL && visB > visT) {
      // Map the visible screen rect back to source board-pixel coords
      const srcX = (visL - ox) / scale;
      const srcY = (visT - oy) / scale;
      const srcW = (visR - visL) / scale;
      const srcH = (visB - visT) / scale;

      // Draw only the visible slice — skip off-screen pixels entirely
      ctx.drawImage(
        bufferCanvas,
        srcX, srcY, srcW, srcH,
        visL, visT, visR - visL, visB - visT
      );
    }

    // Redraw grid only when scale/offset changed — grid lives on its own canvas
    drawGridIfDirty();

    // Overlay is cursor-only; clear and redraw just the cursor highlight
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    drawCursor();
    rulerDrawOverlay();
  });
}

function getCanvasCoords(clientX, clientY) {
  // Use viewport rect — canvas pixel dimensions are sized from viewport, not from canvas CSS size.
  // offsetX/Y are always whole numbers (rounded at every write site), so
  // tap-to-place always lands on the same cell the cursor highlight is drawn on.
  const rect = viewport.getBoundingClientRect();

  // When the user pinch-zooms the *browser* (not the in-app zoom), the Visual
  // Viewport API reports a scale != 1.  touch.clientX/clientY are given in
  // *layout* CSS pixels (unscaled), but getBoundingClientRect() also returns
  // layout pixels, so they cancel correctly.  However offsetX/offsetY are
  // maintained in *visual* CSS pixels (the coordinate space the canvas is
  // drawn in), so we must divide by the visual viewport scale to convert
  // them back to layout pixels before subtracting.
  //
  // On browsers that don't support visualViewport the scale is 1 and this
  // reduces to the original formula.
  const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;

  const ox = offsetX / vvScale;
  const oy = offsetY / vvScale;
  const s  = scale   / vvScale;

  const x = (clientX - rect.left - ox) / s;
  const y = (clientY - rect.top  - oy) / s;
  return {
    x: clamp(Math.floor(x), 0, BOARD_WIDTH - 1),
    y: clamp(Math.floor(y), 0, BOARD_HEIGHT - 1)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampOffsets() {
  const dpr = window.devicePixelRatio || 1;
  // Use CSS pixel dimensions so all comparisons are in the same unit as scale, offsetX, offsetY.
  const vpW = canvas.width / dpr;
  const vpH = canvas.height / dpr;
  const scaledWidth = BOARD_WIDTH * scale;
  const scaledHeight = BOARD_HEIGHT * scale;

  // Allow panning up to 30% of the viewport outside the canvas edges
  // so users can see the dark-blue area around the canvas.
  const padX = Math.round(vpW * 0.30);
  const padY = Math.round(vpH * 0.30);

  if (vpW >= scaledWidth) {
    // Canvas fits: center it, but still allow a little wiggle
    const centered = Math.round((vpW - scaledWidth) / 2);
    offsetX = clamp(offsetX, centered - padX, centered + padX);
  } else {
    offsetX = clamp(offsetX, vpW - scaledWidth - padX, padX);
  }

  if (vpH >= scaledHeight) {
    const centered = Math.round((vpH - scaledHeight) / 2);
    offsetY = clamp(offsetY, centered - padY, centered + padY);
  } else {
    offsetY = clamp(offsetY, vpH - scaledHeight - padY, padY);
  }
}

function paintPixel(x, y, customSize = pixelSize, customTool = tool, customColor = color) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  bufferCtx.save();
  if (customTool === 'eraser') {
    bufferCtx.globalCompositeOperation = 'destination-out';
    // destination-out uses the source alpha; fully transparent fill erases nothing.
    bufferCtx.fillStyle = 'rgba(0, 0, 0, 1)';
  } else {
    bufferCtx.globalCompositeOperation = 'source-over';
    bufferCtx.fillStyle = customColor;
  }
  bufferCtx.fillRect(x, y, customSize, customSize);
  bufferCtx.restore();
}

function fillArea(x, y) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  const imageData = bufferCtx.getImageData(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  const targetIndex = (y * BOARD_WIDTH + x) * 4;
  const targetColor = imageData.data.slice(targetIndex, targetIndex + 4);
  const replacement = hexToRgba(color);
  if (colorsMatch(targetColor, replacement)) return;

  const queue = [{ x, y }];
  const visited = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT);

  while (queue.length) {
    const { x: cx, y: cy } = queue.pop();
    const index = cy * BOARD_WIDTH + cx;
    if (cx < 0 || cy < 0 || cx >= BOARD_WIDTH || cy >= BOARD_HEIGHT) continue;
    if (visited[index]) continue;
    visited[index] = 1;

    const pixelIndex = index * 4;
    if (!colorsMatch(imageData.data.slice(pixelIndex, pixelIndex + 4), targetColor)) continue;

    imageData.data[pixelIndex] = replacement[0];
    imageData.data[pixelIndex + 1] = replacement[1];
    imageData.data[pixelIndex + 2] = replacement[2];
    imageData.data[pixelIndex + 3] = replacement[3];

    queue.push({ x: cx + 1, y: cy });
    queue.push({ x: cx - 1, y: cy });
    queue.push({ x: cx, y: cy + 1 });
    queue.push({ x: cx, y: cy - 1 });
  }

  bufferCtx.putImageData(imageData, 0, 0);
}

function colorsMatch(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function hexToRgba(hex) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  if (clean.length === 3) {
    return [
      ((bigint >> 8) & 0xf) * 17,
      ((bigint >> 4) & 0xf) * 17,
      (bigint & 0xf) * 17,
      255
    ];
  }
  return [
    (bigint >> 16) & 255,
    (bigint >> 8) & 255,
    bigint & 255,
    255
  ];
}

function drawCursor() {
  if (!cursorPosition || tool === 'hand' || tool === 'none') return;

  const dpr = window.devicePixelRatio || 1;
  const { x, y } = cursorPosition;

  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // offsetX/Y are always integers — no rounding needed
  const ox = offsetX;
  const oy = offsetY;
  
  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);
  
  // Calculating dynamic width based on next pixel coordinate avoids any 1px overlap gaps
  const sizeX = Math.floor((x + 1) * scale + ox) - px;
  const sizeY = Math.floor((y + 1) * scale + oy) - py;

  // FIX: Inject the currently selected color into the cursor fill (Eraser shows white)
  // For the ruler tool, flash the cell with a cyan tint.
  // While drawing: highlight the live endpoint (current cursor = where the
  // ruler end will be placed).  While idle: show where the first point goes.
  const isRulerMode = tool === 'ruler';
  const activeColor = isRulerMode
    ? '#00e5ff'
    : (tool === 'eraser' ? '#ffffff' : (color || '#000000'));
  const rgba = hexToRgba(activeColor);
  // Ruler uses a pulsing alpha so the highlight is clearly distinct from a
  // normal brush cursor.  A simple sine on performance.now() gives a smooth
  // flash without requiring a separate rAF loop.
  const rulerAlpha = isRulerMode
    ? 0.25 + 0.25 * Math.sin(performance.now() / 180)
    : 0.45;
  overlayCtx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rulerAlpha})`;
  overlayCtx.fillRect(px, py, sizeX, sizeY);

  // Ensure border stays exactly 1px thick at all zoom levels
  overlayCtx.lineWidth = 1;

  // Outer dark border (+0.5 centers the stroke perfectly)
  overlayCtx.strokeStyle = 'rgba(0,0,0,0.8)';
  overlayCtx.strokeRect(px - 0.5, py - 0.5, sizeX + 1, sizeY + 1);

  // Inner white border — only draw when the cell is large enough that it won't overdraw the fill
  if (sizeX >= 4 && sizeY >= 4) {
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    overlayCtx.strokeRect(px + 0.5, py + 0.5, sizeX - 1, sizeY - 1);
  }
}

function moveCursor(dx, dy) {
  if (!cursorPosition) return;
  const x = clamp(cursorPosition.x + dx, 0, BOARD_WIDTH - 1);
  const y = clamp(cursorPosition.y + dy, 0, BOARD_HEIGHT - 1);
  cursorPosition = { x, y };
  updateStatus(x, y);
  redraw();
}

function armKeyboardCursorAfterArrow() {
  keyboardCursorArmored = true;
  mouseArmorAnchorX = lastPointerClientX;
  mouseArmorAnchorY = lastPointerClientY;
}

function disarmKeyboardCursor() {
  keyboardCursorArmored = false;
}

function pointerMovedPastArmor(clientX, clientY) {
  const dx = clientX - mouseArmorAnchorX;
  const dy = clientY - mouseArmorAnchorY;
  return dx * dx + dy * dy >= MOUSE_CURSOR_ARMOR_PX * MOUSE_CURSOR_ARMOR_PX;
}

function ensureBoardCursor() {
  if (!cursorPosition) {
    cursorPosition = { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
  }
}

/** Arrow keys move one board pixel; repeated keys are throttled so holding the key does not jump too fast. */
function moveCursorFromArrow(dx, dy, event) {
  ensureBoardCursor();
  if (event.repeat) {
    const now = Date.now();
    if (now - lastArrowKeyMoveAt < ARROW_KEY_REPEAT_MS) return;
    lastArrowKeyMoveAt = now;
  } else {
    lastArrowKeyMoveAt = Date.now();
  }
  moveCursor(dx, dy);
  armKeyboardCursorAfterArrow();
}

function applyToolAtCell(x, y) {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return;
  if (tool === 'none' || tool === 'hand') return;
  if (tool === 'ruler') { rulerHandleClick(x, y); return; }
  updateStatus(x, y);
  cursorPosition = { x, y };

  if (tool === 'eyedropper') {
    const pixel = bufferCtx.getImageData(x, y, 1, 1).data;
    // FIX 1: Default to white if clicking an empty/transparent canvas area
    const picked = pixel[3] === 0 ? '#ffffff' : rgbToHex(pixel[0], pixel[1], pixel[2]);
    const norm = normalizeHexColor(picked);

    // Find the closest existing palette entry by hue similarity and update it
    // in-place, rather than adding a new entry.
    // FIX 2: Extract Lightness (pL) to distinguish between black and white
    const [pH, pS, pL] = hexToHsl(norm);

    // Search paletteColors (source of truth) directly — avoids the dual-DOM
    // problem where #palette and #fullscreen-palette are separate button sets.
    // Prefer the most-recently-used slot when multiple slots tie on hue distance,
    // so picking a dark blue replaces the blue you last used, not a random one.
    let bestIdx = -1;
    let bestDist = Infinity;

    paletteColors.forEach((entry, i) => {
      // Always compare against the canonical base color stored in paletteColors
      const base = normalizeHexColor(entry.color);     
      const [bH, bS, bL] = hexToHsl(base);
      
      const dH = Math.min(Math.abs(pH - bH), 360 - Math.abs(pH - bH));
      
      // 1. Calculate the 3D HSL distance first
      const dist = dH + Math.abs(pS - bS) * 0.3 + Math.abs(pL - bL) * 0.5;

      // 2. Set your comparison epsilon (1.0 handles 0-100 Lightness values smoothly)
      const EPSILON = 1.0;

      // 3. Run your comparison checks safely using the computed dist
      const isBetter = dist < bestDist - EPSILON;
      const isTieWithRecent = Math.abs(dist - bestDist) <= EPSILON && i === lastUsedPaletteIdx;
      
      if (isBetter || isTieWithRecent) { 
        bestDist = dist; 
        bestIdx = i; 
      }
    });

    // Only update in-place when the hue is genuinely close (within 30°); otherwise
    // fall back to adding a new entry so completely novel colors still get recorded.
    const HUE_THRESHOLD = 30;
    // Collect every button updated by the eyedropper (both #palette and
    // #fullscreen-palette mirror the same slot) so setColor can mark all of them
    // selected at once.  The old "last wins" approach only marked the
    // fullscreen-palette button, leaving the desktop palette button unselected.
    const eyedropperBtns = [];
    if (bestIdx !== -1 && bestDist <= HUE_THRESHOLD) {
      // The exact color currently stored at the best slot — used to match DOM buttons precisely.
      const slotColor = normalizeHexColor(paletteColors[bestIdx].color);
      // Update paletteColors (source of truth) first
      paletteColors[bestIdx] = asPaletteEntry({ ...paletteColors[bestIdx], color: norm });
      // Sync ALL buttons whose dataset.color exactly matches the slot being replaced
      // (both the desktop #palette button and the mobile #fullscreen-palette button).
      document.querySelectorAll('#palette button, #fullscreen-palette button').forEach(btn => {
        if (normalizeHexColor(btn.dataset.color) === slotColor) {
          btn.style.background = norm;
          btn.dataset.color = norm;
          btn.title = norm.toUpperCase();
          // dataset.baseColor intentionally NOT updated — keeps the hue family anchor
          eyedropperBtns.push(btn);
        }
      });
    } else {
      const alreadyIn = paletteColors.some(e => normalizeHexColor(e.color) === norm);
      if (!alreadyIn) {
        paletteColors.push(asPaletteEntry({ id: null, label: norm, color: norm }));
        renderPalette();
      }
    }

    // Mark all matched buttons selected; pass first as the "preferred" anchor so
    // setColor's loop doesn't also try to search by hex (which could match wrong slots).
    // Then manually select any remaining ones setColor didn't touch.
    setColor(norm, eyedropperBtns[0] || null);
    if (eyedropperBtns.length > 1) {
      // setColor already cleared all .selected; re-apply to the rest
      eyedropperBtns.forEach(btn => btn.classList.add('selected'));
    }
    _eyedropperJustFired = true;
    // Cancel any pending long-press-pan timer so the mouseup for this same
    // click doesn't try to place a pixel after the eyedropper pick.
    cancelLongPressPan();
    // Delay the tool switch on touch devices so the touchend that triggered the
    // eyedropper pick has fully resolved before brush becomes active.
    // Without this delay, the same touch gesture that picked the color could
    // immediately place a pixel once the tool switches to brush.
    if (window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => { setTool('brush'); _eyedropperJustFired = false; }, 320);
    } else {
      setTool('brush');
    }
    redraw();
    return;
  }

  if (!canPlacePixel()) {
    updateCooldownLabel();
    redraw();
    return;
  }

  // 1. Paint immediately to the buffer and flush to screen — zero latency
  paintPixel(x, y);
  lastPlaceAt = Date.now();

  // Draw only the new pixel directly to ctx for instant feedback
  const ox = offsetX;
  const oy = offsetY;
  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);
  const size = Math.max(1, Math.round(pixelSize * scale));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (tool === 'eraser') {
    ctx.clearRect(px, py, size, size);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(px, py, size, size);
  }
  ctx.restore();

  // 2. Full redraw (grid, cursor, overlay) deferred one frame — invisible delay
  requestAnimationFrame(() => redraw());

  // 3. Defer storage/broadcast off the hot path entirely
  setTimeout(() => {
    updateCooldownLabel();
    broadcastEvent({
      type: 'pixel',
      x,
      y,
      color: tool === 'eraser' ? null : color,
      size: pixelSize,
      tool,
      user: currentUser,
      time: lastPlaceAt
    });
  }, 0);
}

function placeFromKeyboard() {
  if (!currentUser) return;
  ensureBoardCursor();

  // If the cursor wandered outside the board (panning into the void), snap it
  // back to the nearest valid board pixel so Enter always lands somewhere.
  cursorPosition = {
    x: clamp(cursorPosition.x, 0, BOARD_WIDTH  - 1),
    y: clamp(cursorPosition.y, 0, BOARD_HEIGHT - 1),
  };

  // 'none' and 'hand' are view-only tools — pressing Enter should place a pixel,
  // so switch to brush first (same intent as any other keyboard-place action).
  if (tool === 'none' || tool === 'hand') {
    setTool('brush');
  }

  applyToolAtCell(cursorPosition.x, cursorPosition.y);
}

function updateStatus(x, y) {
  const txt = `${x}, ${y}`;
  coordLabel.textContent = txt;
  const topbarCoord = document.getElementById('coord-topbar');
  if (topbarCoord) topbarCoord.textContent = txt;
}

function appendHistory(event) {
  const history = safeParse(localStorage.getItem(PIXEL_HISTORY_KEY), []);
  history.push(event);
  if (history.length > 500) history.shift();
  localStorage.setItem(PIXEL_HISTORY_KEY, JSON.stringify(history));
}

function broadcastEvent(event) {
  // Write EVENT_KEY synchronously so other tabs get it immediately,
  // but defer the heavier history append to keep the click path instant.
  localStorage.setItem(EVENT_KEY, JSON.stringify(event));
  if (event.type === 'pixel') {
    setTimeout(() => appendHistory(event), 0);

    // Persist to server (leaderboard + pixel history)
    const token = getStoredToken();
    if (token) {
      const endpoint = event.tool === 'eraser' ? '/api/erase' : '/api/pixel';
      // Coerce x/y to integers — the server guard uses parseInt() but sending
      // floats can cause subtle mismatches on fractional zoom coords.
      const payload = event.tool === 'eraser'
        ? { x: Math.round(event.x), y: Math.round(event.y) }
        : { x: Math.round(event.x), y: Math.round(event.y), color: event.color };
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      }).then(res => {
        if (res.ok) {
          window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
        } else {
          // Non-2xx = pixel was NOT saved (e.g. server-side cooldown race or IP
          // anti-cheat rejection). Roll back the client state so the cooldown
          // is not wasted and the ghost pixel doesn't stay on screen.
          res.json().then(data => {
            console.warn('[sp] pixel save failed:', res.status, data?.error);
            // Rollback: clear our local cooldown timestamp so the user can retry
            lastPlaceAt = 0;
            // Erase the optimistically-painted pixel from the buffer
            paintPixel(event.x, event.y, event.size || 1, 'eraser', null);
            redraw();
          }).catch(() => {
            console.warn('[sp] pixel save failed:', res.status);
            lastPlaceAt = 0;
            paintPixel(event.x, event.y, event.size || 1, 'eraser', null);
            redraw();
          });
        }
      }).catch(err => {
        // Network error — pixel visible locally but not persisted to server.
        console.warn('[sp] pixel save network error:', err.message);
      });
    }
  }
  if (event.type === 'clear') {
    setTimeout(() => localStorage.setItem(PIXEL_HISTORY_KEY, JSON.stringify([])), 0);
  }
}

function applyRemotePixel(event) {
  const remoteTool = event.tool || 'brush';
  const remoteColor =
    remoteTool === 'eraser'
      ? null
      : event.color != null && event.color !== ''
        ? normalizeHexColor(String(event.color))
        : '#000000';
  paintPixel(event.x, event.y, event.size || 1, remoteTool, remoteColor);
  // NOTE: callers are responsible for calling redraw() — do NOT call it here
  // to avoid double-redraws when batching multiple remote pixels.
}

function handleRemoteEvent(event) {
  if (!event || !event.type) return;
  if (event.type === 'pixel') {
    applyRemotePixel(event);
    redraw();
  } else if (event.type === 'clear') {
    clearCanvasLocal(false);
  } else if (event.type === 'palette') {
    customPalette = Array.isArray(event.palette)
      ? event.palette.map(entry =>
          normalizeHexColor(typeof entry === 'string' ? entry : String(entry?.color ?? ''))
        )
      : [];
    saveCustomPalette(customPalette);
    renderPalette();
  }
}

function replayHistory() {
  const history = safeParse(localStorage.getItem(PIXEL_HISTORY_KEY), []);
  history.forEach(event => {
    if (event.type === 'pixel') {
      applyRemotePixel(event);
    }
  });
}

function clearCanvasLocal(announce = true) {
  bufferCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  redraw();
  if (announce) {
    broadcastEvent({ type: 'clear', user: currentUser });
  }
}

function clearCanvas() {
  if (!currentUser) return;
  clearCanvasLocal(true);
}

function exportPng() {
  // bufferCanvas is 2000×2000 but the board is only BOARD_WIDTH×BOARD_HEIGHT.
  // Export only the board region so the PNG isn't padded with blank rows/columns.
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width  = BOARD_WIDTH;
  exportCanvas.height = BOARD_HEIGHT;
  exportCanvas.getContext('2d').drawImage(
    bufferCanvas,
    0, 0, BOARD_WIDTH, BOARD_HEIGHT,   // source: board region of buffer
    0, 0, BOARD_WIDTH, BOARD_HEIGHT    // dest: full export canvas
  );
  const link = document.createElement('a');
  link.download = 'saint-pixels.png';
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
}

function hexToHsl(hex) {
  let [r, g, b] = hexToRgba(hex).slice(0, 3).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function removeVariationPicker() {
  const existing = document.querySelector('.variation-picker');
  if (existing) existing.remove();
}

function showVariationPicker(button, baseColor) {
  removeVariationPicker();
  const [h, s, l] = hexToHsl(baseColor);
  const variants = [
    hslToHex(h, s, Math.max(0,   l - 25)),
    hslToHex(h, s, Math.max(0,   l - 12)),
    baseColor,
    hslToHex(h, s, Math.min(100, l + 12)),
    hslToHex(h, s, Math.min(100, l + 25)),
  ];

  // Find which variant best matches the shade currently shown on the button.
  // This makes double-clicking after picking a shade keep that shade highlighted.
  const currentButtonColor = normalizeHexColor(button.dataset.color || baseColor);
  let activeIdx = 2; // default to the base/middle swatch
  let bestDist = Infinity;
  variants.forEach((hex, i) => {
    const norm = normalizeHexColor(hex);
    if (norm === currentButtonColor) { activeIdx = i; bestDist = 0; return; }
    // Fallback: pick closest by lightness distance if no exact match
    if (bestDist > 0) {
      const [,, li] = hexToHsl(hex);
      const [,, lc] = hexToHsl(currentButtonColor);
      const d = Math.abs(li - lc);
      if (d < bestDist) { bestDist = d; activeIdx = i; }
    }
  });

  const picker = document.createElement('div');
  picker.className = 'variation-picker';
  picker.style.cssText = [
    'position:fixed', 'z-index:99999',
    'display:flex', 'gap:6px', 'padding:8px',
    'background:rgba(47,47,48,0.98)',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:12px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
    'touch-action:none',
  ].join(';');

  // Shared cleanup — always removes the outside listeners
  function cleanupOutside() {
    document.removeEventListener('touchstart', onOutside, true);
    document.removeEventListener('mousedown',  onOutside, true);
  }

  variants.forEach(function(hex, i) {
    const swatch = document.createElement('button');
    swatch.className = 'variation-swatch';
    const isActive = i === activeIdx;
    const sz = isActive ? '36px' : '28px';
    const bd = isActive ? '2px solid rgba(255,255,255,0.5)' : '1px solid rgba(255,255,255,0.2)';
    swatch.style.cssText = 'width:' + sz + ';height:' + sz + ';border-radius:6px;background:' + hex + ';border:' + bd + ';cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;';
    swatch.title = hex.toUpperCase();

    function applyHex(e) {
      e.preventDefault();
      e.stopPropagation();
      const normHex = normalizeHexColor(hex);
      // Do NOT mutate paletteColors — the slot keeps its original color so that
      // if renderPalette() is ever called, the rebuilt button still anchors to
      // the original hue and dataset.baseColor stays correct.
      // Only update the button's visual so the swatch shows the chosen shade.
      if (button) {
        button.style.background = normHex;
        button.dataset.color = normHex;
        button.title = normHex.toUpperCase();
        // dataset.baseColor intentionally NOT updated — locks the hue family
      }
      setColor(normHex);
      removeVariationPicker();
      cleanupOutside();
    }
    swatch.addEventListener('click', applyHex);
    swatch.addEventListener('touchend', applyHex, { passive: false });
    picker.appendChild(swatch);
  });

  document.body.appendChild(picker);

  const rect = button.getBoundingClientRect();
  const pw = picker.offsetWidth || 220;
  const ph = picker.offsetHeight || 52;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  const spaceBelow = window.innerHeight - rect.bottom - 10;
  const top = spaceBelow >= ph ? rect.bottom + 6 : rect.top - ph - 6;
  picker.style.left = left + 'px';
  picker.style.top  = Math.max(8, top) + 'px';

  // Dismiss on outside touch/click — 200ms grace so the opening touch
  // does not immediately close the picker
  let dismissReady = false;
  setTimeout(function() { dismissReady = true; }, 200);

  function onOutside(e) {
    if (!dismissReady) return;
    if (picker.contains(e.target)) return;
    removeVariationPicker();
    cleanupOutside();
  }
  document.addEventListener('touchstart', onOutside, { capture: true, passive: true });
  document.addEventListener('mousedown',  onOutside, { capture: true });
}

function createPaletteButton(entry) {
  const button = document.createElement('button');
  button.style.background = entry.color;
  button.dataset.color = entry.color;
  // baseColor is the original hue of this slot — never updated by variation picks,
  // so double-click always generates shades around the same root color.
  button.dataset.baseColor = entry.color;
  button.title = `${entry.label} (${entry.color.toUpperCase()})`;
  if (entry.color.toLowerCase() === (color || '').toLowerCase()) {
    button.classList.add('selected');
  }

  // Touch double-tap state — declared here so both click and touchend share the same variable
  let _tapTimer = null;
  let _tapCount = 0;
  let _suppressNextClick = false;

  button.addEventListener('click', () => {
    if (_suppressNextClick) { _suppressNextClick = false; return; }
    // Select the current color of this swatch (may be a picked variation)
    const current = normalizeHexColor(button.dataset.color);
    setColor(current);
  });

  button.addEventListener('dblclick', (e) => {
    e.preventDefault();
    // Always open picker from the original base color, never from a previously picked shade
    showVariationPicker(button, button.dataset.baseColor);
  });

  // Touch double-tap for variation picker on mobile
  button.addEventListener('touchend', (e) => {
    _tapCount++;
    if (_tapCount === 1) {
      _tapTimer = setTimeout(() => { _tapCount = 0; }, 350);
    } else if (_tapCount >= 2) {
      clearTimeout(_tapTimer);
      _tapCount = 0;
      e.preventDefault();
      e.stopPropagation();
      _suppressNextClick = true;
      // Reset suppress after a short delay in case no click fires (touchend only)
      setTimeout(() => { _suppressNextClick = false; }, 600);
      showVariationPicker(button, button.dataset.baseColor);
    }
  }, { passive: false });

  // Prevent long-press from removing color on mobile (contextmenu fires on long-press)
  let _longPressTimer = null;
  button.addEventListener('touchstart', (e) => {
    _longPressTimer = setTimeout(() => {
      // On mobile long-press: do nothing (don't remove the color)
      _longPressTimer = null;
    }, 500);
  }, { passive: true });
  button.addEventListener('touchend', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  });
  button.addEventListener('touchmove', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  });

  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Only remove on desktop (non-touch) right-click
    if (e.pointerType === 'touch' || window.matchMedia('(pointer: coarse)').matches) return;
    const idx = paletteColors.findIndex(p => normalizeHexColor(p.color) === normalizeHexColor(entry.color));
    if (idx !== -1) {
      paletteColors.splice(idx, 1);
      renderPalette();
    }
  });

  return button;
}

function renderPalette() {
  paletteEl.innerHTML = '';
  const fsPaletteEl = document.getElementById('fullscreen-palette');
  if (fsPaletteEl) fsPaletteEl.innerHTML = '';

  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const colors = sourcePalette.map(asPaletteEntry);

  colors.forEach(entry => {
    paletteEl.appendChild(createPaletteButton(entry));
    if (fsPaletteEl) {
      fsPaletteEl.appendChild(createPaletteButton(entry));
    }
  });

  // Variation hint — visible only on mobile via .mob-variation-hint CSS class
  if (fsPaletteEl) {
    const hint = document.createElement('span');
    hint.className = 'mob-variation-hint';
    hint.textContent = 'Double-tap a color for lighter / darker variations';
    fsPaletteEl.appendChild(hint);
  }
}

async function initPalette() {
  customPalette = getCustomPalette();
  await loadServerPalette();
  renderPalette();
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}


function setTool(newTool) {
  tool = newTool;
  toolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === newTool));
  dispatchStateChange({ currentTool: newTool.charAt(0).toUpperCase() + newTool.slice(1) });
  
  // Manage active cursor styling layers directly on the viewport wrapper container
  if (tool === 'hand') {
    rulerFlashStop();
    viewport.classList.add('tool-hand-active');
    canvas.style.cursor = 'grab';
    overlay.style.cursor = 'grab';
  } else if (tool === 'none') {
    rulerFlashStop();
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'default';
    overlay.style.cursor = 'default';
  } else if (tool === 'ruler') {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'crosshair';
    overlay.style.cursor = 'crosshair';
    // Start the cursor-flash animation loop for the ruler tool.
    rulerFlashStart();
    // If ruler is in "drawing" mode (start set, not yet finished), keep that state
    // but reset to idle if there's no pending start (allow switching back freely)
  } else {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'crosshair';
    overlay.style.cursor = 'crosshair';
    // Stop the ruler flash loop when switching to any other tool.
    rulerFlashStop();
  }
}

// ═══════════════════════════════════════════════════════════════════
// ── PIXEL RULER ENGINE ──────────────────────────────────────────────
// Cursor-flash rAF loop — keeps the sine-pulse animating even when the
// mouse is stationary.  Runs only while the ruler tool is active.
let _rulerFlashRaf = null;
function rulerFlashStart() {
  if (_rulerFlashRaf !== null) return; // already running
  function tick() {
    if (tool !== 'ruler') { _rulerFlashRaf = null; return; }
    redraw();
    _rulerFlashRaf = requestAnimationFrame(tick);
  }
  _rulerFlashRaf = requestAnimationFrame(tick);
}
function rulerFlashStop() {
  if (_rulerFlashRaf !== null) {
    cancelAnimationFrame(_rulerFlashRaf);
    _rulerFlashRaf = null;
  }
}
// State machine: idle → drawing (start set, line follows cursor) → locked (measurement shown)
// Rulers persist across tool changes. A red trash icon on each ruler removes it.
// ═══════════════════════════════════════════════════════════════════

const rulers = []; // Array of { x1, y1, x2, y2 } locked rulers
let rulerState = 'idle'; // 'idle' | 'drawing'
let rulerStart = null;   // { x, y } in board pixels
let rulerLiveEnd = null; // { x, y } board pixels — where cursor is while drawing

/** Called from applyToolAtCell when tool === 'ruler' */
function rulerHandleClick(bx, by) {
  if (rulerState === 'idle') {
    rulerStart = { x: bx, y: by };
    rulerLiveEnd = { x: bx, y: by };
    rulerState = 'drawing';
  } else {
    // Lock the ruler
    rulers.push({ x1: rulerStart.x, y1: rulerStart.y, x2: bx, y2: by });
    rulerState = 'idle';
    rulerStart = null;
    rulerLiveEnd = null;
    rulerRenderDOM();
  }
  redraw();
}

/** Called from canvas mousemove / touchmove when tool === 'ruler' */
function rulerUpdateLiveEnd(bx, by) {
  if (rulerState !== 'drawing') return;
  rulerLiveEnd = { x: bx, y: by };
  redraw();
}

/** Pixel distance between two board-pixel points */
function rulerPixelDistance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

/** Board pixel coords → overlay canvas CSS coords */
function boardToOverlayCSS(bx, by) {
  const dpr = window.devicePixelRatio || 1;
  const ox = offsetX;
  const oy = offsetY;
  // overlayCtx uses DPR transform; but DOM labels live in CSS space.
  // We need CSS px = board * scale + offset (both already in CSS px).
  return {
    cx: bx * scale + ox,
    cy: by * scale + oy,
  };
}

/** Draw the live (in-progress) ruler on the overlay canvas */
function rulerDrawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Draw all locked rulers
  for (const r of rulers) {
    rulerDrawLine(r.x1, r.y1, r.x2, r.y2, false);
  }

  // Draw in-progress ruler
  if (rulerState === 'drawing' && rulerStart && rulerLiveEnd) {
    rulerDrawLine(rulerStart.x, rulerStart.y, rulerLiveEnd.x, rulerLiveEnd.y, true);
    // Draw crosshair cursor at start
    rulerDrawCrosshair(rulerStart.x, rulerStart.y, '#00e5ff');
  }

  // Reposition DOM labels to follow zoom/pan
  rulerRepositionLabels();
}

function rulerDrawLine(x1, y1, x2, y2, isLive) {
  const ox = offsetX;
  const oy = offsetY;
  const sx1 = x1 * scale + ox;
  const sy1 = y1 * scale + oy;
  const sx2 = x2 * scale + ox;
  const sy2 = y2 * scale + oy;

  const dist = rulerPixelDistance(x1, y1, x2, y2);

  // Main line
  overlayCtx.save();
  overlayCtx.setLineDash(isLive ? [6, 4] : []);
  overlayCtx.strokeStyle = isLive ? 'rgba(0,229,255,0.85)' : 'rgba(0,229,255,1)';
  overlayCtx.lineWidth = isLive ? 1.5 : 2;
  overlayCtx.shadowColor = 'rgba(0,180,220,0.6)';
  overlayCtx.shadowBlur = 4;
  overlayCtx.beginPath();
  overlayCtx.moveTo(sx1, sy1);
  overlayCtx.lineTo(sx2, sy2);
  overlayCtx.stroke();
  overlayCtx.setLineDash([]);
  overlayCtx.shadowBlur = 0;

  // Endpoint caps
  const capSize = Math.max(3, Math.min(8, scale * 0.6));
  overlayCtx.strokeStyle = isLive ? 'rgba(0,229,255,0.85)' : 'rgba(0,229,255,1)';
  overlayCtx.lineWidth = isLive ? 1.5 : 2;
  // Start cap
  const angle = Math.atan2(sy2 - sy1, sx2 - sx1);
  const perp = angle + Math.PI / 2;
  [{ sx: sx1, sy: sy1 }, { sx: sx2, sy: sy2 }].forEach(({ sx, sy }) => {
    overlayCtx.beginPath();
    overlayCtx.moveTo(sx + Math.cos(perp) * capSize, sy + Math.sin(perp) * capSize);
    overlayCtx.lineTo(sx - Math.cos(perp) * capSize, sy - Math.sin(perp) * capSize);
    overlayCtx.stroke();
  });

  // Pixel label — only on live line or short lines; DOM handles locked ruler labels
  if (isLive) {
    const mx = (sx1 + sx2) / 2;
    const my = (sy1 + sy2) / 2;
    const label = `${dist} px`;
    overlayCtx.font = 'bold 12px ui-monospace, monospace';
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    const tw = overlayCtx.measureText(label).width;
    const pad = 5;
    overlayCtx.fillStyle = 'rgba(0,0,0,0.75)';
    overlayCtx.beginPath();
    overlayCtx.roundRect(mx - tw / 2 - pad, my - 10, tw + pad * 2, 20, 5);
    overlayCtx.fill();
    overlayCtx.fillStyle = '#00e5ff';
    overlayCtx.fillText(label, mx, my);
  }

  overlayCtx.restore();
}

function rulerDrawCrosshair(bx, by, color) {
  const ox = offsetX;
  const oy = offsetY;
  const sx = bx * scale + ox;
  const sy = by * scale + oy;
  const arm = 8;
  overlayCtx.save();
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = 1.5;
  overlayCtx.beginPath();
  overlayCtx.moveTo(sx - arm, sy); overlayCtx.lineTo(sx + arm, sy);
  overlayCtx.moveTo(sx, sy - arm); overlayCtx.lineTo(sx, sy + arm);
  overlayCtx.stroke();
  overlayCtx.restore();
}

/** Render DOM labels for locked rulers (positioned over the canvas viewport) */
function rulerRenderDOM() {
  // Remove old ruler DOM labels
  document.querySelectorAll('.sp-ruler-label').forEach(el => el.remove());

  rulers.forEach((r, idx) => {
    const label = document.createElement('div');
    label.className = 'sp-ruler-label';
    label.dataset.rulerIdx = idx;

    const dist = rulerPixelDistance(r.x1, r.y1, r.x2, r.y2);
    const dx = r.x2 - r.x1;
    const dy = r.y2 - r.y1;

    label.innerHTML = `
      <svg class="sp-ruler-icon" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <line x1="1" y1="11" x2="11" y2="1"/>
        <line x1="1" y1="8" x2="1" y2="11"/>
        <line x1="4" y1="11" x2="1" y2="11"/>
        <line x1="8" y1="1" x2="11" y2="1"/>
        <line x1="11" y1="4" x2="11" y2="1"/>
      </svg>
      <span class="sp-ruler-dist">${dist} px</span>
      ${dx !== 0 ? `<span class="sp-ruler-axis">W:${Math.abs(dx)}</span>` : ''}
      ${dy !== 0 ? `<span class="sp-ruler-axis">H:${Math.abs(dy)}</span>` : ''}
      <button class="sp-ruler-trash" data-ruler-idx="${idx}" title="Remove ruler" aria-label="Remove ruler">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
          <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
        </svg>
      </button>
    `;

    // Position: midpoint of the ruler line in viewport CSS coords
    const { cx: mx, cy: my } = boardToOverlayCSS((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
    label.style.left = `${mx}px`;
    label.style.top  = `${my}px`;

    viewport.appendChild(label);

    // Forward wheel events on the ruler label to the canvas so the user can
    // still zoom in/out when the cursor happens to be over a ruler widget.
    label.addEventListener('wheel', (e) => {
      e.stopPropagation();
      handleWheel(e);
    }, { passive: false });
  });

  // Trash click handler
  viewport.querySelectorAll('.sp-ruler-trash').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.rulerIdx, 10);
      rulers.splice(idx, 1);
      rulerRenderDOM();
      redraw();
    });
  });
}

/** Reposition DOM ruler labels whenever viewport changes (zoom / pan / resize) */
function rulerRepositionLabels() {
  viewport.querySelectorAll('.sp-ruler-label').forEach(label => {
    const idx = parseInt(label.dataset.rulerIdx, 10);
    const r = rulers[idx];
    if (!r) return;
    const { cx, cy } = boardToOverlayCSS((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
    label.style.left = `${cx}px`;
    label.style.top  = `${cy}px`;
  });
}

// ── Patch redraw to also reposition ruler labels ───────────────────────────
// rulerRepositionLabels is called from rulerDrawOverlay() which is called
// at the end of every redraw() rAF pass — no extra wiring needed.

// ═══════════════════════════════════════════════════════════════════
// End of PIXEL RULER ENGINE
// ═══════════════════════════════════════════════════════════════════

/** Perceived brightness 0–255; pick label ink for small hex swatches in the top bar. */
function brightnessRgb(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function applyColorSwatchStyles(hex) {
  const [r, g, b] = hexToRgba(hex);
  const y = brightnessRgb(r, g, b);
  // currentColor swatch styling is handled by Alpine :style binding
}

function setColor(newColor, preferredBtn) {
  const norm = normalizeHexColor(newColor);
  color = norm;
  if (colorInput) colorInput.value = norm;
  dispatchStateChange({ currentColor: norm });
  applyColorSwatchStyles(norm);

  // Track which paletteColors slot was last activated so the eyedropper
  // can prefer it over other same-hue slots when resolving ties.
  const activatedIdx = paletteColors.findIndex(e => normalizeHexColor(e.color) === norm);
  if (activatedIdx !== -1) lastUsedPaletteIdx = activatedIdx;

  // If a specific button is preferred (e.g. after an eyedropper pick that
  // updates exactly one slot), mark only that button as selected so two
  // buttons with the same hex never both light up at once.
  const allBtns = document.querySelectorAll('#palette button, #fullscreen-palette button');
  if (preferredBtn) {
    allBtns.forEach(b => b.classList.remove('selected'));
    preferredBtn.classList.add('selected');
  } else {
    // Normal path: first button whose color matches gets selected; if multiple
    // share the same hex (e.g. after a variation pick), only the first is marked.
    let marked = false;
    allBtns.forEach(b => {
      const matches = !marked && normalizeHexColor(b.dataset.color) === norm;
      b.classList.toggle('selected', matches);
      if (matches) marked = true;
    });
  }

  // Redraw immediately so cursor preview color updates without waiting for mousemove
  redraw();
}

// cleanup: keep the UI consistent after any color change or palette update
function addColorToPalette() {
  const newColor = normalizeHexColor(colorInput ? colorInput.value : '#000000');
  const already = paletteColors.some(e => normalizeHexColor(e.color) === newColor);
  if (!already) {
    paletteColors.push(asPaletteEntry({ id: null, label: newColor, color: newColor }));
  }
  renderPalette();
  setColor(newColor);
}

function syncUI() {
  renderPalette();
  setColor(color);
  setTool(tool);
  updateStatus(cursorPosition.x, cursorPosition.y);
  updateCooldownLabel();
}


function updateLiveCount(count) {
  dispatchStateChange({ liveCount: count });
}

function cancelLongPressPan() {
  if (_longPressPanTimer !== null) {
    clearTimeout(_longPressPanTimer);
    _longPressPanTimer = null;
  }
}

function startAction(event) {
  if (event.button === 2) return; // Disallow right-clicks

  // If holding shift, middle mouse button OR the active tool is 'hand', trigger panning
  if (event.shiftKey || event.button === 1 || tool === 'hand') {
    handlePanStart(event);
    return;
  }

  if (!currentUser) {
    return;
  }

  // Start a long-press timer — if the user holds left-click without moving,
  // switch into pan mode after LONG_PRESS_PAN_DELAY_MS milliseconds.
  // We do NOT place a pixel yet; we wait to see whether this becomes a pan
  // or a normal click (resolved in endAction / stopAction).
  _longPressAnchorX = event.clientX;
  _longPressAnchorY = event.clientY;
  _longPressPanTimer = setTimeout(() => {
    _longPressPanTimer = null;
    // Only activate if we haven't released the mouse yet
    if (isMouseDown) {
      isMouseDown = false;
      handlePanStart({ clientX: lastPointerClientX, clientY: lastPointerClientY });
    }
  }, LONG_PRESS_PAN_DELAY_MS);

  isMouseDown = true;
  // Pixel placement is deferred to endAction so a long-press pan never
  // consumes the cooldown. The pixel is drawn on mouseup (short click).
}

function moveAction(event) {
  // Update hover crosshair labels
  const _coordPos = getCanvasCoords(event.clientX, event.clientY);
  updateStatus(_coordPos.x, _coordPos.y);

  // Cancel the long-press-to-pan timer if the pointer drifted too far.
  // Once cancelled by movement this becomes a normal draw drag — fire
  // handleAction so the first dragged pixel isn't skipped.
  if (_longPressPanTimer !== null) {
    const dx = event.clientX - _longPressAnchorX;
    const dy = event.clientY - _longPressAnchorY;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD) {
      cancelLongPressPan();
      if (isMouseDown && !isPanning) {
        handleAction(event);
      }
    }
  }

  // If we are currently panning, calculate new offset positions
  if (isPanning) {
    offsetX = event.clientX - panStartX;
    offsetY = event.clientY - panStartY;
    redraw();
    return;
  }

  if (!isMouseDown) return;
  handleAction(event);
}



function handleAction(event) {
  disarmKeyboardCursor();
  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  // Always paint at the actual pointer position.
  // cursorPosition is used for the keyboard/arrow-key workflow; relying on it
  // here caused off-by-one placement on Android because touchmove jitter
  // updated cursorPosition to a slightly wrong cell before touchend fired.
  applyToolAtCell(x, y);
}

function stopAction(event) {
  // If the long-press timer is still pending, this was a short click (not a pan).
  // Cancel the timer and place the pixel now — unless the eyedropper just fired
  // on this same click, in which case we only picked a color, not placed a pixel.
  const wasShortClick = _longPressPanTimer !== null;
  cancelLongPressPan();

  if (wasShortClick && isMouseDown && !isPanning && !_eyedropperJustFired) {
    handleAction(event);
  }
  // Clear the flag so the next independent click works normally.
  _eyedropperJustFired = false;

  isMouseDown = false;
}

function handleWheel(event) {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  const boardX = (mouseX - offsetX) / scale;
  const boardY = (mouseY - offsetY) / scale;
  const direction = -Math.sign(event.deltaY);
  
  // scale factor per wheel tick
  let nextZoom = scale * (direction > 0 ? 1.12 : 0.88);
  nextZoom = clamp(nextZoom, 0.05, MAX_ZOOM_SCALE);
  scale = nextZoom;
  
  offsetX = Math.round(mouseX - boardX * scale);
  offsetY = Math.round(mouseY - boardY * scale);

  clampOffsets();

  // If the user is panning at the same time (e.g. holding the middle mouse
  // button while scrolling), the wheel just changed offsetX/Y so panStartX/Y
  // is now stale. Re-anchor it to the post-zoom offset so the next mousemove
  // delta is computed correctly and the view doesn't teleport.
  if (isPanning) {
    panStartX = event.clientX - offsetX;
    panStartY = event.clientY - offsetY;
  }

  zoomInput.value = Math.round(scale * 100);
  dispatchStateChange({ zoomLevel: Math.round(scale * 100) });
  
  // NEW: Instantly recalculate the cursor position based on the new zoom scale
  const newCoords = getCanvasCoords(event.clientX, event.clientY);
  cursorPosition = { x: newCoords.x, y: newCoords.y };
  
  redraw();
}

function handlePanStart(event) {
  isPanning = true;
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
  // Always force the grabbing cursor regardless of tool
  canvas.classList.remove('shift-pan');
  viewport.classList.remove('tool-hand-active');
  viewport.classList.add('tool-hand-dragging');
}

function handlePanMove(event) {
  if (!isPanning) return;
  offsetX = Math.round(event.clientX - panStartX);
  offsetY = Math.round(event.clientY - panStartY);
  // clampOffsets() is called inside redraw() — no need to duplicate it here
  redraw();

  // Re-anchor panStart if clamping moved the offset away from the proposed position
  // so the pan doesn't drift when hitting a boundary
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
}

function handlePanEnd() {
  if (!isPanning) return;
  isPanning = false;
  viewport.classList.remove('tool-hand-dragging');
  if (tool === 'hand') {
    viewport.classList.add('tool-hand-active');
  }
}

function endAction(event) {
  const wasShortClick = _longPressPanTimer !== null;
  cancelLongPressPan();
  
  if (wasShortClick && isMouseDown && !isPanning && !_eyedropperJustFired) {
    handleAction(event);
  }
  // Clear the flag so the next independent click works normally.
  _eyedropperJustFired = false;

  isMouseDown = false;
  if (isPanning) {
    isPanning = false;
    viewport.classList.remove('tool-hand-dragging');
    if (tool === 'hand') {
      viewport.classList.add('tool-hand-active');
    }
  }
}

function resizeViewport() {
  const dpr = window.devicePixelRatio || 1;
  const rect = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  
  canvas.width      = w * dpr;
  canvas.height     = h * dpr;
  gridCanvas.width  = w * dpr;
  gridCanvas.height = h * dpr;
  overlay.width     = w * dpr;
  overlay.height    = h * dpr;

  lastGridScale = null;
  clampOffsets();
  redraw();
}

window.addEventListener('resize', resizeViewport);

// When the user pinch-zooms the *browser* (not the in-app zoom), the Visual
// Viewport fires resize and scroll events.  We re-run resizeViewport so that
// canvas.width/height and offsetX/offsetY stay consistent with the new scale.
// Without this, getCanvasCoords works in a stale coordinate space and taps
// land on the wrong pixel.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resizeViewport);
  window.visualViewport.addEventListener('scroll', resizeViewport);
}
canvas.addEventListener('mousedown', event => {
  startAction(event);
});

canvas.addEventListener('mousemove', event => {
  lastPointerClientX = event.clientX;
  lastPointerClientY = event.clientY;
  
  if (isPanning) {
    handlePanMove(event); 
    return;
  }

  if (keyboardCursorArmored && cursorPosition) {
    if (!pointerMovedPastArmor(event.clientX, event.clientY)) {
      updateStatus(cursorPosition.x, cursorPosition.y);
      redraw();
      return;
    }
    disarmKeyboardCursor();
  }

  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  updateStatus(x, y);

  // Skip redraw when the cursor is still on the same board pixel — avoids
  // thrashing the canvas on sub-pixel mouse movements (e.g. high-DPI mice).
  const cellChanged = !cursorPosition || cursorPosition.x !== x || cursorPosition.y !== y;
  cursorPosition = { x, y };

  // Update live ruler end if ruler is in drawing state
  if (tool === 'ruler') {
    rulerUpdateLiveEnd(x, y);
    redraw(); // ruler always needs redraw for the pulsing cursor
    return;
  }

  if (cellChanged || isMouseDown) {
    redraw();
  }
});

canvas.addEventListener('mouseup', event => {
  if (isPanning) {
    handlePanEnd(); 
    return;
  }
  stopAction(event);
});
// Also listen on the whole document so panning is robust when the pointer leaves the canvas element
document.addEventListener('mousemove', event => {
  if (isPanning) handlePanMove(event); 
});
document.addEventListener('mouseup', event => {
  if (isPanning) handlePanEnd(); 
});
canvas.addEventListener('mouseleave', () => {
  //isMouseDown = false;
  //disarmKeyboardCursor();
  //cursorPosition = null;
  //redraw();
});
canvas.addEventListener('wheel', handleWheel, { passive: false });

zoomInput.addEventListener('input', event => {
  const nextZoom = Number(event.target.value) / 100;
  const rect = viewport.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const boardCenterX = (centerX - offsetX) / scale;
  const boardCenterY = (centerY - offsetY) / scale;

  scale = clamp(nextZoom, 0.05, MAX_ZOOM_SCALE);
  offsetX = Math.round(centerX - boardCenterX * scale);
  offsetY = Math.round(centerY - boardCenterY * scale);
  clampOffsets();
  dispatchStateChange({ zoomLevel: Math.round(scale * 100) });

  // NEW: Instantly recalculate the cursor position based on the new zoom scale
  const newCoords = getCanvasCoords(event.clientX, event.clientY);
  cursorPosition = { x: newCoords.x, y: newCoords.y };

  redraw();
});

toggleGridBtn.addEventListener('click', () => {
  toggleGrid();
});

// ensure UI reflects current grid state on load
if (toggleGridBtn) toggleGridBtn.classList.toggle('active', gridEnabled);

// Clear canvas button removed — users cannot wipe the shared board
exportButton.addEventListener('click', exportPng);
if (colorInput) colorInput.addEventListener('input', event => setColor(event.target.value));
if (addColorButton) addColorButton.addEventListener('click', addColorToPalette);

toolButtons.forEach(button => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

// ─── Captcha helpers ────────────────────────────────────────────────────────
function getCaptchaToken() {
  if (isLocalDev()) return 'dev-bypass';
  if (typeof hcaptcha !== 'undefined') {
    const response = hcaptcha.getResponse();
    // getResponse() returns '' when not yet completed or already used
    return response || null;
  }
  // hCaptcha not loaded (no sitekey configured) — return a placeholder
  return 'dev-bypass';
}

function resetCaptcha() {
  if (typeof hcaptcha !== 'undefined') {
    hcaptcha.reset();
  }
}

// ─── Auth mode tabs ──────────────────────────────────────────────────────────
// Tracks whether the panel is in 'login' or 'register' mode.
// The email field and submit button label change accordingly.
let authMode = 'login'; // 'login' | 'register'

const authTabLogin    = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');
const authSubmit      = document.getElementById('authSubmit');

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === 'register';

  // Show / hide email field (no flicker — driven by explicit state)
  if (authEmailLabel) authEmailLabel.style.display = isRegister ? '' : 'none';

  // Show / hide rules checkbox (register only)
  const rulesRow   = document.getElementById('authRulesRow');
  const rulesCheck = document.getElementById('authRulesCheck');
  if (rulesRow) rulesRow.style.display = isRegister ? '' : 'none';
  // Uncheck when switching away from register so it resets cleanly
  if (!isRegister && rulesCheck) rulesCheck.checked = false;

  // Update submit button label
  if (authSubmit) authSubmit.textContent = isRegister ? 'Create account' : 'Login';

  // Tab active styles
  if (authTabLogin) {
    authTabLogin.classList.toggle('bg-white/10',        !isRegister);
    authTabLogin.classList.toggle('border-white/20',    !isRegister);
    authTabLogin.classList.toggle('border-transparent',  isRegister);
    authTabLogin.classList.toggle('text-white',         !isRegister);
    authTabLogin.classList.toggle('text-slate-400',      isRegister);
    authTabLogin.classList.toggle('hover:text-white',    isRegister);
  }
  if (authTabRegister) {
    authTabRegister.classList.toggle('bg-white/10',        isRegister);
    authTabRegister.classList.toggle('border-white/20',    isRegister);
    authTabRegister.classList.toggle('border-transparent', !isRegister);
    authTabRegister.classList.toggle('text-white',         isRegister);
    authTabRegister.classList.toggle('text-slate-400',    !isRegister);
    authTabRegister.classList.toggle('hover:text-white',  !isRegister);
  }
}

if (authTabLogin)    authTabLogin.addEventListener('click',    () => { setAuthMode('login');    syncPasswordAutocomplete(); });
if (authTabRegister) authTabRegister.addEventListener('click', () => { setAuthMode('register'); syncPasswordAutocomplete(); });

// Unified submit button triggers the right handler based on current mode
if (authSubmit) {
  authSubmit.addEventListener('click', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

// Also handle native form submit (enables iOS password manager save prompt)
const authForm = document.getElementById('authForm');
if (authForm) {
  authForm.addEventListener('submit', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

// Switch autocomplete on the password field based on auth mode so
// iOS/Safari knows whether to offer saved passwords or to save a new one.
function syncPasswordAutocomplete() {
  if (authPassword) {
    authPassword.setAttribute('autocomplete',
      authMode === 'register' ? 'new-password' : 'current-password');
  }
}

// Initialise to login mode
setAuthMode('login');
syncPasswordAutocomplete();

// ─── Rules modal ─────────────────────────────────────────────────────────────
const rulesModal     = document.getElementById('rulesModal');
const rulesModalClose = document.getElementById('rulesModalClose');
const authRulesLink  = document.getElementById('authRulesLink');

function openRulesModal() {
  if (rulesModal) rulesModal.style.display = 'grid';
}
function closeRulesModal() {
  if (rulesModal) rulesModal.style.display = 'none';
}

if (authRulesLink)   authRulesLink.addEventListener('click', openRulesModal);
if (rulesModalClose) rulesModalClose.addEventListener('click', closeRulesModal);

// Close modal on backdrop click
if (rulesModal) {
  rulesModal.addEventListener('click', (e) => {
    if (e.target === rulesModal) closeRulesModal();
  });
}
// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rulesModal && rulesModal.style.display === 'grid') {
    closeRulesModal();
  }
});

// ─── Email verification banner ───────────────────────────────────────────────
const resendVerifyBtn = document.getElementById('resendVerifyBtn');
const resendMsg = document.getElementById('resendMsg');

if (resendVerifyBtn) {
  let resendCooling = false;
  resendVerifyBtn.addEventListener('click', async () => {
    if (resendCooling) return;
    resendCooling = true;
    resendVerifyBtn.disabled = true;
    resendVerifyBtn.style.opacity = '0.5';
    if (resendMsg) resendMsg.textContent = 'Sending…';
    try {
      const token = getStoredToken();
      const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json();
      if (resendMsg) {
        resendMsg.textContent = res.ok
          ? (data.message || 'Sent! Check your inbox.')
          : (data.error  || 'Could not send — try again.');
      }
    } catch {
      if (resendMsg) resendMsg.textContent = 'Could not send — try again.';
    }
    // Allow retry after 10 s
    setTimeout(() => {
      resendCooling = false;
      resendVerifyBtn.disabled = false;
      resendVerifyBtn.style.opacity = '';
    }, 10000);
  });
}

// Handle ?verified=1 redirect from email link.
// checkVerifiedParam() writes to localStorage BEFORE updateAuthState() reads it,
// so the banner is already dismissed when /api/me resolves.
// (EMAIL_VERIFIED_KEY is declared at the top of DOMContentLoaded — see line 74.)
(function checkVerifiedParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('verified') === '1') {
    // Persist so refreshes don't re-show the banner while the DB is being read
    localStorage.setItem(EMAIL_VERIFIED_KEY, '1');
    dispatchStateChange({ emailVerified: true });
    history.replaceState(null, '', window.location.pathname);
  }
})();

// Enter on username or password submits the current mode's action

const logoutButton = document.getElementById('logoutButton');
if (logoutButton) {
  logoutButton.addEventListener('click', event => {
    event.preventDefault();
    handleLogout();
  });
}

authPassword.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  }
});
authUsername.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', event => {
  const target = event.target;
  // Let the browser handle standard text typing naturally 
  if (target.closest?.('input, textarea, select')) return;
  // Don't steal Enter from focused toolbar/auth buttons (activation uses Enter).
  if (target.closest?.('button') && event.key === 'Enter') return;

  // Respect browser shortcuts when modifiers are used
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (hasModifier) {
    return;
  }
  
  switch (event.key) {
    case 'w':
    case 'W': moveColorFocus(0, -1); break;
    case 's':
    case 'S': moveColorFocus(0, 1); break;
    case 'a':
    case 'A': moveColorFocus(-1, 0); break;
    case 'd':
    case 'D': moveColorFocus(1, 0); break;
    
    case '1': setTool('brush'); break;
    case '2': setTool('eraser'); break;
    case '3': setTool('eyedropper'); break;
    case '4': setTool('hand'); break;
    case '5': setTool('ruler'); break;
    case '6': setTool('none'); break;
    case 'g': 
    case 'G': 
      toggleGrid(); 
      break;

    case 'Enter':
      placeFromKeyboard();
      break;
    // Fullscreen
    case 'f':
    case 'F':
      fullscreenBtn?.click();
      break;
    // Arrow key movement
    case 'ArrowUp':
      moveCursorFromArrow(0, -1, event);
      break;
    case 'ArrowDown':
      moveCursorFromArrow(0, 1, event);
      break;
    case 'ArrowLeft':
      moveCursorFromArrow(-1, 0, event);
      break;
    case 'ArrowRight':
      moveCursorFromArrow(1, 0, event);
      break;
    // Canvas panning
    case 'Shift':
      canvas.classList.add('shift-pan');
      break;
  }
});

window.addEventListener('keyup', event => {
  if (event.key === 'Shift') {
    canvas.classList.remove('shift-pan');
  }
});

window.addEventListener('storage', event => {
  if (!event.key) return;

  if (event.key === EVENT_KEY) {
    const remoteEvent = safeParse(event.newValue, null);
    if (remoteEvent) {
      handleRemoteEvent(remoteEvent);
      if (remoteEvent.type === 'pixel') {
        window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
      }
    }
  }

  if (event.key === CUSTOM_PALETTE_KEY) {
    customPalette = getCustomPalette();
    renderPalette();
  }
});

window.addEventListener('beforeunload', () => {
  // nothing to clean up for live count — SSE disconnect is handled server-side
});

/**
 * Returns true when the mobileDebug bypass should be active on the client.
 *
 * Two conditions must BOTH be true:
 * 1. The server injected data-local-bypass="1" on <html> — this only
 * happens when MOBILE_DEBUG=true is set in .env AND the request came
 * from a private/loopback IP.  Without the server flag this is always
 * false, so the bypass is completely inert for public users.
 * 2. The browser hostname is a loopback or private-network address.
 * This double-check prevents a cached/CDN copy of the page from
 * accidentally activating the bypass on a public host.
 *
 * The original localhost-only check is preserved as the fast path.
 */
function isLocalDev() {
  const { hostname } = window.location;

  // Fast path: genuine loopback (original behaviour, always allowed)
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;

  // mobileDebug path: LAN IP + server confirmed bypass is active
  const serverBypass = document.documentElement.dataset.localBypass === '1';
  if (!serverBypass) return false;

  // Verify the hostname is actually a private-network address
  // (guards against a stale cached page reaching a public server)
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  // IPv6 loopback / link-local
  if (hostname === '::1' || /^\[?fe80:/i.test(hostname)) return true;

  return false;
}

window.addEventListener('load', () => {
  // 1. Size the canvas and draw the white board instantly (fixes the blue flash)
  resizeViewport();
  syncUI();

  // 2. Fetch server data asynchronously in the background
  initPalette();

  // On local dev / mobileDebug origins skip the login overlay entirely.
  // For genuine localhost we use the hardcoded 'dev' username (no network
  // round-trip needed).  For LAN IPs we call /api/me so the server can
  // return the real anon-<octet> username it assigned via localBypassMiddleware.
  if (isLocalDev()) {
    const isLoopback = (() => {
      const h = window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1';
    })();

    if (isLoopback) {
      // Pure localhost — no token, no network call needed
      setCurrentUser('dev', true);
    } else {
      // LAN IP — ask the server for the assigned anon username
      fetch('/api/me')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.username) {
            setCurrentUser(data.username, true);
          } else {
            // Fallback: derive username from hostname last octet
            const parts = window.location.hostname.split('.');
            setCurrentUser('anon-' + parts[parts.length - 1], true);
          }
        })
        .catch(() => {
          setCurrentUser('anon-local', true);
        });
    }
  } else {
    updateAuthState();
  }
  
  // 3. Start game loops
  replayHistory();
  connectSSE();
  updateCooldownLabel();
});

(function () {
  const SPAWN_COOLDOWN_MS = 7000;
  let lastSpawnAt = 0;
  let spawnCooldownTimer = null;

  const spawnBtn = document.getElementById('spawn-btn');

  function updateSpawnBtn(remaining) {
    if (remaining > 0) {
      spawnBtn.disabled = true;
      spawnBtn.textContent = `Go (${Math.ceil(remaining / 1000)}s)`;
    } else {
      spawnBtn.disabled = false;
      spawnBtn.textContent = 'Go';
    }
  }

  spawnBtn.addEventListener('click', () => {
    const now = Date.now();
    const remaining = SPAWN_COOLDOWN_MS - (now - lastSpawnAt);
    if (remaining > 0) return;

    const spawnXInput = document.getElementById('spawn-x');
    const spawnYInput = document.getElementById('spawn-y');
    const spawnZoomInput = document.getElementById('spawn-zoom');

    const targetX = parseInt(spawnXInput.value, 10);
    const targetY = parseInt(spawnYInput.value, 10);
    let targetZoomPercent = parseInt(spawnZoomInput.value, 10);

    if (isNaN(targetX) || isNaN(targetY)) {
      alert('Please enter valid X and Y coordinates.');
      return;
    }
    if (isNaN(targetZoomPercent) || targetZoomPercent <= 0) {
      targetZoomPercent = 4500;
    }

    scale = clamp(targetZoomPercent / 100, 0.05, MAX_ZOOM_SCALE);

    const rect = viewport.getBoundingClientRect();
    offsetX = rect.width / 2 - targetX * scale;
    offsetY = rect.height / 2 - targetY * scale;

    zoomInput.value = Math.round(scale * 100);
    dispatchStateChange({ zoomLevel: Math.round(scale * 100) });

    clampOffsets();
    redraw();

    // Start cooldown
    lastSpawnAt = Date.now();
    if (spawnCooldownTimer) clearInterval(spawnCooldownTimer);
    spawnCooldownTimer = setInterval(() => {
      const rem = SPAWN_COOLDOWN_MS - (Date.now() - lastSpawnAt);
      updateSpawnBtn(rem);
      if (rem <= 0) {
        clearInterval(spawnCooldownTimer);
        spawnCooldownTimer = null;
      }
    }, 200);
    updateSpawnBtn(SPAWN_COOLDOWN_MS);
  });
})();

function moveColorFocus(dx, dy) {
  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const cols = 6;
  const currentIndex = sourcePalette.findIndex(p => normalizeHexColor(p.color) === normalizeHexColor(color));
  
  if (currentIndex === -1) return;

  const row = Math.floor(currentIndex / cols);
  const col = currentIndex % cols;

  const newRow = row + dy;
  const newCol = col + dx;

  if (newCol < 0 || newCol >= cols || newRow < 0) return;
  const newIndex = newRow * cols + newCol;

  if (newIndex >= 0 && newIndex < sourcePalette.length) {
    setColor(sourcePalette[newIndex].color);
  }
}


// --- TOPBAR DRAG LOGIC ---
// Uses scrollLeft instead of transform so the header never shrinks away
// from the right edge (which exposed the background behind it).
(function () {
  const header = document.querySelector('header.flex');
  const handle = document.getElementById('topbar-drag-handle');
  if (!header || !handle) return;

  let dragging = false;
  let startClientX = 0;
  let startScrollLeft = 0;

  function onDown(e) {
    dragging = true;
    startClientX = e.touches ? e.touches[0].clientX : e.clientX;
    startScrollLeft = header.scrollLeft;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    // drag left = positive delta = scroll right into overflow
    const delta = startClientX - clientX;
    header.scrollLeft = Math.max(0, startScrollLeft + delta);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown',  onDown, { passive: false });
  handle.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup',  onUp);
  document.addEventListener('touchend', onUp);
  window.addEventListener('resize', () => { header.scrollLeft = 0; });
})();

// --- FULLSCREEN LOGIC ---
const fullscreenBtn = document.getElementById('fullscreen-btn');
const fsIconEnter = document.getElementById('fs-icon-enter');
const fsIconExit = document.getElementById('fs-icon-exit');

if (fullscreenBtn) {
  // Core fullscreen toggle function
  const toggleFullscreen = (event) => {
    // Crucial: Stop the canvas behind it from intercepting the tap/click
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    fullscreenBtn.blur();
    const fsTarget = document.documentElement;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (fsTarget.requestFullscreen) {
        fsTarget.requestFullscreen().catch(err => console.error("Fullscreen error:", err));
      } else if (fsTarget.webkitRequestFullscreen) {
        fsTarget.webkitRequestFullscreen(); // Safari/iOS fallback
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  };

  // Bind to both click (desktop) and touchend (mobile) directly
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  fullscreenBtn.addEventListener('touchend', toggleFullscreen, { passive: false });

  const handleFullscreenChange = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (fsIconEnter) fsIconEnter.style.display = 'none';
      if (fsIconExit) fsIconExit.style.display = 'block';
    } else {
      if (fsIconEnter) fsIconEnter.style.display = 'block';
      if (fsIconExit) fsIconExit.style.display = 'none';
    }
    
    if (typeof resizeViewport === 'function') {
      setTimeout(resizeViewport, 150);
    }
  };

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
}

// --- MOBILE TOUCH LOGIC ---
let lastTouchDistance = 0;
let isTouchDragging = false;
let lastTouchX = 0;
let lastTouchY = 0;
/** True while a single-finger touch pan is actively moving — suppresses cursor overlay redraws. */
let isTouchPanning = false;

/** True when a touch started on a UI control (palette, toolbar, etc.) — suppresses tap-to-place. */
let touchStartedOnUI = false;

// Mark touches that start on any UI control outside the drawing surface so they don't place pixels.
// Note: #fullscreen-palette and #fullscreen-btn live inside #viewport in the DOM, so we must
// explicitly exclude them in addition to anything outside the viewport entirely.
const _uiLayersInsideViewport = [
  document.getElementById('fullscreen-palette'),
  document.getElementById('fullscreen-btn'),
];

document.addEventListener("touchstart", (e) => {
  const target = e.target;
  const insideViewport = viewport.contains(target);
  const onUILayer = _uiLayersInsideViewport.some(el => el && el.contains(target));
  touchStartedOnUI = !insideViewport || onUILayer;
}, { passive: true, capture: true });

viewport.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    isTouchDragging = false;
  } else if (e.touches.length === 2) {
    e.preventDefault(); // Stop native 2-finger zoom gestures
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDistance = Math.hypot(dx, dy);
  }
}, { passive: false });

viewport.addEventListener("touchmove", (e) => {
  e.preventDefault(); // Stops pulling-to-refresh & native web scroll

  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;
    
    // Threshold to prevent jittering taps
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      isTouchDragging = true;
      isTouchPanning = true;
    }

    // Round at write time so offsetX/Y are always whole numbers.
    // Storing fractional values and rounding only inside redraw() causes
    // a 1px oscillation on every frame — the visible pan jitter on mobile.
    offsetX = Math.round(offsetX + dx);
    offsetY = Math.round(offsetY + dy);
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;

    clampOffsets();

    // If ruler is drawing, update live end from touch position
    if (tool === 'ruler' && rulerState === 'drawing') {
      const coords = getCanvasCoords(e.touches[0].clientX, e.touches[0].clientY);
      rulerUpdateLiveEnd(coords.x, coords.y);
    }

    redraw();
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const distance = Math.hypot(dx, dy);

    if (lastTouchDistance) {
      const delta = distance - lastTouchDistance;
      const centerClientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerClientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      // Zoom towards center of the pinch
      const rect = viewport.getBoundingClientRect();
      const mouseX = centerClientX - rect.left;
      const mouseY = centerClientY - rect.top;

      const boardX = (mouseX - offsetX) / scale;
      const boardY = (mouseY - offsetY) / scale;

      let nextZoom = scale * (1 + delta * 0.005);
      nextZoom = clamp(nextZoom, 0.05, MAX_ZOOM_SCALE);
      scale = nextZoom;

      // Round at write time — same reason as the pan path above
      offsetX = Math.round(mouseX - boardX * scale);
      offsetY = Math.round(mouseY - boardY * scale);

      clampOffsets();
      zoomInput.value = Math.round(scale * 100);
      dispatchStateChange({ zoomLevel: Math.round(scale * 100) });
      redraw();
    }
    lastTouchDistance = distance;
  }
}, { passive: false });

viewport.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) {
    lastTouchDistance = 0;
  }
  
  // If one finger is left on the screen after a pinch, 
  // re-anchor the coordinates to that specific finger so the camera doesn't jump.
  if (e.touches.length === 1) {
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    isTouchDragging = true; // Mark as dragging so it doesn't accidentally drop a pixel
  }

  // Finger lifted — stop suppressing cursor overlay
  if (e.touches.length === 0) {
    isTouchPanning = false;
    // Full redraw to restore cursor overlay now that panning stopped
    redraw();
  }
  
  // TAP TO PLACE: If it was 1 finger, it ended, didn't drag, and started on the canvas (not a palette/UI tap)
  // Skip when hand tool is active — hand tool only pans, never places pixels
  if (!isTouchDragging && !touchStartedOnUI && tool !== 'hand' && e.changedTouches.length === 1 && e.touches.length === 0) {
     if (_eyedropperJustFired) { _eyedropperJustFired = false; return; }
     const touch = e.changedTouches[0];
     // iOS reports clientY at the TOP of the contact ellipse, not its center.
     // Adding half the vertical touch diameter corrects the perceived tap
     // position so the pixel lands where the majority of the finger was.
     //
     // touch.radiusY is in *physical* pixels on some browsers (notably Chrome
     // on Android) and in CSS pixels on others (Safari/iOS).  Dividing by
     // devicePixelRatio normalises it to CSS pixels in both cases.  When DPR
     // is 1 (desktop) this is a no-op.
     //
     // When the browser is pinch-zoomed OUT (vvScale < 1), clientX/Y are in
     // layout pixels but radiusY (after /dpr) is still in visual CSS pixels.
     // We must divide by vvScale to bring it into the same layout-pixel space
     // as clientY so the offset doesn't overshoot at non-100% browser zoom.
     const dpr = window.devicePixelRatio || 1;
     const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;
     // iOS Safari reports clientY at the top of the contact ellipse on older
     // versions, but the radiusY value it gives is a fixed hardware constant
     // (~11 physical px) that doesn't track the actual touch centroid — it
     // overcorrects especially when the browser is pinch-zoomed out.
     // We detect iOS Safari and skip the adjustment; the tap lands close enough
     // to centre already. On other platforms we apply a conservative cap (max
     // 8 CSS px) so any residual error stays small.
     const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
                   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
     let adjustedClientY = touch.clientY;
     if (!isIOS) {
       const radiusY = (touch.radiusY || 0) / dpr / vvScale;
       adjustedClientY = touch.clientY - Math.min(radiusY, 8);
     }
     const coords = getCanvasCoords(touch.clientX, adjustedClientY);
     // Snap cursorPosition to the exact tap location BEFORE placing.
     // On Android, touchmove fires for tiny jitter during a tap and leaves
     // cursorPosition at a slightly wrong cell. Without this snap, any code
     // path that reads cursorPosition (e.g. handleAction) would place the
     // pixel one cell off from where the finger actually landed.
     cursorPosition = { x: coords.x, y: coords.y };
     applyToolAtCell(coords.x, coords.y);
  }
});

// ─── LEADERBOARD + PROFILE ──────────────────────────────────────────────────
(function initLeaderboard() {
  const panel        = document.getElementById('lb-panel');
  const toggle       = document.getElementById('lb-toggle');
  const list         = document.getElementById('lb-list');
  const dateEl       = document.getElementById('lb-date');
  const filtersEl    = document.getElementById('lb-filters');
  const resetNote    = document.getElementById('lb-reset-note');
  const profileStrip = document.getElementById('lb-profile-strip');
  const profileAvatar= document.getElementById('lb-profile-avatar');
  const profileName  = document.getElementById('lb-profile-name');
  const profileSub   = document.getElementById('lb-profile-sub');

  // Profile modal elements
  const modalOverlay = document.getElementById('profile-modal-overlay');
  const pmAvatar     = document.getElementById('pm-avatar');
  const pmUsername   = document.getElementById('pm-username');
  const pmSub        = document.getElementById('pm-sub');
  const pmTotal      = document.getElementById('pm-total');
  const pmToday      = document.getElementById('pm-today');
  const pmRank       = document.getElementById('pm-rank');
  const pmRecent     = document.getElementById('pm-recent-pixels');
  const pmClose      = document.getElementById('pm-close');

  if (!panel || !toggle || !list) return;

  let isOpen = false;
  let activePeriod = 'today';

  // ── Period filter buttons ──────────────────────────────────
  if (filtersEl) {
    filtersEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.lb-filter-btn');
      if (!btn) return;
      filtersEl.querySelectorAll('.lb-filter-btn').forEach(b => b.classList.remove('lb-filter-active'));
      btn.classList.add('lb-filter-active');
      activePeriod = btn.dataset.period;
      hasFetchedOnce = false; // Show loading indicator for the newly selected period

      // Update reset note text
      if (resetNote) {
        resetNote.textContent = activePeriod === 'today'
          ? 'Today resets at midnight · UTC−4'
          : `Showing ${activePeriod === 'alltime' ? 'all-time' : activePeriod} totals`;
      }

      fetchLeaderboard();
    });
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('lb-open');
  }

  toggle.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('lb-open', isOpen);
    if (isOpen) fetchLeaderboard();
  });

  window.addEventListener('sp-state-change', (e) => {
    if (e.detail && e.detail.currentUser !== undefined) {
      updateProfileStrip(e.detail.currentUser);
      if (e.detail.currentUser === null) closePanel();
    }
  });

  // ── Profile strip update ────────────────────────────────────
  function updateProfileStrip(username) {
    if (!profileName || !profileAvatar || !profileSub) return;
    if (!username) {
      profileAvatar.textContent = '?';
      profileName.textContent = 'Not logged in';
      profileSub.textContent = 'Sign in to track pixels';
      return;
    }
    profileAvatar.textContent = username.charAt(0);
    profileName.textContent = username;
    profileSub.textContent = 'Tap to view your profile';
  }

  // ── Profile modal ───────────────────────────────────────────
  async function openProfileModal(username) {
    if (!modalOverlay || !username) return;
    pmAvatar.textContent = username.charAt(0);
    pmUsername.textContent = username;
    pmSub.textContent = 'Loading stats…';
    pmTotal.textContent = '—';
    pmToday.textContent = '—';
    pmRank.textContent = '—';
    pmRecent.innerHTML = '<span class="pm-loading">Loading…</span>';
    modalOverlay.classList.add('pm-open');

    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
      if (!res.ok) throw new Error('Profile fetch failed');
      const d = await res.json();
      pmSub.textContent = `${(d.totalPixels || 0).toLocaleString()} pixels total`;
      pmTotal.textContent = (d.totalPixels || 0).toLocaleString();
      pmToday.textContent = (d.todayPixels || 0).toLocaleString();
      pmRank.textContent = d.allTimeRank ? `#${d.allTimeRank}` : '—';

      if (d.recentPixels && d.recentPixels.length > 0) {
        pmRecent.innerHTML = d.recentPixels.map(p => {
          const safeX = parseInt(p.x, 10) || 0;
          const safeY = parseInt(p.y, 10) || 0;
          
          const isErase = p.color === 'erase';
          
          // Using clean Base64 with no quotes inside url() ensures it never breaks HTML rendering
          const styleRule = isErase
            ? `background-image: url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjMWUyOTNiIiByeD0iMiIvPjxwYXRoIGQ9Ik00IDRsOCA4TTEyIDRMNCAxMiIgc3Ryb2tlPSIjZWY0NDQ0IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==); background-size: cover;`
            : `background: ${normalizeHexColor(String(p.color || '#888'))};`;
            
          const tooltipText = isErase 
            ? `(${safeX},${safeY}) Erased` 
            : `(${safeX},${safeY}) ${normalizeHexColor(String(p.color || '#888'))}`;

          return `<div class="pm-pixel-dot" style="${styleRule}" title="${tooltipText}"></div>`;
        }).join('');
      } else {
        pmRecent.innerHTML = '<span style="color:#475569;font-size:0.82rem;font-style:italic;">No pixels placed yet.</span>';
      }
    } catch {
      pmSub.textContent = 'Could not load profile.';
    }
  }

  function closeProfileModal() {
    if (modalOverlay) modalOverlay.classList.remove('pm-open');
  }

  if (profileStrip) {
    profileStrip.addEventListener('click', () => {
      if (currentUser) openProfileModal(currentUser);
    });
  }

  if (pmClose) pmClose.addEventListener('click', closeProfileModal);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeProfileModal();
    });
  }

  // Allow clicking a username in the leaderboard list to open their profile
  if (list) {
    list.addEventListener('click', (e) => {
      const span = e.target.closest('.lb-username');
      if (!span) return;
      const username = span.dataset.username;
      if (username) openProfileModal(username);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────
  function todayUTC4() {
    const d = new Date(Date.now() - 4 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function msUntilMidnightUTC4() {
    const now = new Date();
    const utc4 = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const nextMidnight = new Date(utc4);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    return nextMidnight.getTime() - utc4.getTime();
  }

  // ── Render ───────────────────────────────────────────────────
  function render(rows) {
    dateEl.textContent = todayUTC4();
    if (!rows || rows.length === 0) {
      list.innerHTML = '<li class="lb-empty">No pixels placed yet.</li>';
      return;
    }

    const rankSymbols = ['🥇', '🥈', '🥉'];
    const rankClasses = ['lb-rank--gold', 'lb-rank--silver', 'lb-rank--bronze'];

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    list.innerHTML = rows.map((row, i) => {
      const rankContent = i < 3 ? rankSymbols[i] : `${i + 1}`;
      const rankCls = i < 3 ? rankClasses[i] : '';
      const isMe = currentUser && row.username === currentUser;
      const safeUsername = escHtml(row.username);
      return `
        <li class="${isMe ? 'lb-me' : ''}">
          <span class="lb-rank ${rankCls}">${rankContent}</span>
          <span class="lb-username" data-username="${safeUsername}" title="View ${safeUsername}'s profile">${safeUsername}</span>
          <span class="lb-count">${Number(row.count).toLocaleString()} px</span>
        </li>`;
    }).join('');
  }

  let hasFetchedOnce = false;

  async function fetchLeaderboard() {
    // Only show the loading placeholder on the very first fetch.
    // Subsequent refreshes update the list silently so there's no flash.
    if (!hasFetchedOnce) {
      list.innerHTML = '<li class="lb-loading">Loading…</li>';
    }
    try {
      const res = await fetch(`/api/leaderboard?period=${activePeriod}`);
      if (!res.ok) throw new Error('Leaderboard fetch failed');
      const data = await res.json();
      render(data.leaderboard || []);
      hasFetchedOnce = true;
    } catch {
      // Only replace content with error if we haven't shown real data yet
      if (!hasFetchedOnce) {
        list.innerHTML = '<li class="lb-loading">Unable to load…</li>';
      }
    }
  }

  // Auto-refresh every 10 s when open
  setInterval(() => { if (isOpen) fetchLeaderboard(); }, 10_000);

  // Instant refresh whenever any pixel is placed — own tab, other tab, or other player via SSE
  window.addEventListener('sp-pixel-placed', () => {
    if (isOpen) fetchLeaderboard();
  });

  // Scheduled reset at UTC-4 midnight
  function scheduleReset() {
    const delay = msUntilMidnightUTC4();
    setTimeout(() => {
      if (isOpen) fetchLeaderboard();
      scheduleReset();
    }, delay);
  }
  scheduleReset();

  // ── Expose openProfileModal globally so chat.js can open profiles on username click
  window.__openProfile = function (username) {
    openProfileModal(username);
  };
})();

// ── Password visibility toggle (auth form) ─────────────────────────────────
const togglePasswordBtn = document.getElementById('togglePassword');
const eyeIconOpen       = document.getElementById('eyeIconOpen');
const eyeIconClosed     = document.getElementById('eyeIconClosed');
if (togglePasswordBtn && authPassword && eyeIconOpen && eyeIconClosed) {
  togglePasswordBtn.addEventListener('click', () => {
    const isHidden = authPassword.type === 'password';
    authPassword.type = isHidden ? 'text' : 'password';
    eyeIconOpen.style.display   = isHidden ? 'none'  : '';
    eyeIconClosed.style.display = isHidden ? ''      : 'none';
  });
}

// ── Forgot / Reset password flow ───────────────────────────────────────────
const resetOverlay     = document.getElementById('resetPasswordOverlay');
const resetModalClose  = document.getElementById('resetModalClose');
const resetStep1       = document.getElementById('resetStep1');
const resetStep2       = document.getElementById('resetStep2');
const resetEmailInput  = document.getElementById('resetEmail');
const resetNewPassword = document.getElementById('resetNewPassword');
const resetSendBtn     = document.getElementById('resetSendBtn');
const resetConfirmBtn  = document.getElementById('resetConfirmBtn');
const resetMessage     = document.getElementById('resetMessage');
const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
const forgotPasswordRow = document.getElementById('forgotPasswordRow');

// Toggle password eye on reset modal
const toggleResetPasswordBtn = document.getElementById('toggleResetPassword');
const resetEyeIconOpen       = document.getElementById('resetEyeIconOpen');
const resetEyeIconClosed     = document.getElementById('resetEyeIconClosed');
if (toggleResetPasswordBtn && resetNewPassword && resetEyeIconOpen && resetEyeIconClosed) {
  toggleResetPasswordBtn.addEventListener('click', () => {
    const isHidden = resetNewPassword.type === 'password';
    resetNewPassword.type = isHidden ? 'text' : 'password';
    resetEyeIconOpen.style.display   = isHidden ? 'none' : '';
    resetEyeIconClosed.style.display = isHidden ? ''     : 'none';
  });
}

function showResetMessage(msg, isError = true) {
  if (!resetMessage) return;
  resetMessage.textContent = msg;
  resetMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function openResetModal(showStep2 = false, token = '') {
  if (!resetOverlay) return;
  resetOverlay.style.display = 'grid';
  showResetMessage('');
  if (showStep2) {
    if (resetStep1) resetStep1.style.display = 'none';
    if (resetStep2) resetStep2.style.display = '';
    resetOverlay._resetToken = token;
  } else {
    if (resetStep1) resetStep1.style.display = '';
    if (resetStep2) resetStep2.style.display = 'none';
    resetOverlay._resetToken = '';
    if (resetEmailInput) resetEmailInput.value = '';
    if (resetNewPassword) resetNewPassword.value = '';
  }
}

function closeResetModal() {
  if (resetOverlay) resetOverlay.style.display = 'none';
}

if (forgotPasswordBtn) {
  forgotPasswordBtn.addEventListener('click', () => openResetModal(false));
}
if (resetModalClose) {
  resetModalClose.addEventListener('click', closeResetModal);
}
if (resetOverlay) {
  resetOverlay.addEventListener('click', (e) => {
    if (e.target === resetOverlay) closeResetModal();
  });
}

// Hide "Forgot password?" in register mode
const origSetAuthMode = typeof setAuthMode === 'function' ? setAuthMode : null;
// Patch via MutationObserver since setAuthMode is defined in the same closure
if (forgotPasswordRow) {
  const authTabLoginEl    = document.getElementById('authTabLogin');
  const authTabRegisterEl = document.getElementById('authTabRegister');
  function syncForgotRow() {
    const isRegister = authTabRegisterEl &&
      authTabRegisterEl.classList.contains('bg-white/10');
    forgotPasswordRow.style.display = isRegister ? 'none' : '';
  }
  if (authTabLoginEl)    authTabLoginEl.addEventListener('click',    syncForgotRow);
  if (authTabRegisterEl) authTabRegisterEl.addEventListener('click', syncForgotRow);
}

// Send reset email
if (resetSendBtn) {
  resetSendBtn.addEventListener('click', async () => {
    const email = resetEmailInput ? resetEmailInput.value.trim() : '';
    if (!email) { showResetMessage('Enter your email address.'); return; }
    resetSendBtn.disabled = true;
    resetSendBtn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Always show success to avoid leaking whether an email exists
      showResetMessage('If that email is registered, a reset link has been sent. Check your inbox (and spam folder).', false);
      resetSendBtn.textContent = 'Sent!';
    } catch {
      showResetMessage('Unable to reach server. Try again.');
      resetSendBtn.disabled = false;
      resetSendBtn.textContent = 'Send reset link';
    }
  });
}

// Confirm new password
if (resetConfirmBtn) {
  resetConfirmBtn.addEventListener('click', async () => {
    const password = resetNewPassword ? resetNewPassword.value : '';
    const token = resetOverlay ? resetOverlay._resetToken : '';
    if (!password || password.length < 8) {
      showResetMessage('Password must be at least 8 characters.');
      return;
    }
    if (!token) { showResetMessage('Missing reset token.'); return; }
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        showResetMessage(data.error || 'Reset failed.');
        resetConfirmBtn.disabled = false;
        resetConfirmBtn.textContent = 'Set new password';
        return;
      }
      showResetMessage('Password updated! You can now log in.', false);
      resetConfirmBtn.textContent = 'Done ✓';
      // Remove the token from the URL so a reload doesn't re-open the modal
      const url = new URL(window.location.href);
      url.searchParams.delete('resetToken');
      window.history.replaceState({}, '', url.toString());
    } catch {
      showResetMessage('Unable to reach server.');
      resetConfirmBtn.disabled = false;
      resetConfirmBtn.textContent = 'Set new password';
    }
  });
}

// On load: check if URL has ?resetToken= and open step 2 automatically
(function checkResetToken() {
  const params = new URLSearchParams(window.location.search);
  const rt = params.get('resetToken');
  if (rt) openResetModal(true, rt);
})();

}); // end DOMContentLoaded