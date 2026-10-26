import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryStore, SCHEMA_VERSION } from '../src/store.ts';

for (const keepAudit of [true, false]) {
  test(`schema upgrades repair early supersession ${keepAudit ? 'from audit history' : 'without audit history'}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'engram-scheduled-migration-'));
    const dbPath = join(directory, 'memory.sqlite');
    let store = new MemoryStore({ dbPath });
    try {
      store.init();
      const input = { kind: 'fact' as const, subjectKey: 'runtime', confidence: 1 };
      const first = store.insertFact({ ...input, text: 'runtime one', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z' });
      const second = store.insertFact({ ...input, text: 'runtime two', validFrom: '2026-01-10T00:00:00Z', writtenAt: '2026-01-02T00:00:00Z' });
      const third = store.insertFact({ ...input, text: 'runtime three', validFrom: '2026-01-20T00:00:00Z', writtenAt: '2026-01-03T00:00:00Z' });
      const db = store.rawConnection();
      db.prepare('UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?')
        .run(keepAudit ? third.id : second.id, '2026-01-03T00:00:00.000Z', first.id);
      db.prepare('UPDATE memories SET superseded_at = ? WHERE id = ?')
        .run('2026-01-03T00:00:00.000Z', second.id);
      if (!keepAudit) db.exec('DELETE FROM resolutions');
      db.exec('PRAGMA user_version = 2');
      assert.deepEqual(store.queryFacts('runtime', '2026-01-05T00:00:00Z'), []);
      store.close();

      store = new MemoryStore({ dbPath });
      store.init();
      assert.equal(store.rawConnection().prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
      assert.deepEqual(store.queryFacts('runtime', '2026-01-05T00:00:00Z').map(({ text }) => text), ['runtime one']);
      assert.deepEqual(store.queryFacts('runtime', '2026-01-15T00:00:00Z').map(({ text }) => text), ['runtime two']);
      assert.deepEqual(store.queryFacts('runtime', '2026-01-25T00:00:00Z').map(({ text }) => text), ['runtime three']);
      assert.equal(store.getAllFactsForSubject('runtime').find(({ id }) => id === first.id)?.supersededBy, second.id);
      const before = store.getAllFactsForSubject('runtime');
      store.init();
      assert.deepEqual(store.getAllFactsForSubject('runtime'), before);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a failed schema upgrade rolls back repaired rows and can be retried', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const input = { kind: 'fact' as const, subjectKey: 'runtime', confidence: 1 };
    const first = store.insertFact({ ...input, text: 'runtime one', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z' });
    const second = store.insertFact({ ...input, text: 'runtime two', validFrom: '2026-01-10T00:00:00Z', writtenAt: '2026-01-02T00:00:00Z' });
    store.insertFact({ ...input, text: 'runtime three', validFrom: '2026-01-20T00:00:00Z', writtenAt: '2026-01-03T00:00:00Z' });
    const db = store.rawConnection();
    db.exec("UPDATE memories SET superseded_at = '2026-01-03T00:00:00.000Z' WHERE status = 'superseded'; PRAGMA user_version = 2;");
    db.prepare('DELETE FROM resolutions WHERE existing_id = ?').run(second.id);
    db.exec("CREATE TRIGGER fail_upgrade BEFORE UPDATE OF superseded_at ON memories WHEN OLD.text = 'runtime two' BEGIN SELECT RAISE(ABORT, 'upgrade blocked'); END;");
    assert.throws(() => store.init(), /upgrade blocked/);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(store.getAllFactsForSubject('runtime').find(({ id }) => id === first.id)?.supersededAt, '2026-01-03T00:00:00.000Z');
    db.exec('DROP TRIGGER fail_upgrade');
    store.init();
    assert.deepEqual(store.queryFacts('runtime', '2026-01-05T00:00:00Z').map(({ text }) => text), ['runtime one']);
  } finally {
    store.close();
  }
});
