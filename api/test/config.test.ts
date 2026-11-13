import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError, readConfig } from '../src/config';

const base = { DATABASE_URL: 'postgresql://user@db.example/mindmap' };

test('proxy trust is explicit: off by default, true only behind a trusted reverse proxy, never loosely parsed', () => {
  assert.equal(readConfig(base).trustProxy, false);
  assert.equal(readConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(readConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy, true);
  for (const invalid of ['1', 'yes', 'TRUE', '10.0.0.0/8', '']) {
    assert.throws(() => readConfig({ ...base, TRUST_PROXY: invalid }), (error: unknown) =>
      error instanceof ConfigurationError && error.field === 'TRUST_PROXY');
  }
});
