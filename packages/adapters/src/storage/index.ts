// packages/adapters/src/storage/index.ts
// Evidence and KYC object storage. Every write is a short-lived presigned PUT for a key the
// server chose (domain/text/sanitize.ts builds them); every read is a short-lived presigned
// GET. The API never proxies image bytes in production.
//
// `local` stores files under a directory and signs URLs that the API's /uploads route
// verifies. It exists so the whole system runs on a laptop; config refuses it in production.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedPut { url: string; headers: Record<string, string>; expiresIn: number }

export interface StoragePort {
  presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedPut>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}

// ─────────────────────────────────────────────── local

export class LocalStorage implements StoragePort {
  private readonly root: string;
  constructor(root: string, private readonly publicOrigin: string, private readonly secret: string) {
    this.root = resolve(root);
  }

  private sign(method: 'PUT' | 'GET', key: string, exp: number, contentType = ''): string {
    return createHmac('sha256', this.secret).update(`${method}\n${key}\n${exp}\n${contentType}`).digest('base64url');
  }

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedPut> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.sign('PUT', key, exp, contentType);
    return {
      url: `${this.publicOrigin}/uploads/${key}?exp=${exp}&sig=${sig}`,
      headers: { 'content-type': contentType },
      expiresIn: ttlSeconds,
    };
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.publicOrigin}/uploads/${key}?exp=${exp}&sig=${this.sign('GET', key, exp)}`;
  }

  /** Called by the API's /uploads route. Returns false for an expired or forged URL. */
  verify(method: 'PUT' | 'GET', key: string, exp: number, sig: string, contentType = ''): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const want = Buffer.from(this.sign(method, key, exp, contentType));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private pathFor(key: string): string {
    const p = resolve(join(this.root, key));
    // Keys are server-built, but the path check stays: a key is a path on this driver.
    if (!p.startsWith(this.root + sep)) throw new Error('Object key escapes the storage root');
    return p;
  }

  async write(key: string, body: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async read(key: string): Promise<Buffer | null> {
    try { return await readFile(this.pathFor(key)); } catch { return null; }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.read(key)) !== null;
  }
}

// ─────────────────────────────────────────────── R2 (S3-compatible)

export class R2Storage implements StoragePort {
  private readonly client: S3Client;
  constructor(private readonly cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedPut> {
    const url = await getSignedUrl(this.client,
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds });
    return { url, headers: { 'content-type': contentType }, expiresIn: ttlSeconds };
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}
