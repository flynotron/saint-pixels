const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new Database(dbFile);
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

function hashPassword(password, username) {
  const user = typeof username === 'string' ? username : '';
  const pwd = typeof password === 'string' ? password : '';
  const salt = crypto.createHash('sha256').update(user).digest('hex');
  return crypto.createHmac('sha512', salt).update(pwd).digest('hex');
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, created: Date.now() });
  return token;
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type === 'Bearer' && sessions.has(token)) {
    return sessions.get(token);
  }
  return null;
}

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    ip TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS palette (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    color TEXT NOT NULL
  );
`);

 

// Populate default palette if empty
try {
  const countStmt = db.prepare('SELECT COUNT(*) AS count FROM palette');
  const result = countStmt.get();
  if (result.count === 0) {
    const insertStmt = db.prepare('INSERT INTO palette (label, color) VALUES (?, ?)');
    const defaultPalette = [
      ['Black', '000000'],
      ['White', 'ffffff'],
      ['Red', 'ef4444'],
      ['Orange', 'fb923c'],
      ['Yellow', 'facc15'],
      ['Green', '22c55e'],
      ['Cyan', '06b6d4'],
      ['Blue', '3b82f6'],
      ['Indigo', '6366f1'],
      ['Violet', '8b5cf6'],
      ['Pink', 'ec4899']
    ];
    const insertMany = db.transaction((colors) => {
      colors.forEach(([label, color]) => insertStmt.run(label, color));
    });
    insertMany(defaultPalette);
  }
} catch (err) {
  console.error('Failed to populate default palette:', err);
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters and only letters, numbers, hyphen, underscore.' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  try {
    const checkUserStmt = db.prepare('SELECT id FROM accounts WHERE username = ?');
    if (checkUserStmt.get(username)) {
      return res.status(409).json({ error: 'Username already taken.' });
    }

    const hashed = hashPassword(password, username);
    const createdAt = Date.now();
    const insertStmt = db.prepare('INSERT INTO accounts (username, password, ip, created_at) VALUES (?, ?, ?, ?)');
    insertStmt.run(username, hashed, ip, createdAt);
    const token = createSession(username);
    return res.json({ username, token });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const selectStmt = db.prepare('SELECT username, password FROM accounts WHERE username = ?');
    const row = selectStmt.get(username);
    if (!row) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (row.password !== hashPassword(password, username)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const token = createSession(username);
    return res.json({ username, token });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Database error.' });
  }
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  return res.json({ username: session.username });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');
  if (token && sessions.has(token)) {
    sessions.delete(token);
  }
  res.json({ success: true });
});

app.get('/api/palette', (req, res) => {
  try {
    const selectStmt = db.prepare('SELECT id, label, color FROM palette ORDER BY id ASC');
    const rows = selectStmt.all();
    const colors = rows.map(row => ({
      id: row.id,
      label: row.label,
      color: row.color
    }));
    res.json({ colors });
  } catch (err) {
    console.error('Palette fetch error:', err);
    return res.status(500).json({ error: 'Could not load palette.' });
  }
});

app.use((req, res) => {
  res.status(404).send('Not found');
});

const desiredPort = process.env.PORT ? Number(process.env.PORT) : 0;
const server = app.listen(desiredPort, () => {
  const addr = server.address();
  const boundPort = (typeof addr === 'string') ? addr : addr.port;
  console.log(`Saint Pixels server running on http://localhost:${boundPort}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port already in use. Try setting PORT environment variable to a free port.');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
