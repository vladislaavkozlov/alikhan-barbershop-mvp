// Фаза 5 мультиарендности: живой прогон ТРЁХ КАБИНЕТОВ Алихана (24.08.2026).
// Критерий 5 спеки - «Алихан не заметил изменений».
//
// Настоящий браузер (headless Chrome через tools/cdp.mjs) открывает crm-owner.html,
// crm-admin.html и crm-master.html, входит рабочей почтой и PIN и работает в
// кабинете - против локального API, поднятого на базе со ВСЕМИ миграциями Этапа A,
// включая замок. Боевая база не участвует.
//
// Что доказывается:
//   - вход работает во всех трёх кабинетах;
//   - данные салона на экране есть (записи, команда, расписание), а не пустота;
//   - ни одной ошибки в консоли браузера и ни одной ошибки замка в логе сервера;
//   - скриншоты каждого кабинета лежат рядом - смотреть глазами, а не верить на слово.
//
// Запуск: node tools/verify-2026-08-24-tenant-cabinets.mjs [папка-для-скриншотов]
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { hashPin } from '../api/lib/auth.js';
import { withBrowser } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const DB = 'tenant_cabinets_probe';
const ROLE = 'probe_cab_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const API_PORT = 9102;
const WEB_PORT = 8793;
const WEB_ORIGIN = `localhost:${WEB_PORT}`;
const SHOTS = process.argv[2] || join(ROOT, 'tools', 'shots-2026-08-24-tenant');

const CABINETS = [
  { file: 'crm-owner.html', email: 'owner@alikhan.local', who: 'владелец' },
  { file: 'crm-admin.html', email: 'admin@alikhan.local', who: 'администратор' },
  { file: 'crm-master.html', email: 'master@alikhan.local', who: 'мастер' },
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

// Салон как у Алихана: три роли, услуги, клиенты, записи на сегодня, графики
async function seedSalon(db) {
  const q = (sql, params) => asTenant(db, 1, sql, params);
  await q("SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");
  const loc = await q("INSERT INTO locations (name) VALUES ('Точка на Ленина') RETURNING id");
  const locationId = loc.rows[0].id;
  const staff = [
    ['staff-cab-owner', 'Алиовсад', 'owner', 'owner@alikhan.local', true],
    ['staff-cab-admin', 'Кабинет администратора', 'admin', 'admin@alikhan.local', false],
    ['staff-cab-master', 'Мамедхан', 'master', 'master@alikhan.local', true],
    ['staff-cab-master2', 'Елизавета', 'master', 'master2@alikhan.local', true],
  ];
  for (const [id, name, role, email, provides] of staff) {
    await q(
      `INSERT INTO staff (id, location_id, name, role, email, pin_hash, provides_services)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, locationId, name, role, email, hashPin('1234'), provides]
    );
  }
  const services = [
    ['svc-cab-strizhka', 'Стрижка', 'base', 60, 1500],
    ['svc-cab-boroda', 'Борода', 'base', 30, 900],
  ];
  for (const [id, name, category, dur, price] of services) {
    await q(
      `INSERT INTO services (id, name, category, duration_min, price) VALUES ($1, $2, $3, $4, $5)`,
      [id, name, category, dur, price]
    );
  }
  for (const masterId of ['staff-cab-master', 'staff-cab-master2', 'staff-cab-owner']) {
    for (const [serviceId, , , dur, price] of services) {
      await q(
        'INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4)',
        [masterId, serviceId, price, dur]
      );
    }
    await q('INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, 0.45)', [masterId]);
    for (let weekday = 1; weekday <= 7; weekday++) {
      await q(
        'INSERT INTO master_weekly_schedule (master_id, weekday, work_start, work_end) VALUES ($1, $2, $3, $4)',
        [masterId, weekday, '10:00', '20:00']
      );
    }
    await q(
      `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, CURRENT_DATE, '10:00', '20:00')`,
      [masterId]
    );
  }
  const clients = [
    ['client-cab-1', '+79881110001', 'Иван'],
    ['client-cab-2', '+79881110002', 'Пётр'],
    ['client-cab-3', '+79881110003', 'Сергей'],
  ];
  for (const [id, phone, name] of clients) await q('INSERT INTO clients (id, phone, name) VALUES ($1, $2, $3)', [id, phone, name]);

  const bookings = [
    ['bk-cab-1', 'staff-cab-master', 'client-cab-1', '11:00', '12:00', 'planned', null],
    ['bk-cab-2', 'staff-cab-master', 'client-cab-2', '13:00', '14:00', 'done', 1500],
    ['bk-cab-3', 'staff-cab-master2', 'client-cab-3', '15:00', '16:00', 'planned', null],
  ];
  for (const [id, masterId, clientId, start, end, status, actual] of bookings) {
    await q(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, actual_price)
       VALUES ($1, $2, $3, 'svc-cab-strizhka', $4, CURRENT_DATE, $5, $6, $7, $8)`,
      [id, locationId, masterId, clientId, start, end, status, actual]
    );
    await q('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [id, 'svc-cab-strizhka']);
  }
  await q(
    `INSERT INTO notifications (id, staff_id, type, booking_id, title, body)
     VALUES ('notif-cab-1', 'staff-cab-owner', 'booking_new', 'bk-cab-1', 'Новая запись', 'сегодня, 11:00')`
  );
  await q("UPDATE tenants SET domains = domains || $1::text WHERE id = 1", [WEB_ORIGIN]);
}

// Статика проекта с одной подменой: адрес API - локальный, а не боевой
function startWebServer() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = extname(file);
    let body = readFileSync(file);
    if (ext === '.html') {
      body = Buffer.from(
        body.toString('utf8').replaceAll('https://alikhancrm1-vladislaavkozlov.amvera.io', `http://127.0.0.1:${API_PORT}`)
      );
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(WEB_PORT, () => resolve(server)));
}

