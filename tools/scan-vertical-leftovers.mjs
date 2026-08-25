// Этап B: сито №2 - барбершопные слова на ЭКРАНЕ клиники (24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Греп по исходникам (tests/vertical-leftovers.test.js) ловит слово, написанное
// руками. Он не поймает слово, собранное из кусков, приехавшее из чужого модуля или
// нарисованное там, куда греп не заглядывал. Поэтому второе сито - настоящий браузер:
// поднимаем кабинет арендатора-клиники, входим, разворачиваем разделы и читаем ВЕСЬ
// видимый текст.
//
// Данные арендатора здесь намеренно клинические («Консультация», «Брекеты», врач
// Карина): если после этого на экране встретилось слово «мастер» или «запись» - это
// точно интерфейс, а не название услуги, которое клиент завёл себе сам.
//
// Пока кабинеты не переведены (фазы 3-5), прогон красный - это ожидаемо, он и служит
// списком работ. Зелёным он обязан стать к концу фазы 5.
//
// Запуск: node tools/scan-vertical-leftovers.mjs [папка-для-скриншотов]
import pg from 'pg';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { hashPin } from '../api/lib/auth.js';
import { withBrowser } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const DB = 'vertical_scan_probe';
const ROLE = 'probe_scan_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const API_PORT = 9108;
const WEB_PORT = 8794;
const WEB_ORIGIN = `localhost:${WEB_PORT}`;
const SHOTS = process.argv[2] || join(ROOT, 'tools', 'shots-2026-08-24-vertical-clinic');
const TENANT = 2;

// Стоп-лист: корни, которых на экране клиники быть не должно
const STOP = /мастер|запис|услуг|клиент|салон|стрижк|барбершоп/gi;

const CABINETS = [
  { file: 'crm-owner.html', email: 'owner@klinika.local', who: 'владелец' },
  { file: 'crm-admin.html', email: 'admin@klinika.local', who: 'администратор' },
  { file: 'crm-master.html', email: 'doctor@klinika.local', who: 'врач' },
];

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

// Клиника целиком: свои люди, свои процедуры, свои пациенты. Ни одного барбершопного
// слова в самих данных
async function seedClinic(db) {
  const q = (sql, params) => asTenant(db, TENANT, sql, params);
  await asTenant(
    db, '*',
    `INSERT INTO tenants (id, name, vertical, domains) VALUES ($1, 'Клиника Карины', 'clinic', ARRAY[$2::text])
     ON CONFLICT (id) DO UPDATE SET vertical = EXCLUDED.vertical, domains = EXCLUDED.domains`,
    [TENANT, WEB_ORIGIN]
  );
  await asTenant(db, '*', "SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");
  const loc = await q("INSERT INTO locations (name) VALUES ('Кабинет на Пушкина') RETURNING id");
  const locationId = loc.rows[0].id;
  const people = [
    ['staff-cl-owner', 'Карина', 'owner', 'owner@klinika.local', true],
    ['staff-cl-admin', 'Ольга', 'admin', 'admin@klinika.local', false],
    ['staff-cl-doc', 'Ильдар', 'master', 'doctor@klinika.local', true],
  ];
  for (const [id, name, role, email, provides] of people) {
    await q(
      `INSERT INTO staff (id, location_id, name, role, email, pin_hash, provides_services)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, locationId, name, role, email, hashPin('1234'), provides]
    );
  }
  const procedures = [['svc-cl-consult', 'Консультация', 30, 2000], ['svc-cl-braces', 'Брекеты', 90, 15000]];
  for (const [id, name, dur, price] of procedures) {
    await q(`INSERT INTO services (id, name, category, duration_min, price) VALUES ($1, $2, 'base', $3, $4)`, [id, name, dur, price]);
  }
  for (const staffId of ['staff-cl-doc', 'staff-cl-owner']) {
    for (const [serviceId, , dur, price] of procedures) {
      await q('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4)', [staffId, serviceId, price, dur]);
    }
    await q('INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, 0.45)', [staffId]);
    for (let weekday = 1; weekday <= 7; weekday++) {
      await q('INSERT INTO master_weekly_schedule (master_id, weekday, work_start, work_end) VALUES ($1, $2, $3, $4)', [staffId, weekday, '09:00', '19:00']);
    }
    await q(`INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, CURRENT_DATE, '09:00', '19:00')`, [staffId]);
  }
  const patients = [['pat-1', '+79881230001', 'Марина'], ['pat-2', '+79881230002', 'Тимур'], ['pat-3', '+79881230003', 'Алина']];
  for (const [id, phone, name] of patients) await q('INSERT INTO clients (id, phone, name) VALUES ($1, $2, $3)', [id, phone, name]);
  const visits = [
    ['vis-1', 'staff-cl-doc', 'pat-1', '10:00', '10:30', 'planned', null],
    ['vis-2', 'staff-cl-doc', 'pat-2', '12:00', '12:30', 'done', 2000],
    ['vis-3', 'staff-cl-owner', 'pat-3', '14:00', '15:30', 'planned', null],
  ];
  for (const [id, staffId, patientId, start, end, status, actual] of visits) {
    await q(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, actual_price)
       VALUES ($1, $2, $3, 'svc-cl-consult', $4, CURRENT_DATE, $5, $6, $7, $8)`,
      [id, locationId, staffId, patientId, start, end, status, actual]
    );
    await q('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [id, 'svc-cl-consult']);
  }
}

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
      body = Buffer.from(body.toString('utf8').replaceAll('https://alikhancrm1-vladislaavkozlov.amvera.io', `http://127.0.0.1:${API_PORT}`));
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

