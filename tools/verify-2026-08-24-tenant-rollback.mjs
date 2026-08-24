// Проверка ПУТИ ОТКАТА Этапа A (Фаза 5, 24.08.2026).
//
// План требует не просто записать откат, а проверить его. Здесь это делается
// буквально: снимается слепок схемы ДО миграций Этапа A, затем миграции
// накатываются, затем выполняется откат - и слепок сравнивается посимвольно.
// Плюс счётчики строк по каждой таблице до и после: откат не должен стоить ни одной
// строки Алихана.
//
// Отдельно проверяется защита: если в базе есть строки второго арендатора, откат
// обязан отказаться работать - иначе он смешал бы два салона в один.
//
// Запуск: node tools/verify-2026-08-24-tenant-rollback.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const ROLLBACK_SQL = readFileSync(join(ROOT, 'tools', 'rollback', 'multitenancy-etap-a-rollback.sql'), 'utf8');
const DB = 'tenant_rollback_probe';
const ROLE = 'probe_rollback_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const ETAP_A = ['057_tenants.sql', '058_rls.sql', '059_tenant_domains.sql'];

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function recreate() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  await admin.end();
}

async function asTenant(db, tenantId, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const res = await db.query(sql, params);
    await db.query('COMMIT');
    return res;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function applyMigrations(db, files) {
  for (const file of files) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file])).rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

// Слепок схемы: колонки, индексы, ограничения, флаги замка. Сравнивается целиком
async function schemaSnapshot(db) {
  const columns = (
    await db.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public'
        ORDER BY table_name, column_name`
    )
  ).rows;
  const indexes = (
    await db.query(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexdef`
    )
  ).rows;
  const constraints = (
    await db.query(
      `SELECT conrelid::regclass::text AS table_name, contype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace
        ORDER BY 1, 2, 3`
    )
  ).rows;
  const rls = (
    await db.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`
    )
  ).rows;
  const functions = (
    await db.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' ORDER BY proname`
    )
  ).rows;
  return { columns, indexes, constraints, rls, functions };
}

async function rowCounts(db, tables, tenantAware) {
  const out = {};
  for (const t of tables) {
    const run = tenantAware ? (sql) => asTenant(db, '*', sql) : (sql) => db.query(sql);
    out[t] = Number((await run(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}

async function seed(db) {
  await db.query("INSERT INTO locations (id, name) VALUES (99, 'Точка отката') ON CONFLICT DO NOTHING");
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, email) VALUES ('staff-rb', 99, 'Мастер', 'master', 'rb@probe.local')`
  );
  await db.query("INSERT INTO clients (id, phone, name) VALUES ('client-rb', '+79001110022', 'Клиент')");
  await db.query(
    `INSERT INTO services (id, name, category, duration_min, price) VALUES ('service-rb', 'Услуга', 'base', 60, 1000)`
  );
  await db.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
     VALUES ('booking-rb', 99, 'staff-rb', 'service-rb', 'client-rb', '2026-08-25', '10:00', '11:00', 'planned')`
  );
  await db.query(
    `INSERT INTO notifications (id, staff_id, type, booking_id, title) VALUES ('notif-rb', 'staff-rb', 'booking_new', 'booking-rb', 'Запись')`
  );
}

async function main() {
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );

  console.log('Проверка пути отката Этапа A:');

  const before056 = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !ETAP_A.includes(f)).sort();
  await applyMigrations(db, before056);
  await seed(db);

  const TABLES = (
    await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1")
  ).rows.map((r) => r.tablename);

  const snapshotBefore = await schemaSnapshot(db);
  const countsBefore = await rowCounts(db, TABLES, false);

  await step('миграции Этапа A накатываются на базу с данными', async () => {
    await applyMigrations(db, ETAP_A);
    const applied = await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE filename = ANY($1)', [ETAP_A]);
    assert.equal(Number(applied.rows[0].n), 3);
  });

  await step('откат отказывается работать, пока в базе есть второй арендатор', async () => {
    await asTenant(db, '*', "INSERT INTO tenants (id, name, domains) VALUES (2, 'Второй салон', ARRAY['vtoroy.test'])");
    await asTenant(db, 2, "INSERT INTO clients (id, phone, name) VALUES ('client-vtoroy', '+79002220033', 'Чужой клиент')");
    await assert.rejects(
      () => db.query(ROLLBACK_SQL),
      /строк второго арендатора/,
      'откат обязан остановиться: снятие колонки смешало бы два салона'
    );
    // Убираем второго - дальше проверяем откат в той ситуации, для которой он и писан
    await asTenant(db, '*', "DELETE FROM clients WHERE tenant_id = 2");
    await asTenant(db, '*', 'DELETE FROM tenants WHERE id = 2');
  });

  await step('откат возвращает схему ровно к состоянию до Этапа A', async () => {
    await db.query(ROLLBACK_SQL);
    const snapshotAfter = await schemaSnapshot(db);
    assert.deepEqual(snapshotAfter.columns, snapshotBefore.columns, 'колонки разошлись');
    assert.deepEqual(snapshotAfter.indexes, snapshotBefore.indexes, 'индексы разошлись');
    assert.deepEqual(snapshotAfter.constraints, snapshotBefore.constraints, 'ограничения разошлись');
    assert.deepEqual(snapshotAfter.rls, snapshotBefore.rls, 'флаги замка не сняты');
    assert.deepEqual(snapshotAfter.functions, snapshotBefore.functions, 'служебная функция не убрана');
  });

  await step('откат не стоит ни одной строки', async () => {
    const countsAfter = await rowCounts(db, TABLES, false);
    assert.deepEqual(countsAfter, countsBefore);
  });

  await step('после отката база снова работает без арендатора - как старый код', async () => {
    const rows = await db.query('SELECT id FROM bookings ORDER BY id');
    assert.deepEqual(rows.rows.map((r) => r.id), ['booking-rb']);
    await db.query("INSERT INTO clients (id, phone, name) VALUES ('client-after', '+79003330044', 'После отката')");
    const check = await db.query("SELECT count(*)::int AS n FROM clients");
    assert.equal(Number(check.rows[0].n), 2);
  });

  await step('миграции Этапа A забыты - новый код накатит их заново', async () => {
    const left = await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE filename = ANY($1)', [ETAP_A]);
    assert.equal(Number(left.rows[0].n), 0);
    await applyMigrations(db, ETAP_A);
    const back = await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema = 'public'");
    assert.equal(Number(back.rows[0].n), TABLES.length, 'повторный накат должен вернуть арендатора всем таблицам данных');
  });

  await db.end();
  console.log(`\nПуть отката проверен: ${results.length} проверок на настоящем Postgres`);
}

await main();
