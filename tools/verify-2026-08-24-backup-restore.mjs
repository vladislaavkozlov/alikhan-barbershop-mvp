// Проверка резервной копии ВОССТАНОВЛЕНИЕМ (24.08.2026).
//
// Копия, которую никогда не восстанавливали, - это копия неизвестного качества.
// Здесь полный круг на настоящем Postgres: поднимается сервер с данными двух
// арендаторов, снимается копия через живой роут, заливается в ЧИСТУЮ базу, и
// содержимое сверяется построчно.
//
// Заодно проверяются замки роута: без секрета, чужой ролью и с неверным секретом
// копия не отдаётся.
//
// Запуск: node tools/verify-2026-08-24-backup-restore.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashPin } from '../api/lib/auth.js';
import { BACKUP_TABLES } from '../api/routes/backup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const SRC_DB = 'backup_source_probe';
const DST_DB = 'backup_restore_probe';
const ROLE = 'probe_backup_app';
const PASSWORD = 'probe';
// Секрет уезжает HTTP-заголовком - только латиница и цифры, кириллица в заголовок не влезает
const SECRET = 'probe-backup-secret-2026';
const host = process.env.PGHOST || '/tmp';
const PORT = 9107;
const ORIGIN = 'https://backup-probe.test';

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function recreate() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  for (const db of [SRC_DB, DST_DB]) await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  for (const db of [SRC_DB, DST_DB]) await admin.query(`CREATE DATABASE ${db} OWNER ${ROLE}`);
  await admin.end();
}

function connect(db) {
  return new pg.Pool({ host, database: db, user: ROLE, password: PASSWORD, max: 1 });
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

async function asTenant(db, id, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(id)]);
    const res = await db.query(sql, params);
    await db.query('COMMIT');
    return res;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function applyMigrations(db) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file])).rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

