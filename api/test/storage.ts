import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { ObjectStorage } from '../src/object-storage';

const exec = promisify(execFile);
export const STORAGE_IMAGE = 'rustfs/rustfs@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2';

export async function isolatedStorage(): Promise<{ storage: ObjectStorage; close: () => Promise<void> }> {
  const name = `friendly-mindmap-test-storage-${randomUUID()}`;
  const accessKey = randomBytes(12).toString('hex');
  const secretKey = randomBytes(32).toString('hex');
  await exec('docker', [
    'run', '--rm', '--detach', '--name', name, '--publish', '127.0.0.1::9000',
    '--volume', '/data', '--env', 'RUSTFS_ACCESS_KEY', '--env', 'RUSTFS_SECRET_KEY',
    '--env', 'RUSTFS_CONSOLE_ENABLE=false', '--env', 'RUSTFS_OBS_LOGGER_LEVEL=error',
    STORAGE_IMAGE, '/data',
  ], {
    env: { ...process.env, RUSTFS_ACCESS_KEY: accessKey, RUSTFS_SECRET_KEY: secretKey }, timeout: 180_000,
  });
  let storage: ObjectStorage | undefined;
  try {
    const { stdout } = await exec('docker', ['port', name, '9000/tcp']);
    const port = stdout.trim().split(':').at(-1);
    if (!port || !/^\d+$/.test(port)) throw new Error('Test object-storage port was not assigned');
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`Storage health returned ${response.status}`);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await setTimeout(200);
      }
    }
    storage = new ObjectStorage({
      endpoint, accessKeyId: accessKey, secretAccessKey: secretKey,
      region: 'us-east-1', bucket: `test-${randomUUID()}`,
    });
    await storage.client.send(new CreateBucketCommand({ Bucket: storage.config.bucket }));
    await storage.ready();
    const instance = storage;
    return {
      storage: instance,
      close: async () => {
        instance.client.destroy();
        await exec('docker', ['stop', name], { timeout: 30_000 });
      },
    };
  } catch (error) {
    storage?.client.destroy();
    await exec('docker', ['stop', name], { timeout: 30_000 });
    throw error;
  }
}
