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
  { id: 10, label: 'Pink', color: '#ec4899' }
];
const paletteColors = [];
const CUSTOM_PALETTE_KEY = 'sp_customPalette';
const TOKEN_KEY = 'sp_token';
const EVENT_KEY = 'sp_last_event';
const PIXEL_HISTORY_KEY = 'sp_pixel_history';
const CLIENTS_KEY = 'sp_clients';
const COOLDOWN_MS = 5000;
/** Max zoom as UI scale (1 = 100%, 50 = 5000%) */
const MAX_ZOOM_SCALE = 50;
/** Slow OS key-repeat for arrow nudging (ms between steps while key is held) */
const ARROW_KEY_REPEAT_MS = 110;
/** Ignore small mouse jitter after arrow moves until pointer moves this far (px). */
const MOUSE_CURSOR_ARMOR_PX = 36;
/** Grid corner dots — screen pixels per dot (was 1×1). */
const GRID_DOT_SCREEN_PX = 3;
const CLIENT_HEARTBEAT_MS = 2000;
const CLIENT_TTL = 8000;
const sessionRandom = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
const sessionId = `${Date.now()}-${sessionRandom}`;

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
let dragStart = null;
let gridEnabled = true;
let tool = 'brush';
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
 */
function ensureRainbowInPalette(list) {
  if (!Array.isArray(list)) return;
  const rainbowLabels = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Indigo', 'Violet'];
  const present = new Set(list.map(e => String(e.label || e.color || '').toLowerCase()));
  // Add missing rainbow entries from DEFAULT_PALETTE preserving original order
  DEFAULT_PALETTE.forEach(entry => {
    if (rainbowLabels.includes(entry.label) && !present.has(String(entry.label).toLowerCase())) {
      list.push(asPaletteEntry(entry));
      present.add(String(entry.label).toLowerCase());
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
    dispatchStateChange({ currentUser: data.username, emailVerified: !!data.emailVerified });
    document.body.classList.remove('auth-open');
    authMessage.textContent = '';
    updateCooldownLabel();
  } catch (error) {
    currentUser = null;
    dispatchStateChange({ currentUser: null, emailVerified: false });
    document.body.classList.add('auth-open');
    authUsername.focus();
  }
}

function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function setCurrentUser(username, emailVerified = false) {
  currentUser = username;
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

    saveToken(data.token);
    setCurrentUser(data.username, data.emailVerified);
  } catch (error) {
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
    // Fallback: ensure UI shows the new username
    setCurrentUser(data.username, data.emailVerified);
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
    cooldownBarLabel.textContent = `Pixel cooldown · ${Math.ceil(remaining / 1000)}s`;
    // Drive smooth updates via rAF while cooling
    if (!_cooldownRafId) {
      const tick = () => {
        const rem = Math.max(0, COOLDOWN_MS - (Date.now() - lastPlaceAt));
        const pct = (1 - rem / COOLDOWN_MS) * 100;
        cooldownFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        if (rem > 0) {
          cooldownBarLabel.textContent = `Pixel cooldown · ${Math.ceil(rem / 1000)}s`;
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
  });
}

function getCanvasCoords(clientX, clientY) {
  // Use viewport rect — canvas pixel dimensions are sized from viewport, not from canvas CSS size.
  // offsetX/Y are always whole numbers (rounded at every write site), so
  // tap-to-place always lands on the same cell the cursor highlight is drawn on.
  const rect = viewport.getBoundingClientRect();
  // offsetX/Y are always integers — no rounding needed
  const ox = offsetX;
  const oy = offsetY;
  const x = (clientX - rect.left - ox) / scale;
  const y = (clientY - rect.top - oy) / scale;
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
  const activeColor = tool === 'eraser' ? '#ffffff' : (color || '#000000');
  const rgba = hexToRgba(activeColor);
  overlayCtx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, 0.45)`;
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
  if (tool === 'none') return;
  updateStatus(x, y);
  cursorPosition = { x, y };

  if (tool === 'eyedropper') {
    const pixel = bufferCtx.getImageData(x, y, 1, 1).data;
    const picked = pixel[3] === 0 ? '#000000' : rgbToHex(pixel[0], pixel[1], pixel[2]);
    const norm = normalizeHexColor(picked);

    // Find the closest existing palette entry by hue similarity and update it
    // in-place, rather than adding a new entry.
    const [pH, pS] = hexToHsl(norm);

    // Search paletteColors (source of truth) directly — avoids the dual-DOM
    // problem where #palette and #fullscreen-palette are separate button sets.
    let bestIdx = -1;
    let bestDist = Infinity;
    paletteColors.forEach((entry, i) => {
      // Always compare against the canonical base color stored in paletteColors
      const base = normalizeHexColor(entry.color);
      const [bH, bS] = hexToHsl(base);
      const dH = Math.min(Math.abs(pH - bH), 360 - Math.abs(pH - bH));
      const dist = dH + Math.abs(pS - bS) * 0.3;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    });

    // Only update in-place when the hue is genuinely close (within 30°); otherwise
    // fall back to adding a new entry so completely novel colors still get recorded.
    const HUE_THRESHOLD = 30;
    if (bestIdx !== -1 && bestDist <= HUE_THRESHOLD) {
      // Update paletteColors (source of truth) first
      paletteColors[bestIdx] = asPaletteEntry({ ...paletteColors[bestIdx], color: norm });
      // Now sync ALL matching palette buttons in both #palette and #fullscreen-palette.
      document.querySelectorAll('#palette button, #fullscreen-palette button').forEach(btn => {
        const btnBase = btn.dataset.baseColor ? normalizeHexColor(btn.dataset.baseColor) : normalizeHexColor(btn.dataset.color);
        const [btnH, btnS] = hexToHsl(btnBase);
        const dH = Math.min(Math.abs(pH - btnH), 360 - Math.abs(pH - btnH));
        const dist = dH + Math.abs(pS - btnS) * 0.3;
        if (dist <= HUE_THRESHOLD) {
          btn.style.background = norm;
          btn.dataset.color = norm;
          btn.title = norm.toUpperCase();
          // dataset.baseColor intentionally NOT updated — keeps the hue family anchor
        }
      });
    } else {
      const alreadyIn = paletteColors.some(e => normalizeHexColor(e.color) === norm);
      if (!alreadyIn) {
        paletteColors.push(asPaletteEntry({ id: null, label: norm, color: norm }));
        renderPalette();
      }
    }

    setColor(norm);
    setTool('brush');
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
    if (token && event.tool !== 'eraser') {
      fetch('/api/pixel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ x: event.x, y: event.y, color: event.color })
      }).then(() => {
        window.dispatchEvent(new CustomEvent('sp-pixel-placed'));
      }).catch(() => { /* fire-and-forget; local paint already happened */ });
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
  redraw();
}

function handleRemoteEvent(event) {
  if (!event || !event.type) return;
  if (event.type === 'pixel') {
    applyRemotePixel(event);
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
  const link = document.createElement('a');
  link.download = 'saint-pixels.png';
  link.href = bufferCanvas.toDataURL('image/png');
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
    const sz = i === 2 ? '36px' : '28px';
    const bd = i === 2 ? '2px solid rgba(255,255,255,0.5)' : '1px solid rgba(255,255,255,0.2)';
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
    // Always activate from baseColor so a single tap resets any variation
    // and the palette swatch reliably highlights the canonical slot color.
    const canonical = normalizeHexColor(button.dataset.baseColor || button.dataset.color);
    const current   = normalizeHexColor(button.dataset.color);
    if (current !== canonical) {
      // Restore DOM button to its base color
      button.style.background = canonical;
      button.dataset.color = canonical;
      // Sync paletteColors so renderPalette() doesn't re-apply the variation
      const pcIdx = paletteColors.findIndex(e => normalizeHexColor(e.color) === current);
      if (pcIdx !== -1) paletteColors[pcIdx] = asPaletteEntry({ ...paletteColors[pcIdx], color: canonical });
    }
    setColor(canonical);
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
    viewport.classList.add('tool-hand-active');
    canvas.style.cursor = 'grab';
    overlay.style.cursor = 'grab';
  } else if (tool === 'none') {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'default';
    overlay.style.cursor = 'default';
  } else {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.remove('tool-hand-dragging');
    canvas.style.cursor = 'crosshair';
    overlay.style.cursor = 'crosshair';
  }
}

/** Perceived brightness 0–255; pick label ink for small hex swatches in the top bar. */
function brightnessRgb(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function applyColorSwatchStyles(hex) {
  const [r, g, b] = hexToRgba(hex);
  const y = brightnessRgb(r, g, b);
  // currentColor swatch styling is handled by Alpine :style binding
}

function setColor(newColor) {
  const norm = normalizeHexColor(newColor);
  color = norm;
  if (colorInput) colorInput.value = norm;
  dispatchStateChange({ currentColor: norm });
  applyColorSwatchStyles(norm);

  document.querySelectorAll('#palette button, #fullscreen-palette button').forEach(b => {
    const btnColor = normalizeHexColor(b.dataset.color);
    b.classList.toggle('selected', btnColor === norm);
  });

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

function registerClientHeartbeat() {
  const clients = safeParse(localStorage.getItem(CLIENTS_KEY), {});
  const now = Date.now();
  clients[sessionId] = now;
  Object.keys(clients).forEach(key => {
    if (now - clients[key] > CLIENT_TTL) {
      delete clients[key];
    }
  });
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients));
  updateLiveCount(Object.keys(clients).length);
}

function removeClientHeartbeat() {
  const clients = safeParse(localStorage.getItem(CLIENTS_KEY), {});
  delete clients[sessionId];
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients));
}

function updateLiveCount(count) {
  dispatchStateChange({ liveCount: count });
}

function startAction(event) {
  if (event.button !== 0) return; // Only allow left-clicks

  // If holding shift OR the active tool is 'hand', trigger panning
  if (event.shiftKey || tool === 'hand') {
    isPanning = true;
    panStartX = event.clientX - offsetX;
    panStartY = event.clientY - offsetY;
    
    // Switch cursor look to a closed grabbing fist
    viewport.classList.remove('tool-hand-active');
    viewport.classList.add('tool-hand-dragging');
    return;
  }

  if (!currentUser) {
    return;
  }

  isMouseDown = true;
  handleAction(event);
}

function moveAction(event) {
  // Update hover crosshair labels
  updateCoords(event);

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

function endAction(event) {
  isMouseDown = false;
  
  if (isPanning) {
    isPanning = false;
    
    // Restore styling back to open grab hand if tool is still 'hand'
    if (tool === 'hand') {
      viewport.classList.remove('tool-hand-dragging');
      viewport.classList.add('tool-hand-active');
    }
  }
}

function handleAction(event) {
  disarmKeyboardCursor();
  const { x, y } = getCanvasCoords(event.clientX, event.clientY);
  // Mousemove keeps cursorPosition aligned with the pointer; arrow keys move it without moving the mouse.
  // Paint where the overlay/cursor is, not necessarily under the hardware pointer.
  if (cursorPosition == null) {
    applyToolAtCell(x, y);
    return;
  }
  applyToolAtCell(cursorPosition.x, cursorPosition.y);
}

function stopAction() {
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
  viewport.classList.add('tool-hand-dragging');
}

function handlePanMove(event) {
  if (!isPanning) return;
  const proposedX = event.clientX - panStartX;
  const proposedY = event.clientY - panStartY;
  const scaledWidth = BOARD_WIDTH * scale;
  const scaledHeight = BOARD_HEIGHT * scale;

  const _dpr = window.devicePixelRatio || 1;
  const _vpW = canvas.width / _dpr;
  const _vpH = canvas.height / _dpr;

  let allowedX;
  if (_vpW >= scaledWidth) {
    allowedX = Math.round((_vpW - scaledWidth) / 2);
  } else {
    allowedX = clamp(proposedX, _vpW - scaledWidth, 0);
  }

  let allowedY;
  if (_vpH >= scaledHeight) {
    allowedY = Math.round((_vpH - scaledHeight) / 2);
  } else {
    allowedY = clamp(proposedY, _vpH - scaledHeight, 0);
  }

  offsetX = Math.round(allowedX);
  offsetY = Math.round(allowedY);
  redraw();

  if (proposedX !== allowedX) panStartX = event.clientX - allowedX;
  if (proposedY !== allowedY) panStartY = event.clientY - allowedY;
}

function handlePanEnd() {
  if (!isPanning) return;
  isPanning = false;
  // Remove the grabbing cursor
  viewport.classList.remove('tool-hand-dragging');
}

function endAction(event) {
  isMouseDown = false;
  handlePanEnd(); 
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
canvas.addEventListener('mousedown', event => {
  if (event.shiftKey || tool === 'hand') {
    handlePanStart(event);
    return;
  }
  startAction(event);
});

canvas.addEventListener('mousemove', event => {
  lastPointerClientX = event.clientX;
  lastPointerClientY = event.clientY;
  
  if (isPanning) {
    handlePanMove(event); // <--- Make sure this says handlePanMove
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
  cursorPosition = { x, y };
  redraw();
});

canvas.addEventListener('mouseup', event => {
  if (isPanning) {
    handlePanEnd(); // <--- Make sure this says handlePanEnd
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
  gridEnabled = !gridEnabled;
  toggleGridBtn.classList.toggle('active', gridEnabled);
  // Force a full grid redraw since gridEnabled changed
  lastGridScale = null;
  redraw();
});

// ensure UI reflects current grid state on load
if (toggleGridBtn) toggleGridBtn.classList.toggle('active', gridEnabled);

clearCanvasButton.addEventListener('click', clearCanvas);
exportButton.addEventListener('click', exportPng);
if (colorInput) colorInput.addEventListener('input', event => setColor(event.target.value));
if (addColorButton) addColorButton.addEventListener('click', addColorToPalette);

toolButtons.forEach(button => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

// ─── Captcha helpers ────────────────────────────────────────────────────────
function getCaptchaToken() {
  if (typeof hcaptcha !== 'undefined') {
    return hcaptcha.getResponse();
  }
  // hCaptcha not loaded (e.g. dev without sitekey) — return a placeholder
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

  // Update submit button label
  if (authSubmit) authSubmit.textContent = isRegister ? 'Create account' : 'Login';

  // Tab active styles
  if (authTabLogin) {
    authTabLogin.classList.toggle('bg-white/10',      !isRegister);
    authTabLogin.classList.toggle('border-white/20',  !isRegister);
    authTabLogin.classList.toggle('text-white',       !isRegister);
    authTabLogin.classList.toggle('text-slate-400',    isRegister);
    authTabLogin.classList.toggle('hover:text-white',  isRegister);
  }
  if (authTabRegister) {
    authTabRegister.classList.toggle('bg-white/10',     isRegister);
    authTabRegister.classList.toggle('border-white/20', isRegister);
    authTabRegister.classList.toggle('text-white',      isRegister);
    authTabRegister.classList.toggle('text-slate-400',  !isRegister);
    authTabRegister.classList.toggle('hover:text-white',!isRegister);
  }
}

if (authTabLogin)    authTabLogin.addEventListener('click',    () => setAuthMode('login'));
if (authTabRegister) authTabRegister.addEventListener('click', () => setAuthMode('register'));

// Unified submit button triggers the right handler based on current mode
if (authSubmit) {
  authSubmit.addEventListener('click', event => {
    event.preventDefault();
    if (authMode === 'register') handleRegister(); else handleLogin();
  });
}

// Initialise to login mode
setAuthMode('login');

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

// Handle ?verified=1 redirect from email link
(function checkVerifiedParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('verified') === '1') {
    dispatchStateChange({ emailVerified: true });
    // Clean the URL without a reload
    history.replaceState(null, '', window.location.pathname);
    // Brief confirmation to the user
    setTimeout(() => {
      const banner = document.getElementById('verifyBanner');
      if (banner) banner.style.display = 'none';
    }, 100);
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

document.addEventListener('keydown', event => {

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
    case '4': setTool('hand'); break; // NEW
    case 'g': gridEnabled = !gridEnabled; toggleGridBtn.classList.toggle('active', gridEnabled); redraw(); break;
  }

  if (event.key === 'Shift') {
    canvas.classList.add('shift-pan');
  }

  const target = event.target;
  if (target.closest?.('input, textarea, select')) return;
  // Don't steal Enter from focused toolbar/auth buttons (activation uses Enter).
  if (target.closest?.('button') && event.key === 'Enter') return;

  switch (event.key) {
    case '1': setTool('brush'); break;
    case '2': setTool('eraser'); break;
    case '3': setTool('eyedropper'); break;
    case 'g': gridEnabled = !gridEnabled; toggleGridBtn.classList.toggle('active', gridEnabled); redraw(); break;
    case 'c': clearCanvas(); break;
    case 'Enter':
      event.preventDefault();
      placeFromKeyboard();
      break;
    case 'f':
    case 'F':
      event.preventDefault();
      fullscreenBtn?.click();
      break;
    case 'ArrowUp': event.preventDefault(); moveCursorFromArrow(0, -1, event); break;
    case 'ArrowDown': event.preventDefault(); moveCursorFromArrow(0, 1, event); break;
    case 'ArrowLeft': event.preventDefault(); moveCursorFromArrow(-1, 0, event); break;
    case 'ArrowRight': event.preventDefault(); moveCursorFromArrow(1, 0, event); break;
  }
});

window.addEventListener('keyup', event => {
  if (event.key === 'Shift') {
    canvas.classList.remove('shift-pan');
  }
});

window.addEventListener('storage', event => {
  if (!event.key) return;

  if (event.key === CLIENTS_KEY) {
    const clients = safeParse(event.newValue, {});
    updateLiveCount(Object.keys(clients).length);
  }

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
  removeClientHeartbeat();
});

window.addEventListener('load', () => {
  // 1. Size the canvas and draw the white board instantly (fixes the blue flash)
  resizeViewport();
  syncUI();

  // 2. Fetch server data asynchronously in the background
  initPalette();
  updateAuthState();
  
  // 3. Start game loops
  registerClientHeartbeat();
  setInterval(registerClientHeartbeat, CLIENT_HEARTBEAT_MS);
  replayHistory();
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
    // Skip full redraw (which redraws cursor overlay) while panning for perf;
    // only redraw the canvas + grid layers directly.
    if (isTouchPanning) {
      // Lightweight pan-only redraw: skip overlay cursor
      if (!isRedrawPending) {
        isRedrawPending = true;
        requestAnimationFrame(() => {
          isRedrawPending = false;
          clampOffsets();
          const dpr = window.devicePixelRatio || 1;
          const vpW = canvas.width / dpr;
          const vpH = canvas.height / dpr;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, vpW, vpH);
          ctx.save();
          ctx.setTransform(dpr * scale, 0, 0, dpr * scale, Math.round(offsetX * dpr), Math.round(offsetY * dpr));
          // Draw white board background first
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
          ctx.drawImage(bufferCanvas, 0, 0);
          ctx.restore();
          drawGridIfDirty();
          // Clear overlay during pan (no cursor shown while panning)
          overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
          overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
        });
      }
    } else {
      redraw();
    }
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
  if (!isTouchDragging && !touchStartedOnUI && e.changedTouches.length === 1 && e.touches.length === 0) {
     const touch = e.changedTouches[0];
     const coords = getCanvasCoords(touch.clientX, touch.clientY);
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
          const color = p.color || '#888';
          return `<div class="pm-pixel-dot" style="background:${color};" title="(${p.x},${p.y}) ${color}"></div>`;
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

    list.innerHTML = rows.map((row, i) => {
      const rankContent = i < 3 ? rankSymbols[i] : `${i + 1}`;
      const rankCls = i < 3 ? rankClasses[i] : '';
      const isMe = currentUser && row.username === currentUser;
      return `
        <li class="${isMe ? 'lb-me' : ''}">
          <span class="lb-rank ${rankCls}">${rankContent}</span>
          <span class="lb-username" data-username="${row.username}" title="View ${row.username}'s profile">${row.username}</span>
          <span class="lb-count">${Number(row.count).toLocaleString()} px</span>
        </li>`;
    }).join('');
  }

  async function fetchLeaderboard() {
    list.innerHTML = '<li class="lb-loading">Loading…</li>';
    try {
      const res = await fetch(`/api/leaderboard?period=${activePeriod}`);
      if (!res.ok) throw new Error('Leaderboard fetch failed');
      const data = await res.json();
      render(data.leaderboard || []);
    } catch {
      list.innerHTML = '<li class="lb-loading">Unable to load…</li>';
    }
  }

  // Auto-refresh every 10 s (only when open) — acts as a catch-all for
  // players on other machines whose pixel events don't reach this tab via localStorage
  setInterval(() => { if (isOpen) fetchLeaderboard(); }, 10_000);

  // Instant refresh whenever any pixel is placed (own tab or other tab on same machine)
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
})();

}); // end DOMContentLoaded