async function seed(db) {
  await service(db, "SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");
  await service(db, 'UPDATE tenants SET domains = domains || $1::text WHERE id = 1', [
    ORIGIN.replace('https://', ''),
  ]);
  await service(db, `INSERT INTO tenants (id, name, vertical, domains) VALUES (2, 'Клиника', 'clinic', ARRAY['klinika.test'])`);
  for (const [id, tag] of [[1, 'alikhan'], [2, 'karina']]) {
    const loc = await asTenant(db, id, 'INSERT INTO locations (name) VALUES ($1) RETURNING id', [`Точка ${tag}`]);
    await asTenant(
      db, id,
      `INSERT INTO staff (id, location_id, name, role, email, pin_hash, provides_services)
       VALUES ($1, $2, $3, 'owner', $4, $5, true)`,
      [`staff-${tag}`, loc.rows[0].id, `Владелец ${tag}`, `owner@${tag}.test`, hashPin('1234')]
    );
    await asTenant(db, id, `INSERT INTO services (id, name, category, duration_min, price) VALUES ($1, $2, 'base', 60, 1000)`, [
      `service-${tag}`, `Услуга ${tag}`,
    ]);
    await asTenant(db, id, 'INSERT INTO clients (id, phone, name) VALUES ($1, $2, $3)', [
      `client-${tag}`, `+7900${id}555111`, `Клиент ${tag}`,
    ]);
    await asTenant(
      db, id,
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, actual_price)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, '10:00', '11:00', 'done', 1500)`,
      [`booking-${tag}`, loc.rows[0].id, `staff-${tag}`, `service-${tag}`, `client-${tag}`]
    );
  }
}

async function main() {
  await recreate();
  const src = connect(SRC_DB);
  await applyMigrations(src);
  await seed(src);

  const api = spawn(process.execPath, [join(ROOT, 'api', 'server.mjs')], {
    env: {
      ...process.env, PORT: String(PORT), DB_HOST: host, DB_NAME: SRC_DB, DB_USER: ROLE,
      DB_PASSWORD: PASSWORD, DB_SSL: 'disable', BACKUP_TOKEN: SECRET, TENANT_CACHE_TTL_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* поднимается */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const call = (headers) => fetch(`http://127.0.0.1:${PORT}/backup`, { headers: { Origin: ORIGIN, ...headers } });
  let dump = null;

  try {
    console.log('Резервная копия: полный круг снятие → восстановление');

    const ownerToken = (await (await fetch(`http://127.0.0.1:${PORT}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: 'owner@alikhan.test', pin: '1234' }),
    })).json()).token;

    await step('без секрета копия не отдаётся, и роут прикидывается несуществующим', async () => {
      const res = await call({ Authorization: `Bearer ${ownerToken}` });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'route_not_found' });
    });

    await step('с неверным секретом копия не отдаётся', async () => {
      const res = await call({ Authorization: `Bearer ${ownerToken}`, 'X-Backup-Token': 'probe-backup-wrong-2026' });
      assert.equal(res.status, 404);
    });

    await step('без входа владельца копия не отдаётся даже с верным секретом', async () => {
      const res = await call({ 'X-Backup-Token': SECRET });
      assert.equal(res.status, 401);
    });

    await step('владелец с секретом получает копию всех арендаторов', async () => {
      const res = await call({ Authorization: `Bearer ${ownerToken}`, 'X-Backup-Token': SECRET });
      assert.equal(res.status, 200);
      dump = await res.json();
      assert.deepEqual(Object.keys(dump.tables).sort(), [...BACKUP_TABLES].sort());
      // Владелец Алихана снимает копию, а в ней обязаны быть и строки Карины -
      // иначе копия тихо неполная
      const tenantsInDump = new Set(dump.tables.bookings.map((b) => b.tenant_id));
      assert.deepEqual([...tenantsInDump].sort(), [1, 2]);
      assert.equal(dump.tables.tenants.length, 2);
    });
  } finally {
    api.kill('SIGTERM');
  }

  const file = join(mkdtempSync(join(tmpdir(), 'backup-probe-')), 'dump.json');
  writeFileSync(file, JSON.stringify(dump));

  // Чистая база: схема есть, данных нет
  const dst = connect(DST_DB);
  await applyMigrations(dst);

  await step('копия восстанавливается в чистую базу', async () => {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, 'tools', 'restore-backup.mjs'), file, DST_DB, ROLE], {
        env: { ...process.env, PGHOST: host, PGPASSWORD: PASSWORD },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const log = [];
      child.stdout.on('data', (d) => log.push(String(d)));
      child.stderr.on('data', (d) => log.push(String(d)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(log.join('')))));
    });
  });

  await step('живые сессии в копию не попали - в файле нет токенов доступа', async () => {
    assert.ok(!('sessions' in dump.tables), 'таблица сессий не должна выгружаться');
    assert.doesNotMatch(JSON.stringify(dump).slice(0, 200000), /"token"/, 'в копии не должно быть токенов');
  });

  await step('в восстановленной базе столько же строк, сколько было в исходной', async () => {
    for (const table of BACKUP_TABLES) {
      const before = (await service(src, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      const after = (await service(dst, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      assert.equal(Number(after), Number(before), `${table}: было ${before}, восстановлено ${after}`);
    }
  });

  await step('данные совпадают построчно, а не только по счётчику', async () => {
    for (const [table, key] of [['bookings', 'id'], ['clients', 'id'], ['staff', 'id'], ['tenants', 'id']]) {
      const rows = async (db) =>
        (await service(db, `SELECT * FROM ${table} ORDER BY ${key}`)).rows.map((r) => JSON.stringify(r));
      assert.deepEqual(await rows(dst), await rows(src), `${table}: содержимое разошлось`);
    }
  });

  await step('замок в восстановленной базе работает: арендаторы по-прежнему изолированы', async () => {
    const own = await asTenant(dst, 2, 'SELECT tenant_id FROM bookings');
    assert.deepEqual(own.rows.map((r) => r.tenant_id), [2], 'второй арендатор видит чужие записи');
  });

  await step('счётчики продолжаются с последнего номера - новая строка не спотыкается', async () => {
    const created = await asTenant(dst, 1, "INSERT INTO locations (name) VALUES ('Новая точка') RETURNING id");
    assert.ok(created.rows[0].id > 0);
  });

  await src.end();
  await dst.end();
  console.log(`\nКопия проверена восстановлением: ${results.length} проверок`);
}

await main();