// Из сплошного текста экрана достаём короткие куски вокруг каждого попадания -
// по ним видно, ГДЕ править, а не только сколько осталось
function findLeftovers(text) {
  const hits = new Map();
  for (const match of text.matchAll(STOP)) {
    const from = Math.max(0, match.index - 40);
    const snippet = text.slice(from, match.index + 40).replace(/\s+/g, ' ').trim();
    hits.set(snippet, (hits.get(snippet) ?? 0) + 1);
  }
  return hits;
}

async function main() {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  await applyMigrations(db);
  await seedClinic(db);

  const api = spawn(process.execPath, [join(ROOT, 'api', 'server.mjs')], {
    env: { ...process.env, PORT: String(API_PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiLog = [];
  api.stdout.on('data', (d) => apiLog.push(String(d)));
  api.stderr.on('data', (d) => apiLog.push(String(d)));
  const web = await startWebServer();
  const report = {};

  try {
    console.log('Барбершопные слова на экране клиники:\n');
    await waitForApi();

    await withBrowser(async (s) => {
      await s.setViewport(1440, 950, false);
      for (const cabinet of CABINETS) {
        await s.navigate(`http://${WEB_ORIGIN}/${cabinet.file}`);
        await s.eval('window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message)));');
        // Экран входа - тоже экран арендатора, читаем его отдельно
        await s.sleep(800);
        const gateText = await s.eval('document.body.innerText');
        await s.typeReal('#loginEmail', cabinet.email);
        await s.typeReal('#loginPin', '1234');
        await s.click('#loginForm button[type="submit"]');
        await s.sleep(2500);
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
        if (target && target.hits) await s.clickAt(target.x, target.y);
        await s.sleep(2000);
        await s.screenshot(join(SHOTS, `${cabinet.file.replace('.html', '')}.png`));
        const screen = await s.eval(`(function(){
          const gate = document.getElementById('loginGate');
          return {
            text: document.body.innerText,
            gateGone: !gate || gate.hidden || getComputedStyle(gate).display === 'none',
            errors: window.__errors || [],
          };
        })()`);
        report[cabinet.who] = { ...screen, gateText };
      }
    });
  } finally {
    api.kill('SIGTERM');
    web.close();
    await db.end();
  }

  let total = 0;
  for (const cabinet of CABINETS) {
    const r = report[cabinet.who];
    if (!r) {
      console.log(`  ✖ ${cabinet.who}: прогон не дошёл до кабинета`);
      total += 1;
      continue;
    }
    if (!r.gateGone) {
      console.log(`  ✖ ${cabinet.who}: не вошёл в кабинет - читать нечего`);
      total += 1;
      continue;
    }
    if (r.errors.length) console.log(`  ⚠ ${cabinet.who}: ошибки в консоли - ${r.errors.join(' | ')}`);
    const gateHits = findLeftovers(r.gateText ?? '');
    const hits = findLeftovers(r.text ?? '');
    const count = [...hits.values()].reduce((a, b) => a + b, 0) + [...gateHits.values()].reduce((a, b) => a + b, 0);
    total += count;
    if (count === 0) {
      console.log(`  ✔ ${cabinet.who}: барбершопных слов на экране нет`);
      continue;
    }
    console.log(`  ✖ ${cabinet.who}: ${count} барбершопных слов на экране`);
    for (const [snippet, n] of [...gateHits, ...hits].slice(0, 25)) console.log(`      ${n}× …${snippet}…`);
    if (hits.size > 25) console.log(`      … и ещё ${hits.size - 25} мест`);
  }

  console.log(`\nИтого на экранах клиники: ${total} барбершопных слов`);
  console.log(`Скриншоты: ${SHOTS}`);
  if (total > 0) process.exitCode = 1;
}

await main();
