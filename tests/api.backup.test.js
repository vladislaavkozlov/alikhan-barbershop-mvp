// Своя резервная копия боевой базы (24.08.2026, plans/2026-08-24-backup-prod.md).
//
// База Amvera недоступна снаружи, поэтому копию снимает само приложение. Роут
// отдаёт ВСЮ базу целиком, включая телефоны клиентов, - поэтому здесь проверяется
// не столько формат, сколько замки на нём.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { backupAllowed, BACKUP_TABLES } from '../api/routes/backup.js';

test('роут выключен, пока не задан секрет - как поток событий', () => {
  assert.equal(backupAllowed({ role: 'owner' }, 'что-угодно', undefined), false);
  assert.equal(backupAllowed({ role: 'owner' }, 'что-угодно', ''), false);
});

test('одной роли владельца мало - нужен ещё секрет', () => {
  assert.equal(backupAllowed({ role: 'owner' }, null, 'секрет'), false);
  assert.equal(backupAllowed({ role: 'owner' }, 'не-тот-секрет', 'секрет'), false);
  assert.equal(backupAllowed({ role: 'owner' }, 'секрет', 'секрет'), true);
});

test('одного секрета тоже мало - нужна роль владельца', () => {
  for (const role of ['manager', 'admin', 'master', undefined]) {
    assert.equal(backupAllowed({ role }, 'секрет', 'секрет'), false, `${role} не должен снимать копию`);
  }
  assert.equal(backupAllowed(null, 'секрет', 'секрет'), false, 'аноним тем более');
});

test('секрет сравнивается целиком, а не по началу строки', () => {
  assert.equal(backupAllowed({ role: 'owner' }, 'секрет-длиннее', 'секрет'), false);
  assert.equal(backupAllowed({ role: 'owner' }, 'сек', 'секрет'), false);
});

test('в копию входят все таблицы данных плюс справочник, но НЕ живые сессии', async () => {
  const schemaSql = await readFile(new URL('../api/migrations/057_tenants.sql', import.meta.url), 'utf8');
  const dataTables = [...schemaSql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN IF NOT EXISTS tenant_id/gi)]
    .map((m) => m[1])
    .sort();
  // Справочник арендаторов обязателен: без него восстановленная база не примет ни
  // одной строки - внешний ключ не на что положить
  const expected = [...dataTables.filter((t) => t !== 'sessions'), 'tenants'].sort();
  assert.deepEqual([...BACKUP_TABLES].sort(), expected);
  // Токены доступа в кабинеты не должны лежать в файле на диске
  assert.ok(!BACKUP_TABLES.includes('sessions'), 'живые сессии в копию не выгружаем');
});

test('копия снимается в служебном контексте - иначе замок скроет чужих арендаторов', async () => {
  const src = await readFile(new URL('../api/routes/backup.js', import.meta.url), 'utf8');
  assert.match(src, /SYSTEM_TENANT/, 'иначе в копию попадёт только один арендатор');
  assert.doesNotMatch(src, /DEFAULT_TENANT_ID/);
});

test('секрет не утекает в ответ и в лог', async () => {
  const src = await readFile(new URL('../api/routes/backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /console\.log\([^)]*token/i);
  assert.doesNotMatch(src, /BACKUP_TOKEN[^\n]*sendJson/i);
});

test('реестр роутов знает про /backup и требует владельца', async () => {
  const server = await readFile(new URL('../api/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /\{ method: 'GET', path: 'backup', auth: 'owner' \}/);
});
