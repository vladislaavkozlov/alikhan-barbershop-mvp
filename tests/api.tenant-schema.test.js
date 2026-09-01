// Фаза 2 мультиарендности (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
// Схема: справочник арендаторов и признак принадлежности во ВСЕХ таблицах данных.
//
// Здесь проверяется текст миграции, а не живая база: офлайн-набор Postgres не
// поднимает. Живая репетиция (счётчики строк до и после, изоляция ключей) - в
// tools/verify-2026-08-24-tenant-schema.mjs, она обязательна к прогону вместе с этим
// файлом.
//
// Главный тест файла - последний: список таблиц берётся не из головы, а вычисляется
// из всех предыдущих миграций. Забытая таблица (риск из плана) ловится списком, а не
// глазами, и поймается так же, когда её заведёт будущая миграция.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const MIGRATIONS = new URL('../api/migrations/', import.meta.url);
const migrationSql = await readFile(new URL('057_tenants.sql', MIGRATIONS), 'utf8');

// Таблицы данных: у каждой появляется признак арендатора. schema_migrations -
// служебная (история накатывания схемы, общая на всю установку), tenants - сам
// справочник, признак принадлежности им не нужен.
// tenant_channels (миграция 062) добавлен к служебным осознанно: это конфигурация
// каналов, а не данные клиентов. Он обязан читаться ДО того, как арендатор известен -
// именно по нему входящее обновление от бота сопоставляется с заведением.
const SERVICE_TABLES = ['schema_migrations', 'tenants', 'tenant_channels'];

async function tablesCreatedByMigrations() {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const created = new Set();
  for (const file of files) {
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) created.add(m[1]);
    for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_]+)/gi)) created.delete(m[1]);
  }
  return [...created].filter((t) => !SERVICE_TABLES.includes(t)).sort();
}

test('справочник арендаторов заведён, барбершоп Алихана - арендатор №1', () => {
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS tenants/);
  assert.match(migrationSql, /INSERT INTO tenants \(id, name/);
  assert.match(migrationSql, /VALUES \(1,/, 'Алихан получает номер 1 явно, а не по счётчику');
  assert.match(migrationSql, /setval/, 'счётчик справочника сдвинут - следующий арендатор получит 2');
  assert.match(migrationSql, /domains/, 'домены арендатора - в справочнике (Фаза 4)');
  assert.match(migrationSql, /vertical/, 'вертикаль - в справочнике (Этап B)');
  assert.match(migrationSql, /status/);
});

test('существующие строки достаются Алихану автоматически', () => {
  assert.match(
    migrationSql,
    /ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants\(id\)/,
    'колонка добавляется с дефолтом 1 - боевые строки переезжают без UPDATE и без простоя на переливку'
  );
});

test('после переезда дефолт колонки - арендатор запроса, а не единица', () => {
  assert.match(
    migrationSql,
    /ALTER COLUMN tenant_id SET DEFAULT current_setting\('app\.tenant_id'\)::int/,
    'иначе строки второго арендатора молча уезжали бы Алихану'
  );
  assert.doesNotMatch(
    migrationSql,
    /current_setting\('app\.tenant_id', true\)::int/,
    'без контекста запроса вставка обязана падать, а не подставлять пустоту'
  );
  const setDefault = migrationSql.indexOf("SET DEFAULT current_setting");
  const addColumn = migrationSql.indexOf('ADD COLUMN IF NOT EXISTS tenant_id');
  assert.ok(addColumn < setDefault, 'сначала переезд на единицу, только потом дефолт из контекста');
  // Проверять «где-то есть такая строка» мало: пропущенная таблица молча осталась бы
  // с дефолтом 1, и строки второго арендатора уезжали бы Алихану именно в ней
  const added = [...migrationSql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN IF NOT EXISTS tenant_id/gi)]
    .map((m) => m[1])
    .sort();
  const redefaulted = [
    ...migrationSql.matchAll(/ALTER TABLE ([a-z_]+) ALTER COLUMN tenant_id SET DEFAULT current_setting/gi),
  ]
    .map((m) => m[1])
    .sort();
  assert.deepEqual(redefaulted, added, 'дефолт из контекста обязан быть у каждой таблицы с арендатором');
});

test('глобальные уникальные ключи стали составными (ловушка 5)', () => {
  const expected = [
    ['staff', /CREATE UNIQUE INDEX[^;]*staff[^;]*\(tenant_id, email\)/i],
    ['clients', /CREATE UNIQUE INDEX[^;]*clients[^;]*\(tenant_id, phone\)/i],
    ['holidays', /PRIMARY KEY \(tenant_id, date\)/i],
    ['staff protected owner', /staff_one_protected_owner_idx ON staff \(tenant_id\)\s*WHERE/i],
    ['schedule_shifts', /schedule_shifts[^;]*\(tenant_id, master_id, date\)/i],
    ['kv_store', /kv_store[^;]*PRIMARY KEY \(tenant_id, key\)/i],
    ['payroll_settings', /payroll_settings[^;]*PRIMARY KEY \(tenant_id\)/i],
    ['discount_settings', /discount_settings[^;]*PRIMARY KEY \(tenant_id\)/i],
  ];
  for (const [what, re] of expected) {
    assert.match(migrationSql, re, `${what}: ключ обязан быть составным с арендатором`);
  }
  for (const dedup of ['notifications_booking_dedup', 'notifications_schedreq_dedup', 'notifications_master_dedup']) {
    const re = new RegExp(`CREATE UNIQUE INDEX ${dedup} ON notifications \\(tenant_id, staff_id`, 'i');
    assert.match(migrationSql, re, `${dedup}: дедуп уведомлений считается внутри арендатора`);
  }
});

