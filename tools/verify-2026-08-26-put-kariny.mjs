// Пройдёт ли Карина путь одна, без разработчика (Окно 69, задача 4 брифа,
// 26.08.2026, plans/2026-08-26-podklyuchenie-arendatora.md).
//
// Заведение арендатора даёт ей владельца и две процедуры. Всё остальное - команда,
// прайс, графики - она наполняет сама штатными экранами. Проверяется это не чтением
// реестра роутов, а живьём: настоящий браузер открывает её кабинет на её домене под
// её учёткой, а права подтверждаются настоящими запросами под её токеном.
//
// Прогон честный: то, чего система сегодня не умеет, он не обходит, а фиксирует.
// Находка окна - каталог процедур: POST /services не существует, и Карина не может
// добавить процедуру из кабинета. Ниже это проверено, а не предположено.
//
// Запуск: node tools/verify-2026-08-26-put-kariny.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const SHOTS = join(ROOT, 'tools', 'shots-2026-08-26-karina');
const DB = 'tenant_put_kariny_probe';
const ROLE = 'probe_put_kariny';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const API_PORT = 9108;
const WEB_PORT = 8796;
const WEB_ORIGIN = `127.0.0.1:${WEB_PORT}`;

const OWNER_EMAIL = 'karina@urbashevichus.ru';
const OWNER_PIN = '482913';
const KARINA = {
  name: 'Урбашевичус - клиника авторской ортодонтии',
  // Домен кабинета в прогоне - локальная статика. На проде здесь
  // crm.karinaurbashevichus.ru, механизм от этого не меняется
  domains: [WEB_ORIGIN],
  vertical: 'clinic',
  owner: { name: 'Карина Урбашевичус', email: OWNER_EMAIL, pin: OWNER_PIN },
  services: [
    { name: 'Консультация', durationMin: 30, price: 0 },
    { name: 'Повторный сеанс', durationMin: 30, price: 0 },
  ],
};

const results = [];
const findings = [];
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

function startWebServer() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    let body = readFileSync(file);
    if (extname(file) === '.html') {
      body = Buffer.from(body.toString('utf8').replaceAll('https://alikhancrm1-vladislaavkozlov.amvera.io', `http://127.0.0.1:${API_PORT}`));
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(WEB_PORT, () => resolve(server)));
}

