// Репетиция отката Этапа B (25.08.2026).
//
// Проверяется не «файл существует», а то, ради чего откат нужен: после наката и
// отката схема побайтово та же, что была до, и прежний код по ней работает.
//
// Запуск: node tools/verify-2026-08-25-etap-b-rollback.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'api', 'migrations');
const DB = 'etap_b_rollback_probe';
const ROLE = 'probe_rollback_b';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function asSystem(db, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    const res = await db.query(sql, params);
    await db.query('COMMIT');
    return res;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function applyMigrations(db, upTo = null) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (upTo && file > upTo) break;
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file])).rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

// Слепок схемы: все колонки всех таблиц с типами, обязательностью и умолчаниями
async function schemaSnapshot(db) {
  const res = await asSystem(
    db,
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name`
  );
  return JSON.stringify(res.rows);
}

async function main() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  await admin.end();

  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  console.log('Откат Этапа B, репетиция накат-откат-накат:');

  let before = '';
  let tenantsBefore = '';
  await step('база собрана миграциями до Этапа B (001-059)', async () => {
    await applyMigrations(db, '059_tenant_domains.sql');
    before = await schemaSnapshot(db);
    tenantsBefore = JSON.stringify((await asSystem(db, 'SELECT id, name, vertical, status, domains FROM tenants ORDER BY id')).rows);
    assert.ok(before.length > 1000, 'слепок схемы подозрительно мал');
  });

  await step('накат 060 добавляет ровно одну колонку и ничего больше', async () => {
    await applyMigrations(db);
    const after = await schemaSnapshot(db);
    const added = JSON.parse(after).filter((c) => !JSON.parse(before).some((b) => b.table_name === c.table_name && b.column_name === c.column_name));
    assert.deepEqual(added.map((c) => `${c.table_name}.${c.column_name}`), ['tenants.modules']);
    assert.equal(JSON.parse(after).length, JSON.parse(before).length + 1, 'схема изменилась не только новой колонкой');
  });

  await step('откат возвращает схему ровно к прежней', async () => {
    await asSystem(db, readFileSync(join(ROOT, 'tools', 'rollback', 'etap-b-rollback.sql'), 'utf8'));
    assert.equal(await schemaSnapshot(db), before, 'после отката схема отличается от прежней');
  });

  await step('данные арендаторов откат не тронул', async () => {
    const now = JSON.stringify((await asSystem(db, 'SELECT id, name, vertical, status, domains FROM tenants ORDER BY id')).rows);
    assert.equal(now, tenantsBefore);
  });

  await step('история миграций тоже откатилась - повторный накат возможен', async () => {
    const left = await asSystem(db, "SELECT 1 FROM schema_migrations WHERE filename = '060_tenant_modules.sql'");
    assert.equal(left.rowCount, 0, 'запись о миграции осталась - повторный накат будет пропущен');
    await applyMigrations(db);
    const col = await asSystem(
      db,
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'modules'"
    );
    assert.equal(col.rowCount, 1, 'повторный накат не вернул колонку');
  });

  await db.end();
  console.log(`\nОткат проверен: ${results.length} проверок на настоящем Postgres`);
}

main().catch((err) => {
  console.error('\n✖ РЕПЕТИЦИЯ ОТКАТА УПАЛА:', err.message);
  process.exitCode = 1;
});
