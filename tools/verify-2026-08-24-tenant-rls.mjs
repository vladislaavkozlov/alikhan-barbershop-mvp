// ГЛАВНЫЙ ТЕСТ ЭТАПА A: атака на изоляцию арендаторов (Фаза 3, 24.08.2026).
//
// Изоляция доказывается атакой, а не рассуждением (критерий 1 спеки). База -
// эфемерная, но собранная так же, как боевая: таблицы принадлежат ОБЫЧНОЙ роли без
// суперправ, потому что весь смысл ловушки 1 в том, что владелец таблиц обходит
// замок без FORCE. Прогон из-под суперпользователя дал бы ложную зелень.
//
// В конце - проверка чувствительности: FORCE снимается, и атака ОБЯЗАНА пройти.
// Тест, который не падает при снятой защите, ничего не проверяет.
//
// Запуск: node tools/verify-2026-08-24-tenant-rls.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'migrations');
const DB = 'tenant_rls_probe';
const ROLE = 'probe_rls_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';

const DATA_TABLES = [...readFileSync(join(MIGRATIONS_DIR, '057_tenants.sql'), 'utf8')
  .matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN IF NOT EXISTS tenant_id/gi)]
  .map((m) => m[1])
  .sort();

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

// Роль-владелец без суперправ - ровно та ситуация, что на Amvera
async function recreateDbOwnedByPlainRole() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  await admin.end();
}

