import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MemoryStore, SCHEMA_VERSION } from '../src/store.ts';

test('rejecting a newer schema leaves its database bytes unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'engram-future-schema-'));
  const dbPath = join(directory, 'memory.sqlite');
  try {
    const future = new DatabaseSync(dbPath);
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}; CREATE TABLE future_data (payload TEXT); INSERT INTO future_data VALUES ('keep');`);
    future.close();
    const original = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    const store = new MemoryStore({ dbPath });
    try {
      assert.throws(() => store.init(), /newer than this engram/);
    } finally {
      store.close();
    }
    assert.equal(createHash('sha256').update(readFileSync(dbPath)).digest('hex'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejecting a newer WAL database does not checkpoint its committed writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'engram-future-wal-'));
  const dbPath = join(directory, 'memory.sqlite');
  try {
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA user_version = ${SCHEMA_VERSION + 1}; CREATE TABLE future_data (payload TEXT); INSERT INTO future_data VALUES ('keep');");
      process.exit(0);
    `, dbPath], { encoding: 'utf8' });
    assert.equal(writer.status, 0, writer.stderr);
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const original = [hash(dbPath), hash(`${dbPath}-wal`)];
    const store = new MemoryStore({ dbPath });
    try {
      assert.throws(() => store.init(), /newer than this engram/);
    } finally {
      store.close();
    }
    assert.deepEqual([hash(dbPath), hash(`${dbPath}-wal`)], original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
