import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, open, chmod, rm } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

/** SQLite's backup API takes a consistent snapshot, including committed WAL data. */
export async function backupDatabase(source, destination) {
  if (!isAbsolute(source) || !isAbsolute(destination) || ['', '-wal', '-shm', '-journal'].some(suffix => resolve(source) + suffix === resolve(destination))) throw new Error('Use distinct absolute source and backup paths outside the live SQLite sidecars.');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const reserved = await open(destination, 'wx', 0o600); await reserved.close();
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    await backup(db, destination);
    await chmod(destination, 0o600);
  } catch (error) { await rm(destination, { force: true }); throw error; }
  finally { db?.close(); }
}

if (import.meta.main) {
  try {
    if (!process.env.DATABASE_PATH || !process.argv[2]) throw new Error('Missing backup paths');
    await backupDatabase(process.env.DATABASE_PATH, resolve(process.argv[2]));
    console.log('SQLite backup completed.');
  } catch { console.error('Backup failed; check source, destination and permissions. Existing backups are never overwritten.'); process.exitCode = 1; }
}
