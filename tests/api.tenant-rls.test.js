// Фаза 3 мультиарендности (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
// Замок в базе: изоляция обеспечивается самой базой, а не аккуратностью в коде.
//
// Здесь проверяется текст миграции 058. Сам замок доказывается атакой на настоящем
// Postgres - tools/verify-2026-08-24-tenant-rls.mjs, и там же доказывается, что тест
// атаки не ложноположительный (снимаем FORCE - атака обязана пройти).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const MIGRATIONS = new URL('../api/migrations/', import.meta.url);
const rlsSql = await readFile(new URL('058_rls.sql', MIGRATIONS), 'utf8');
const schemaSql = await readFile(new URL('057_tenants.sql', MIGRATIONS), 'utf8');

// Список таблиц берётся из предыдущей миграции, а не набирается руками: забытая
// таблица - отдельный риск в плане, и ловиться он должен списком.
const DATA_TABLES = [...schemaSql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN IF NOT EXISTS tenant_id/gi)]
  .map((m) => m[1])
  .sort();

test('замок включён и распространяется на владельца таблиц (ловушка 1)', () => {
  assert.ok(DATA_TABLES.length === 20, `таблиц данных должно быть 20, найдено ${DATA_TABLES.length}`);
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

test('миграция - только про схему, без данных', () => {
  const body = rlsSql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /INSERT INTO/i);
  assert.doesNotMatch(body, /DELETE FROM/i);
  assert.doesNotMatch(body, /DROP TABLE/i);
});
