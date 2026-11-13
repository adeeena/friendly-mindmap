import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { migrate, readMigrations } from '../src/migrations';
import { transaction } from '../src/database';
import { isolatedPostgres } from './postgres';

test('migrations are repeatable, constrained, locked and transactional on real PostgreSQL', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  try {
    const migrations = await readMigrations();
    await Promise.all([migrate(database.pool, migrations), migrate(database.pool, migrations)]);
    await migrate(database.pool, migrations);
    const applied = await database.pool.query('SELECT version FROM schema_migrations');
    assert.equal(applied.rowCount, migrations.length);
    const tables = await database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const name of ['users', 'sessions', 'boards', 'board_history', 'board_attachments',
      'board_attachment_refs', 'board_history_attachments', 'attachment_uploads', 'mutation_receipts']) {
      assert(tables.rows.some((row) => row.tablename === name), `Missing table ${name}`);
    }
    const id = randomUUID();
    await database.pool.query(
      'INSERT INTO users(id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [id, 'basic', 'Basic', 'test-hash'],
    );
    await assert.rejects(database.pool.query("UPDATE users SET role = 'superuser' WHERE id = $1", [id]), { code: '23514' });
    await assert.rejects(database.pool.query(
      'INSERT INTO sessions(id, user_id, token_hash, csrf_hash, idle_expires_at, expires_at) VALUES ($1,$2,$3,$4,now(),now()+interval \'1 day\')',
      [randomUUID(), randomUUID(), 'token-hash', 'csrf-hash'],
    ), { code: '23503' });
    await assert.rejects(transaction(database.pool, async (client) => {
      await client.query("UPDATE users SET display_name = 'Changed' WHERE id = $1", [id]);
      throw new Error('Expected rollback');
    }), /Expected rollback/);
    assert.equal((await database.pool.query('SELECT display_name FROM users WHERE id=$1', [id])).rows[0]?.['display_name'], 'Basic');
    const first = migrations[0];
    assert(first);
    await assert.rejects(migrate(database.pool, [{ ...first, checksum: 'tampered' }]), /Unknown or modified migration/);
    await assert.rejects(migrate(database.pool, [...migrations, { version: '999_broken.sql', checksum: 'broken', sql: 'INVALID SQL' }]));
    assert.equal((await database.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0]?.['count'], migrations.length);
  } finally {
    await database.close();
  }
});