test('старые глобальные ключи сняты обеими формами - и как ограничение, и как индекс', () => {
  // Живая находка 24.08.2026: staff_email_key заведён ограничением таблицы, а
  // clients_phone_key - отдельным уникальным индексом. DROP CONSTRAINT на индекс
  // проходит молча, и глобальный ключ остался бы жить рядом с составным.
  for (const key of ['staff_email_key', 'clients_phone_key', 'schedule_shifts_master_id_date_key']) {
    assert.match(migrationSql, new RegExp(`DROP CONSTRAINT IF EXISTS ${key}`, 'i'), `${key}: нет снятия ограничения`);
    assert.match(migrationSql, new RegExp(`DROP INDEX IF EXISTS ${key}`, 'i'), `${key}: нет снятия индекса`);
  }
});

test('старые глобальные ключи сняты, а не оставлены рядом', () => {
  for (const dropped of [
    'staff_email_key',
    'clients_phone_key',
    'schedule_shifts_master_id_date_key',
    'notifications_booking_dedup',
    'notifications_schedreq_dedup',
    'notifications_master_dedup',
  ]) {
    assert.match(migrationSql, new RegExp(`DROP (?:INDEX|CONSTRAINT) IF EXISTS ${dropped}`, 'i'), `${dropped} не снят`);
  }
  for (const table of ['holidays', 'kv_store', 'payroll_settings', 'discount_settings']) {
    assert.match(
      migrationSql,
      new RegExp(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`, 'i'),
      `${table}: прежний первичный ключ не снят`
    );
  }
});

test('выборки идут по индексу с арендатором впереди (ловушка 6)', () => {
  // Прежние индексы этих таблиц переписываются с арендатором первой колонкой -
  // иначе замок из Фазы 3 просматривал бы чужие строки, чтобы их отбросить.
  const expected = [
    /bookings_master_date_idx ON bookings \(tenant_id, master_id, date\)/i,
    /bookings_client_history_idx ON bookings \(tenant_id, client_id, date, start_time\)/i,
    /notifications_bell_idx ON notifications \(tenant_id, staff_id, created_at DESC\)/i,
    /notifications_staff_unread_idx ON notifications \(tenant_id, staff_id, read_at, created_at DESC\)/i,
    /staff_media_staff_sort_idx ON staff_media \(tenant_id, staff_id/i,
    /schedule_change_requests_master_idx ON schedule_change_requests \(tenant_id, master_id, status\)/i,
    /schedule_change_requests_status_idx ON schedule_change_requests \(tenant_id, status, created_at\)/i,
    /staff_created_at_idx ON staff \(tenant_id, created_at, id\)/i,
  ];
  for (const re of expected) assert.match(migrationSql, re, `нет индекса с арендатором впереди: ${re}`);
  // Плюс отдельный индекс по арендатору там, где выборка идёт по всей таблице
  for (const table of ['staff', 'services', 'bookings', 'clients', 'sessions', 'locations']) {
    assert.match(
      migrationSql,
      new RegExp(`ON ${table} \\(tenant_id`, 'i'),
      `${table}: нет ни одного индекса, начинающегося с арендатора`
    );
  }
});

test('миграция - только про схему, без QA-фикстур (инцидент 04.08.2026)', () => {
  const body = migrationSql.replace(/--[^\n]*/g, '');
  const inserts = [...body.matchAll(/INSERT INTO ([a-z_]+)/gi)].map((m) => m[1]);
  assert.deepEqual(inserts, ['tenants'], 'единственная вставка миграции - строка справочника');
  assert.doesNotMatch(body, /DELETE FROM/i, 'миграция ничего не удаляет из данных');
  assert.doesNotMatch(body, /DROP TABLE/i);
});

test('ни одна таблица данных не забыта - список сверяется с миграциями, а не с памятью', async () => {
  const dataTables = await tablesCreatedByMigrations();
  // Признак арендатора появляется у таблицы одним из двух способов, и оба
  // засчитываются (расширено в Окне 73, 28.08.2026). Таблицы, существовавшие до
  // Фазы 2, получили колонку отдельной командой в 057. Таблица, заведённая позже,
  // объявляет её прямо в своём CREATE TABLE - требовать для неё ALTER задним
  // числом в чужой миграции неправильно: миграции после накатывания не меняют.
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const covered = new Set(
    [...migrationSql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN IF NOT EXISTS tenant_id/gi)].map((m) => m[1]),
  );
  for (const file of files) {
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    // CREATE TABLE, в теле которого объявлен tenant_id
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
      // Справочник может ссылаться на арендатора, не будучи таблицей данных:
      // tenant_channels хранит бота заведения и читается ДО контекста арендатора
      if (/\btenant_id\b/i.test(m[2]) && !SERVICE_TABLES.includes(m[1])) covered.add(m[1]);
    }
  }
  assert.deepEqual([...covered].sort(), dataTables, 'признак арендатора обязан быть у каждой таблицы данных');
  // Число зафиксировано отдельно: если следующая миграция заведёт таблицу, тест
  // упадёт здесь и заставит принять решение про арендатора осознанно.
  // 21-я - push_subscriptions (Окно 73, 28.08.2026): решение про арендатора принято,
  // колонка объявлена в самой таблице, замок стоит в той же миграции.
  // 22-24 - client_channels, client_channel_invites, client_messages (Волна 1,
  // 01.09.2026): переписка с клиентами заведения, замок обязателен и стоит в
  // миграции 062. Четвёртая таблица той же миграции, tenant_channels, намеренно
  // осталась справочником без замка - см. SERVICE_TABLES выше.
  assert.equal(dataTables.length, 24, 'таблиц данных 24 - число меняется только вместе с осознанным решением про арендатора');
});
