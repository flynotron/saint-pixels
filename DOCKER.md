# Saint Pixels - Development Setup with Docker

## Quick Start with Docker Compose

No need to install Node.js or npm locally. Just install Docker and Docker Compose:

```bash
docker-compose up
```

The app will be available at `http://localhost:3000`

## Environment Variables

You can override the port by setting `PORT`:

```bash
PORT=8080 docker-compose up
```

## Without Docker

If you prefer to run locally:

```bash
npm install
npm start
# or
node server.js
```

The server runs on a random available port (printed to console) or the port specified in `PORT` env var.

## API Endpoints

- `POST /api/register` - Create a new account
- `POST /api/login` - Login
- `GET /api/me` - Get current user
- `POST /api/logout` - Logout
- `GET /api/palette` - Get color palette from database

## Database

SQLite database is automatically initialized with default colors on first run.
