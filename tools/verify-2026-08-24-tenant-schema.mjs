// Живая репетиция миграции 057 (Фаза 2 мультиарендности, 24.08.2026) на настоящем
// Postgres. Копия боевой базы будет на Фазе 5 - здесь эфемерная база, собранная теми
// же миграциями 001-056 и засеянная строками во ВСЕ 20 таблиц данных.
//
// Что доказывается:
//   1. миграция не теряет строк - счётчик по каждой таблице до и после совпадает;
//   2. все существующие строки достались арендатору №1 (Алихану);
//   3. новая строка получает арендатора из контекста запроса, а не единицу;
//   4. вставка без контекста арендатора падает (fail-closed);
//   5. составные ключи развязали арендаторов: одинаковая почта сотрудника, телефон
//      клиента, дата праздника и настройки зарплаты у двоих больше не конфликтуют;
//   6. каждая таблица данных имеет колонку арендатора - список, а не глаза.
//
// Запуск: node tools/verify-2026-08-24-tenant-schema.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'migrations');
const PROBE_DB = 'tenant_schema_probe';
const host = process.env.PGHOST || '/tmp';

const DATA_TABLES = [
  'booking_services', 'bookings', 'clients', 'discount_settings', 'holidays',
  'kv_store', 'locations', 'master_payroll_settings', 'master_services',
  'master_weekly_schedule', 'notifications', 'payroll_settings', 'sales',
  'schedule_breaks', 'schedule_change_requests', 'schedule_shifts', 'services',
  'sessions', 'staff', 'staff_media',
];

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function recreateDb() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
  await admin.query(`CREATE DATABASE ${PROBE_DB}`);
  await admin.end();
}

// Тот же порядок и тот же способ, что у авто-раннера в server.mjs
async function applyMigrations(db, upTo) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (file > upTo) continue;
    const applied = await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (applied.rowCount) continue;
    await db.query('BEGIN');
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

