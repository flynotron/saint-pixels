const canvas = document.getElementById('canvas');
const overlay = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const overlayCtx = overlay.getContext('2d');
const viewport = document.getElementById('viewport');
const zoomInput = document.getElementById('zoom');
const toggleGridBtn = document.getElementById('toggle-grid');
const clearCanvasButton = document.getElementById('clear-canvas');
const exportButton = document.getElementById('export-png');
const paletteEl = document.getElementById('palette');
const colorInput = document.getElementById('color');
const toolButtons = document.querySelectorAll('[data-tool]');
const coordLabel = document.getElementById('coord');
const currentToolLabel = document.getElementById('current-tool');
const currentColorLabel = document.getElementById('current-color');
const zoomLevelLabel = document.getElementById('zoom-level');
const authOverlay = document.getElementById('authOverlay');
const authUsername = document.getElementById('authUsername');
const authPassword = document.getElementById('authPassword');
const authLoginButton = document.getElementById('authLogin');
const authRegisterButton = document.getElementById('authRegister');
const authMessage = document.getElementById('authMessage');
const addColorButton = document.getElementById('add-color');
const currentUserLabel = document.getElementById('current-user');
const cooldownBar = document.getElementById('cooldownBar');
const cooldownFill = document.getElementById('cooldownFill');
const cooldownBarLabel = document.getElementById('cooldownBarLabel');
const liveCountLabel = document.getElementById('live-count');
const logoutButton = document.getElementById('logoutButton');

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
    currentUserLabel.textContent = 'Guest';
    authOverlay.classList.remove('hidden');
    authOverlay.style.display = 'grid';
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
      currentUserLabel.textContent = 'Guest';
      authOverlay.classList.remove('hidden');
      authUsername.focus();
      return;
    }

    const data = await response.json();
    currentUser = data.username;
    currentUserLabel.textContent = data.username;
    authOverlay.classList.add('hidden');
    authOverlay.style.display = 'none';
    authMessage.textContent = '';
    updateCooldownLabel();
  } catch (error) {
    currentUser = null;
    currentUserLabel.textContent = 'Guest';
    authOverlay.classList.remove('hidden');
    authOverlay.style.display = 'grid';
    authUsername.focus();
  }
}

function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.style.color = isError ? '#fca5a5' : '#86efac';
}

function setCurrentUser(username) {
  currentUser = username;
  currentUserLabel.textContent = username;
  authOverlay.classList.add('hidden');
  authOverlay.style.display = 'none';
  showAuthMessage(`Logged in as ${username}`, false);
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
  currentUserLabel.textContent = 'Guest';
  authOverlay.classList.remove('hidden');
  authOverlay.style.display = 'grid';
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

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    if (!response.ok) {
      showAuthMessage(data.error || 'Login failed.');
      return;
    }

    saveToken(data.token);
    setCurrentUser(data.username);
  } catch (error) {
    showAuthMessage('Unable to reach server.');
  }
}

async function handleRegister(event) {
  if (event) event.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) {
    showAuthMessage('Enter username and password.');
    return;
  }

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    if (!response.ok) {
      showAuthMessage(data.error || 'Registration failed.');
      return;
    }

    // Save token and update auth state so the overlay closes immediately
    saveToken(data.token);
    await updateAuthState();
    // Fallback: ensure UI shows the new username
    setCurrentUser(data.username);
  } catch (error) {
    showAuthMessage('Unable to reach server.');
  }
}

