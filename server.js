const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile);
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function hashPassword(password, username) {
  const salt = crypto.createHash('sha256').update(username).digest('hex');
  return crypto.createHmac('sha512', salt).update(password).digest('hex');
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

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    ip TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  )`);
});

db.run(`CREATE TABLE IF NOT EXISTS palette (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  color TEXT NOT NULL
)`);

db.get('SELECT COUNT(*) AS count FROM palette', (err, row) => {
  if (err) {
    console.error('Palette table count failed:', err);
    return;
  }
  if (!row || row.count === 0) {
    const defaultPalette = [
      ['Black', '000000'],
      ['White', 'ffffff'],
      ['Orange', 'f97316'],
      ['Yellow', 'fde047'],
      ['Green', '22c55e'],
      ['Blue', '38bdf8'],
      ['Indigo', '818cf8'],
      ['Pink', 'ec4899'],
      ['Light Green', 'a3e635']
    ];
    const stmt = db.prepare('INSERT INTO palette (label, color) VALUES (?, ?)');
    defaultPalette.forEach(([label, color]) => stmt.run(label, color));
    stmt.finalize();
  }
});

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

  db.get('SELECT id FROM accounts WHERE ip = ?', [ip], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (row) return res.status(409).json({ error: 'One account per IP is allowed.' });

    db.get('SELECT id FROM accounts WHERE username = ?', [username], (err, existing) => {
      if (err) return res.status(500).json({ error: 'Database error.' });
      if (existing) return res.status(409).json({ error: 'Username already taken.' });

      const hashed = hashPassword(password, username);
      const createdAt = Date.now();
      db.run('INSERT INTO accounts (username, password, ip, created_at) VALUES (?, ?, ?, ?)', [username, hashed, ip, createdAt], function (insertErr) {
        if (insertErr) return res.status(500).json({ error: 'Could not create account.' });
        const token = createSession(username);
        return res.json({ username, token });
      });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const passwordHash = hashPassword(password, username);

  db.get('SELECT username, password FROM accounts WHERE username = ? AND password = ?', [username, hash], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (!row) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = createSession(username);
    return res.json({ username, token });
  });
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