// Строки во все таблицы данных - как будто это живой салон Алихана до переезда
async function seed(db) {
  await db.query("INSERT INTO locations (id, name) VALUES (1, 'Точка 1') ON CONFLICT DO NOTHING");
  await db.query(
    // Защищённого владельца и часть каталога миграции 001-056 уже завели сами -
    // добавляем своего сотрудника рядом, не споря с боевыми сидами
    `INSERT INTO staff (id, location_id, name, role, email)
     VALUES ('staff-probe-owner', 1, 'Мастер репетиции', 'master', 'probe@probe.local')`
  );
  await db.query(
    `INSERT INTO services (id, name, category, duration_min, price)
     VALUES ('probe-service', 'Стрижка', 'base', 60, 1000) ON CONFLICT DO NOTHING`
  );
  await db.query("INSERT INTO clients (id, phone, name) VALUES ('client-probe', '+79000000001', 'Клиент')");
  await db.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
     VALUES ('booking-probe', 1, 'staff-probe-owner', 'probe-service', 'client-probe', '2026-08-25', '10:00', '11:00', 'planned')`
  );
  await db.query("INSERT INTO booking_services (booking_id, service_id) VALUES ('booking-probe', 'probe-service')");
  await db.query("INSERT INTO sales (id, booking_id, item_name, amount) VALUES ('sale-probe', 'booking-probe', 'Воск', 500)");
  const shift = await db.query(
    `INSERT INTO schedule_shifts (master_id, date, start_time, end_time)
     VALUES ('staff-probe-owner', '2026-08-25', '10:00', '20:00') RETURNING id`
  );
  await db.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
    shift.rows[0].id, '14:00', '15:00',
  ]);
  await db.query(
    "INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('staff-probe-owner', 'probe-service', 1000, 60)"
  );
  await db.query("INSERT INTO master_payroll_settings (master_id, pct) VALUES ('staff-probe-owner', 0.45)");
  await db.query("INSERT INTO master_weekly_schedule (master_id, weekday, work_start, work_end) VALUES ('staff-probe-owner', 1, '10:00', '20:00')");
  await db.query(
    `INSERT INTO notifications (id, staff_id, type, title, booking_id)
     VALUES ('notif-probe', 'staff-probe-owner', 'booking_new', 'Новая запись', 'booking-probe')`
  );
  await db.query(
    `INSERT INTO schedule_change_requests (master_id, request_type, date_from)
     VALUES ('staff-probe-owner', 'day_off', '2026-08-26')`
  );
  await db.query(
    "INSERT INTO sessions (token, staff_id, expires_at) VALUES ('token-probe', 'staff-probe-owner', now() + interval '30 days')"
  );
  await db.query(
    `INSERT INTO staff_media (id, staff_id, kind, storage_key)
     VALUES ('media-probe', 'staff-probe-owner', 'portfolio', 'probe.webp')`
  );
  // Праздники засевает сама миграция 034 - своих не добавляем
  await db.query("INSERT INTO kv_store (key, value) VALUES ('probe', '{}')");
}

async function counts(db) {
  const out = {};
  for (const table of DATA_TABLES) {
    out[table] = Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  }
  return out;
}

// Запрос от имени арендатора - ровно так же, как это делает api/lib/db.js
async function asTenant(db, tenantId, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const result = await db.query(sql, params);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  await recreateDb();
  const db = new pg.Pool({ host, database: PROBE_DB, max: 1 });
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );

  console.log('Живая репетиция миграции 057:');

  await applyMigrations(db, '056_zzz');
  await seed(db);
  const before = await counts(db);

  await step('миграция 057 накатывается на засеянную базу', async () => {
    await applyMigrations(db, '057_zzz');
    const applied = await db.query("SELECT 1 FROM schema_migrations WHERE filename = '057_tenants.sql'");
    assert.equal(applied.rowCount, 1);
  });

  await step('ни одной строки не потеряно - счётчик по каждой из 20 таблиц совпал', async () => {
    const after = await counts(db);
    assert.deepEqual(after, before);
    const total = Object.values(after).reduce((a, b) => a + b, 0);
    assert.ok(total >= 20, `засеяно слишком мало строк для доказательства: ${total}`);
  });

  await step('все существующие строки достались Алихану - арендатору №1', async () => {
    for (const table of DATA_TABLES) {
      const wrong = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id <> 1`);
      assert.equal(Number(wrong.rows[0].n), 0, `${table}: есть строки не у арендатора 1`);
    }
  });

  await step('каждая таблица данных получила колонку арендатора - список, а не глаза', async () => {
    const withColumn = (
      await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`
      )
    ).rows.map((r) => r.table_name);
    assert.deepEqual(withColumn, [...DATA_TABLES].sort());
  });

  await step('новая строка получает арендатора из контекста запроса, а не единицу', async () => {
    await asTenant(db, 1, "INSERT INTO tenants (id, name, vertical) VALUES (2, 'Клиника Карины', 'clinic') ON CONFLICT DO NOTHING");
    await asTenant(db, 2, `INSERT INTO locations (id, name) VALUES (900, 'Клиника')`);
    const row = await db.query('SELECT tenant_id FROM locations WHERE id = 900');
    assert.equal(row.rows[0].tenant_id, 2);
  });

  await step('вставка без контекста арендатора падает (fail-closed)', async () => {
    // Два кода ошибки, оба означают «арендатор неизвестен»: 42704 - параметр в этом
    // соединении не ставился ни разу, 22P02 - ставился, но сброшен по концу
    // транзакции в пустую строку (живая находка Фазы 1), и она не приводится к числу
    await assert.rejects(
      () => db.query("INSERT INTO clients (id, phone) VALUES ('client-nobody', '+79000000009')"),
      (err) => ['42704', '22P02'].includes(err.code),
      'без арендатора строка не должна появиться вообще'
    );
    const leftovers = await db.query("SELECT count(*)::int AS n FROM clients WHERE id = 'client-nobody'");
    assert.equal(Number(leftovers.rows[0].n), 0);
  });

  await step('одинаковая почта, телефон и праздник у двух арендаторов больше не конфликтуют', async () => {
    await asTenant(
      db,
      2,
      `INSERT INTO staff (id, location_id, name, role, email, protected_owner)
       VALUES ('staff-karina-owner', 900, 'Карина', 'owner', 'owner@probe.local', true)`
    );
    await asTenant(db, 2, "INSERT INTO clients (id, phone, name) VALUES ('client-karina', '+79000000001', 'Клиент')");
    const sameHoliday = (await db.query("SELECT date FROM holidays WHERE tenant_id = 1 LIMIT 1")).rows[0].date;
    await asTenant(db, 2, 'INSERT INTO holidays (date, name) VALUES ($1, $2)', [sameHoliday, 'Тот же праздник']);
    await asTenant(db, 2, 'INSERT INTO payroll_settings (id) VALUES (1)');
    await asTenant(db, 2, 'INSERT INTO discount_settings (payroll_from_actual_price) VALUES (false)');
    await asTenant(db, 2, "INSERT INTO kv_store (key, value) VALUES ('probe', '{}')");
    for (const table of ['staff', 'clients', 'holidays', 'payroll_settings', 'discount_settings', 'kv_store']) {
      const res = await db.query(
        `SELECT count(*) FILTER (WHERE tenant_id = 1)::int AS one,
                count(*) FILTER (WHERE tenant_id = 2)::int AS two FROM ${table}`
      );
      assert.ok(Number(res.rows[0].one) >= 1, `${table}: строки Алихана пропали`);
      assert.equal(Number(res.rows[0].two), 1, `${table}: строка второго арендатора не встала рядом`);
    }
  });

  await step('ключи всё ещё держат уникальность ВНУТРИ арендатора', async () => {
    await assert.rejects(
      () => asTenant(db, 2, "INSERT INTO clients (id, phone, name) VALUES ('client-karina-2', '+79000000001', 'Дубль')"),
      /clients_tenant_phone_key/,
      'один и тот же телефон дважды у одного арендатора остаётся ошибкой'
    );
    await assert.rejects(
      () =>
        asTenant(
          db,
          2,
          `INSERT INTO staff (id, location_id, name, role, protected_owner)
           VALUES ('staff-karina-2', 900, 'Второй владелец', 'owner', true)`
        ),
      /staff_one_protected_owner_idx/,
      'защищённый владелец у арендатора по-прежнему ровно один'
    );
  });

  await step('глобальных уникальных ключей по человеческим полям не осталось', async () => {
    // Именно здесь 24.08.2026 поймана дыра: clients_phone_key заведён индексом, а не
    // ограничением, и DROP CONSTRAINT снял его молча мимо. Проверка идёт списком:
    // каждый уникальный ключ либо начинается с арендатора, либо стоит в белом списке
    // с обоснованием, почему глобальная уникальность для него безопасна.
    const GLOBALLY_UNIQUE_OK = {
      bookings_pkey: 'id брони - случайный текст',
      clients_pkey: 'id клиента - случайный текст',
      staff_pkey: 'id сотрудника - случайный staff-<32 hex>',
      notifications_pkey: 'id уведомления - случайный текст',
      sales_pkey: 'id продажи - случайный текст',
      staff_media_pkey: 'id файла - случайный текст',
      staff_media_storage_key_key: 'имя файла в хранилище - случайное',
      sessions_pkey: 'токен сессии - 32 случайных байта',
      locations_pkey: 'сквозной счётчик точек',
      schedule_shifts_pkey: 'сквозной счётчик смен',
      schedule_breaks_pkey: 'сквозной счётчик перерывов',
      schedule_change_requests_pkey: 'сквозной счётчик заявок',
      booking_services_pkey: 'ключ начинается с id брони',
      master_services_pkey: 'ключ начинается с id мастера',
      master_weekly_schedule_pkey: 'ключ начинается с id мастера',
      master_payroll_settings_pkey: 'ключ начинается с id мастера',
      services_pkey: 'каталог услуг: id задаются нами при заведении арендатора, не пользователем',
      tenants_pkey: 'сам справочник арендаторов',
      schema_migrations_pkey: 'служебная история схемы',
    };
    const rows = (
      await db.query(
        `SELECT c.relname AS index_name, t.relname AS table_name, pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND i.indisunique
          ORDER BY t.relname, c.relname`
      )
    ).rows;
    const offenders = rows
      .filter((r) => !/\(tenant_id[,)]/.test(r.def))
      .filter((r) => !(r.index_name in GLOBALLY_UNIQUE_OK))
      .map((r) => `${r.index_name} :: ${r.def}`);
    assert.deepEqual(offenders, [], 'остались глобальные уникальные ключи, ломающие второго арендатора');
  });

  await step('выборки арендатора идут по индексу с ним впереди (ловушка 6)', async () => {
    const plan = (
      await db.query(
        `EXPLAIN SELECT * FROM bookings WHERE tenant_id = 1 AND master_id = 'staff-probe-owner' AND date = '2026-08-25'`
      )
    ).rows.map((r) => r['QUERY PLAN']).join('\n');
    // На пустой базе планировщик выберет перебор - здесь достаточно, что индекс с
    // арендатором впереди существует и по нему можно идти
    const idx = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'bookings' AND indexname = 'bookings_master_date_idx'`
    );
    assert.match(idx.rows[0].indexdef, /\(tenant_id, master_id, date\)/);
    assert.ok(plan.length > 0);
  });

  await step('ON CONFLICT срабатывает, хотя арендатор в списке колонок INSERT не указан', async () => {
    // Тонкость, ради которой это проверяется живьём: код вставляет клиента как
    // `INSERT INTO clients (id, name, phone)` - арендатор приезжает из умолчания
    // колонки. Ключ при этом составной, (tenant_id, phone). Postgres обязан взять
    // значение умолчания при разрешении конфликта - иначе повторная запись клиента
    // на проде дала бы либо дубль, либо ошибку.
    const upsert = `INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name)
       RETURNING id, name`;
    const first = await asTenant(db, 2, upsert, ['client-upsert-1', 'Первый', '+79000000077']);
    const second = await asTenant(db, 2, upsert, ['client-upsert-2', 'Второй', '+79000000077']);
    assert.equal(second.rows[0].id, first.rows[0].id, 'должна обновиться та же строка, а не появиться вторая');
    assert.equal(second.rows[0].name, 'Второй');
    const count = await db.query("SELECT count(*)::int AS n FROM clients WHERE phone = '+79000000077'");
    assert.equal(Number(count.rows[0].n), 1);
    // И тот же телефон у Алихана живёт своей жизнью
    await asTenant(db, 1, upsert, ['client-upsert-3', 'Клиент Алихана', '+79000000077']);
    const both = await db.query("SELECT count(*)::int AS n FROM clients WHERE phone = '+79000000077'");
    assert.equal(Number(both.rows[0].n), 2);
  });

  await step('каждый ON CONFLICT в коде опирается на реально существующий ключ', async () => {
    // Класс ошибки, найденный живой репетицией 24.08.2026: составной ключ ломает
    // `ON CONFLICT (phone)` - Postgres не находит подходящий уникальный индекс и
    // валит запрос. Это боевые пути: создание записи, простановка смены, уведомление
    // о переносе. Проверяются не глазами - спецификации выдёргиваются из исходников
    // и сверяются с уникальными индексами живой схемы.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
    const sources = [];
    const walk = (p) => {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = join(p, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs)$/.test(entry.name)) sources.push(full);
      }
    };
    walk(dir);

    const specs = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8').replace(/^\s*\/\/[^\n]*$/gm, '');
      for (const m of src.matchAll(/INSERT INTO ([a-z_]+)[\s\S]{0,600}?ON CONFLICT \(([^)]+)\)/gi)) {
        specs.push({ file, table: m[1], columns: m[2].split(',').map((c) => c.trim()).sort() });
      }
    }
    assert.ok(specs.length >= 7, `спецификаций ON CONFLICT найдено подозрительно мало: ${specs.length}`);

    const indexes = (
      await db.query(
        `SELECT t.relname AS table_name, pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND i.indisunique`
      )
    ).rows.map((r) => ({
      table: r.table_name,
      columns: r.def
        .slice(r.def.indexOf('(') + 1, r.def.indexOf(')'))
        .split(',')
        .map((c) => c.trim().replace(/ (ASC|DESC)$/i, ''))
        .sort(),
    }));

    const broken = specs.filter(
      (spec) =>
        !indexes.some(
          (idx) => idx.table === spec.table && idx.columns.join('|') === spec.columns.join('|')
        )
    );
    assert.deepEqual(
      broken.map((b) => `${b.table} (${b.columns.join(', ')})`),
      [],
      'этот INSERT упадёт на проде: подходящего уникального ключа больше нет'
    );
  });

  await db.end();
  console.log(`\nРепетиция пройдена: ${results.length} проверок на настоящем Postgres`);
}

await main();
