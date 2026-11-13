import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStorageConfig } from '../src/object-storage';

test('object storage requires server-side configuration without embedding credentials in URLs', () => {
  assert.throws(() => readStorageConfig({}), /S3_ENDPOINT: is required/);
  assert.throws(() => readStorageConfig({ S3_ENDPOINT: 'not-an-endpoint' }), /must be an HTTP/);
  assert.throws(() => readStorageConfig({ S3_ENDPOINT: 'http://user:secret@localhost' }), /without embedded credentials/);
  assert.throws(() => readStorageConfig({ S3_ENDPOINT: 'http://localhost:9000' }), /S3_ACCESS_KEY: is required/);
});
