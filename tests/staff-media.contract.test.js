import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_MEDIA_BYTES, newMediaKey, processImage } from '../api/lib/staff-media.js';

test('медиа-ключ не раскрывает исходное имя и имеет безопасное webp-расширение', () => {
  assert.match(newMediaKey(), /^[a-f0-9]{36}\.webp$/);
});

test('файл больше 8 МБ отклоняется до обработки с точным кодом', async () => {
  await assert.rejects(processImage(Buffer.alloc(MAX_MEDIA_BYTES + 1)), (error) => error.code === 'payload_too_large');
});
