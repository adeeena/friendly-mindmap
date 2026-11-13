import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`provision-bucket: ${name} is required (set it in containers/.env)`);
    process.exit(2);
  }
  return value;
};

const bucket = required('S3_BUCKET');
const client = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: process.env['S3_REGION'] || 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: required('S3_ACCESS_KEY'), secretAccessKey: required('S3_SECRET_KEY') },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

async function exists() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false;
    throw error;
  }
}

try {
  if (!(await exists())) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error?.name)) throw error;
    }
  }
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log('provision-bucket: bucket ready');
} catch (error) {
  console.error(`provision-bucket: failed (${error?.name ?? 'Error'}); check object-storage credentials and connectivity`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
