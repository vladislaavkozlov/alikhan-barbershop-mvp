import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

export const MEDIA_ROOT = process.env.STAFF_MEDIA_ROOT || '/data/staff-media';
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_PORTFOLIO_ITEMS = 20;
export const newMediaKey = () => `${randomBytes(18).toString('hex')}.webp`;
export async function processImage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_MEDIA_BYTES) throw new Error('invalid_media');
  try { return await sharp(raw, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer(); }
  catch { throw new Error('invalid_media'); }
}
export async function saveProcessedImage(raw) { const output = await processImage(raw); const key = newMediaKey(); await mkdir(MEDIA_ROOT, { recursive: true }); await writeFile(join(MEDIA_ROOT, key), output, { flag: 'wx' }); return { key, bytes: output.length }; }
export async function removeStoredImage(key) { try { await unlink(join(MEDIA_ROOT, key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
