/**
 * 
 * @param {Database} db 
 */
export function initializeDatabase(db) {
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
}