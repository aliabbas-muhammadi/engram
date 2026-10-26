import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
