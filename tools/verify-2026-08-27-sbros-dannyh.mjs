// ГЛАВНЫЙ ПРОГОН: сброс рабочих данных арендатора на настоящем Postgres
// (27.08.2026, передача кабинета заказчику).
//
// Офлайн-набор (tests/api.reset-tenant-data.test.js) держит контракт на поддельном
// пуле: порядок, откат, идемпотентность. Проверить он не может главного - что
// настоящий сервер, стартуя с переменной RESET_TENANT_DATA против настоящей базы с
// настоящим замком на строках, чистит ровно своего арендатора и не задевает соседа.
//
// База эфемерная, но собранная как боевая: таблицы принадлежат ОБЫЧНОЙ роли без
// суперправ. Из-под суперпользователя замок из миграции 058 не действует вовсе, и
// прогон дал бы ложную зелень (та же ловушка, что у прогонов мультиарендности).
//
// Запуск: node tools/verify-2026-08-27-sbros-dannyh.mjs
//
// Даты в базе - тип date, а pg отдаёт их JS-датой по времени процесса. Снимок отката
// пишет сервер, у которого TZ жёстко UTC (api/lib/db.js), поэтому и здесь UTC: иначе
// восстановленная дата уехала бы на день (та же ловушка, что найдена 04.08.2026).
process.env.TZ = 'UTC';
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DROP_SNAPSHOT_VARIABLE, RESET_TABLES, SNAPSHOT_TABLES, snapshotKey } from '../api/lib/reset-tenant-data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const SERVER = join(ROOT, 'api', 'server.mjs');
const DB = 'sbros_dannyh_probe';
const ROLE = 'probe_sbros_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const PORT = 9111;
const BASE = `http://127.0.0.1:${PORT}`;

// Арендатор 1 заведён миграцией 057 и называется именно так - это же имя поедет в
// переменную панели Amvera
const ALIKHAN = { id: 1, name: 'Барбершоп Алихан' };
const SOSED = { id: null, name: 'Клиника-сосед, проверочный арендатор' };
const LABEL = 'probe-sbros-2026-08-27';

// Ровно 20 таблиц данных из миграции 057 - те, на которых стоит замок арендатора.
// tenants в список не входит: это справочник, он общий и сознательно без замка
const DATA_TABLES = [
  'booking_services', 'bookings', 'clients', 'discount_settings', 'holidays', 'kv_store',
  'locations', 'master_payroll_settings', 'master_services', 'master_weekly_schedule',
  'notifications', 'payroll_settings', 'sales', 'schedule_breaks', 'schedule_change_requests',
  'schedule_shifts', 'services', 'sessions', 'staff', 'staff_media',
];

// Что обязано пережить сброс строка в строку
const KEPT_TABLES = [
  'staff', 'services', 'master_services', 'master_payroll_settings', 'payroll_settings',
  'discount_settings', 'staff_media', 'locations', 'holidays',
];

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

