import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListPartsCommand, ListMultipartUploadsCommand,
  S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ConfigurationError } from './config';

export function storageMissing(error: unknown): boolean {
  return error instanceof Error && ['NotFound', 'NoSuchKey', 'NoSuchUpload'].includes(error.name);
}

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function readStorageConfig(environment: NodeJS.ProcessEnv = process.env): StorageConfig {
  const required = (key: string) => {
    const value = environment[key];
    if (!value) throw new ConfigurationError(key, 'is required');
    return value;
  };
  const endpoint = required('S3_ENDPOINT');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ConfigurationError('S3_ENDPOINT', 'must be an HTTP(S) URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new ConfigurationError('S3_ENDPOINT', 'must be an HTTP(S) URL without embedded credentials');
  }
  return {
    endpoint, region: environment['S3_REGION'] || 'us-east-1',
    accessKeyId: required('S3_ACCESS_KEY'), secretAccessKey: required('S3_SECRET_KEY'), bucket: required('S3_BUCKET'),
  };
}

export class ObjectStorage {
  readonly client: S3Client;

  constructor(readonly config: StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async ready(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }

  async download(key: string) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!(object.Body instanceof Readable)) throw new Error('Object storage returned no readable body');
    return { body: object.Body, size: object.ContentLength, etag: object.ETag };
  }

  async begin(key: string): Promise<string> {
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.config.bucket, Key: key, ContentType: 'application/octet-stream',
    }));
    if (!result.UploadId) throw new Error('Object storage did not provide an upload identifier');
    return result.UploadId;
  }

  async part(key: string, uploadId: string, partNumber: number, size: number, body: Readable, signal?: AbortSignal): Promise<string> {
    const result = await this.client.send(new UploadPartCommand({
      Bucket: this.config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size, Body: body,
    }), { abortSignal: signal });
    if (!result.ETag) throw new Error('Object storage did not acknowledge the upload part');
    return result.ETag;
  }

  async parts(key: string, uploadId: string) {
    const parts: { number: number; etag: string; size: number }[] = [];
    let marker: string | undefined;
    do {
      const result = await this.client.send(new ListPartsCommand({
        Bucket: this.config.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker,
      }));
      for (const part of result.Parts ?? []) {
        if (part.PartNumber === undefined || !part.ETag || part.Size === undefined) throw new Error('Incomplete storage part metadata');
        parts.push({ number: part.PartNumber, etag: part.ETag, size: part.Size });
      }
      marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
      if (result.IsTruncated && !marker) throw new Error('Storage part pagination did not advance');
    } while (marker);
    return parts;
  }

  async complete(key: string, uploadId: string, parts: readonly { number: number; etag: string }[]): Promise<void> {
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.number, ETag: part.etag })) },
    }));
  }

  async head(key: string): Promise<number> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (result.ContentLength === undefined) throw new Error('Object storage did not provide object size');
    return result.ContentLength;
  }

  async abort(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.config.bucket, Key: key, UploadId: uploadId }));
    } catch (error) {
      if (!storageMissing(error)) throw error;
    }
  }

  async *uploads() {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      const result = await this.client.send(new ListMultipartUploadsCommand({
        Bucket: this.config.bucket, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker, MaxUploads: 1000,
      }));
      for (const upload of result.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId || !upload.Initiated) throw new Error('Incomplete storage upload metadata');
        yield { key: upload.Key, id: upload.UploadId, createdAt: upload.Initiated };
      }
      if (!result.IsTruncated) break;
      if (!result.NextKeyMarker || (result.NextKeyMarker === keyMarker && result.NextUploadIdMarker === uploadIdMarker)) {
        throw new Error('Storage upload pagination did not advance');
      }
      keyMarker = result.NextKeyMarker;
      uploadIdMarker = result.NextUploadIdMarker;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
