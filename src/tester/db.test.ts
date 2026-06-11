import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('Database', () => {
  it('should create and query database', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT UNIQUE NOT NULL,
        profile TEXT,
        base_url TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        model_count INTEGER DEFAULT 0,
        config_json TEXT
      );
    `);

    db.prepare(`
      INSERT INTO runs (run_id, profile, base_url, started_at, config_json)
      VALUES (?, ?, ?, ?, ?)
    `).run('test123', 'test', 'http://test.com', '2026-01-01T00:00:00', '{}');

    const rows = db.prepare('SELECT * FROM runs WHERE run_id = ?').all('test123');
    expect(rows.length).toBe(1);
    expect((rows[0] as any).run_id).toBe('test123');

    db.close();
  });

  it('should support prepared statements', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT);
    `);
    
    const insert = db.prepare('INSERT INTO test (name) VALUES (?)');
    insert.run('Alice');
    insert.run('Bob');
    
    const rows = db.prepare('SELECT * FROM test').all();
    expect(rows.length).toBe(2);
    
    db.close();
  });
});
