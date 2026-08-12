import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
test('каталог и услуги мастера имеют стабильный серверный порядок', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/services.js', root), 'utf8');
  assert.match(source, /services ORDER BY name, id/);
  assert.match(source, /master_services ORDER BY master_id, service_id/);
});
