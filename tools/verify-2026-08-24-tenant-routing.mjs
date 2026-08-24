// Фаза 4 мультиарендности: арендатор по домену, живьём (24.08.2026).
//
// Два арендатора на разных доменах, у каждого ПОЛНЫЙ набор ролей - владелец,
// управляющий, администратор, мастер - и у обоих арендаторов сотрудники с
// ОДИНАКОВЫМИ почтами (ловушка 8 спеки). Поднимается настоящий api/server.mjs,
// дальше всё идёт настоящим HTTP.
//
// Что доказывается:
//   1. каждая роль каждого арендатора работает со своими данными;
//   2. ни в одном ответе ни одной роли нет ни следа чужого арендатора (критерий 1);
//   3. неизвестный домен получает 404, а не данные Алихана (критерий 4);
//   4. токен, выданный на одном домене, не действует на другом;
//   5. одинаковая почта в двух салонах - каждый входит к себе;
//   6. CORS разрешает домен арендатора и не разрешает чужой (ловушка 7);
//   7. проверка живости отвечает без домена вообще.
//
// Запуск: node tools/verify-2026-08-24-tenant-routing.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashPin } from '../api/lib/auth.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'migrations');
const DB = 'tenant_routing_probe';
const ROLE = 'probe_routing_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const PORT = 9101;
const BASE = `http://127.0.0.1:${PORT}`;

// Два салона на своих доменах. Роли - все, что знает система
const TENANTS = [
  { id: 1, tag: 'alikhan', domain: 'alikhan.test', title: 'Барбершоп Алихан' },
  { id: 2, tag: 'karina', domain: 'klinika.karina.test', title: 'Клиника Карины' },
];
const ROLES = ['owner', 'manager', 'admin', 'master'];

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

