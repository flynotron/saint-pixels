'use strict';

/**
 * src/setup/timelapse.js — Server-side timelapse job manager + HTTP routes
 *
 * Exposes:
 *   POST /api/timelapse/start   — enqueue a new render job (admin-only)
 *   GET  /api/timelapse/:id     — poll job status / download finished MP4
 *   GET  /api/timelapse/:id/progress — SSE stream of render progress
 *   DELETE /api/timelapse/:id   — cancel a pending/running job (admin-only)
 *
 * Auth:
 *   All write endpoints require  Authorization: Bearer <TIMELAPSE_SECRET>
 *   where TIMELAPSE_SECRET is an env var you set in .env.
 *   If TIMELAPSE_SECRET is unset, the timelapse API is disabled entirely.
 *
 * Design:
 *   • One job runs at a time — ffmpeg + canvas rendering is CPU-bound.
 *   • Jobs are stored in-memory (a Map). A server restart clears them.
 *   • Finished MP4s are written to TIMELAPSE_OUT_DIR (default: ./timelapse-jobs/).
 *   • Callers can watch progress via SSE before polling for the download URL.
 *
 * Usage in server.js:
 *   const { initializeTimelapse } = require('./src/setup/timelapse.js');
 *   initializeTimelapse(app, db, timelapseLimiter);
 */

const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const { spawn } = require('child_process');

// ── Configuration ─────────────────────────────────────────────────────────────

const TIMELAPSE_SECRET  = process.env.TIMELAPSE_SECRET || null;
const FFMPEG_BIN        = process.env.FFMPEG_PATH || 'ffmpeg';
const OUT_DIR           = process.env.TIMELAPSE_OUT_DIR
  || path.join(process.cwd(), 'timelapse-jobs');

const BOARD_W = 1920;
const BOARD_H = 1080;

// ── Job store ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{ 
 *   id: string,
 *   status: 'pending'|'running'|'done'|'failed'|'cancelled',
 *   created_at: number,
 *   started_at: number|null,
 *   finished_at: number|null,
 *   options: object,
 *   progress: { events: number, total: number, frames: number },
 *   error: string|null,
 *   outPath: string|null,
 *   progressListeners: Set<import('http').ServerResponse>
 * }} Job
 */

/** @type {Map<string, Job>} */
const jobs = new Map();

/** @type {string|null} — id of the currently running job */
let activeJobId = null;

/** @type {Job[]} — FIFO queue of pending jobs */
const queue = [];

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireTimelapsAuth(req, res, next) {
  if (!TIMELAPSE_SECRET) {
    return res.status(503).json({ error: 'Timelapse API is disabled (TIMELAPSE_SECRET not set).' });
  }
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || token !== TIMELAPSE_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing timelapse secret.' });
  }
  next();
}

// ── Progress broadcast ────────────────────────────────────────────────────────

function broadcastProgress(job) {
  const payload = `data: ${JSON.stringify({
    id:       job.id,
    status:   job.status,
    progress: job.progress,
    error:    job.error,
  })}\n\n`;
  for (const res of job.progressListeners) {
    try { res.write(payload); } catch { job.progressListeners.delete(res); }
  }
  // On terminal states, close all SSE listeners
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    for (const res of job.progressListeners) {
      try { res.end(); } catch { /* ignore */ }
    }
    job.progressListeners.clear();
  }
}

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Run a timelapse render job.  Resolves when ffmpeg closes successfully.
 * @param {Job} job
 * @param {import('better-sqlite3').Database} db
 */
