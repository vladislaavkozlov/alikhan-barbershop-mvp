import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildPublicMasters } from '../api/routes/public-masters.js';

const masterRow = (over = {}) => ({
  id: 'm1', name: 'Мастер', photo_url: null, experience_text: '10 лет', strengths_text: 'фейды',
  certificates_text: 'курс 2024', public_profile_enabled: true, media_id: null, kind: null,
  storage_key: null, sort_order: 0, ...over,
});

test('публичный контракт мастеров фильтрует незавершённые профили и не выбирает закрытые поля', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/public-masters.js', root), 'utf8');
  for (const condition of ['s.employed=true', 's.provides_services=true', 'master_services', 'master_weekly_schedule']) assert.match(source, new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /pin_hash|has_system_access|s\.phone|s\.email|s\.role/);
});

// Регрессия 13.08.2026: до фикса это условие стояло в WHERE и выключенный тумблер
// убирал мастера из публичной записи целиком (сайт остался без мастеров и услуг).
test('тумблер профиля не участвует в отборе мастеров - запись от него не зависит', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/public-masters.js', root), 'utf8');
  assert.doesNotMatch(source, /WHERE[\s\S]*public_profile_enabled\s*=\s*true/);
});

test('мастер с выключенным профилем остаётся доступным для записи, но без витрины', () => {
  const [master] = buildPublicMasters(
    [masterRow({ public_profile_enabled: false, media_id: 'p1', kind: 'portfolio', storage_key: 'k1' })],
    [{ master_id: 'm1', id: 'strizhka', name: 'Стрижка', price: 2000, duration_min: 60 }],
  );
  assert.equal(master.id, 'm1');
  assert.equal(master.services.length, 1);
  assert.equal(master.publicProfileEnabled, false);
  assert.equal(master.experienceText, null);
  assert.equal(master.strengthsText, null);
  assert.equal(master.certificatesText, null);
  assert.deepEqual(master.portfolio, []);
});

test('мастер с включённым профилем отдаёт стаж, сильные стороны, сертификаты и работы', () => {
  const [master] = buildPublicMasters([masterRow({ media_id: 'p1', kind: 'portfolio', storage_key: 'k1' })]);
  assert.equal(master.publicProfileEnabled, true);
  assert.equal(master.experienceText, '10 лет');
  assert.equal(master.strengthsText, 'фейды');
  assert.equal(master.certificatesText, 'курс 2024');
  assert.deepEqual(master.portfolio, [{ id: 'p1', url: '/media/k1' }]);
});

test('аватар показывается независимо от тумблера - это лицо мастера в списке выбора', () => {
  const [master] = buildPublicMasters([masterRow({ public_profile_enabled: false, media_id: 'a1', kind: 'avatar', storage_key: 'ava' })]);
  assert.equal(master.photoUrl, '/media/ava');
});

test('список сотрудников отдаёт CRM только собственные метаданные медиа для превью и управления', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/staff.js', root), 'utf8');
  assert.match(source, /staff_media/);
  assert.match(source, /portfolio/);
  assert.match(source, /storage_key/);
});