// Полный салон: точка, сотрудник на каждую роль, услуга, клиент, запись, смена.
// Почты НЕ уникальны между арендаторами - в этом и смысл проверки
async function seedTenant(db, { id, tag }) {
  const q = (sql, params) => asTenant(db, id, sql, params);
  const loc = await q('INSERT INTO locations (name) VALUES ($1) RETURNING id', [`Точка ${tag}`]);
  const locationId = loc.rows[0].id;
  for (const role of ROLES) {
    await q(
      `INSERT INTO staff (id, location_id, name, role, email, pin_hash, provides_services)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [`staff-${tag}-${role}`, locationId, `${role} ${tag}`, role, `${role}@shared.test`, hashPin('1234')]
    );
  }
  await q(`INSERT INTO services (id, name, category, duration_min, price) VALUES ($1, $2, 'base', 60, 1000)`, [
    `service-${tag}`, `Услуга ${tag}`,
  ]);
  await q('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 60)', [
    `staff-${tag}-master`, `service-${tag}`,
  ]);
  await q('INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, 0.45)', [`staff-${tag}-master`]);
  await q('INSERT INTO clients (id, phone, name) VALUES ($1, $2, $3)', [
    `client-${tag}`, `+7900${id}000111`, `Клиент ${tag}`,
  ]);
  await q(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, actual_price)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, '10:00', '11:00', 'done', 1500)`,
    [`booking-${tag}`, locationId, `staff-${tag}-master`, `service-${tag}`, `client-${tag}`]
  );
  await q(
    `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, CURRENT_DATE, '10:00', '20:00')`,
    [`staff-${tag}-master`]
  );
  // Недельный график - второй критерий бронируемости мастера (mastersWithWorkingSchedule)
  for (let weekday = 1; weekday <= 7; weekday++) {
    await q(
      'INSERT INTO master_weekly_schedule (master_id, weekday, work_start, work_end) VALUES ($1, $2, $3, $4)',
      [`staff-${tag}-master`, weekday, '10:00', '20:00']
    );
  }
  await q(
    `INSERT INTO notifications (id, staff_id, type, booking_id, title, body) VALUES ($1, $2, 'booking_new', $3, $4, $5)`,
    [`notif-${tag}`, `staff-${tag}-owner`, `booking-${tag}`, `Запись ${tag}`, `секрет-${tag}`]
  );
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // поднимается
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся');
}

const api = (path, { origin, token, method = 'GET', body } = {}) =>
  fetch(`${BASE}/${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: `https://${origin}` } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

// Роуты, которые кабинет дёргает у сервера. Права у ролей разные - здесь важно не
// «кому 200», а «никому ни строчки чужого»
const ROUTES = [
  'auth/me', 'staff', 'locations', 'services', 'master-services',
  'bookings?from=2020-01-01&to=2030-12-31', 'schedule-availability?masterId=&serviceId=',
  'holidays?year=2026', 'notifications', 'notifications/unread-count',
  'clients?all=true', 'payroll-settings', 'discount-settings', 'payroll',
  'revenue/today', 'owner/alerts', 'analytics/retention?months=3',
  'analytics/sources?months=3', 'analytics/lapsed', 'finance/missed-profit?from=2020-01-01&to=2030-12-31',
  'public/masters', 'changes',
];

async function main() {
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  await applyMigrations(db);
  await asTenant(db, '*', "SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");

  // Домены арендаторов: у Алихана к боевым добавляется тестовый, Карина заводится
  // строкой в справочнике - ровно так, как это будет при подключении настоящего
  // второго клиента (критерий 6: без правок кода и без новой миграции)
  await asTenant(db, '*', 'UPDATE tenants SET domains = domains || $1::text WHERE id = 1', [TENANTS[0].domain]);
  await asTenant(
    db, '*',
    `INSERT INTO tenants (id, name, vertical, domains) VALUES (2, $1, 'clinic', ARRAY[$2::text])
     ON CONFLICT (id) DO UPDATE SET domains = EXCLUDED.domains`,
    [TENANTS[1].title, TENANTS[1].domain]
  );
  for (const tenant of TENANTS) await seedTenant(db, tenant);

  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable',
      // Кэш справочника - 200 мс вместо минуты: прогон проверяет, что новый арендатор
      // становится известен сам, без перезапуска сервера, а не ждёт минуту
      TENANT_CACHE_TTL_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(String(d)));
  child.stderr.on('data', (d) => serverLog.push(String(d)));

  try {
    console.log('Арендатор по домену, живой прогон:');
    await waitForServer();

    const login = (domain, role) =>
      api('auth/login', { origin: domain, method: 'POST', body: { email: `${role}@shared.test`, pin: '1234' } });

    const tokens = {};

    await step('одинаковая почта в двух салонах - каждая роль входит к себе (ловушка 8)', async () => {
      for (const tenant of TENANTS) {
        tokens[tenant.tag] = {};
        for (const role of ROLES) {
          const res = await login(tenant.domain, role);
          const body = await res.json();
          assert.equal(res.status, 200, `${tenant.tag}/${role}: вход не прошёл - ${JSON.stringify(body)}`);
          assert.equal(body.staff.role, role);
          assert.match(
            body.staff.name,
            new RegExp(tenant.tag),
            `${tenant.tag}/${role}: вошёл не в свой салон - ${body.staff.name}`
          );
          tokens[tenant.tag][role] = body.token;
        }
      }
    });

    await step('каждая роль каждого арендатора видит только свои данные - 8 кабинетов', async () => {
      const problems = [];
      for (const tenant of TENANTS) {
        const foreign = TENANTS.find((t) => t.tag !== tenant.tag).tag;
        for (const role of ROLES) {
          let answered = 0;
          for (const route of ROUTES) {
            const res = await api(route, { origin: tenant.domain, token: tokens[tenant.tag][role] });
            const text = await res.text();
            if (res.status === 200) answered++;
            if (res.status >= 500) problems.push(`${tenant.tag}/${role} ${route} -> ${res.status}`);
            if (new RegExp(foreign, 'i').test(text)) {
              problems.push(`УТЕЧКА ${tenant.tag}/${role} ${route}: ${text.slice(0, 160)}`);
            }
          }
          assert.ok(answered >= 8, `${tenant.tag}/${role}: ответило всего ${answered} роутов - прогон пустой`);
        }
      }
      assert.deepEqual(problems, []);
    });

    await step('неизвестный домен получает 404, а не данные Алихана (критерий 4)', async () => {
      for (const route of ['staff', 'bookings?from=2020-01-01&to=2030-12-31', 'public/masters', 'services']) {
        const res = await api(route, { origin: 'chuzhoy-sayt.test' });
        assert.equal(res.status, 404, `${route}: неизвестный домен должен получать 404`);
        assert.deepEqual(await res.json(), { error: 'unknown_tenant' });
      }
      const login404 = await login('chuzhoy-sayt.test', 'owner');
      assert.equal(login404.status, 404, 'вход с неизвестного домена не должен даже искать сотрудника');
    });

    await step('токен одного арендатора не действует на домене другого', async () => {
      const res = await api('auth/me', { origin: TENANTS[1].domain, token: tokens.alikhan.owner });
      assert.equal(res.status, 401, 'чужой токен на чужом домене обязан быть отклонён');
      const back = await api('auth/me', { origin: TENANTS[0].domain, token: tokens.alikhan.owner });
      assert.equal(back.status, 200, 'на своём домене тот же токен должен работать');
    });

    await step('CORS разрешает домен арендатора и молчит на чужой (ловушка 7)', async () => {
      const own = await api('services', { origin: TENANTS[1].domain, token: tokens.karina.owner });
      assert.equal(own.headers.get('access-control-allow-origin'), `https://${TENANTS[1].domain}`);
      const alien = await api('services', { origin: 'chuzhoy-sayt.test' });
      assert.equal(alien.headers.get('access-control-allow-origin'), null, 'чужому источнику разрешения быть не должно');
      const preflight = await api('bookings', { origin: TENANTS[0].domain, method: 'OPTIONS' });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), `https://${TENANTS[0].domain}`);
    });

    await step('проверка живости отвечает без домена вообще', async () => {
      const res = await fetch(`${BASE}/health`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
    });

    await step('мастер и администратор пишут данные в свой салон, не в чужой', async () => {
      // Смена мастера засеяна на сегодня, 10:00-11:00 уже занято записью - берём 12:00
      const today = (await asTenant(db, '*', "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")).rows[0].d;
      // Мастеру запись создавать нельзя (правило системы), администратор - может
      const asMaster = await api('bookings', {
        origin: TENANTS[1].domain, token: tokens.karina.master, method: 'POST',
        body: { masterId: 'staff-karina-master', serviceIds: ['service-karina'], date: today, startTime: '12:00', clientName: 'X', clientPhone: '+79005550001' },
      });
      assert.equal(asMaster.status, 403, 'мастер не создаёт записи - правило не должно было измениться');
      const asAdmin = await api('bookings', {
        origin: TENANTS[1].domain, token: tokens.karina.admin, method: 'POST',
        body: { masterId: 'staff-karina-master', serviceIds: ['service-karina'], date: today, startTime: '12:00', clientName: 'Клиент Карины', clientPhone: '+79005550002' },
      });
      assert.ok(
        [200, 201].includes(asAdmin.status),
        `администратор не смог создать запись: ${asAdmin.status} ${await asAdmin.clone().text()}`
      );
      // Берём всё, что не засеяно репетицией: id засеянных начинаются с 'booking-'
      const created = await asTenant(db, '*', "SELECT tenant_id, id, start_time FROM bookings WHERE id NOT LIKE 'booking-%'");
      assert.deepEqual(
        created.rows.map((r) => r.tenant_id),
        [2],
        `запись обязана лечь арендатору того домена, с которого пришла. Ответ: ${asAdmin.status} ${await asAdmin.clone().text()}; строки: ${JSON.stringify(created.rows)}`
      );
    });

    await step('второй арендатор подключается строкой в справочнике, без правок кода (критерий 6)', async () => {
      await asTenant(
        db, '*',
        `INSERT INTO tenants (id, name, vertical, domains) VALUES (3, 'Третий салон', 'barbershop', ARRAY['tretiy.test'])`
      );
      // Домен третьего салона сервер видит впервые: до вставки - 404, после вставки
      // и истечения кэша - уже свой арендатор, сервер при этом не перезапускался
      await new Promise((r) => setTimeout(r, 300));
      const res = await api('public/masters', { origin: 'tretiy.test' });
      assert.equal(res.status, 200, 'новый арендатор должен заработать без правок кода и перезапуска');
      assert.deepEqual(await res.json(), [], 'у нового салона своих мастеров пока нет - и чужих он не видит');
      const known = await asTenant(db, '*', "SELECT count(*)::int AS n FROM tenants WHERE 'tretiy.test' = ANY(domains)");
      assert.equal(Number(known.rows[0].n), 1, 'арендатор заведён одной строкой, миграций не потребовалось');
    });

    await step('сотрудники, созданные ЧЕРЕЗ КАБИНЕТ, ложатся своему салону', async () => {
      // Проверка не про уже засеянные строки, а про новые: всё, что заводится живым
      // кабинетом после переезда, обязано получать своего арендатора само - код
      // POST /staff про арендаторов ничего не знает и знать не должен
      const created = {};
      for (const tenant of TENANTS) {
        const res = await api('staff', {
          origin: tenant.domain, token: tokens[tenant.tag].owner, method: 'POST',
          body: { name: `Новичок ${tenant.tag}`, email: 'novichok@shared.test', role: 'master', providesServices: true },
        });
        const body = await res.json();
        assert.ok([200, 201].includes(res.status), `${tenant.tag}: сотрудник не создался - ${JSON.stringify(body)}`);
        created[tenant.tag] = body.id ?? body.staff?.id;
        assert.ok(created[tenant.tag], `${tenant.tag}: сервер не вернул id нового сотрудника`);
      }
      // Одна и та же почта в двух салонах прошла - составной ключ работает на живом
      // создании, а не только в репетиции миграции
      for (const tenant of TENANTS) {
        const row = await asTenant(db, '*', 'SELECT tenant_id FROM staff WHERE id = $1', [created[tenant.tag]]);
        assert.equal(row.rows[0].tenant_id, tenant.id, `${tenant.tag}: новый сотрудник лёг чужому арендатору`);
      }
      // И ни один салон не видит новичка соседа в своём списке команды
      for (const tenant of TENANTS) {
        const foreign = TENANTS.find((t) => t.tag !== tenant.tag);
        const list = await (await api('staff', { origin: tenant.domain, token: tokens[tenant.tag].owner })).json();
        const ids = list.map((r) => r.id);
        assert.ok(ids.includes(created[tenant.tag]), `${tenant.tag}: свой новичок не виден в команде`);
        assert.ok(!ids.includes(created[foreign.tag]), `${tenant.tag}: ВИДИТ новичка чужого салона`);
      }
    });

    await step('салон, заведённый после переезда, работает с нуля и чужого не видит', async () => {
      // Полный цикл подключения нового клиента: строка в справочнике, первый
      // сотрудник, вход, кабинет. Ровно то, что предстоит сделать для Карины
      await asTenant(
        db, '*',
        `INSERT INTO tenants (id, name, vertical, domains) VALUES (4, 'Новый салон', 'barbershop', ARRAY['noviy.test'])`
      );
      await asTenant(db, 4, 'INSERT INTO locations (name) VALUES ($1)', ['Точка нового салона']);
      const locationId = (await asTenant(db, 4, 'SELECT id FROM locations LIMIT 1')).rows[0].id;
      await asTenant(
        db, 4,
        `INSERT INTO staff (id, location_id, name, role, email, pin_hash, provides_services)
         VALUES ('staff-noviy-owner', $1, 'Владелец нового салона', 'owner', 'owner@shared.test', $2, true)`,
        [locationId, hashPin('1234')]
      );
      await new Promise((r) => setTimeout(r, 300));

      const login = await api('auth/login', {
        origin: 'noviy.test', method: 'POST', body: { email: 'owner@shared.test', pin: '1234' },
      });
      const body = await login.json();
      assert.equal(login.status, 200, `новый салон не пускает владельца: ${JSON.stringify(body)}`);
      assert.equal(body.staff.name, 'Владелец нового салона', 'вошёл не в свой салон - почта-то одна на троих');

      const team = await (await api('staff', { origin: 'noviy.test', token: body.token })).json();
      assert.equal(team.length, 1, `новый салон видит лишних сотрудников: ${JSON.stringify(team)}`);
      const bookings = await (
        await api('bookings?from=2020-01-01&to=2030-12-31', { origin: 'noviy.test', token: body.token })
      ).json();
      assert.deepEqual(bookings.bookings ?? bookings, [], 'новый салон видит чужие записи');
      const clients = await (await api('clients?all=true', { origin: 'noviy.test', token: body.token })).json();
      assert.deepEqual(clients.clients ?? clients, [], 'новый салон видит чужую базу клиентов');
    });

    await step('аварийная ручка: с TENANT_FALLBACK_ID неизвестный домен обслуживается', async () => {
      // На эту ручку вся надежда, если после переключения прода окажется, что живой
      // клиент приходит с источником, которого нет в справочнике: включается
      // переменной в панели, без деплоя. Непроверенная страховка - не страховка
      const FALLBACK_PORT = PORT + 1;
      const fallbackServer = spawn(
        process.execPath,
        [join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'server.mjs')],
        {
          env: {
            ...process.env,
            PORT: String(FALLBACK_PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE,
            DB_PASSWORD: PASSWORD, DB_SSL: 'disable', TENANT_CACHE_TTL_MS: '200',
            TENANT_FALLBACK_ID: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      try {
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(`http://127.0.0.1:${FALLBACK_PORT}/health`)).ok) break;
          } catch {
            // поднимается
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        const res = await fetch(`http://127.0.0.1:${FALLBACK_PORT}/public/masters`, {
          headers: { Origin: 'https://sovsem-neizvestnyy.test' },
        });
        assert.equal(res.status, 200, 'с включённой ручкой неизвестный домен должен обслуживаться');
        const masters = await res.json();
        assert.ok(Array.isArray(masters), 'ответ должен быть нормальным, а не заглушкой');
        // И это именно арендатор из ручки, а не «все подряд»
        const strict = await api('public/masters', { origin: 'sovsem-neizvestnyy.test' });
        assert.equal(strict.status, 404, 'на сервере без ручки тот же домен обязан получать 404');
      } finally {
        fallbackServer.kill('SIGTERM');
      }
    });

    await step('в логе сервера нет ошибок замка и запросов без арендатора', async () => {
      const log = serverLog.join('');
      assert.doesNotMatch(log, /row-level security/i, log.slice(-600));
      assert.doesNotMatch(log, /tenant_context_missing/i, log.slice(-600));
    });
  } catch (err) {
    console.log('\n--- лог сервера ---\n' + serverLog.join('').slice(-3000));
    throw err;
  } finally {
    child.kill('SIGTERM');
    await db.end();
  }

  console.log(`\nМаршрутизация по домену: ${results.length} проверок пройдено`);
}

await main();
