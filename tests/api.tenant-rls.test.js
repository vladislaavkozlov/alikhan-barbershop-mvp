// Фаза 3 мультиарендности (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
// Замок в базе: изоляция обеспечивается самой базой, а не аккуратностью в коде.
//
// Здесь проверяется текст миграции 058. Сам замок доказывается атакой на настоящем
// Postgres - tools/verify-2026-08-24-tenant-rls.mjs, и там же доказывается, что тест
// атаки не ложноположительный (снимаем FORCE - атака обязана пройти).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const MIGRATIONS = new URL('../api/migrations/', import.meta.url);
// Правила замка собираются из ВСЕХ миграций, а не только из 058 (расширено в
// Окне 73, 28.08.2026). Замок для таблиц, существовавших на момент Фазы 3, живёт в
// 058; таблица, заведённая позже, приносит свой замок в собственной миграции - иначе
// её пришлось бы дописывать в старый файл задним числом, а миграции неизменяемы
// после накатывания. Проверка от этого не слабеет: требование «у каждой таблицы
// данных есть ENABLE, FORCE и политика» остаётся ровно тем же.
const rlsSql = await (async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const parts = [];
  for (const file of files) parts.push(await readFile(new URL(file, MIGRATIONS), 'utf8'));
  return parts.join('\n');
})();

// Служебные таблицы: история накатывания схемы, сам справочник арендаторов и
// справочник их ботов.
//
// tenant_channels (миграция 062) остаётся без замка не по недосмотру, а по факту,
// проверенному живым запросом 01.09.2026: политика вызывает app_current_tenant(),
// а тот падает с «unrecognized configuration parameter», если контекста нет
// вообще. Входящее обновление от бота приходит ДО контекста - по этой таблице
// как раз и определяется, чей это бот. Замок здесь означал бы, что webhook не
// может себя найти. Клиентских данных в таблице нет, только конфигурация канала.
const SERVICE_TABLES = ['schema_migrations', 'tenants', 'tenant_channels'];

// Список берётся из ВСЕХ миграций, а не из 057: таблица, заведённая будущей
// миграцией, обязана уронить этот тест и заставить принять решение про замок
// осознанно. Сверка только с 057 такую таблицу пропустила бы молча.
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

const DATA_TABLES = await tablesCreatedByMigrations();

test('замок включён и распространяется на владельца таблиц (ловушка 1)', () => {
  // 21-я таблица - push_subscriptions (Окно 73, 28.08.2026), подписки устройств.
  // 22-24 - client_channels, client_channel_invites, client_messages (Волна 1,
  // 01.09.2026): привязка клиента к боту, одноразовые приглашения и очередь
  // сообщений. Это переписка с клиентами заведения, замок обязателен.
  assert.ok(DATA_TABLES.length === 24, `таблиц данных должно быть 24, найдено ${DATA_TABLES.length}`);
  for (const table of DATA_TABLES) {
    assert.match(
      rlsSql,
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'),
      `${table}: замок не включён`
    );
    // Без FORCE политика не действует на владельца таблиц, а приложение на Amvera
    // подключается именно им. Тестирование «изоляция работает» дало бы ложную
    // зелень - ровно ловушка 1 спеки.
    assert.match(
      rlsSql,
      new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'),
      `${table}: без FORCE замок не действует на владельца - это и есть ловушка 1`
    );
  }
});

test('политика есть у каждой таблицы данных и покрывает чтение и запись', () => {
  for (const table of DATA_TABLES) {
    const policy = new RegExp(
      `CREATE POLICY tenant_isolation ON ${table}\\s+FOR ALL\\s+USING \\(([^)]*\\)?[^;]*?)\\s+WITH CHECK`,
      'i'
    );
    assert.match(rlsSql, policy, `${table}: политика должна быть FOR ALL с USING и WITH CHECK`);
  }
  const policies = [...rlsSql.matchAll(/CREATE POLICY tenant_isolation ON ([a-z_]+)/gi)].map((m) => m[1]).sort();
  assert.deepEqual(policies, DATA_TABLES, 'политика обязана быть ровно у тех же таблиц, что и признак арендатора');
});

test('арендатор запроса вычисляется одной функцией, а не рассыпан по политикам', () => {
  assert.match(rlsSql, /CREATE OR REPLACE FUNCTION app_current_tenant\(\) RETURNS integer/i);
  // CASE, а не OR: порядок вычисления в SQL не гарантирован, и `'*'::int` мог бы
  // сработать раньше проверки на служебный контекст, уронив любой запрос миграций
  assert.match(rlsSql, /CASE WHEN current_setting\('app\.tenant_id'\) = '\*'/i);
  assert.doesNotMatch(
    rlsSql,
    /current_setting\('app\.tenant_id', true\)/,
    'мягкое чтение настройки вернуло бы NULL без контекста - это открыло бы всю базу'
  );
});

test('служебный контекст пропускается только он сам, всё остальное сравнивается по номеру', () => {
  const policyBody = rlsSql.match(/USING \(([^;]*?)\)\s*\n\s*WITH CHECK/i)?.[1] ?? '';
  assert.match(policyBody, /app_current_tenant\(\) IS NULL OR tenant_id = app_current_tenant\(\)/i);
});

test('миграция отказывается ставить замок там, где его всё равно обойдут', () => {
  // Суперпользователь и роль с BYPASSRLS игнорируют политику даже с FORCE. Молча
  // положить замок на такую базу - худший исход: он выглядит поставленным, но не
  // держит. Поэтому миграция падает, а сервер не стартует.
  assert.match(rlsSql, /rolsuper OR rolbypassrls/i);
  assert.match(rlsSql, /RAISE EXCEPTION/i);
});

test('справочник арендаторов сознательно остаётся без замка - с обоснованием в тексте', () => {
  assert.doesNotMatch(rlsSql, /ALTER TABLE tenants ENABLE ROW LEVEL SECURITY/i);
  assert.match(rlsSql, /tenants/i, 'решение по справочнику должно быть объяснено в самой миграции');
});

test('справочник ботов тоже без замка - и это объяснено в своей миграции', async () => {
  const sql = await readFile(new URL('062_client_messaging.sql', MIGRATIONS), 'utf8');
  assert.doesNotMatch(sql, /ALTER TABLE tenant_channels ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /Замка арендатора здесь нет/i, 'решение по справочнику ботов должно быть объяснено в миграции');
  // А вот три таблицы с перепиской клиентов замок обязаны иметь
  for (const table of ['client_channels', 'client_channel_invites', 'client_messages']) {
    assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'), `${table}: переписка клиентов без замка`);
  }
});

// Проверка чистоты смотрит на КОНКРЕТНЫЕ миграции, а не на их склейку: ранние
// миграции проекта (002) содержат заготовку данных по историческим причинам, и
// сверять с ними бессмысленно. Здесь перечислены те, что вводят замок и таблицы
// под ним, - для них правило «миграция только про схему» действует строго.
const SCHEMA_ONLY_MIGRATIONS = ['058_rls.sql', '061_push_subscriptions.sql'];

test('миграция - только про схему, без данных', async () => {
  for (const file of SCHEMA_ONLY_MIGRATIONS) {
    const body = (await readFile(new URL(file, MIGRATIONS), 'utf8')).replace(/--[^\n]*/g, '');
    assert.doesNotMatch(body, /INSERT INTO/i, `${file}: миграция вставляет данные`);
    assert.doesNotMatch(body, /DELETE FROM/i, `${file}: миграция удаляет данные`);
    assert.doesNotMatch(body, /DROP TABLE/i, `${file}: миграция роняет таблицу`);
  }
});
