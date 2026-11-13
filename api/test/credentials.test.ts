import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Credentials, hashPassword, normalizeUsername } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';

test('Argon2 credentials normalize usernames, hide failures and persist throttling', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  try {
    await migrate(database.pool, await readMigrations());
    const password = randomBytes(16).toString('hex');
    const encoded = await hashPassword(password);
    assert.match(encoded, /^\$argon2id\$/);
    assert(!encoded.includes(password));
    await database.pool.query(
      'INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), 'adena', 'Adena', encoded, 'admin'],
    );
    assert.equal(normalizeUsername('  ＡDENA '), 'adena');
    const credentials = new Credentials(database.pool);
    const account = await credentials.authenticate(' ADENA ', password, '127.0.0.1');
    assert.equal(account.role, 'admin');
    assert(!('password_hash' in account));
    for (const [username, candidate] of [['adena', 'wrong'], ['missing', 'wrong']]) {
      await assert.rejects(credentials.authenticate(username, candidate, '127.0.0.1'), {
        code: 'INVALID_CREDENTIALS', status: 401, message: 'Invalid username or password.',
      });
    }
    await database.pool.query('UPDATE users SET disabled_at=now() WHERE username=$1', ['adena']);
    await assert.rejects(credentials.authenticate('adena', password, '127.0.0.1'), { code: 'INVALID_CREDENTIALS' });
    await database.pool.query('UPDATE users SET disabled_at=NULL WHERE username=$1', ['adena']);
    for (let n = 0; n < 7; n++) {
      await assert.rejects(credentials.authenticate('adena', 'wrong', '127.0.0.1'), { code: 'INVALID_CREDENTIALS' });
    }
    const restarted = new Credentials(database.pool);
    await assert.rejects(restarted.authenticate('adena', password, 'another-ip'), { status: 429, code: 'LOGIN_THROTTLED' });
    await database.pool.query("UPDATE login_attempts SET window_started_at=now()-interval '16 minutes'");
    assert.equal((await restarted.authenticate('adena', password, '127.0.0.1')).username, 'adena');
  } finally {
    await database.close();
  }
});
