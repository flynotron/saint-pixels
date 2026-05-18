# Saint Pixels - Development Setup with Docker

## Quick Start with Docker Compose

No need to install Node.js or npm locally. Just install [Docker](https://docs.docker.com/get-docker/) (which includes Docker Compose):

```bash
sudo docker compose up --build
```

The app will be available at `d`

## Environment Variables

You can override the port by setting `PORT`:

```bash
PORT=8080 sudo docker compose up --build
```

## Without Docker

If you prefer to run locally (requires Node.js 20+):

```bash
npm install
node server.js
```

The server prints the URL to the console on startup.

## API Endpoints

- `POST /api/register` - Create a new account
- `POST /api/login` - Login
- `GET /api/me` - Get current user
- `POST /api/logout` - Logout
- `GET /api/palette` - Get color palette from database

## Database

SQLite database is automatically initialized with default colors on first run. The `database.sqlite` file is excluded from the repository and created locally on first run.
