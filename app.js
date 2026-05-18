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
  if (!gridEnabled) return;

  // Use the same rounded offsets as redraw() so grid aligns perfectly with pixels
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

    for (let gx = startX; gx <= endX; gx++) {
      const px = Math.floor(gx * scale + ox) + 0.5;
      overlayCtx.beginPath();
      overlayCtx.moveTo(px, Math.floor(startY * scale + oy));
      overlayCtx.lineTo(px, Math.floor(endY * scale + oy));
      overlayCtx.stroke();
    }

    for (let gy = startY; gy <= endY; gy++) {
      const py = Math.floor(gy * scale + oy) + 0.5;
      overlayCtx.beginPath();
      overlayCtx.moveTo(Math.floor(startX * scale + ox), py);
      overlayCtx.lineTo(Math.floor(endX * scale + ox), py);
      overlayCtx.stroke();
    }

    overlayCtx.restore();
  }

  // Board border
  overlayCtx.save();
  overlayCtx.strokeStyle = 'rgba(0,0,0,0.55)';
  overlayCtx.setLineDash([]);
  const bx = ox + 0.5;
  const by = oy + 0.5;
  const bw = Math.round(BOARD_WIDTH * scale - 1);
  const bh = Math.round(BOARD_HEIGHT * scale - 1);
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
  const scaledWidth = CANVAS_WIDTH * scale;
  const scaledHeight = CANVAS_HEIGHT * scale;

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
  const { x, y } = cursorPosition;
  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);
  const px = Math.floor(x * scale + ox);
  const py = Math.floor(y * scale + oy);
  const size = Math.max(1, Math.round(pixelSize * scale));

  // semi-transparent preview fill matching current color
  const rgba = hexToRgba(color || '#000000');
  overlayCtx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, 0.35)`;
  overlayCtx.fillRect(px, py, size, size);

  // outline to indicate exact placement
  overlayCtx.strokeStyle = 'rgba(255,255,255,0.9)';
  overlayCtx.lineWidth = 1.5;
  overlayCtx.strokeRect(px, py, size, size);
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
  } else {
    if (!canPlacePixel()) {
      updateCooldownLabel();
      return;
    }
    paintPixel(x, y);
    lastPlaceAt = Date.now();
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
  }

  redraw();
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
  localStorage.setItem(EVENT_KEY, JSON.stringify(event));
  if (event.type === 'pixel') {
    appendHistory(event);
  }
  if (event.type === 'clear') {
    localStorage.setItem(PIXEL_HISTORY_KEY, JSON.stringify([]));
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

function renderPalette() {
  paletteEl.innerHTML = '';
  const sourcePalette = paletteColors.length > 0 ? paletteColors : DEFAULT_PALETTE;
  const colors = sourcePalette.map(asPaletteEntry);

  colors.forEach(entry => {
    const button = document.createElement('button');
    button.style.background = entry.color;
    button.dataset.color = entry.color;
    button.title = `${entry.label} (${entry.color.toUpperCase()})`;
    if (entry.color.toLowerCase() === (color || '').toLowerCase()) {
      button.classList.add('selected');
    }
    let clickTimer = null;
    button.addEventListener('click', () => {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        setColor(entry.color);
        document.querySelectorAll('.palette button').forEach(b => {
          b.classList.toggle('selected', b.dataset.color === entry.color);
        });
      }, 220);
    });

    button.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      showVariationPicker(entry, button);
    });

    paletteEl.appendChild(button);
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
  document.body.appendChild(picker);

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
  // update palette selection visuals
  renderPalette();
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
  if (event.button !== 0) return;
  if (event.shiftKey) {
    handlePanStart(event);
    return;
  }
  if (!currentUser) {
    authOverlay.classList.remove('hidden');
    return;
  }
  isMouseDown = true;
  handleAction(event);
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
  // Default: wheel zooms around cursor. Hold Shift to pan instead.
  if (event.shiftKey) {
    offsetX -= event.deltaY * 0.8;
    offsetY -= event.deltaX * 0.4;
    clampOffsets();
    redraw();
    return;
  }

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
  redraw();
}

function handlePanStart(event) {
  if (event.button !== 0) return;
  isPanning = true;
  dragStart = { x: event.clientX - offsetX, y: event.clientY - offsetY };
  canvas.classList.add('panning');
}

function handlePan(event) {
  if (!isPanning || !dragStart) return;
  offsetX = event.clientX - dragStart.x;
  offsetY = event.clientY - dragStart.y;
  clampOffsets();
  redraw();
}

function handlePanEnd() {
  isPanning = false;
  dragStart = null;
  canvas.classList.remove('panning');
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
  if (event.shiftKey) {
    handlePanStart(event);
    return;
  }
  startAction(event);
});
canvas.addEventListener('mousemove', event => {
  lastPointerClientX = event.clientX;
  lastPointerClientY = event.clientY;
  if (isPanning) {
    handlePan(event);
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
    handlePanEnd();
    return;
  }
  stopAction(event);
});
canvas.addEventListener('mouseleave', () => {
  isMouseDown = false;
  disarmKeyboardCursor();
  cursorPosition = null;
  redraw();
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
