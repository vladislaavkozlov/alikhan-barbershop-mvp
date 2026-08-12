import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Amvera монтирует постоянное хранилище туда же, куда пишет staff media', async () => {
  const root = new URL('../', import.meta.url);
  const [config, media] = await Promise.all([
    readFile(new URL('api/amvera.yaml', root), 'utf8'),
    readFile(new URL('api/lib/staff-media.js', root), 'utf8'),
  ]);
  assert.match(config, /persistenceMount:\s*\/data/);
  assert.match(media, /STAFF_MEDIA_ROOT \|\| '\/data\/staff-media'/);
});