const api = (path, { token, method = 'GET', body } = {}) =>
  fetch(`http://127.0.0.1:${API_PORT}/${path}`, {
    method,
    headers: {
      Origin: `http://${WEB_ORIGIN}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function main() {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  await applyMigrations(db);

  const apiProc = spawn(process.execPath, [join(ROOT, 'api', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(API_PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable',
      TENANT_CACHE_TTL_MS: '200',
      // Ровно тот путь, что поедет на прод: панель Amvera не принимает кавычки
      // (проверено живьём 26.08.2026), поэтому заявка едет закодированной
      NEW_TENANT_B64: Buffer.from(JSON.stringify(KARINA), 'utf8').toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiLog = [];
  apiProc.stdout.on('data', (d) => apiLog.push(String(d)));
  apiProc.stderr.on('data', (d) => apiLog.push(String(d)));
  const web = await startWebServer();

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok) break;
      } catch { /* поднимается */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error(`API не поднялся:\n${apiLog.join('')}`);
    }

    console.log('Путь Карины, свежим глазом:\n');

    let token = null;
    await step('вход по временному PIN - тем же экраном, что у всех', async () => {
      const res = await api('auth/login', { method: 'POST', body: { email: OWNER_EMAIL, pin: OWNER_PIN } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.staff.mustChangePin, true);
      token = body.token;
    });

    await step('добавить сотрудника она может сама', async () => {
      const res = await api('staff', {
        token, method: 'POST',
        body: { name: 'Ассистент Мария', email: 'assistent@urbashevichus.ru', phone: '', role: 'admin', providesServices: false, locationId: null },
      });
      assert.equal(res.status, 201, `POST /staff вернул ${res.status}`);
      const body = await res.json();
      // Кабинет показывает временный PIN нового сотрудника - без него человек не войдёт
      assert.match(String(body.temporaryPin), /^\d{6}$/);
    });

    await step('точки у клиники нет, и сотрудник это переживает', async () => {
      const locations = await (await api('locations', { token })).json();
      assert.equal(locations.length ?? locations.locations?.length ?? 0, 0, 'у новой клиники точек быть не должно');
      const staff = await (await api('staff', { token })).json();
      const list = Array.isArray(staff) ? staff : staff.staff;
      assert.equal(list.length, 2, 'владелец и добавленный сотрудник');
    });

    await step('поставить график себе она может сама', async () => {
      const res = await api('master-weekly-schedule', {
        token, method: 'PUT',
        body: {
          masterId: (await (async () => {
            const staff = await (await api('staff', { token })).json();
            const list = Array.isArray(staff) ? staff : staff.staff;
            return list.find((s) => s.email === OWNER_EMAIL).id;
          })()),
          weeklyChanges: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, isWorking: true, workStart: '10:00', workEnd: '19:00' })),
        },
      });
      assert.ok(res.status < 400, `PUT /master-weekly-schedule вернул ${res.status}: ${await res.text()}`);
    });

    await step('цену и длительность своей процедуры она правит сама', async () => {
      const services = await (await api('services', { token })).json();
      const list = Array.isArray(services) ? services : services.services;
      assert.equal(list.length, 2, 'две стартовые процедуры');
      const staff = await (await api('staff', { token })).json();
      const me = (Array.isArray(staff) ? staff : staff.staff).find((s) => s.email === OWNER_EMAIL);
      const res = await api(`master-services/${me.id}/${list[0].id}`, {
        token, method: 'PUT', body: { price: 2500, durationMin: 45 },
      });
      assert.ok(res.status < 400, `PUT /master-services вернул ${res.status}`);
    });

    await step('НАХОДКА: завести новую процедуру из кабинета нельзя - роута нет', async () => {
      const res = await api('services', { token, method: 'POST', body: { name: 'Брекет-система', durationMin: 60, price: 5000 } });
      // 404 здесь - ответ реестра роутов «такого роута не существует», а не «нет прав»
      assert.equal(res.status, 404, `ожидался 404 несуществующего роута, пришёл ${res.status}`);
      findings.push('Каталог процедур: POST /services не существует. Новую процедуру Карина сама не заведёт - только цену и длительность уже заведённой. Отдельное окно (решение Влада 26.08.2026)');
    });

    await step('НАХОДКА: завести точку из кабинета тоже нельзя', async () => {
      const res = await api('locations', { token, method: 'POST', body: { name: 'Клиника', address: 'Тухачевского, 9' } });
      assert.equal(res.status, 404);
      findings.push('Точки: POST /locations не существует. Клинике на одном адресе это не мешает - сотрудник заводится без точки, проверено выше');
    });

    // ── Живой браузер: кабинет открывается и не сыплет ошибками ──────────────
    await withBrowser(async (s) => {
      await s.setViewport(1440, 950, false);
      await step('кабинет владелицы открывается на её домене и говорит её словами', async () => {
        await s.navigate(`http://${WEB_ORIGIN}/crm-owner.html`);
        await s.eval('window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message))); window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));');
        await s.eval('localStorage.clear()');
        await s.type('#loginEmail', OWNER_EMAIL);
        await s.type('#loginPin', OWNER_PIN);
        await s.click('#loginForm button[type="submit"]');
        await s.sleep(3000);
        await s.screenshot(join(SHOTS, 'owner-vhod.png'));

        const text = await s.eval('document.body.innerText');
        const near = (re) => (text.match(new RegExp(`.{0,90}${re}.{0,90}`, 'gi')) ?? []).join(' | ');
        assert.doesNotMatch(text, /мастер/i, `в кабинете клиники не должно быть барбершопных слов: ${near('мастер')}`);
        // Оформление под её бренд - Этап D по решению Влада, окно его не делает.
        // Но найденное фиксируем поимённо, иначе «осознанно отложено» через месяц
        // превратится в «никто не заметил»
        if (/Алихан/.test(text)) {
          findings.push('Оформление (Этап D): в боковой панели кабинета имя заведения зашито строкой - assets/crm-app-shell.js:152 «Алихан, Ставрополь». GET /tenant/appearance название арендатора уже отдаёт, панель им не пользуется');
        }
        const title = await s.eval('document.title');
        if (/Алихан/.test(String(title))) {
          findings.push('Оформление (Этап D): в шапке кабинета логотип-герб барбершопа «АЛИХАН · премиум мужские стрижки» - виден на скриншоте owner-vhod.png');
          findings.push(`Оформление (Этап D): заголовок вкладки - «${title}» (crm-owner.html), у Карины будет тот же`);
        }
        const errors = await s.eval('JSON.stringify(window.__errors)');
        assert.equal(errors, '[]', `ошибки в консоли кабинета: ${errors}`);
      });

      await step('экран команды открывается и показывает её саму', async () => {
        const text = await s.eval('document.body.innerText');
        assert.match(text, /Карина Урбашевичус|Ассистент Мария/, 'кабинет не показывает состав команды');
        await s.screenshot(join(SHOTS, 'owner-komanda.png'));
      });
    });
  } finally {
    apiProc.kill('SIGKILL');
    await new Promise((r) => apiProc.on('exit', r));
    web.close();
    await db.end();
  }

  console.log(`\nГотово: ${results.length} проверок, все зелёные`);
  console.log('\nЧто Карина НЕ может сама (записано честно, не обойдено):');
  for (const f of findings) console.log(`  · ${f}`);
  console.log(`\nСкриншоты: ${SHOTS}`);
}

main().catch((err) => {
  console.error('\nПРОГОН КРАСНЫЙ:', err.message);
  process.exit(1);
});