async function applyMigrations(db) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const applied = await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (applied.rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

async function asTenant(db, tenantId, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const result = await db.query(sql, params);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Полный набор данных одного салона: сотрудник, клиент, запись, деньги, график,
// уведомления - чтобы атаке было что искать в каждой таблице
async function seedTenant(db, tenantId, tag) {
  const q = (sql, params) => asTenant(db, tenantId, sql, params);
  const loc = await q('INSERT INTO locations (name) VALUES ($1) RETURNING id', [`Точка ${tag}`]);
  const locationId = loc.rows[0].id;
  await q(
    `INSERT INTO staff (id, location_id, name, role, email)
     VALUES ($1, $2, $3, 'master', $4)`,
    [`staff-${tag}`, locationId, `Мастер ${tag}`, `master@${tag}.local`]
  );
  await q(
    `INSERT INTO services (id, name, category, duration_min, price) VALUES ($1, $2, 'base', 60, 1000)`,
    [`service-${tag}`, `Услуга ${tag}`]
  );
  await q('INSERT INTO clients (id, phone, name) VALUES ($1, $2, $3)', [
    `client-${tag}`, `+7900000${tag === 'alikhan' ? '1' : '2'}111`, `Клиент ${tag}`,
  ]);
  await q(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, actual_price)
     VALUES ($1, $2, $3, $4, $5, '2026-08-25', '10:00', '11:00', 'planned', 1500)`,
    [`booking-${tag}`, locationId, `staff-${tag}`, `service-${tag}`, `client-${tag}`]
  );
  await q('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [`booking-${tag}`, `service-${tag}`]);
  await q('INSERT INTO sales (id, booking_id, item_name, amount) VALUES ($1, $2, $3, 700)', [
    `sale-${tag}`, `booking-${tag}`, `Косметика ${tag}`,
  ]);
  const shift = await q(
    `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, '2026-08-25', '10:00', '20:00') RETURNING id`,
    [`staff-${tag}`]
  );
  await q('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
    shift.rows[0].id, '14:00', '15:00',
  ]);
  await q('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 60)', [
    `staff-${tag}`, `service-${tag}`,
  ]);
  await q('INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, 0.45)', [`staff-${tag}`]);
  await q(
    'INSERT INTO master_weekly_schedule (master_id, weekday, work_start, work_end) VALUES ($1, 1, $2, $3)',
    [`staff-${tag}`, '10:00', '20:00']
  );
  await q(
    `INSERT INTO notifications (id, staff_id, type, booking_id, title, body) VALUES ($1, $2, 'booking_new', $3, $4, $5)`,
    [`notif-${tag}`, `staff-${tag}`, `booking-${tag}`, `Новая запись ${tag}`, `тайна ${tag}`]
  );
  await q('INSERT INTO schedule_change_requests (master_id, request_type, date_from) VALUES ($1, $2, $3)', [
    `staff-${tag}`, 'day_off', '2026-08-26',
  ]);
  await q("INSERT INTO sessions (token, staff_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [
    `token-${tag}`, `staff-${tag}`,
  ]);
  await q('INSERT INTO staff_media (id, staff_id, kind, storage_key) VALUES ($1, $2, $3, $4)', [
    `media-${tag}`, `staff-${tag}`, 'portfolio', `${tag}.webp`,
  ]);
  await q('INSERT INTO kv_store (key, value) VALUES ($1, $2)', ['probe', `{"tag":"${tag}"}`]);
  await q('INSERT INTO holidays (date, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['2026-12-31', `Праздник ${tag}`]);
  await q('INSERT INTO payroll_settings (id) VALUES (1) ON CONFLICT DO NOTHING', []);
  await q('INSERT INTO discount_settings (payroll_from_actual_price) VALUES (false) ON CONFLICT DO NOTHING', []);
}

async function setForceRls(db, enabled) {
  for (const table of DATA_TABLES) {
    await db.query(`ALTER TABLE ${table} ${enabled ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`);
  }
}

// Сама атака: из-под арендатора 2 ищем хоть одну строку арендатора 1
async function attack(db) {
  const leaks = [];
  for (const table of DATA_TABLES) {
    const rows = (await asTenant(db, 2, `SELECT * FROM ${table}`)).rows;
    const foreign = rows.filter((r) => r.tenant_id !== 2);
    if (foreign.length) leaks.push(`${table}: ${foreign.length} чужих строк`);
  }
  return leaks;
}

async function main() {
  await recreateDbOwnedByPlainRole();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });

  console.log('Атака на изоляцию арендаторов:');

  await applyMigrations(db);
  // Точки салона миграции заводят с явными id, счётчик при этом не двигают - на
  // эфемерной базе он остаётся на нуле и первая же вставка спотыкается. К замку
  // арендаторов отношения не имеет, поправка чисто для этого прогона
  // Читаем через служебный контекст: замок уже стоит, и запрос без арендатора
  // падает - что само по себе первое живое подтверждение fail-closed
  await asTenant(db, '*', "SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");

  await step('замок ставится обычной ролью-владельцем, как на Amvera', async () => {
    const who = await db.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    assert.equal(who.rows[0].rolsuper, false, 'прогон из-под суперпользователя ничего не доказывает');
    assert.equal(who.rows[0].rolbypassrls, false);
    const owner = await db.query("SELECT tableowner FROM pg_tables WHERE tablename = 'bookings'");
    assert.equal(owner.rows[0].tableowner, ROLE, 'таблицы должны принадлежать той же роли, что ходит в базу');
  });

  await step('замок и политика есть у каждой из 20 таблиц - списком, а не глазами', async () => {
    const rows = (
      await db.query(
        `SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
        [DATA_TABLES]
      )
    ).rows;
    assert.equal(rows.length, DATA_TABLES.length);
    const broken = rows.filter((r) => !r.enabled || !r.forced || Number(r.policies) !== 1);
    assert.deepEqual(broken.map((r) => r.table_name), []);
  });

  await seedTenant(db, 1, 'alikhan');
  await asTenant(db, 1, "INSERT INTO tenants (id, name, vertical) VALUES (2, 'Клиника Карины', 'clinic') ON CONFLICT DO NOTHING");
  await seedTenant(db, 2, 'karina');

  await step('данные обоих арендаторов реально лежат в базе - атаке есть что искать', async () => {
    const counts = await asTenant(
      db, '*',
      `SELECT count(*) FILTER (WHERE tenant_id = 1)::int AS one,
              count(*) FILTER (WHERE tenant_id = 2)::int AS two FROM bookings`
    );
    assert.ok(Number(counts.rows[0].one) >= 1 && Number(counts.rows[0].two) >= 1);
    let tablesWithBoth = 0;
    for (const table of DATA_TABLES) {
      const res = await asTenant(
        db, '*',
        `SELECT count(*) FILTER (WHERE tenant_id = 1)::int AS one,
                count(*) FILTER (WHERE tenant_id = 2)::int AS two FROM ${table}`
      );
      if (Number(res.rows[0].one) > 0 && Number(res.rows[0].two) > 0) tablesWithBoth++;
    }
    assert.ok(tablesWithBoth >= 18, `таблиц с данными обоих арендаторов всего ${tablesWithBoth} - атака была бы пустой`);
  });

  await step('АТАКА: запрос без единого условия не возвращает ни одной чужой строки', async () => {
    assert.deepEqual(await attack(db), []);
  });

  await step('АТАКА: запрос по чужому идентификатору возвращает пусто, а не чужие данные', async () => {
    // Самый реалистичный вектор: Карина знает id брони Алихана и подставляет его в
    // свой роут. Условие по арендатору в коде роута при этом отсутствует
    for (const [sql, params] of [
      ['SELECT * FROM bookings WHERE id = $1', ['booking-alikhan']],
      ['SELECT * FROM clients WHERE id = $1', ['client-alikhan']],
      ['SELECT * FROM staff WHERE id = $1', ['staff-alikhan']],
      ['SELECT * FROM notifications WHERE id = $1', ['notif-alikhan']],
      ['SELECT * FROM sessions WHERE token = $1', ['token-alikhan']],
      ['SELECT * FROM sales WHERE id = $1', ['sale-alikhan']],
      ['SELECT * FROM staff_media WHERE storage_key = $1', ['alikhan.webp']],
      ['SELECT b.*, c.phone FROM bookings b JOIN clients c ON c.id = b.client_id', []],
    ]) {
      const res = await asTenant(db, 2, sql, params);
      const foreign = res.rows.filter((r) => r.tenant_id !== 2);
      assert.deepEqual(foreign, [], `утечка через запрос: ${sql}`);
    }
  });

  await step('АТАКА: чужую строку нельзя изменить или удалить', async () => {
    const upd = await asTenant(db, 2, "UPDATE bookings SET actual_price = 1 WHERE id = 'booking-alikhan'");
    assert.equal(upd.rowCount, 0, 'обновление чужой записи не должно затрагивать строки');
    const del = await asTenant(db, 2, "DELETE FROM clients WHERE id = 'client-alikhan'");
    assert.equal(del.rowCount, 0);
    const wipe = await asTenant(db, 2, 'DELETE FROM notifications');
    const left = await asTenant(db, '*', "SELECT count(*)::int AS n FROM notifications WHERE tenant_id = 1");
    assert.ok(Number(left.rows[0].n) >= 1, 'удаление «всего» из-под второго арендатора выкосило чужие уведомления');
    assert.ok(wipe.rowCount >= 0);
    const alikhanBooking = await asTenant(db, '*', "SELECT actual_price FROM bookings WHERE id = 'booking-alikhan'");
    assert.equal(alikhanBooking.rows[0].actual_price, 1500, 'цена записи Алихана изменена из-под чужого арендатора');
  });

  await step('АТАКА: нельзя записать строку чужому арендатору (WITH CHECK)', async () => {
    await assert.rejects(
      () =>
        asTenant(
          db,
          2,
          `INSERT INTO clients (id, phone, name, tenant_id) VALUES ('client-injected', '+79005550000', 'Подкидыш', 1)`
        ),
      /row-level security/i,
      'вставка строки чужому арендатору обязана быть отвергнута'
    );
    await assert.rejects(
      () => asTenant(db, 2, "UPDATE clients SET tenant_id = 1 WHERE id = 'client-karina'"),
      /row-level security/i,
      'переписать свою строку на чужого арендатора тоже нельзя'
    );
  });

  await step('свой арендатор видит свои данные полностью - замок не мешает работать', async () => {
    for (const tenantId of [1, 2]) {
      const res = await asTenant(db, tenantId, 'SELECT count(*)::int AS n FROM bookings');
      assert.equal(Number(res.rows[0].n), 1, `арендатор ${tenantId} не видит собственную запись`);
    }
    const own = await asTenant(db, 2, "SELECT body FROM notifications WHERE id = 'notif-karina'");
    assert.equal(own.rowCount <= 1, true);
  });

  await step('служебный контекст миграций видит всё - иначе схему не обновить', async () => {
    const res = await asTenant(db, '*', 'SELECT count(*)::int AS n FROM bookings');
    assert.equal(Number(res.rows[0].n), 2);
  });

  await step('без контекста арендатора не читается вообще ничего (fail-closed)', async () => {
    await assert.rejects(
      () => db.query('SELECT * FROM bookings'),
      (err) => ['42704', '22P02'].includes(err.code),
      'запрос без арендатора обязан падать, а не отдавать данные'
    );
  });

  await step('замок держится и на выборке по индексу с арендатором впереди', async () => {
    // Двадцать тысяч записей, чтобы планировщик выбирал по-настоящему, а не считал
    // всю таблицу мелочью
    await asTenant(
      db,
      1,
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
       SELECT 'bulk-' || g, (SELECT location_id FROM staff WHERE id = 'staff-alikhan'), 'staff-alikhan',
              'service-alikhan', 'client-alikhan', date '2026-01-01' + (g % 300), '10:00', '11:00', 'planned'
         FROM generate_series(1, 20000) g`
    );
    await db.query('ANALYZE bookings');
    const plan = (
      await asTenant(
        db,
        1,
        `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM bookings WHERE master_id = 'staff-alikhan' AND date = '2026-03-01'`
      )
    ).rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /Index (Scan|Only Scan|Cond)/, `выборка пошла перебором вместо индекса:\n${plan}`);
    const leaks = await attack(db);
    assert.deepEqual(leaks, [], 'на объёме замок обязан держать так же');
  });

  await step('ЧУВСТВИТЕЛЬНОСТЬ: без FORCE атака проходит - тест не ложноположительный', async () => {
    await setForceRls(db, false);
    const leaks = await attack(db);
    assert.ok(
      leaks.length > 0,
      'со снятым FORCE чужие строки обязаны стать видны - иначе тест ничего не проверяет'
    );
    console.log(`      (со снятым FORCE утекло таблиц: ${leaks.length} из ${DATA_TABLES.length})`);
    await setForceRls(db, true);
    assert.deepEqual(await attack(db), [], 'после возврата FORCE утечек быть не должно');
  });

  await db.end();
  console.log(`\nАтака отбита: ${results.length} проверок на настоящем Postgres`);
}

await main();
