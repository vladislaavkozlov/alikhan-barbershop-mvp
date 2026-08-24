// Замок из Фазы 3 глазами самого приложения (24.08.2026). Атака в
// verify-2026-08-24-tenant-rls.mjs доказывает изоляцию на уровне SQL - здесь тот же
// вопрос задаётся живому API: поднимается настоящий api/server.mjs против базы с
// включённым замком, и по роутам ходят настоящим HTTP с настоящим токеном.
//
// Что доказывается:
//   - кабинет арендатора работает как раньше: роуты отвечают 200 и отдают его данные
//     (критерий 5 спеки на уровне API; живой CDP трёх кабинетов - Фаза 5);
//   - токен чужого арендатора не действует - ещё до маршрутизации по домену (Фаза 4);
//   - в ответах роутов нет ни одной строки чужого арендатора.
//
// База берётся та, что осталась от verify-2026-08-24-tenant-rls.mjs - запускать
// после него: node tools/verify-2026-08-24-tenant-rls.mjs && node tools/verify-2026-08-24-tenant-rls-api.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashPin } from '../api/lib/auth.js';

const DB = 'tenant_rls_probe';
const ROLE = 'probe_rls_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
// После Фазы 4 сервер определяет арендатора по домену запроса, поэтому прогон
// представляется доменом арендатора №1 - иначе честно получит 404 «неизвестный домен»
const ORIGIN = 'https://api-probe.test';

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
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

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // сервер ещё поднимается
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся');
}

async function main() {
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });

  // Владельцу каждого арендатора ставим известный PIN - вход дальше идёт настоящим
  // роутом POST /auth/login, пароли не подсматриваются
  for (const [tenantId, tag] of [[1, 'alikhan'], [2, 'karina']]) {
    await asTenant(db, tenantId, "UPDATE staff SET role = 'owner', provides_services = true, email = $2, pin_hash = $3 WHERE id = $1", [
      `staff-${tag}`, `${tag}@probe.local`, hashPin('1234'),
    ]);
  }

  await asTenant(db, '*', "UPDATE tenants SET domains = domains || 'api-probe.test'::text WHERE id = 1 AND NOT ('api-probe.test' = ANY(domains))");

  const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_HOST: host,
      DB_NAME: DB,
      DB_USER: ROLE,
      DB_PASSWORD: PASSWORD,
      DB_SSL: 'disable',
      ALLOWED_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(String(d)));
  child.stderr.on('data', (d) => serverLog.push(String(d)));

  try {
    console.log('Замок глазами живого API:');
    await waitForServer();

    const login = async (email) => {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email, pin: '1234' }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    let alikhanToken = null;

    await step('владелец арендатора входит через настоящий роут логина', async () => {
      const res = await login('alikhan@probe.local');
      assert.equal(res.status, 200, `логин не прошёл: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.token, 'токен не выдан');
      alikhanToken = res.body.token;
    });

    await step('токен чужого арендатора не действует (предвестник Фазы 4)', async () => {
      // Сервер пока всегда работает от имени арендатора 1, поэтому сессия Карины для
      // него не существует вовсе - её строка закрыта замком. Вход по её почте тоже
      // не проходит: сотрудник другого арендатора этому серверу не виден
      const foreign = await login('karina@probe.local');
      assert.equal(foreign.status, 401, 'сотрудник чужого арендатора не должен входить');
      const karinaToken = (await asTenant(db, 2, "SELECT token FROM sessions WHERE staff_id = 'staff-karina'")).rows[0];
      if (karinaToken) {
        const res = await fetch(`${BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${karinaToken.token}`, Origin: ORIGIN },
        });
        assert.equal(res.status, 401, 'чужой токен не должен открывать кабинет');
      }
    });

    await step('кабинет арендатора работает: роуты отвечают и отдают его данные', async () => {
      const routes = [
        'auth/me', 'staff', 'locations', 'services', 'master-services',
        'bookings?from=2026-01-01&to=2026-12-31', 'schedule?date=2026-08-25',
        'schedule-range?masterId=staff-alikhan&from=2026-08-25&to=2026-08-27', 'holidays?year=2026',
        'notifications', 'notifications/unread-count', 'clients?all=true',
        'payroll-settings', 'discount-settings', 'revenue/today',
        'owner/alerts', 'analytics/retention?months=3', 'analytics/sources?months=3',
        'finance/missed-profit?from=2026-01-01&to=2026-12-31', 'changes',
      ];
      const failed = [];
      for (const route of routes) {
        const res = await fetch(`${BASE}/${route}`, {
          headers: { Authorization: `Bearer ${alikhanToken}`, Origin: ORIGIN },
        });
        const text = await res.text();
        if (res.status !== 200) failed.push(`${route} -> ${res.status} ${text.slice(0, 120)}`);
        // Ни в одном ответе не должно быть следов второго арендатора
        assert.doesNotMatch(text, /karina/i, `${route}: в ответе оказались данные чужого арендатора`);
      }
      assert.deepEqual(failed, [], 'роуты, упавшие под замком');
    });

    await step('запись создаётся и ложится своему арендатору', async () => {
      // Мастер работает 25.08 (смена засеяна репетицией), 10:00-11:00 уже занято.
      // Повторный запуск инструмента не должен спотыкаться о свою же прошлую запись
      await asTenant(db, '*', "DELETE FROM bookings WHERE id LIKE 'booking-api-probe%' OR (date = '2026-08-25' AND start_time = '12:00')");
      const res = await fetch(`${BASE}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alikhanToken}`, Origin: ORIGIN },
        body: JSON.stringify({
          masterId: 'staff-alikhan',
          serviceIds: ['service-alikhan'],
          date: '2026-08-25',
          startTime: '12:00',
          clientName: 'Проверочный клиент',
          clientPhone: '+79001234567',
        }),
      });
      const body = await res.json().catch(() => null);
      assert.ok([200, 201].includes(res.status), `запись не создалась: ${res.status} ${JSON.stringify(body)}`);
      const created = await asTenant(
        db, '*',
        "SELECT tenant_id FROM bookings WHERE date = '2026-08-25' AND start_time = '12:00'"
      );
      assert.equal(created.rows.length, 1);
      assert.equal(created.rows[0].tenant_id, 1, 'новая запись обязана лечь арендатору того, кто её создал');
    });

    await step('сервер не сыпал ошибками замка в лог', async () => {
      const log = serverLog.join('');
      assert.doesNotMatch(log, /row-level security/i, `в логе сервера ошибки замка:\n${log.slice(-800)}`);
      assert.doesNotMatch(log, /tenant_context_missing/i, `в логе сервера запросы без арендатора:\n${log.slice(-800)}`);
    });
  } finally {
    child.kill('SIGTERM');
    await db.end();
  }

  console.log(`\nAPI под замком: ${results.length} проверок пройдено`);
}

await main();
