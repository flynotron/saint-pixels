#!/usr/bin/env node
/**
 * timelapse.js — Saint-Pixels canvas timelapse generator
 *
 * Reads the pixel_history table (append-log of every placement ever made)
 * and renders each event onto a 1920×1080 canvas, then pipes the frames
 * through ffmpeg to produce a timelapse MP4.
 *
 * USAGE
 * ─────
 *   node timelapse.js [options]
 *
 * OPTIONS
 *   --db <path>         Path to database.sqlite  (default: ./database.sqlite)
 *   --out <path>        Output MP4 file           (default: ./timelapse.mp4)
 *   --fps <n>           Output framerate          (default: 30)
 *   --pps <n>           Pixels per second — how many placement events to
 *                       burn into each output second (default: 200)
 *                       e.g. 200 pps @ 30 fps → a new frame every 200/30 ≈ 7 pixels
 *   --from <ISO date>   Only include events on/after this date  (optional)
 *   --to   <ISO date>   Only include events up to this date     (optional)
 *   --user <username>   Only include placements by this user    (optional)
 *   --scale <n>         Downscale factor for the output video   (default: 1)
 *                       2 = render at 960×540 (half res, much faster)
 *   --bg <hex>          Background fill colour                  (default: 2e2e2f)
 *   --no-watermark      Suppress the "Saint-Pixels" text overlay
 *   --crop <x0,y0,x1,y1>
 *                       Crop the rendered output to the rectangle defined by
 *                       top-left corner (x0,y0) and bottom-right corner (x1,y1).
 *                       Both corners are in full-resolution board pixels.
 *                       e.g. --crop 0,0,1000,1000  renders only the top-left
 *                       1000×1000 region of the board.
 *                       The crop is applied after --scale, so the final video
 *                       dimensions will be ceil(width/scale) × ceil(height/scale).
 *   --help              Print this help and exit
 *
 * REQUIREMENTS
 * ────────────
 *   npm install canvas better-sqlite3
 *   ffmpeg must be on PATH  (or set FFMPEG_PATH env var)
 *
 * DATABASE REQUIREMENT
 * ────────────────────
 *   This script reads from `pixel_history`, NOT the `pixels` table.
 *   `pixels` only stores the current board state (upsert model).
 *   `pixel_history` is an append-log added by the migration in server.js.
 *   See the "Adding pixel_history to your server" section in the README
 *   or follow the instructions printed when this script first runs.
 *
 * HOW IT WORKS
 * ────────────
 *   1. Load all pixel_history rows ordered by placed_at ASC.
 *   2. Group them into "frames" — every (pps / fps) events = 1 frame.
 *   3. For each frame: paint the new pixels onto the canvas, encode the
 *      raw RGBA pixel buffer, and write it to ffmpeg via stdin pipe.
 *   4. ffmpeg assembles the raw frames into a compressed MP4.
 *
 * PERFORMANCE NOTES
 * ─────────────────
 *   A full 1920×1080 canvas is 8 MB of raw RGBA per frame.
 *   At 30 fps, that's 240 MB/s into ffmpeg — fine on localhost, but use
 *   --scale 2 (960×540) to halve that if you're RAM-constrained.
 *   canvas.toBuffer('raw') is the fastest export path (no PNG compression).
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function hasFlag(flag) {
  return args.includes(flag);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
Usage: node timelapse.js [options]

  --db <path>        SQLite database file  (default: ./database.sqlite)
  --json <path>      JSON pixel-history file instead of SQLite
                     (array of {username,x,y,color,placed_at} objects)
  --out <path>       Output MP4            (default: ./timelapse.mp4)
  --fps <n>          Output framerate      (default: 30)
  --pps <n>          Pixel events per second of output (default: 200)
  --from <ISO>       Start date filter     (e.g. 2025-01-01)
  --to   <ISO>       End date filter       (e.g. 2025-12-31)
  --user <name>      Filter to one user
  --scale <n>        Downscale factor      (default: 1, use 2 for half-res)
  --bg <hex>         Background colour     (default: 2e2e2f)
  --no-watermark     Disable text overlay
  --crop <x0,y0,x1,y1>
                     Crop the output to a rectangle defined by two corners:
                     top-left (x0,y0) → bottom-right (x1,y1).
                     e.g. --crop 0,0,1000,1000
  --help             Show this help
`.trim());
  process.exit(0);
}

const DB_PATH      = getArg('--db',  path.join(process.cwd(), 'database.sqlite'));
const JSON_PATH    = getArg('--json', null);   // if set, read from JSON instead of SQLite
const OUT_PATH     = getArg('--out', path.join(process.cwd(), 'timelapse.mp4'));
const FPS          = Math.max(1, parseInt(getArg('--fps', '30'), 10));
const PPS          = Math.max(1, parseInt(getArg('--pps', '200'), 10));
const FROM_DATE    = getArg('--from', null);
const TO_DATE      = getArg('--to',   null);
const USER_FILTER  = getArg('--user', null);
const SCALE        = Math.max(1, parseInt(getArg('--scale', '1'), 10));
const BG_HEX       = '#' + getArg('--bg', '2e2e2f').replace(/^#/, '');
const WATERMARK    = !hasFlag('--no-watermark');
const FFMPEG_BIN   = process.env.FFMPEG_PATH || 'ffmpeg';

// ── Crop option ───────────────────────────────────────────────────────────────
// --crop x0,y0,x1,y1  — board-pixel coordinates (before scaling).
// x0,y0 = top-left corner; x1,y1 = bottom-right corner (exclusive).
// Defaults to the full board.

const CROP_ARG = getArg('--crop', null);
let CROP_X0 = 0, CROP_Y0 = 0, CROP_X1, CROP_Y1;  // X1/Y1 set after BOARD_W/H are defined

if (CROP_ARG) {
  const parts = CROP_ARG.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    console.error('[timelapse] --crop must be four comma-separated integers: x0,y0,x1,y1');
    process.exit(1);
  }
  [CROP_X0, CROP_Y0, CROP_X1, CROP_Y1] = parts;
  if (CROP_X0 >= CROP_X1 || CROP_Y0 >= CROP_Y1) {
    console.error('[timelapse] --crop: x0 must be < x1 and y0 must be < y1');
    process.exit(1);
  }
}

// Canvas dimensions
const BOARD_W = 1920;
const BOARD_H = 1080;

// Finalise crop bounds now that board size is known, then clamp to board.
if (!CROP_ARG) {
  CROP_X1 = BOARD_W;
  CROP_Y1 = BOARD_H;
}
CROP_X0 = Math.max(0, Math.min(CROP_X0, BOARD_W - 1));
CROP_Y0 = Math.max(0, Math.min(CROP_Y0, BOARD_H - 1));
CROP_X1 = Math.max(CROP_X0 + 1, Math.min(CROP_X1, BOARD_W));
CROP_Y1 = Math.max(CROP_Y0 + 1, Math.min(CROP_Y1, BOARD_H));

const CROP_W = CROP_X1 - CROP_X0;   // crop width  in board pixels
const CROP_H = CROP_Y1 - CROP_Y0;   // crop height in board pixels
const CROP_ENABLED = CROP_ARG !== null;

// Output dimensions: scale is applied to the crop region (or full board if no crop).
const OUT_W   = Math.round(CROP_W / SCALE);
const OUT_H   = Math.round(CROP_H / SCALE);

// Events-per-frame (may be fractional — we accumulate)
const EVENTS_PER_FRAME = PPS / FPS;

// ── Dependency checks ─────────────────────────────────────────────────────────

let Database, createCanvas;

// better-sqlite3 is only required when reading from SQLite (no --json flag).
// canvas is always required.
if (!JSON_PATH) {
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error(
      '\n[timelapse] ERROR: better-sqlite3 is not installed.\n' +
      '  Run:  npm install better-sqlite3\n' +
      '  (Or use --json <path> to read from a JSON pixel-history file instead.)\n'
    );
    process.exit(1);
  }
}

try {
  ({ createCanvas } = require('canvas'));
} catch {
  console.error(
    '\n[timelapse] ERROR: canvas is not installed.\n' +
    '  Run:  npm install canvas\n' +
    '  (You may also need system libs: libcairo2-dev, libpango1.0-dev, libpng-dev)\n'
  );
  process.exit(1);
}

// ── Data source: JSON or SQLite ───────────────────────────────────────────────
//
// Both paths produce the same interface:
//   total   — total number of pixel events to render
//   getIter — zero-arg function that returns an iterable of
//             { username, x, y, color, placed_at } objects, already sorted
//             by placed_at ASC and filtered by --from / --to / --user.

let total;
let getIter;

if (JSON_PATH) {
  // ── JSON mode ───────────────────────────────────────────────────────────────
  if (!fs.existsSync(JSON_PATH)) {
    console.error(`\n[timelapse] ERROR: JSON file not found at: ${JSON_PATH}\n`);
    process.exit(1);
  }

  let rawRows;
  try {
    const text = fs.readFileSync(JSON_PATH, 'utf8');
    rawRows = JSON.parse(text);
  } catch (err) {
    console.error(`\n[timelapse] ERROR: Could not parse JSON file: ${err.message}\n`);
    process.exit(1);
  }

  if (!Array.isArray(rawRows)) {
    console.error('\n[timelapse] ERROR: JSON file must contain a top-level array of pixel events.\n');
    process.exit(1);
  }

  // Apply the same date/user filters that the SQLite path supports.
  const fromTs = FROM_DATE ? Date.parse(FROM_DATE)              : null;
  const toTs   = TO_DATE   ? Date.parse(TO_DATE + 'T23:59:59') : null;

  if ((FROM_DATE && isNaN(fromTs)) || (TO_DATE && isNaN(toTs))) {
    console.error('[timelapse] Invalid --from or --to date.');
    process.exit(1);
  }

  let filtered = rawRows.filter(r => {
    if (fromTs !== null && r.placed_at < fromTs) return false;
    if (toTs   !== null && r.placed_at > toTs)   return false;
    if (USER_FILTER && r.username !== USER_FILTER) return false;
    return true;
  });

  // Sort ascending by placement time (the dump may already be sorted, but be safe).
  filtered.sort((a, b) => a.placed_at - b.placed_at);

  total   = filtered.length;
  getIter = () => filtered; // array is already in memory — just return it

} else {
  // ── SQLite mode ─────────────────────────────────────────────────────────────
  if (!fs.existsSync(DB_PATH)) {
    console.error(`\n[timelapse] ERROR: database not found at: ${DB_PATH}\n`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  // Check that pixel_history exists
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pixel_history'"
  ).get();

  if (!tables) {
    console.error(`
[timelapse] ERROR: The 'pixel_history' table does not exist in this database.

The regular 'pixels' table only stores the CURRENT board state (upsert model).
To generate a timelapse you need a separate append-log that records every
placement event.

─────────────────────────────────────────────────────────────────────────────
HOW TO ADD pixel_history TO YOUR SERVER
─────────────────────────────────────────────────────────────────────────────

1. In database.js, inside initializeDatabase(), add this table creation:

     CREATE TABLE IF NOT EXISTS pixel_history (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       username   TEXT    NOT NULL,
       x          INTEGER NOT NULL,
       y          INTEGER NOT NULL,
       color      TEXT    NOT NULL,
       placed_at  INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_ph_placed_at ON pixel_history(placed_at);
     CREATE INDEX IF NOT EXISTS idx_ph_username  ON pixel_history(username);

2. In PlacePixel.js, inside PlacePixel.execute(), after the pixels UPSERT, add:

     _db.prepare(\`
       INSERT INTO pixel_history (username, x, y, color, placed_at)
       VALUES (?, ?, ?, ?, ?)
     \`).run(session.username, x, y, safeColor, Date.now());

   Do the same inside PlacePixel.erase():

     _db.prepare(\`
       INSERT INTO pixel_history (username, x, y, color, placed_at)
       VALUES (?, ?, ?, 'erase', ?)
     \`).run(session.username, x, y, Date.now());

3. Restart your server — new placements will be recorded from that point on.

─────────────────────────────────────────────────────────────────────────────
`);
    process.exit(1);
  }

  // ── Build query ─────────────────────────────────────────────────────────────
  const conditions = [];
  const bindings   = [];

  if (FROM_DATE) {
    const ts = Date.parse(FROM_DATE);
    if (isNaN(ts)) { console.error(`[timelapse] Invalid --from date: ${FROM_DATE}`); process.exit(1); }
    conditions.push('placed_at >= ?');
    bindings.push(ts);
  }
  if (TO_DATE) {
    const ts = Date.parse(TO_DATE + 'T23:59:59');
    if (isNaN(ts)) { console.error(`[timelapse] Invalid --to date: ${TO_DATE}`); process.exit(1); }
    conditions.push('placed_at <= ?');
    bindings.push(ts);
  }
  if (USER_FILTER) {
    conditions.push('username = ?');
    bindings.push(USER_FILTER);
  }

  const WHERE = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const query = `SELECT username, x, y, color, placed_at FROM pixel_history ${WHERE} ORDER BY placed_at ASC`;

  console.log('[timelapse] Counting events…');
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM pixel_history ${WHERE}`).get(...bindings);
  total   = totalRow.n;
  getIter = () => db.prepare(query).iterate(...bindings);
}

if (total === 0) {
  console.error('[timelapse] No pixel events found for the given filters. Nothing to render.');
  process.exit(1);
}

const sourceLabel = JSON_PATH ? `JSON file: ${JSON_PATH}` : `SQLite: ${DB_PATH}`;
console.log(`[timelapse] Source: ${sourceLabel}`);
console.log(`[timelapse] ${total.toLocaleString()} events | ${FPS} fps | ${PPS} pps | scale 1/${SCALE}`);
if (CROP_ENABLED) {
  console.log(`[timelapse] Crop: (${CROP_X0},${CROP_Y0}) → (${CROP_X1},${CROP_Y1})  [${CROP_W}×${CROP_H} board px → ${OUT_W}×${OUT_H} output px]`);
}
const estimatedFrames = Math.ceil(total / EVENTS_PER_FRAME);
const estimatedSecs   = (estimatedFrames / FPS).toFixed(1);
console.log(`[timelapse] ~${estimatedFrames.toLocaleString()} frames → ~${estimatedSecs}s of video`);
console.log(`[timelapse] Output: ${OUT_PATH}`);

// ── Canvas setup ──────────────────────────────────────────────────────────────

const canvas = createCanvas(BOARD_W, BOARD_H);
const ctx    = canvas.getContext('2d');

// Fill background
ctx.fillStyle = BG_HEX;
ctx.fillRect(0, 0, BOARD_W, BOARD_H);

// Watermark setup (drawn once, on top of every frame)
const FONT_SIZE = Math.max(14, Math.round(22 / SCALE));

function drawWatermark(frameCtx) {
  if (!WATERMARK) return;
  frameCtx.save();
  frameCtx.font      = `bold ${FONT_SIZE}px sans-serif`;
  frameCtx.fillStyle = 'rgba(255,255,255,0.18)';
  frameCtx.textAlign = 'right';
  frameCtx.fillText('Saint-Pixels', OUT_W - 10, OUT_H - 10);
  frameCtx.restore();
}

// Output canvas (may be scaled down and/or cropped)
let outCanvas, outCtx;
if (SCALE === 1 && !CROP_ENABLED) {
  // Fast path: no transformation needed — write the main canvas directly.
  outCanvas = canvas;
  outCtx    = ctx;
} else {
  // A separate output canvas is needed for scaling and/or cropping.
  outCanvas = createCanvas(OUT_W, OUT_H);
  outCtx    = outCanvas.getContext('2d');
}

// ── ffmpeg setup ──────────────────────────────────────────────────────────────

// Pipe raw RGBA frames into ffmpeg
// -f rawvideo: we supply uncompressed pixels
// -pix_fmt bgra: matches canvas.toBuffer('raw') which outputs BGRA, not RGBA
// -s WxH: frame dimensions
// -r FPS: interpret incoming frames at this rate
// -i pipe:0: read from stdin
// -c:v libx264: H.264 compression
// -pix_fmt yuv420p: widest player compatibility
// -preset fast: good quality/speed tradeoff
// -crf 18: near-lossless for colour accuracy
// -movflags +faststart: puts metadata at front for web streaming

const ffmpegArgs = [
  '-y',                              // overwrite output without asking
  '-f', 'rawvideo',
  '-pix_fmt', 'bgra',
  '-s', `${OUT_W}x${OUT_H}`,
  '-r', String(FPS),
  '-i', 'pipe:0',
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-preset', 'fast',
  '-crf', '18',
  '-movflags', '+faststart',
  OUT_PATH,
];

console.log(`\n[timelapse] Launching ffmpeg…`);
const ffmpeg = spawn(FFMPEG_BIN, ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

ffmpeg.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(
      `\n[timelapse] ERROR: ffmpeg not found (tried: ${FFMPEG_BIN})\n` +
      '  Install ffmpeg and ensure it is on your PATH,\n' +
      '  or set the FFMPEG_PATH environment variable.\n'
    );
  } else {
    console.error('[timelapse] ffmpeg error:', err);
  }
  process.exit(1);
});

ffmpeg.on('close', (code) => {
  if (code !== 0) {
    console.error(`\n[timelapse] ffmpeg exited with code ${code}`);
    process.exit(code);
  }
  console.log(`\n[timelapse] ✓ Done! Saved to: ${OUT_PATH}`);
});

const ffmpegStdin = ffmpeg.stdin;

// ── Progress tracking ─────────────────────────────────────────────────────────

let frameCount    = 0;
let eventCount    = 0;
let frameAccum    = 0;          // fractional events-towards-next-frame accumulator
let lastLogTime   = Date.now();

function logProgress() {
  const pct     = ((eventCount / total) * 100).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(
    `\r[timelapse] ${pct}% — ${eventCount.toLocaleString()}/${total.toLocaleString()} events | ` +
    `${frameCount.toLocaleString()} frames | ${elapsed}s elapsed   `
  );
}

// ── Pixel colour helper ───────────────────────────────────────────────────────

function normalizeColor(c) {
  if (!c || c === 'erase') return null; // null = erase
  const h = c.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(h)) return '#' + h;
  if (/^[0-9a-fA-F]{3}$/.test(h)) return '#' + h.split('').map(x => x + x).join('');
  return null;
}

// ── Write one frame to ffmpeg ─────────────────────────────────────────────────

function writeFrame() {
  let buf;
  if (SCALE === 1 && !CROP_ENABLED) {
    // Fast path: no transform — use the main canvas buffer directly.
    buf = outCanvas.toBuffer('raw');
  } else {
    // drawImage(src, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
    // Source rect  = the crop region on the full-res board canvas.
    // Dest rect    = the full output canvas (handles both crop and scale).
    outCtx.drawImage(
      canvas,
      CROP_X0, CROP_Y0, CROP_W, CROP_H,  // source: crop window
      0,       0,       OUT_W,  OUT_H      // dest:   scaled output
    );
    buf = outCanvas.toBuffer('raw');
  }

  drawWatermark(outCtx);
  // Re-export after watermark (only meaningful when SCALE !== 1 or crop is on, but harmless)
  if (WATERMARK) {
    buf = outCanvas.toBuffer('raw');
    // Remove watermark from outCtx so next frame starts clean
    outCtx.clearRect(0, OUT_H - FONT_SIZE * 2, OUT_W, FONT_SIZE * 2 + 10);
    if (SCALE !== 1 || CROP_ENABLED) {
      outCtx.drawImage(
        canvas,
        CROP_X0, CROP_Y0, CROP_W, CROP_H,
        0,       0,       OUT_W,  OUT_H
      );
    }
  }

  const ok = ffmpegStdin.write(buf);
  frameCount++;
  return ok; // false = pipe buffer full (need to drain)
}

// ── Main render loop ──────────────────────────────────────────────────────────

const startTime = Date.now();

async function render() {
  // Stream rows from the data source — avoids loading all rows into memory at once
  // for SQLite; for JSON the array is already in memory (inevitable for JSON files).
  const iter = getIter();

  // Drain-aware write loop using async/await + stream backpressure
  const REPORT_INTERVAL_MS = 500;

  for (const row of iter) {
    const { x, y, color } = row;

    // Paint pixel onto the full-resolution canvas
    if (color === 'erase') {
      ctx.clearRect(x, y, 1, 1);
      ctx.fillStyle = BG_HEX;
      ctx.fillRect(x, y, 1, 1);
    } else {
      const c = normalizeColor(color);
      if (c) {
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
    }

    eventCount++;
    frameAccum += 1;

    // Emit a frame whenever we've accumulated enough events
    if (frameAccum >= EVENTS_PER_FRAME) {
      frameAccum -= EVENTS_PER_FRAME;

      const ok = writeFrame();

      if (!ok) {
        // ffmpeg's stdin buffer is full — wait for it to drain before continuing
        await new Promise(resolve => ffmpegStdin.once('drain', resolve));
      }
    }

    // Throttled progress logging
    if (Date.now() - lastLogTime > REPORT_INTERVAL_MS) {
      logProgress();
      lastLogTime = Date.now();
    }
  }

  // Flush the final partial frame (the last few pixels that didn't fill a frame)
  if (frameAccum > 0) {
    writeFrame();
  }

  logProgress();
  process.stdout.write('\n');

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[timelapse] Render complete — ${frameCount.toLocaleString()} frames in ${totalSecs}s ` +
    `(${(frameCount / totalSecs).toFixed(1)} fps throughput)`
  );

  // Close stdin — tells ffmpeg we're done sending frames
  ffmpegStdin.end();
}

render().catch(err => {
  console.error('\n[timelapse] Unexpected error:', err);
  ffmpegStdin.destroy();
  process.exit(1);
});
