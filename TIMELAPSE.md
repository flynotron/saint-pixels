# Timelapse Generator

Renders every pixel placement ever recorded into a time-lapse MP4 video.

---

## Requirements

**Node packages** (install once in your project root):
```bash
npm install canvas better-sqlite3
```

> On Linux you may also need system libraries for `canvas`:
> ```bash
> sudo apt-get install libcairo2-dev libpango1.0-dev libpng-dev libjpeg-dev
> ```

**ffmpeg** must be available on your system:
```bash
# Ubuntu / Debian
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Or set the FFMPEG_PATH env var if ffmpeg is installed somewhere non-standard
export FFMPEG_PATH=/usr/local/bin/ffmpeg
```

---

## Basic usage

```bash
node timelapse.js
```

This reads `./database.sqlite`, renders all pixel history, and saves `./timelapse.mp4`.

---

## All options

| Flag | Default | Description |
|---|---|---|
| `--db <path>` | `./database.sqlite` | Path to your SQLite database |
| `--json <path>` | — | Use a JSON history file instead of SQLite (see below) |
| `--out <path>` | `./timelapse.mp4` | Output MP4 file path |
| `--fps <n>` | `30` | Output video framerate |
| `--pps <n>` | `200` | Pixel events per second of video |
| `--from <date>` | — | Only include events on or after this date (e.g. `2025-01-01`) |
| `--to <date>` | — | Only include events up to this date (e.g. `2025-12-31`) |
| `--user <name>` | — | Only include placements by one specific user |
| `--scale <n>` | `1` | Downscale factor — `2` renders at 960×540 (faster, less RAM) |
| `--bg <hex>` | `2e2e2f` | Background fill colour (no `#` needed) |
| `--no-watermark` | — | Remove the "Saint-Pixels" text overlay |
| `--help` | — | Print usage and exit |

---

## Examples

**Standard render with custom output path:**
```bash
node timelapse.js --db ./database.sqlite --out ./videos/april.mp4
```

**Faster render at half resolution (recommended for large canvases):**
```bash
node timelapse.js --scale 2
```

**Slow the video down** — fewer pixels per second means more frames per event:
```bash
node timelapse.js --pps 50
```

**Speed the video up** — more pixels burned per second:
```bash
node timelapse.js --pps 1000
```

**Filter to a specific date range:**
```bash
node timelapse.js --from 2025-04-01 --to 2025-04-30 --out april.mp4
```

**Filter to a single user:**
```bash
node timelapse.js --user flynotron --out flynotron.mp4
```

**No watermark, custom background:**
```bash
node timelapse.js --no-watermark --bg 1a1a2e
```

**Read from a JSON history file instead of SQLite:**
```bash
node timelapse.js --json /var/data/timelapse-jobs/pixel-history.json --out timelapse.mp4
```

---

## Data sources

The script can read from two sources — use whichever applies to your setup.

### SQLite (default)

Reads directly from the `pixel_history` table in your database. This table is an append-log of every placement ever made and is separate from the `pixels` table (which only stores the current board state).

> **Note:** If you get an error saying `pixel_history` doesn't exist, your database predates the migration that added it. New placements are recorded automatically once you're running the current version of the server. Historical placements before that point won't appear in the timelapse.

### JSON file

If you set `JSON_HISTORY_PATH` in your Railway environment (recommended: `/var/data/timelapse-jobs/pixel-history.json`), the server writes every placement to that file in real time. Pass it with `--json`:

```bash
node timelapse.js --json /var/data/timelapse-jobs/pixel-history.json
```

The JSON file is a flat array of objects:
```json
[
  { "username": "alice", "x": 100, "y": 200, "color": "ef4444", "placed_at": 1714000000000 },
  { "username": "bob",   "x": 101, "y": 200, "color": "erase",  "placed_at": 1714000001000 }
]
```

---

## Understanding `--fps` and `--pps`

- `--fps` controls the **output video's** frame rate (how smooth it looks). 30 is standard.
- `--pps` controls **how fast events play back** — how many pixel placements are shown per second of video.

A new frame is emitted every `pps / fps` events. For example:
- `--pps 200 --fps 30` → a new frame every ~6–7 pixel events → moderate speed
- `--pps 30 --fps 30` → a new frame per pixel → very slow, every pixel is its own frame
- `--pps 3000 --fps 30` → 100 pixels per frame → very fast render

---

## Performance tips

- Use `--scale 2` to render at 960×540 — roughly 4× less memory and significantly faster encoding.
- The full 1920×1080 canvas is 8 MB of raw RGBA per frame. At 30 fps that's 240 MB/s into ffmpeg — fine on a local machine, but `--scale 2` is recommended on Railway or memory-constrained servers.
- SQLite mode streams rows from the database rather than loading everything into memory at once, so it handles very large histories efficiently.

---

## Running on Railway

Railway doesn't have a persistent shell, so generate the timelapse locally using a copy of your database or the JSON history file:

```bash
# 1. Download your pixel-history.json from the Railway volume (via your app's API or scp)
# 2. Run locally
node timelapse.js --json ./pixel-history.json --out timelapse.mp4
```

Or if ffmpeg is available in your Railway environment (set via `FFMPEG_PATH`), you can trigger it through a custom admin API endpoint in your server.
