import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';
import { transaction } from './database';

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(directory = path.resolve(__dirname, '../../../migrations')): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No database migrations found');
  return Promise.all(files.map(async (version) => {
    const sql = await readFile(path.join(directory, version), 'utf8');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function migrate(pool: Pool, migrations: readonly Migration[]): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(6610, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    for (const row of applied.rows) {
      if (!migrations.some((m) => m.version === row.version && m.checksum === row.checksum)) {
        throw new Error(`Unknown or modified migration: ${row.version}`);
      }
    }
    for (const migration of migrations) {
      if (applied.rows.some((row) => row.version === migration.version)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
    }
  });
}

export async function assertSchemaReady(client: PoolClient, migrations: readonly Migration[]): Promise<void> {
  const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
  if (rows.length !== migrations.length || migrations.some((m) =>
    !rows.some((row) => row.version === m.version && row.checksum === m.checksum))) {
    throw new Error('Database schema is not current; run npm run migrate');
  }
}