async function runJob(job, db) {
  job.status     = 'running';
  job.started_at = Date.now();

  // Lazy-require canvas so the server doesn't crash on startup if canvas isn't installed.
  let createCanvas;
  try {
    ({ createCanvas } = require('canvas'));
  } catch {
    throw new Error(
      'The "canvas" npm package is not installed. Run: npm install canvas\n' +
      '(You may also need system libs: libcairo2-dev, libpango1.0-dev, libpng-dev)'
    );
  }

  const opts   = job.options;
  const SCALE  = Math.max(1, parseInt(opts.scale  || '1',   10));
  const FPS    = Math.max(1, parseInt(opts.fps    || '30',  10));
  const PPS    = Math.max(1, parseInt(opts.pps    || '200', 10));
  const BG_HEX = '#' + (opts.bg || '2e2e2f').replace(/^#/, '');
  const WATERMARK = opts.watermark !== false;

  const OUT_W = Math.round(BOARD_W / SCALE);
  const OUT_H = Math.round(BOARD_H / SCALE);
  const EVENTS_PER_FRAME = PPS / FPS;

  // ── Query pixel_history ────────────────────────────────────────────────────

  let WHERE = '1=1';
  const bindings = [];

  if (opts.from) {
    const fromTs = Date.parse(opts.from);
    if (!isNaN(fromTs)) { WHERE += ' AND placed_at >= ?'; bindings.push(fromTs); }
  }
  if (opts.to) {
    const toTs = Date.parse(opts.to + 'T23:59:59');
    if (!isNaN(toTs)) { WHERE += ' AND placed_at <= ?'; bindings.push(toTs); }
  }
  if (opts.user) {
    WHERE += ' AND username = ?'; bindings.push(opts.user);
  }

  const countRow = db.prepare(`SELECT COUNT(*) AS n FROM pixel_history WHERE ${WHERE}`).get(...bindings);
  const total    = countRow.n;

  if (total === 0) {
    throw new Error('No pixel events found for the given filters.');
  }

  job.progress.total = total;
  broadcastProgress(job);

  // ── Canvas setup ───────────────────────────────────────────────────────────

  const canvas = createCanvas(BOARD_W, BOARD_H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = BG_HEX;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  let outCanvas, outCtx;
  if (SCALE === 1) {
    outCanvas = canvas; outCtx = ctx;
  } else {
    outCanvas = createCanvas(OUT_W, OUT_H);
    outCtx    = outCanvas.getContext('2d');
  }

  const FONT_SIZE = Math.max(14, Math.round(22 / SCALE));
  function drawWatermark() {
    if (!WATERMARK) return;
    outCtx.save();
    outCtx.font      = `bold ${FONT_SIZE}px sans-serif`;
    outCtx.fillStyle = 'rgba(255,255,255,0.18)';
    outCtx.textAlign = 'right';
    outCtx.fillText('Saint-Pixels', OUT_W - 10, OUT_H - 10);
    outCtx.restore();
  }

  // ── ffmpeg ─────────────────────────────────────────────────────────────────

  const outPath = path.join(OUT_DIR, `${job.id}.mp4`);

  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${OUT_W}x${OUT_H}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'fast', '-crf', '18',
    '-movflags', '+faststart',
    outPath,
  ];

  const ffmpeg     = spawn(FFMPEG_BIN, ffmpegArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
  const ffmpegStdin = ffmpeg.stdin;

  // Capture the ffmpeg exit code so we can propagate errors.
  let ffmpegExitCode = null;
  const ffmpegClosed = new Promise(resolve => {
    ffmpeg.on('close', code => { ffmpegExitCode = code; resolve(); });
    ffmpeg.on('error', err => {
      if (err.code === 'ENOENT') {
        err.message = `ffmpeg not found (tried: ${FFMPEG_BIN}). Install ffmpeg or set FFMPEG_PATH.`;
      }
      ffmpegExitCode = -1;
      resolve(err);
    });
  });

  // ── Normalise color helper ─────────────────────────────────────────────────

  function normalizeColor(c) {
    if (!c || c === 'erase') return null;
    const h = c.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(h)) return '#' + h;
    if (/^[0-9a-fA-F]{3}$/.test(h)) return '#' + h.split('').map(x => x + x).join('');
    return null;
  }

  // ── Write one frame ────────────────────────────────────────────────────────

  function writeFrame() {
    if (SCALE !== 1) outCtx.drawImage(canvas, 0, 0, OUT_W, OUT_H);
    drawWatermark();
    const buf = outCanvas.toBuffer('raw');
    // Erase watermark region for next frame
    if (WATERMARK) {
      outCtx.clearRect(0, OUT_H - FONT_SIZE * 2 - 10, OUT_W, FONT_SIZE * 2 + 10);
      if (SCALE !== 1) outCtx.drawImage(canvas, 0, 0, OUT_W, OUT_H);
    }
    const ok = ffmpegStdin.write(buf);
    job.progress.frames++;
    return ok;
  }

  // ── Render loop ────────────────────────────────────────────────────────────

  const iter       = db.prepare(`SELECT x, y, color FROM pixel_history WHERE ${WHERE} ORDER BY placed_at ASC`).iterate(...bindings);
  let frameAccum   = 0;
  let lastBroadcast = Date.now();
  const BROADCAST_INTERVAL_MS = 500;

  for (const row of iter) {
    // Abort if job was cancelled
    if (job.status === 'cancelled') {
      ffmpegStdin.destroy();
      return;
    }

    const { x, y, color } = row;
    if (color === 'erase') {
      ctx.clearRect(x, y, 1, 1);
      ctx.fillStyle = BG_HEX;
      ctx.fillRect(x, y, 1, 1);
    } else {
      const c = normalizeColor(color);
      if (c) { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); }
    }

    job.progress.events++;
    frameAccum += 1;

    if (frameAccum >= EVENTS_PER_FRAME) {
      frameAccum -= EVENTS_PER_FRAME;
      const ok = writeFrame();
      if (!ok) {
        await new Promise(resolve => ffmpegStdin.once('drain', resolve));
      }
    }

    if (Date.now() - lastBroadcast > BROADCAST_INTERVAL_MS) {
      broadcastProgress(job);
      lastBroadcast = Date.now();
    }
  }

  // Flush final partial frame
  if (frameAccum > 0) writeFrame();

  // Signal EOF to ffmpeg and wait for it to finish encoding
  ffmpegStdin.end();
  await ffmpegClosed;

  if (ffmpegExitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${ffmpegExitCode}`);
  }

  job.outPath = outPath;
}

// ── Queue runner ──────────────────────────────────────────────────────────────

let _db = null;

async function runNext() {
  if (activeJobId) return;             // already busy
  if (queue.length === 0) return;      // nothing to do

  const job = queue.shift();
  if (job.status === 'cancelled') { runNext(); return; }

  activeJobId = job.id;
  try {
    await runJob(job, _db);
    if (job.status !== 'cancelled') {
      job.status      = 'done';
      job.finished_at = Date.now();
    }
  } catch (err) {
    if (job.status !== 'cancelled') {
      job.status      = 'failed';
      job.error       = err.message;
      job.finished_at = Date.now();
      console.error(`[timelapse] job ${job.id} failed:`, err.message);
    }
  } finally {
    activeJobId = null;
    broadcastProgress(job);
    // Clean up output file if job failed/cancelled
    if ((job.status === 'failed' || job.status === 'cancelled') && job.outPath) {
      fs.unlink(job.outPath, () => {});
    }
    runNext();
  }
}

// ── HTTP route setup ──────────────────────────────────────────────────────────

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {Function} [limiter]  optional express-rate-limit middleware
 */
function initializeTimelapse(app, db, limiter) {
  if (!TIMELAPSE_SECRET) {
    console.log('[timelapse] TIMELAPSE_SECRET not set — timelapse API disabled.');
    return;
  }

  _db = db;

  // Ensure output dir exists
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* already exists */ }

  // Check that pixel_history table exists
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pixel_history'"
  ).get();
  if (!tableExists) {
    console.warn('[timelapse] WARNING: pixel_history table does not exist. Timelapse API will return errors until the table is created by running the server with the updated database.js.');
  }

  const mw = limiter ? [limiter] : [];

  // ── POST /api/timelapse/start ──────────────────────────────────────────────
  app.post('/api/timelapse/start', ...mw, requireTimelapsAuth, (req, res) => {
    const opts = req.body || {};

    const id  = crypto.randomBytes(8).toString('hex');
    /** @type {Job} */
    const job = {
      id,
      status:      'pending',
      created_at:  Date.now(),
      started_at:  null,
      finished_at: null,
      options:     {
        fps:       opts.fps       || 30,
        pps:       opts.pps       || 200,
        scale:     opts.scale     || 1,
        bg:        opts.bg        || '2e2e2f',
        from:      opts.from      || null,
        to:        opts.to        || null,
        user:      opts.user      || null,
        watermark: opts.watermark !== false,
      },
      progress:          { events: 0, total: 0, frames: 0 },
      error:             null,
      outPath:           null,
      progressListeners: new Set(),
    };

    jobs.set(id, job);
    queue.push(job);
    runNext(); // kick off if idle

    return res.status(202).json({
      id,
      status:    job.status,
      progress:  job.progress,
      statusUrl: `/api/timelapse/${id}`,
      streamUrl: `/api/timelapse/${id}/progress`,
    });
  });

  // ── GET /api/timelapse/:id ─────────────────────────────────────────────────
  app.get('/api/timelapse/:id', ...mw, requireTimelapsAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    // If done and client wants the file directly, stream it
    if (job.status === 'done' && req.query.download === '1' && job.outPath) {
      if (!fs.existsSync(job.outPath)) {
        return res.status(410).json({ error: 'Output file no longer exists.' });
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="timelapse-${job.id}.mp4"`);
      fs.createReadStream(job.outPath).pipe(res);
      return;
    }

    return res.json({
      id:          job.id,
      status:      job.status,
      created_at:  job.created_at,
      started_at:  job.started_at,
      finished_at: job.finished_at,
      progress:    job.progress,
      error:       job.error,
      downloadUrl: job.status === 'done' ? `/api/timelapse/${job.id}?download=1` : null,
    });
  });

  // ── GET /api/timelapse/:id/progress  (SSE) ────────────────────────────────
  app.get('/api/timelapse/:id/progress', ...mw, requireTimelapsAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send current state immediately
    res.write(`data: ${JSON.stringify({
      id: job.id, status: job.status, progress: job.progress, error: job.error,
    })}\n\n`);

    // If already terminal, close immediately
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      res.end();
      return;
    }

    job.progressListeners.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      job.progressListeners.delete(res);
    });
  });

  // ── DELETE /api/timelapse/:id ──────────────────────────────────────────────
  app.delete('/api/timelapse/:id', ...mw, requireTimelapsAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    if (job.status === 'done' || job.status === 'failed') {
      // Clean up output file if it exists
      if (job.outPath) fs.unlink(job.outPath, () => {});
      jobs.delete(job.id);
      return res.json({ message: 'Job deleted.' });
    }

    job.status      = 'cancelled';
    job.finished_at = Date.now();
    broadcastProgress(job);

    // Remove from queue if it hasn't started yet
    const qi = queue.indexOf(job);
    if (qi !== -1) queue.splice(qi, 1);

    return res.json({ id: job.id, status: 'cancelled' });
  });

  // ── GET /api/timelapse  (list jobs) ───────────────────────────────────────
  app.get('/api/timelapse', ...mw, requireTimelapsAuth, (req, res) => {
    const list = [...jobs.values()].map(j => ({
      id:          j.id,
      status:      j.status,
      created_at:  j.created_at,
      started_at:  j.started_at,
      finished_at: j.finished_at,
      progress:    j.progress,
      error:       j.error,
      downloadUrl: j.status === 'done' ? `/api/timelapse/${j.id}?download=1` : null,
    }));
    res.json({ jobs: list, active: activeJobId, queued: queue.length });
  });

  console.log('[timelapse] API enabled at /api/timelapse/*');
}

module.exports = { initializeTimelapse };