function updateCooldownLabel() {
  if (!cooldownBar || !cooldownFill || !cooldownBarLabel) return;
  if (!currentUser) {
    cooldownBar.classList.add('cooldown-bar--guest');
    cooldownBar.classList.remove('cooldown-bar--cooling');
    cooldownFill.style.width = '100%';
    cooldownBarLabel.textContent = 'Sign in to place pixels';
    return;
  }
  cooldownBar.classList.remove('cooldown-bar--guest');
  const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - lastPlaceAt));
  const recharged = 1 - remaining / COOLDOWN_MS;
  cooldownFill.style.width = `${Math.max(0, Math.min(100, recharged * 100))}%`;
  if (remaining > 0) {
    cooldownBar.classList.add('cooldown-bar--cooling');
    cooldownBarLabel.textContent = `Pixel cooldown · ${Math.ceil(remaining / 1000)}s`;
  } else {
    cooldownBar.classList.remove('cooldown-bar--cooling');
    cooldownBarLabel.textContent = 'Ready to place';
  }
}

function canPlacePixel() {
  return !!currentUser && Date.now() - lastPlaceAt >= COOLDOWN_MS;
}

function drawGrid() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.setLineDash([]);
  overlayCtx.lineWidth = 1;
  if (!gridEnabled) return;

  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);

  const startX = Math.floor(Math.max(0, -ox) / scale);
  const startY = Math.floor(Math.max(0, -oy) / scale);
  const endX = Math.ceil(Math.min(BOARD_WIDTH, (overlay.width - ox) / scale));
  const endY = Math.ceil(Math.min(BOARD_HEIGHT, (overlay.height - oy) / scale));

  if (scale >= 3) {
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(0,0,0,0.18)';
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([2, 2]);

    // FIXED: Cleaned up the pixel rounding math so lines don't disappear
    for (let gx = startX; gx <= endX; gx++) {
      const px = Math.round(gx * scale + ox);
      overlayCtx.beginPath();
      overlayCtx.moveTo(px, Math.round(startY * scale + oy));
      overlayCtx.lineTo(px, Math.round(endY * scale + oy));
      overlayCtx.stroke();
    }

    for (let gy = startY; gy <= endY; gy++) {
      const py = Math.round(gy * scale + oy);
      overlayCtx.beginPath();
      overlayCtx.moveTo(Math.round(startX * scale + ox), py);
      overlayCtx.lineTo(Math.round(endX * scale + ox), py);
      overlayCtx.stroke();
    }

    overlayCtx.restore();
  }

  // Board border
  overlayCtx.save();
  overlayCtx.strokeStyle = 'rgba(0,0,0,0.55)';
  overlayCtx.setLineDash([]);
  const bx = ox;
  const by = oy;
  const bw = Math.round(BOARD_WIDTH * scale);
  const bh = Math.round(BOARD_HEIGHT * scale);
  overlayCtx.strokeRect(bx, by, bw, bh);
  overlayCtx.restore();
}

function redraw() {
  clampOffsets();
  const displayWidth = canvas.width;
  const displayHeight = canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, displayWidth, displayHeight);
  ctx.imageSmoothingEnabled = false;

  ctx.setTransform(scale, 0, 0, scale, Math.round(offsetX), Math.round(offsetY));
  ctx.drawImage(bufferCanvas, 0, 0);

  drawGrid();
  drawCursor();
}

