import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const root = new URL('../', import.meta.url);
test('команда строится из API плоскими секциями и завершается добавлением сотрудника', async () => {
  const js = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  for (const label of ['Основное','Профиль на сайте','Услуги и время','График','Доступ']) assert.match(js, new RegExp(label));
  assert.match(js, /fetchJson\('\/staff'\)/);
  assert.match(js, /addCard\(\)/);
  assert.match(js, /renderMasterServiceEditor/);
  assert.match(js, /wireWeeklyScheduleEditor/);
  assert.doesNotMatch(js, /beforeAfterUrls/);
});
