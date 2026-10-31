import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Synchronous SQLite statements retain the atomic CAS/RETURNING semantics of D1. */
export class SqliteD1 {
  constructor(filename, { migrationsDir } = {}) {
    if (typeof filename !== 'string' || !filename || !migrationsDir) throw new TypeError('A database path and migration directory are required.');
    const memory = filename === ':memory:';
    if (!memory) {
      mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
      if (existsSync(filename)) chmodSync(filename, 0o600);
    }
    this.database = new DatabaseSync(filename);
    this.closed = false;
    try {
      if (!memory) chmodSync(filename, 0o600);
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      this.migrate(migrationsDir);
    } catch (error) { this.database.close(); this.closed = true; throw error; }
  }

  // Run once, before listening. A migration and its checksum commit together.
  migrate(directory) {
    const files = readdirSync(directory).filter(name => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
    if (!files.length) throw new Error('No SQLite migrations found.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('CREATE TABLE IF NOT EXISTS _teamlink_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
      const applied = this.database.prepare('SELECT name, sha256 FROM _teamlink_migrations ORDER BY name').all();
      const byName = new Map(applied.map(item => [item.name, item.sha256]));
      if (applied.some(item => !files.includes(item.name))) throw new Error('An applied migration is missing from this release.');
      let hasPending = false;
      for (const name of files) {
        const sql = readFileSync(resolve(directory, name), 'utf8');
        const digest = createHash('sha256').update(sql).digest('hex');
        if (byName.has(name)) {
          if (hasPending || byName.get(name) !== digest) throw new Error('Applied migration history changed; restore the matching release.');
          continue;
        }
        hasPending = true;
        this.database.exec(sql);
        this.database.prepare('INSERT INTO _teamlink_migrations(name, sha256, applied_at) VALUES (?, ?, ?)').run(name, digest, Date.now());
      }
      if (!this.ready()) throw new Error('Room schema is incomplete.');
      this.database.exec('COMMIT');
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    const bound = parameters => Object.freeze({
      first: async (column) => {
        const row = statement.get(...parameters) ?? null;
        return column === undefined || row === null ? row : row[column] ?? null;
      },
      run: async () => {
        const result = statement.run(...parameters);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      all: async () => ({ success: true, results: statement.all(...parameters) }),
    });
    return Object.freeze({ ...bound([]), bind: (...parameters) => bound(parameters) });
  }

  ready() {
    if (this.closed) return false;
    try {
      return this.database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('rooms', 'ai_usage', '_teamlink_migrations')").get().count === 3 &&
        this.database.prepare('SELECT 1 AS ok').get().ok === 1;
    } catch { return false; }
  }

  close() {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }
}