async function inContext(db, tenantId, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const asSystem = (db, sql, params = []) => inContext(db, '*', (c) => c.query(sql, params));
const asTenant = (db, tenantId, sql, params = []) => inContext(db, tenantId, (c) => c.query(sql, params));

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

// Каждый старт сервера - отдельный процесс со своей переменной. Именно так это и
// происходит на Amvera: значение в панели плюс перезапуск контейнера
async function runServer(resetVariable, fn, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable',
      ...(resetVariable === undefined ? {} : { RESET_TENANT_DATA: resetVariable }),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch { /* поднимается */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error(`сервер не поднялся:\n${log.join('')}`);
    }
    return await fn(() => log.join(''));
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
}

// ── Наполнение базы ─────────────────────────────────────────────────────────
// Оба арендатора получают одинаковый набор: состав команды с уволенным и с тем, кто
// клиентов не принимает, клиенты, записи, допродажи, уведомления, разовые смены,
// заявку на график и уже существующий недельный график 10:00-19:00 - его новый
// обязан заменить целиком, а не дописать поверх
async function seed(db, tenantId, prefix, day) {
  await inContext(db, tenantId, async (c) => {
    const loc = await c.query('INSERT INTO locations (tenant_id, name, address) VALUES ($1, $2, $3) RETURNING id', [tenantId, `${prefix} точка`, 'ул. Проверочная, 1']);
    const locationId = loc.rows[0].id;
    const people = [
      { id: `${prefix}-owner`, name: `${prefix} владелец`, role: 'owner', employed: true, provides: true },
      { id: `${prefix}-master`, name: `${prefix} мастер`, role: 'master', employed: true, provides: true },
      { id: `${prefix}-admin`, name: `${prefix} администратор`, role: 'admin', employed: true, provides: false },
      { id: `${prefix}-fired`, name: `${prefix} уволенный`, role: 'master', employed: false, provides: true },
    ];
    for (const p of people) {
      await c.query(
        `INSERT INTO staff (id, tenant_id, location_id, name, email, role, employed, provides_services, has_system_access)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [p.id, tenantId, locationId, p.name, `${p.id}@probe.test`, p.role, p.employed, p.provides]
      );
      await c.query('INSERT INTO master_payroll_settings (tenant_id, master_id, pct) VALUES ($1, $2, 0.4)', [tenantId, p.id]);
      await c.query(
        'INSERT INTO staff_media (id, tenant_id, staff_id, kind, storage_key, sort_order) VALUES ($1, $2, $3, $4, $5, 1)',
        [`${p.id}-photo`, tenantId, p.id, 'avatar', `media/${p.id}.jpg`]
      );
      // Уже существующий график: другой, чем поставит сброс, и не на все семь дней
      for (const weekday of [1, 2, 3]) {
        await c.query(
          `INSERT INTO master_weekly_schedule (tenant_id, master_id, weekday, is_working, work_start, work_end)
           VALUES ($1, $2, $3, true, '10:00', '19:00')`,
          [tenantId, p.id, weekday]
        );
      }
    }
    // Строка настроек у арендатора 1 уже есть от миграций - вторую заводить нечего
    await c.query('INSERT INTO payroll_settings (tenant_id, id, base_rate_per_shift) VALUES ($1, 1, 1500) ON CONFLICT DO NOTHING', [tenantId]);
    await c.query('INSERT INTO discount_settings (tenant_id, id, payroll_from_actual_price) VALUES ($1, true, true) ON CONFLICT DO NOTHING', [tenantId]);
    await c.query('INSERT INTO sessions (tenant_id, token, staff_id, expires_at) VALUES ($1, $2, $3, now() + interval \'7 days\')', [tenantId, `${prefix}-token`, `${prefix}-owner`]);
    if (tenantId !== ALIKHAN.id) {
      await c.query('INSERT INTO holidays (tenant_id, date, name) VALUES ($1, $2, $3), ($1, $4, $5)', [tenantId, '2026-01-01', 'Новый год', '2026-01-02', 'Новогодние каникулы']);
    }

    for (const [index, name] of ['Стрижка', 'Борода'].entries()) {
      const serviceId = `${prefix}-service-${index + 1}`;
      await c.query(
        'INSERT INTO services (id, tenant_id, name, category, duration_min, price, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [serviceId, tenantId, name, 'base', 40, 1500 + index * 500, index + 1]
      );
      await c.query(
        'INSERT INTO master_services (tenant_id, master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, `${prefix}-master`, serviceId, 1500 + index * 500, 40]
      );
    }

    for (const index of [1, 2, 3]) {
      const clientId = `${prefix}-client-${index}`;
      await c.query(
        'INSERT INTO clients (id, tenant_id, name, phone) VALUES ($1, $2, $3, $4)',
        [clientId, tenantId, `Клиент ${index}`, `+7999000000${tenantId}${index}`]
      );
      const bookingId = `${prefix}-booking-${index}`;
      await c.query(
        `INSERT INTO bookings (id, tenant_id, location_id, master_id, client_id, date, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'planned')`,
        [bookingId, tenantId, locationId, `${prefix}-master`, clientId, day, '11:00', '11:40']
      );
      await c.query('INSERT INTO booking_services (tenant_id, booking_id, service_id) VALUES ($1, $2, $3)', [tenantId, bookingId, `${prefix}-service-1`]);
      await c.query('INSERT INTO sales (id, tenant_id, booking_id, item_name, amount) VALUES ($1, $2, $3, $4, $5)', [`${prefix}-sale-${index}`, tenantId, bookingId, 'Воск', 700]);
      await c.query(
        'INSERT INTO notifications (id, tenant_id, staff_id, type, booking_id, title, body) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [`${prefix}-notif-${index}`, tenantId, `${prefix}-master`, 'booking_new', bookingId, 'Новая запись', 'Клиент записался']
      );
    }

    const shift = await c.query(
      'INSERT INTO schedule_shifts (tenant_id, master_id, date, start_time, end_time) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [tenantId, `${prefix}-master`, day, '09:00', '21:00']
    );
    await c.query('INSERT INTO schedule_breaks (tenant_id, shift_id, start_time, end_time) VALUES ($1, $2, $3, $4)', [tenantId, shift.rows[0].id, '15:00', '16:00']);
    await c.query(
      `INSERT INTO schedule_change_requests (tenant_id, master_id, request_type, date_from, category, status)
       VALUES ($1, $2, 'day_off', $3, 'otgul', 'pending')`,
      [tenantId, `${prefix}-master`, day]
    );
    await c.query('INSERT INTO kv_store (tenant_id, key, value) VALUES ($1, $2, $3)', [tenantId, 'legacy-okno-7', '{"старый":"блок"}']);
  });
}

// Счётчики по всем 20 таблицам данных, разбитые по арендаторам. Служебный контекст:
// видеть надо ОБОИХ, иначе неизменность соседа проверять нечем
async function counts(db) {
  const out = {};
  for (const table of DATA_TABLES) {
    const res = await asSystem(db, `SELECT tenant_id, count(*)::int AS n FROM ${table} GROUP BY tenant_id ORDER BY tenant_id`);
    out[table] = Object.fromEntries(res.rows.map((r) => [r.tenant_id, r.n]));
  }
  return out;
}

const forTenant = (all, tenantId) => Object.fromEntries(DATA_TABLES.map((t) => [t, all[t][tenantId] ?? 0]));

// Восстановление из снимка. Порядок обратный удалению - иначе внешние ключи не дадут
// положить строку раньше той, на которую она ссылается.
//
// Недельный график восстанавливается иначе, чем остальные восемь таблиц: операция его
// не удаляла, а заменила своими строками, поэтому сначала снимаются они, и только
// потом кладутся прежние. Без этого шага прежние часы работы салона не вернуть ничем
async function restoreFromSnapshot(db, tenantId, label) {
  const res = await asTenant(db, tenantId, 'SELECT value FROM kv_store WHERE key = $1', [snapshotKey(label)]);
  assert.equal(res.rows.length, 1, 'снимок отката не найден');
  const snapshot = JSON.parse(res.rows[0].value);
  assert.deepEqual(Object.keys(snapshot.tables), SNAPSHOT_TABLES, 'снимок обязан покрывать и недельный график');
  const restored = {};
  await inContext(db, tenantId, async (c) => {
    const insertRows = async (table) => {
      const rows = snapshot.tables[table] ?? [];
      for (const row of rows) {
        const columns = Object.keys(row);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        await c.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, columns.map((col) => row[col]));
      }
      restored[table] = rows.length;
    };
    for (const table of [...RESET_TABLES].reverse()) await insertRows(table);
    await c.query('DELETE FROM master_weekly_schedule WHERE tenant_id = $1', [tenantId]);
    await insertRows('master_weekly_schedule');
  });
  return { snapshot, restored };
}

// Недельный график арендатора одной сравнимой строкой: кому, какой день, какие часы
async function weeklySchedule(db, tenantId) {
  const res = await asTenant(
    db,
    tenantId,
    'SELECT master_id, weekday, is_working, work_start, work_end, break_start, break_end FROM master_weekly_schedule ORDER BY master_id, weekday'
  );
  return res.rows;
}

async function main() {
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 4 });
  await applyMigrations(db);

  // Миграция 002 кладёт две точки с явными id, не двигая последовательность - на
  // свежей базе первая же вставка точки упала бы на занятом номере. На боевой базе
  // этого нет: там последовательность давно ушла вперёд
  await asSystem(db, "SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");

  const safe = await asSystem(db, 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.equal(safe.rows[0].rolsuper, false, 'прогон из-под суперпользователя дал бы ложную зелень: замок арендатора на нём не действует');
  assert.equal(safe.rows[0].rolbypassrls, false);

  const sosed = await asSystem(db, 'INSERT INTO tenants (name, vertical, domains) VALUES ($1, $2, $3::text[]) RETURNING id', [SOSED.name, 'clinic', ['sosed.probe.test']]);
  SOSED.id = sosed.rows[0].id;

  const day = '2026-08-28';
  await seed(db, ALIKHAN.id, 'alikhan', day);
  await seed(db, SOSED.id, 'sosed', day);

  console.log('Сброс рабочих данных арендатора, живой прогон на настоящем Postgres:\n');
  const before = await counts(db);
  const sosedBefore = forTenant(before, SOSED.id);
  const alikhanBefore = forTenant(before, ALIKHAN.id);
  // Прежний недельный график запоминается ДО сброса: именно его обязано вернуть
  // восстановление из снимка, а не только число строк
  const scheduleBefore = await weeklySchedule(db, ALIKHAN.id);

  // ── 0. Чувствительность: неверное имя арендатора ─────────────────────────
  await runServer(`${ALIKHAN.id}:Барбершоп Алихан и партнёры:${LABEL}`, async (logOf) => {
    await step('название не совпало с базой - не удалено ни строки, приложение живо', async () => {
      const after = await counts(db);
      assert.deepEqual(forTenant(after, ALIKHAN.id), alikhanBefore, 'при расхождении имени данные обязаны остаться нетронутыми');
      assert.equal((await fetch(`${BASE}/health`)).status, 200, 'сервер обязан подняться даже с кривой переменной');
      assert.match(logOf(), /называется/);
    });
  });

  // ── 0б. Чувствительность: согласованная пара «номер и имя чужого арендатора» ──
  // Имя ловит опечатку в номере. Оно не ловит случай, когда номер и имя чужого
  // заведения списаны с одного листка и друг с другом сходятся. Ловит вертикаль
  await runServer(`${SOSED.id}:${SOSED.name}:${LABEL}-sosed`, async (logOf) => {
    await step('номер и имя чужого арендатора сошлись, но вертикаль не барбершоп - отказ', async () => {
      const after = await counts(db);
      assert.deepEqual(forTenant(after, SOSED.id), sosedBefore, 'у клиники не должно измениться ни строки');
      assert.deepEqual(forTenant(after, ALIKHAN.id), alikhanBefore, 'и у барбершопа тоже');
      assert.equal((await fetch(`${BASE}/health`)).status, 200, 'сервер обязан подняться и после отказа');
      assert.match(logOf(), /вертикаль «clinic»/);
      const snapshots = await asTenant(db, SOSED.id, 'SELECT count(*)::int AS n FROM kv_store WHERE key = $1', [snapshotKey(`${LABEL}-sosed`)]);
      assert.equal(snapshots.rows[0].n, 0, 'снимок чужого арендатора не пишется');
      console.log(`    отказ по вертикали: ${logOf().split('\n').find((l) => /вертикаль/.test(l))?.trim()}`);
    });
  });

  // ── 1. Сам сброс ─────────────────────────────────────────────────────────
  let resetLog = '';
  await runServer(`${ALIKHAN.id}:${ALIKHAN.name}:${LABEL}`, async (logOf) => {
    resetLog = logOf();
  });
  const after = await counts(db);

  await step('у второго арендатора счётчики по всем 20 таблицам не изменились ни на строку', () => {
    const sosedAfter = forTenant(after, SOSED.id);
    for (const table of DATA_TABLES) {
      assert.equal(sosedAfter[table], sosedBefore[table], `таблица ${table} соседа изменилась: было ${sosedBefore[table]}, стало ${sosedAfter[table]}`);
    }
    console.log(`    сосед (арендатор ${SOSED.id}), таблиц сверено ${DATA_TABLES.length}: ${DATA_TABLES.map((t) => `${t}=${sosedAfter[t]}`).join(', ')}`);
  });

  await step('после сброса очищаемые таблицы арендатора 1 содержат 0 строк', () => {
    const alikhanAfter = forTenant(after, ALIKHAN.id);
    for (const table of RESET_TABLES) assert.equal(alikhanAfter[table], 0, `${table}: осталось ${alikhanAfter[table]} строк`);
    console.log(`    очищено: ${RESET_TABLES.map((t) => `${t}=${alikhanAfter[t]}`).join(', ')}`);
  });

  await step('сохраняемые таблицы арендатора 1 целы: то же число строк, что до сброса', () => {
    const alikhanAfter = forTenant(after, ALIKHAN.id);
    for (const table of KEPT_TABLES) {
      assert.equal(alikhanAfter[table], alikhanBefore[table], `${table}: было ${alikhanBefore[table]}, стало ${alikhanAfter[table]}`);
    }
    console.log(`    сохранено: ${KEPT_TABLES.map((t) => `${t}=${alikhanAfter[t]} (было ${alikhanBefore[t]})`).join(', ')}`);
  });

  await step('график записан всем сотрудникам в штате: 7 дней, 08:00-20:00, перерыв 13:00-14:00', async () => {
    const employed = await asTenant(db, ALIKHAN.id, 'SELECT count(*)::int AS n FROM staff WHERE employed = true');
    const rows = await asTenant(db, ALIKHAN.id, 'SELECT master_id, weekday, is_working, work_start, work_end, break_start, break_end FROM master_weekly_schedule ORDER BY master_id, weekday');
    assert.equal(rows.rows.length, employed.rows[0].n * 7, `строк графика ${rows.rows.length}, а сотрудников в штате ${employed.rows[0].n}`);
    for (const row of rows.rows) {
      assert.equal(row.is_working, true);
      assert.equal(row.work_start, '08:00');
      assert.equal(row.work_end, '20:00');
      assert.equal(row.break_start, '13:00');
      assert.equal(row.break_end, '14:00');
    }
    const fired = rows.rows.filter((r) => r.master_id.endsWith('-fired'));
    assert.equal(fired.length, 0, 'уволенному график не пишется');
    console.log(`    master_weekly_schedule: ${rows.rows.length} строк = 7 × ${employed.rows[0].n} сотрудников в штате, все 08:00-20:00 с перерывом 13:00-14:00`);
  });

  await step('в логе старта построчные счётчики удалённого и напоминание убрать переменную', () => {
    for (const table of RESET_TABLES) assert.match(resetLog, new RegExp(`${table}: удалено строк \\d+`));
    assert.match(resetLog, /Барбершоп Алихан/);
    assert.match(resetLog, /RESET_TENANT_DATA из панели/);
    console.log(resetLog.split('\n').filter((line) => /удалено строк|снято строк графика|график 08:00|снимок для отката|Сброс данных/.test(line)).map((l) => `    ${l.trim()}`).join('\n'));
  });

  await step('снимок отката покрывает и прежний недельный график, а не только восемь очищенных таблиц', async () => {
    const res = await asTenant(db, ALIKHAN.id, 'SELECT value FROM kv_store WHERE key = $1', [snapshotKey(LABEL)]);
    assert.equal(res.rows.length, 1, 'снимок отката не найден');
    const snapshot = JSON.parse(res.rows[0].value);
    assert.deepEqual(Object.keys(snapshot.tables), SNAPSHOT_TABLES);
    assert.equal(snapshot.tables.master_weekly_schedule.length, scheduleBefore.length, 'в снимок попали не все строки прежнего графика');
    console.log(`    снимок: таблиц ${SNAPSHOT_TABLES.length}, строк прежнего графика ${snapshot.tables.master_weekly_schedule.length}, строк клиентов ${snapshot.tables.clients.length}`);
  });

  // ── 2. Повторный старт с той же меткой ───────────────────────────────────
  await asTenant(db, ALIKHAN.id, `INSERT INTO bookings (id, tenant_id, master_id, date, start_time, end_time, status) VALUES ('posle-sbrosa', $1, 'alikhan-master', $2, '12:00', '12:40', 'planned')`, [ALIKHAN.id, day]);
  await runServer(`${ALIKHAN.id}:${ALIKHAN.name}:${LABEL}`, async (logOf) => {
    await step('второй запуск с той же меткой: applied false, ни одного DELETE', async () => {
      assert.match(logOf(), /уже выполнен/, 'в логе должен быть отказ по метке');
      const live = await asTenant(db, ALIKHAN.id, "SELECT count(*)::int AS n FROM bookings WHERE id = 'posle-sbrosa'");
      assert.equal(live.rows[0].n, 1, 'запись, созданная после сброса, обязана пережить повторный старт - иначе DELETE всё-таки был');
      const snapshots = await asTenant(db, ALIKHAN.id, 'SELECT count(*)::int AS n FROM kv_store WHERE key = $1', [snapshotKey(LABEL)]);
      assert.equal(snapshots.rows[0].n, 1, 'снимок отката не переписан вторым прогоном');
      console.log('    второй прогон: applied false, запись «posle-sbrosa» на месте, снимок не переписан');
    });
  });
  await asTenant(db, ALIKHAN.id, "DELETE FROM bookings WHERE id = 'posle-sbrosa'");

  // ── 3. Обратимость ───────────────────────────────────────────────────────
  await step('восстановление из снимка kv_store вернуло исходные счётчики по всем восьми таблицам', async () => {
    const { snapshot, restored } = await restoreFromSnapshot(db, ALIKHAN.id, LABEL);
    assert.equal(snapshot.tenantId, ALIKHAN.id);
    const back = forTenant(await counts(db), ALIKHAN.id);
    for (const table of RESET_TABLES) {
      assert.equal(back[table], alikhanBefore[table], `${table}: восстановлено ${back[table]}, а было ${alikhanBefore[table]}`);
    }
    console.log(`    восстановлено из снимка: ${RESET_TABLES.map((t) => `${t}=${restored[t]}`).join(', ')}`);

    // Не только число строк: дата записи обязана вернуться той же, а не съехать на день
    const dates = await asTenant(db, ALIKHAN.id, 'SELECT id, date::text AS date, start_time FROM bookings ORDER BY id');
    assert.equal(dates.rows.length, 3);
    for (const row of dates.rows) assert.equal(row.date, day, `дата записи ${row.id} уехала: ${row.date}`);
    console.log(`    даты записей после восстановления: ${dates.rows.map((r) => `${r.id} ${r.date} ${r.start_time}`).join(', ')}`);
  });

  await step('восстановление вернуло и прежний недельный график строка в строку', async () => {
    const scheduleBack = await weeklySchedule(db, ALIKHAN.id);
    assert.deepEqual(scheduleBack, scheduleBefore, 'прежний график после восстановления обязан совпасть строка в строку');
    const hours = new Set(scheduleBack.map((r) => `${r.work_start}-${r.work_end}`));
    console.log(`    недельный график после восстановления: строк ${scheduleBack.length}, часы ${[...hours].join(', ')} (график сброса 08:00-20:00 снят)`);
  });

  await step('сосед не пострадал и после восстановления', async () => {
    const sosedAfter = forTenant(await counts(db), SOSED.id);
    assert.deepEqual(sosedAfter, sosedBefore);
  });

  // ── 4. Снятие снимка после подтверждения первого дня ─────────────────────
  // Снимок держит полные строки клиентов с телефонами и нужен только до того, как
  // заказчик подтвердит первый день. Убирается тем же каноническим механизмом
  const legacyBefore = await asTenant(db, ALIKHAN.id, "SELECT count(*)::int AS n FROM kv_store WHERE key = 'legacy-okno-7'");
  await runServer(undefined, async (logOf) => {
    await step('снимок снят переменной, чужие строки kv_store целы', async () => {
      const gone = await asTenant(db, ALIKHAN.id, 'SELECT count(*)::int AS n FROM kv_store WHERE key = $1', [snapshotKey(LABEL)]);
      assert.equal(gone.rows[0].n, 0, 'снимок обязан исчезнуть');
      const legacyAfter = await asTenant(db, ALIKHAN.id, "SELECT count(*)::int AS n FROM kv_store WHERE key = 'legacy-okno-7'");
      assert.equal(legacyAfter.rows[0].n, legacyBefore.rows[0].n, 'соседние строки kv_store не трогаются');
      const sosedKv = await asTenant(db, SOSED.id, 'SELECT count(*)::int AS n FROM kv_store');
      assert.equal(sosedKv.rows[0].n, sosedBefore.kv_store, 'kv_store соседа не тронут');
      assert.match(logOf(), /удалён: строк 1/);
      console.log(`    ${logOf().split('\n').find((l) => /удалён: строк/.test(l))?.trim()}`);
    });
  }, { [DROP_SNAPSHOT_VARIABLE]: `${ALIKHAN.id}:${ALIKHAN.name}:${LABEL}` });

  await runServer(undefined, async (logOf) => {
    await step('повторное снятие снимка: честный лог «убирать нечего», приложение живо', async () => {
      assert.match(logOf(), /убирать нечего/);
      assert.equal((await fetch(`${BASE}/health`)).status, 200);
      console.log(`    ${logOf().split('\n').find((l) => /убирать нечего/.test(l))?.trim()}`);
    });
  }, { [DROP_SNAPSHOT_VARIABLE]: `${ALIKHAN.id}:${ALIKHAN.name}:${LABEL}` });

  await runServer(undefined, async (logOf) => {
    await step('снятие снимка у чужого арендатора не проходит по вертикали', async () => {
      assert.match(logOf(), /вертикаль «clinic»/);
      const sosedKv = await asTenant(db, SOSED.id, 'SELECT count(*)::int AS n FROM kv_store');
      assert.equal(sosedKv.rows[0].n, sosedBefore.kv_store, 'ни одна строка kv_store клиники не тронута');
      console.log('    попытка снять снимок у клиники отклонена, kv_store клиники цел');
    });
  }, { [DROP_SNAPSHOT_VARIABLE]: `${SOSED.id}:${SOSED.name}:${LABEL}` });

  await db.end();
  console.log(`\nГотово: ${results.length} проверок, все зелёные`);
}

main().catch((err) => {
  console.error('\nПРОГОН КРАСНЫЙ:', err.message);
  process.exit(1);
});
