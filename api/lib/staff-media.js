import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

export const MEDIA_ROOT = process.env.STAFF_MEDIA_ROOT || '/data/staff-media';
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_PORTFOLIO_ITEMS = 20;
export const newMediaKey = () => `${randomBytes(18).toString('hex')}.webp`;
function mediaError(code) { const error = new Error(code); error.code = code; return error; }
export async function processImage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) throw mediaError('invalid_image');
  if (raw.length > MAX_MEDIA_BYTES) throw mediaError('payload_too_large');
  try { return await sharp(raw, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer(); }
  catch { throw mediaError('invalid_image'); }
}
export async function saveProcessedImage(raw) { const output = await processImage(raw); const key = newMediaKey(); await mkdir(MEDIA_ROOT, { recursive: true }); await writeFile(join(MEDIA_ROOT, key), output, { flag: 'wx' }); return { key, bytes: output.length }; }
export async function removeStoredImage(key) { try { await unlink(join(MEDIA_ROOT, key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
