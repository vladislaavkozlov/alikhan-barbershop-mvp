import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('публичный контракт мастеров фильтрует незавершённые профили и не выбирает закрытые поля', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/public-masters.js', root), 'utf8');
  for (const condition of ['s.employed=true', 's.provides_services=true', 's.public_profile_enabled=true', 'master_services', 'master_weekly_schedule']) assert.match(source, new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /pin_hash|has_system_access|s\.phone|s\.email|s\.role/);
});

test('список сотрудников отдаёт CRM только собственные метаданные медиа для превью и управления', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/staff.js', root), 'utf8');
  assert.match(source, /staff_media/);
  assert.match(source, /portfolio/);
  assert.match(source, /storage_key/);
});