function getCanvasCoords(clientX, clientY) {
  // Use viewport rect — canvas pixel dimensions are sized from viewport, not from canvas CSS size
  const rect = viewport.getBoundingClientRect();
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  return {
    x: clamp(Math.floor(x), 0, BOARD_WIDTH - 1),
    y: clamp(Math.floor(y), 0, BOARD_HEIGHT - 1)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampOffsets() {
  // Clamp against BOARD dimensions (1920×1080), not the larger buffer canvas.
  const scaledWidth = BOARD_WIDTH * scale;
  const scaledHeight = BOARD_HEIGHT * scale;

  if (canvas.width >= scaledWidth) {
    offsetX = Math.round((canvas.width - scaledWidth) / 2);
  } else {
    offsetX = clamp(offsetX, canvas.width - scaledWidth, 0);
  }

  if (canvas.height >= scaledHeight) {
    offsetY = Math.round((canvas.height - scaledHeight) / 2);
  } else {
    offsetY = clamp(offsetY, canvas.height - scaledHeight, 0);
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
  if (!cursorPosition) return;
  if (tool === 'hand') return;

  const { x, y } = cursorPosition;
  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);
  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);
  const size = Math.max(1, Math.round(pixelSize * scale));

  overlayCtx.save();
  overlayCtx.setLineDash([]);

  const rgba = hexToRgba(color || '#000000');
  overlayCtx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, 0.35)`;
  overlayCtx.fillRect(px, py, size, size);

  // dark shadow border for contrast on light backgrounds
  overlayCtx.strokeStyle = 'rgba(0,0,0,0.5)';
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(px - 0.5, py - 0.5, size + 1, size + 1);

  // white border on top
  overlayCtx.strokeStyle = 'rgba(255,255,255,0.95)';
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeRect(px, py, size, size);

  overlayCtx.restore();
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
  updateStatus(x, y);
  cursorPosition = { x, y };

  if (tool === 'eyedropper') {
    const pixel = bufferCtx.getImageData(x, y, 1, 1).data;
    if (pixel[3] === 0) {
      setColor('#000000');
    } else {
      setColor(rgbToHex(pixel[0], pixel[1], pixel[2]));
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
  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);
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
  if (!currentUser) {
    authOverlay.classList.remove('hidden');
    authOverlay.style.display = 'grid';
    return;
  }
  ensureBoardCursor();
  applyToolAtCell(cursorPosition.x, cursorPosition.y);
}

function updateStatus(x, y) {
  coordLabel.textContent = `${x}, ${y}`;
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
  if (!currentUser) {
    authOverlay.classList.remove('hidden');
    return;
  }
  clearCanvasLocal(true);
}

function exportPng() {
  const link = document.createElement('a');
  link.download = 'saint-pixels.png';
  link.href = bufferCanvas.toDataURL('image/png');
  link.click();
}

function createPaletteButton(entry) {
  const button = document.createElement('button');
  button.style.background = entry.color;
  button.dataset.color = entry.color;
  button.title = `${entry.label} (${entry.color.toUpperCase()})`;
  if (entry.color.toLowerCase() === (color || '').toLowerCase()) {
    button.classList.add('selected');
  }
  
  // Apply the color immediately upon clicking (no more delay)
  button.addEventListener('click', () => {
    setColor(entry.color);
  });

  // Double-clicking will still open the menu for the newly selected color
  button.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    showVariationPicker(entry, button);
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

function generateColorVariations(baseColor) {
  const [r, g, b] = hexToRgba(baseColor);
  
  // Generate 2 lighter and 2 darker versions
  const variations = [];
  
  // Lighter variations (increase towards white)
  for (let i = 1; i <= 2; i++) {
    const factor = i * 0.25;
    const lr = Math.round(r + (255 - r) * factor);
    const lg = Math.round(g + (255 - g) * factor);
    const lb = Math.round(b + (255 - b) * factor);
    variations.push(rgbToHex(lr, lg, lb));
  }
  
  // Darker variations (decrease towards black)
  for (let i = 1; i <= 2; i++) {
    const factor = i * 0.25;
    const dr = Math.round(r * (1 - factor));
    const dg = Math.round(g * (1 - factor));
    const db = Math.round(b * (1 - factor));
    variations.push(rgbToHex(dr, dg, db));
  }
  
  return variations;
}

function showVariationPicker(entry, anchorEl) {
  // Remove any existing picker before opening a new one
  const existing = document.querySelector('.variation-picker');
  if (existing) existing.remove();

  const baseColor = entry.color;
  const [lighter1, lighter2, darker1, darker2] = generateColorVariations(baseColor);
  const normBase = normalizeHexColor(baseColor);

  const picker = document.createElement('div');
  picker.className = 'variation-picker';
  picker.style.position = 'fixed';
  picker.style.zIndex = 1000;
  picker.style.display = 'grid';
  picker.style.gridTemplateColumns = '40px 56px 40px';
  picker.style.gridTemplateRows = '40px 56px 40px';
  picker.style.gap = '6px';
  picker.style.padding = '8px';
  picker.style.borderRadius = '14px';
  picker.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
  picker.style.background = 'var(--surface)';

  const addVariantButton = (hex, onClick) => {
    const btn = document.createElement('button');
    btn.className = 'variation-swatch';
    btn.style.width = '40px';
    btn.style.height = '40px';
    btn.style.border = '1px solid rgba(255,255,255,0.08)';
    btn.style.borderRadius = '10px';
    btn.style.background = normalizeHexColor(hex);
    btn.title = normalizeHexColor(hex).toUpperCase();
    btn.addEventListener('click', onClick);
    btn.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      showVariationPicker({ ...entry, color: normalizeHexColor(hex) }, anchorEl);
    });
    return btn;
  };

  // Top-left darker
  picker.appendChild(addVariantButton(darker1, () => applyPickerColor(darker1, entry, anchorEl, picker)));
  // Top-center spacer
  picker.appendChild(document.createElement('div'));
  // Top-right darker
  picker.appendChild(addVariantButton(darker2, () => applyPickerColor(darker2, entry, anchorEl, picker)));

  // Middle-left spacer
  picker.appendChild(document.createElement('div'));
  // Center original color
  const center = document.createElement('button');
  center.className = 'variation-swatch';
  center.style.width = '56px';
  center.style.height = '56px';
  center.style.border = '2px solid rgba(255,255,255,0.28)';
  center.style.borderRadius = '14px';
  center.style.background = normBase;
  center.title = normBase.toUpperCase();
  center.addEventListener('click', () => {
    setColor(normBase);
    picker.remove();
  });
  center.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    showVariationPicker(entry, anchorEl);
  });
  picker.appendChild(center);
  // Middle-right spacer
  picker.appendChild(document.createElement('div'));

  // Bottom-left lighter
  picker.appendChild(addVariantButton(lighter1, () => applyPickerColor(lighter1, entry, anchorEl, picker)));
  // Bottom-center spacer
  picker.appendChild(document.createElement('div'));
  // Bottom-right lighter
  picker.appendChild(addVariantButton(lighter2, () => applyPickerColor(lighter2, entry, anchorEl, picker)));

  picker.style.visibility = 'hidden';
  picker.style.top = '-9999px';
  picker.style.left = '-9999px';
  const fsTarget = document.fullscreenElement || document.body;
  fsTarget.appendChild(picker);

  void picker.offsetWidth;

  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const controlsPanel = document.querySelector('.controls-panel');
  const panelRect = controlsPanel ? controlsPanel.getBoundingClientRect() : null;

  let left, top;
  if (panelRect && panelRect.left > pickerRect.width + 20) {
    left = panelRect.left - pickerRect.width - 12;
    top = anchorRect.top + anchorRect.height / 2 - pickerRect.height / 2;
  } else {
    left = anchorRect.left + anchorRect.width / 2 - pickerRect.width / 2;
    top = anchorRect.top - pickerRect.height - 8;
  }

  left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - pickerRect.height - 8));

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
  picker.style.visibility = 'visible';

  const onDocClick = (ev) => {
    if (!picker.contains(ev.target) && ev.target !== anchorEl) {
      picker.remove();
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

function applyPickerColor(newColor, entry, anchorEl, picker) {
  const normalized = normalizeHexColor(newColor);
  // Update the palette swatch visually
  anchorEl.style.background = normalized;
  anchorEl.dataset.color = normalized;
  anchorEl.title = normalized.toUpperCase();
  // Update the in-memory palette entry so the change sticks
  const paletteSource = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const paletteEntry = paletteSource.find(pc => pc.id === entry.id);
  if (paletteEntry) {
    paletteEntry.color = normalized;
    paletteEntry.label = normalized;
  }
  setColor(normalized);
  picker.remove();
}

function addColorToPalette() {
  // Disabled: new colors can only be created by double-clicking existing colors
}

function setTool(newTool) {
  tool = newTool;
  toolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === newTool));
  currentToolLabel.textContent = newTool.charAt(0).toUpperCase() + newTool.slice(1);
  
  // Manage active cursor styling layers directly on the viewport wrapper container
  if (tool === 'hand') {
    viewport.classList.add('tool-hand-active');
    canvas.style.cursor = 'grab';
    overlay.style.cursor = 'grab';
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
  currentColorLabel.style.backgroundColor = hex;
  currentColorLabel.style.color = y < 165 ? '#f8fafc' : '#0f172a';
  currentColorLabel.style.border =
    y < 165 ? '1px solid rgba(255, 255, 255, 0.35)' : '1px solid rgba(15, 23, 42, 0.28)';
}

function setColor(newColor) {
  const norm = normalizeHexColor(newColor);
  color = norm;
  colorInput.value = norm;
  currentColorLabel.textContent = norm.toUpperCase();
  applyColorSwatchStyles(norm);

  document.querySelectorAll('.palette button, .fullscreen-palette button').forEach(b => {
    b.classList.toggle('selected', b.dataset.color === norm);
  });

  // Redraw immediately so cursor preview color updates without waiting for mousemove
  redraw();
}

// cleanup: keep the UI consistent after any color change or palette update
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
  liveCountLabel.textContent = count;
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
    authOverlay.classList.remove('hidden');
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
  
  offsetX = mouseX - boardX * scale;
  offsetY = mouseY - boardY * scale;
  
  clampOffsets();
  zoomInput.value = Math.round(scale * 100);
  zoomLevelLabel.textContent = `${Math.round(scale * 100)}%`;
  
  // NEW: Instantly recalculate the cursor position based on the new zoom scale
  const newCoords = getCanvasCoords(event.clientX, event.clientY);
  cursorPosition = { x: newCoords.x, y: newCoords.y };
  
  redraw();
}

function handlePanStart(event) {
  isPanning = true;
  panStartX = event.clientX - offsetX;
  panStartY = event.clientY - offsetY;
  
  if (tool === 'hand') {
    viewport.classList.remove('tool-hand-active');
    viewport.classList.add('tool-hand-dragging');
  }
}

function handlePanMove(event) {
  if (!isPanning) return;

  const proposedX = event.clientX - panStartX;
  const proposedY = event.clientY - panStartY;

  const scaledWidth = BOARD_WIDTH * scale;
  const scaledHeight = BOARD_HEIGHT * scale;

  let allowedX;
  if (canvas.width >= scaledWidth) {
    allowedX = Math.round((canvas.width - scaledWidth) / 2);
  } else {
    allowedX = clamp(proposedX, canvas.width - scaledWidth, 0);
  }

  let allowedY;
  if (canvas.height >= scaledHeight) {
    allowedY = Math.round((canvas.height - scaledHeight) / 2);
  } else {
    allowedY = clamp(proposedY, canvas.height - scaledHeight, 0);
  }

  offsetX = allowedX;
  offsetY = allowedY;
  redraw();

  // Reset the anchor so clamping doesn't cause a dead zone when changing directions
  if (proposedX !== allowedX) panStartX = event.clientX - allowedX;
  if (proposedY !== allowedY) panStartY = event.clientY - allowedY;
}

function handlePanEnd() {
  if (!isPanning) return;
  isPanning = false;
  
  if (tool === 'hand') {
    viewport.classList.remove('tool-hand-dragging');
    viewport.classList.add('tool-hand-active');
  }
}

function endAction(event) {
  isMouseDown = false;
  if (isPanning) {
    isPanning = false;
    
    // Switch cursor look back to an open hand grab state
    if (tool === 'hand') {
      viewport.classList.remove('tool-hand-dragging');
      viewport.classList.add('tool-hand-active');
    }
  }
}

function resizeViewport() {
  const rect = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  canvas.width = w;
  canvas.height = h;
  overlay.width = w;
  overlay.height = h;
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
  offsetX = centerX - boardCenterX * scale;
  offsetY = centerY - boardCenterY * scale;
  clampOffsets();
  zoomLevelLabel.textContent = `${Math.round(scale * 100)}%`;

  // NEW: Instantly recalculate the cursor position based on the new zoom scale
  const newCoords = getCanvasCoords(event.clientX, event.clientY);
  cursorPosition = { x: newCoords.x, y: newCoords.y };

  redraw();
});

toggleGridBtn.addEventListener('click', () => {
  gridEnabled = !gridEnabled;
  toggleGridBtn.classList.toggle('active', gridEnabled);
  redraw();
});

// ensure UI reflects current grid state on load
if (toggleGridBtn) toggleGridBtn.classList.toggle('active', gridEnabled);

clearCanvasButton.addEventListener('click', clearCanvas);
exportButton.addEventListener('click', exportPng);
colorInput.addEventListener('input', event => setColor(event.target.value));
addColorButton.addEventListener('click', addColorToPalette);

toolButtons.forEach(button => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

authLoginButton.addEventListener('click', event => {
  event.preventDefault();
  handleLogin();
});
authRegisterButton.addEventListener('click', event => {
  event.preventDefault();
  handleRegister();
});

if (logoutButton) {
  logoutButton.addEventListener('click', event => {
    event.preventDefault();
    handleLogout();
  });
}

authPassword.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleLogin();
  }
});
authUsername.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleLogin();
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

window.addEventListener('load', async () => {
  await initPalette();
  syncUI();
  updateAuthState();
  registerClientHeartbeat();
  setInterval(registerClientHeartbeat, CLIENT_HEARTBEAT_MS);
  replayHistory();
  resizeViewport();
  updateCooldownLabel();
  setInterval(updateCooldownLabel, 250);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    if (typeof zoomLevelLabel !== 'undefined' && zoomLevelLabel) {
      zoomLevelLabel.textContent = `${Math.round(scale * 100)}%`;
    }

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

// --- FULLSCREEN LOGIC ---
const fullscreenBtn = document.getElementById('fullscreen-btn');
const viewportTarget = document.getElementById('viewport'); // Targeting the exact viewport wrapper container
const fsIconEnter = document.getElementById('fs-icon-enter');
const fsIconExit = document.getElementById('fs-icon-exit');

if (fullscreenBtn && viewportTarget) {
  fullscreenBtn.addEventListener('click', () => {
    fullscreenBtn.blur();
    if (!document.fullscreenElement) {
      viewportTarget.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      fsIconEnter.style.display = 'none'; // FIXED: Removed duplicate .style
      fsIconExit.style.display = 'block';
    } else {
      fsIconEnter.style.display = 'block';
      fsIconExit.style.display = 'none';
    }
    // Forces the pixel art engine to recalculate layout dimensions upon window morphing
    if (typeof resizeCanvas === 'function') {
      resizeCanvas();
    }
  });
}

let lastTouchDistance = 0;

viewport.addEventListener("touchmove", (e) => {

  if (e.touches.length === 2) {

    const dx =
      e.touches[0].clientX - e.touches[1].clientX;

    const dy =
      e.touches[0].clientY - e.touches[1].clientY;

    const distance = Math.hypot(dx, dy);

    if (lastTouchDistance) {

      const delta = distance - lastTouchDistance;

      zoom += delta * 0.01;

      updateZoom();
    }

    lastTouchDistance = distance;

  }

}, { passive: false });

viewport.addEventListener("touchend", () => {
  lastTouchDistance = 0;
});