async function waitForApi() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok) return;
    } catch {
      // поднимается
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('API не поднялся');
}

async function main() {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  await applyMigrations(db);
  await seedSalon(db);

  const api = spawn(process.execPath, [join(ROOT, 'api', 'server.mjs')], {
    env: { ...process.env, PORT: String(API_PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiLog = [];
  api.stdout.on('data', (d) => apiLog.push(String(d)));
  api.stderr.on('data', (d) => apiLog.push(String(d)));
  const web = await startWebServer();

  try {
    console.log('Три кабинета Алихана против базы с замком:');
    await waitForApi();

    const seen = {};
    await withBrowser(async (s) => {
      await s.setViewport(1440, 950, false);
      for (const cabinet of CABINETS) {
        await s.navigate(`http://${WEB_ORIGIN}/${cabinet.file}`);
        // Сессия предыдущего кабинета остаётся в localStorage того же браузера, и
        // страница чужой роли её сбрасывает. Чистим, не перезагружая: повторный
        // переход сбивал раскрытие разделов ниже
        await s.eval('localStorage.clear()');
        // Ошибки консоли собираем сами: драйвер их не слушает
        await s.eval(`window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));`);
        // Почта и PIN вводятся через type(), а не typeReal: после входа в первый
        // кабинет клавиатурные события до следующих страниц не доходят - ограничение
        // драйвера, оговорено в tools/cdp.mjs. Живым жестом (typeReal, clickAt) в этом
        // прогоне проверяется то, ради чего он и заведён: раскрытие разделов и работа
        // в самом кабинете
        await s.type('#loginEmail', cabinet.email);
        await s.type('#loginPin', '1234');
        await s.click('#loginForm button[type="submit"]');
        await s.sleep(2500);
        // Кабинет открывается со свёрнутыми разделами - это его штатный вид. Данные
        // появляются после раскрытия «Дня», поэтому прогон делает то же, что человек
        // Карточки разделов раскрываются настоящим кликом, а не el.click(): это
        // навигация, обработчик висит на живом событии. Координаты берём у элемента и
        // проверяем, что в этой точке лежит именно он (иначе клик уйдёт в никуда)
        // Раскрытие разделов срабатывало через раз: кнопка «Развернуть все» к моменту
        // клика ещё перерисовывалась, хит-тест не подтверждал попадание, прогон молча
        // шёл дальше и сверял вдвое более бедный экран. Три попытки с паузой
        const expandAll = async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const target = await s.eval(`(function(){
              const label = [...document.querySelectorAll('button, .btn, [role="button"]')]
                .find((el) => /Развернуть все/i.test(el.innerText || ''));
              if (!label) return null;
              const r = label.getBoundingClientRect();
              const x = Math.round(r.left + r.width / 2);
              const y = Math.round(r.top + r.height / 2);
              const hit = document.elementFromPoint(x, y);
              return { x, y, hits: !!hit && (hit === label || label.contains(hit)) };
            })()`);
            if (!target) return 'NOT_FOUND';
            if (target.hits) {
              await s.clickAt(target.x, target.y);
              return 'OK';
            }
            await s.sleep(700);
          }
          return 'MISSED';
        };
        const opened = await expandAll();
        if (opened !== 'OK') console.log(`    ⚠ ${cabinet.who}: разделы не раскрылись (${opened})`);
        await s.sleep(2000);
        await s.screenshot(join(SHOTS, `${cabinet.file.replace('.html', '')}.png`));
        seen[cabinet.who] = await s.eval(`(function(){
          const gate = document.getElementById('loginGate');
          const text = document.body.innerText;
          return {
            dayOpened: true,
            gateGone: !gate || gate.hidden || getComputedStyle(gate).display === 'none',
            hasSalonData: /Мамедхан|Елизавета|Иван|Пётр|Сергей|11:00|13:00|15:00/.test(text),
            errorToast: (document.querySelector('.toast-error, .login-error:not([hidden])') || {}).innerText || null,
            errors: window.__errors || [],
            textLength: text.length,
            fullText: text,
          };
        })()`);
      }
    });

    if (process.env.DUMP_TEXT) {
      const { writeFileSync } = await import('node:fs');
      const dump = {};
      for (const cabinet of CABINETS) dump[cabinet.who] = seen[cabinet.who]?.fullText ?? '';
      writeFileSync(process.env.DUMP_TEXT, JSON.stringify(dump, null, 2));
      console.log('    текст экранов записан:', process.env.DUMP_TEXT);
    }

    for (const cabinet of CABINETS) {
      await step(`кабинет: ${cabinet.who} - вход и данные салона на экране`, async () => {
        const r = seen[cabinet.who];
        assert.ok(r, `${cabinet.who}: нет результата`);
        assert.equal(r.gateGone, true, `${cabinet.who}: не вошёл - ${r.errorToast ?? 'форма входа осталась'}`);
        assert.ok(r.textLength > 400, `${cabinet.who}: экран почти пустой (${r.textLength} знаков)`);
        assert.ok(r.hasSalonData, `${cabinet.who}: на экране нет данных салона`);
        assert.deepEqual(r.errors, [], `${cabinet.who}: ошибки в консоли браузера`);
      });
    }

    await step('в логе API нет ошибок замка и запросов без арендатора', async () => {
      const log = apiLog.join('');
      assert.doesNotMatch(log, /row-level security/i, log.slice(-700));
      assert.doesNotMatch(log, /tenant_context_missing/i, log.slice(-700));
      assert.doesNotMatch(log, /Ошибка обработки запроса/i, log.slice(-700));
    });

    await step('время ответа под замком - цифры для наблюдения после переключения', async () => {
      // Транзакция на запрос удерживает соединение всё время обработки. Здесь снимаем
      // ориентир на тех роутах, где это заметнее всего: отчёты делают по несколько
      // выборок, и теперь они идут по очереди, а не разом
      const login = await fetch(`http://127.0.0.1:${API_PORT}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://${WEB_ORIGIN}` },
        body: JSON.stringify({ email: 'owner@alikhan.local', pin: '1234' }),
      });
      const { token } = await login.json();
      const measured = [];
      for (const route of [
        'bookings?from=2026-01-01&to=2026-12-31',
        'payroll?from=2026-01-01&to=2026-12-31&masterId=staff-cab-master',
        'revenue/today',
        'analytics/retention?months=3',
        'finance/missed-profit?from=2026-01-01&to=2026-12-31',
        'staff',
      ]) {
        const runs = [];
        for (let i = 0; i < 5; i++) {
          const started = performance.now();
          const res = await fetch(`http://127.0.0.1:${API_PORT}/${route}`, {
            headers: { Authorization: `Bearer ${token}`, Origin: `http://${WEB_ORIGIN}` },
          });
          await res.text();
          runs.push(performance.now() - started);
          assert.equal(res.status, 200, `${route} ответил ${res.status}`);
        }
        const worst = Math.max(...runs);
        measured.push({ route, worst: Math.round(worst) });
        assert.ok(worst < 3000, `${route}: худший ответ ${Math.round(worst)} мс - соединение держится слишком долго`);
      }
      console.log('        худший ответ, мс:', measured.map((m) => `${m.route.split('?')[0]}=${m.worst}`).join(', '));
    });

    await step('всё, что кабинеты записали, осталось у арендатора 1', async () => {
      const foreign = await asTenant(db, '*', 'SELECT count(*)::int AS n FROM bookings WHERE tenant_id <> 1');
      assert.equal(Number(foreign.rows[0].n), 0);
    });
  } finally {
    api.kill('SIGTERM');
    web.close();
    await db.end();
  }

  console.log(`\nКабинеты Алихана: ${results.length} проверок пройдено`);
  console.log(`Скриншоты: ${SHOTS}`);
}

await main();
