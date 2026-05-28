<p align="center">
  <img src="./1180x100github_title.png" alt="Saint Pixels Title Screen">
</p>

# Sait Pixels

## About

Saint-Pixels is a multiplayer pixel canvas project inspired by classic internet pixel boards. Players can work together to create huge artworks or compete for space on the canvas.

Players can draw, defend, and leave their mark on the world.

The canvas size is **1920x1080** and every pixel matters.

## Features

- Real time pixel drawing
- Defend your artwork from other players
- Large shared canvas
- Simple and clean interface
- Pixel art focused gameplay
- Live chat with other players

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Brush |
| `2` | Eraser |
| `3` | Fill |
| `4` | Eyedropper |
| `5` | None |
| `F` | Toggle fullscreen |
| `G` | Toggle grid |
| `Shift + drag` | Pan canvas |
| `Scroll` | Zoom in/out |
| `w` `a` `s` `d` | Move through color palette |
| Arrow keys | Move selecting cursor |

## License

You can contribute to the project if you want to; you can't redistribute nor sell the project.

## Getting Started with Docker

No need to install Node.js locally. Just install [Docker](https://docs.docker.com/get-docker/) and run:

```bash
docker compose up
```

The app will be available at `http://localhost:3000`

## Environment Variables

Override the port with the `PORT` variable:

```bash
PORT=8080 docker compose up
```

## Without Docker

```bash
npm install
node server.js
```

The server prints the URL to the console on startup.

## Database

SQLite database (`database.sqlite`) is created automatically on first run. It is excluded from the repository via `.gitignore`.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Create a new account |
| POST | `/api/login` | Login |
| GET | `/api/me` | Get current user |
| POST | `/api/logout` | Logout |
| GET | `/api/verify-email` | Verify email by token |
| GET | `/api/chat` | Most recent 200 messages |
| POST | `/api/chat` | Send a new message |
| GET | `/api/leaderboard` | Top 100 players. Filter by period using ?period=<today, week, month, year, decade,alltime> |
| GET | `/api/profile/:username` | Returns stats for a given username |
| POST | `/api/pixel` | Place a colored pixel |
| POST | `/api/erase` | Erase a pixel |
| GET | `/api/stream` | Most recent pixel history of all users |
