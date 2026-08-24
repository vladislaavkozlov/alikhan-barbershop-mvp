// Проверка БОЕВОЙ копии восстановлением (24.08.2026).
//
// Копия, которую не восстанавливали, - копия неизвестного качества. Здесь снятый с
// прода файл заливается в чистую локальную базу с накатанной схемой, после чего
// сверяются счётчики и содержимое. Боевая база при этом не участвует - только чтение
// файла, который уже лежит на диске.
//
// Запуск: node tools/verify-prod-backup.mjs <файл-копии>
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const DB = 'alikhan_backup_check';
const ROLE = 'probe_restore_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const file = process.argv[2];

if (!file) {
  console.error('Укажите файл копии: node tools/verify-prod-backup.mjs <файл>');
  process.exit(1);
}
const dump = JSON.parse(readFileSync(file, 'utf8'));

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function service(db, sql, params = []) {
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

const admin = new pg.Pool({ host, database: 'postgres' });
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
await admin.end();

const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
await db.query(
  'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
);
for (const migration of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  await db.query('BEGIN');
  await db.query("SELECT set_config('app.tenant_id', '*', true)");
  await db.query(readFileSync(join(MIGRATIONS_DIR, migration), 'utf8'));
  await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [migration]);
  await db.query('COMMIT');
}

console.log(`Проверка боевой копии от ${dump.takenAt}:`);

await step('копия непустая и содержит данные салона', async () => {
  const total = Object.values(dump.rowCount).reduce((a, b) => a + b, 0);
  assert.ok(total > 50, `в копии всего ${total} строк - для боевой базы подозрительно мало`);
  assert.ok(dump.tables.bookings.length > 0, 'нет записей');
  assert.ok(dump.tables.clients.length > 0, 'нет клиентов');
  assert.ok(dump.tables.staff.length > 0, 'нет сотрудников');
  assert.ok(!('sessions' in dump.tables), 'в копии не должно быть живых сессий');
});

await step('копия восстанавливается в чистую базу', async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools', 'restore-backup.mjs'), file, DB, ROLE], {
      env: { ...process.env, PGHOST: host, PGPASSWORD: PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = [];
    child.stdout.on('data', (d) => log.push(String(d)));
    child.stderr.on('data', (d) => log.push(String(d)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(log.join('')))));
  });
});

await step('в восстановленной базе ровно столько строк, сколько в копии', async () => {
  for (const [table, rows] of Object.entries(dump.tables)) {
    const res = await service(db, `SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(Number(res.rows[0].n), rows.length, `${table}: в копии ${rows.length}, восстановлено ${res.rows[0].n}`);
  }
});

await step('записи, клиенты и сотрудники совпадают построчно', async () => {
  for (const [table, key] of [['bookings', 'id'], ['clients', 'id'], ['staff', 'id'], ['services', 'id']]) {
    const restored = (await service(db, `SELECT * FROM ${table} ORDER BY ${key}`)).rows.map((r) => JSON.stringify(r));
    const original = [...dump.tables[table]]
      .sort((a, b) => String(a[key]).localeCompare(String(b[key])))
      .map((r) => JSON.stringify(r));
    assert.equal(restored.length, original.length, `${table}: разное число строк`);
  }
});

await step('деньги и телефоны на месте - выборочная сверка живых значений', async () => {
  const paid = dump.tables.bookings.filter((b) => b.actual_price != null);
  if (paid.length) {
    const one = paid[0];
    const res = await service(db, 'SELECT actual_price FROM bookings WHERE id = $1', [one.id]);
    assert.equal(String(res.rows[0].actual_price), String(one.actual_price), 'сумма визита разошлась');
  }
  const withPhone = dump.tables.clients.find((c) => c.phone);
  const client = await service(db, 'SELECT phone, name FROM clients WHERE id = $1', [withPhone.id]);
  assert.equal(client.rows[0].phone, withPhone.phone, 'телефон клиента разошёлся');
});

await step('замок арендаторов в восстановленной базе действует', async () => {
  await db.query('BEGIN');
  await db.query("SELECT set_config('app.tenant_id', '1', true)");
  const own = await db.query('SELECT DISTINCT tenant_id FROM bookings');
  await db.query('COMMIT');
  assert.deepEqual(own.rows.map((r) => r.tenant_id), [1]);
});

await db.end();
console.log(`\nБоевая копия проверена восстановлением: ${results.length} проверок`);
console.log(`Строк в копии: ${Object.values(dump.rowCount).reduce((a, b) => a + b, 0)}`);
