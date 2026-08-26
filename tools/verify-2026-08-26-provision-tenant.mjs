// ГЛАВНЫЙ ПРОГОН ОКНА 69: подключение арендатора работает на настоящем Postgres
// (26.08.2026, plans/2026-08-26-podklyuchenie-arendatora.md).
//
// Офлайн-набор проверяет контракт на поддельном пуле. Здесь проверяется то, чего он
// проверить не может: что настоящий сервер, стартуя с переменной NEW_TENANT против
// настоящей базы с настоящим замком на строках, действительно заводит клиента,
// действительно не заводит его дважды и действительно не роняет Алихана.
//
// База эфемерная, но собранная как боевая: таблицы принадлежат ОБЫЧНОЙ роли без
// суперправ - владелец таблиц обходит замок без FORCE, и прогон из-под
// суперпользователя дал бы ложную зелень (ловушка 1 спеки Этапа A).
//
// Запуск: node tools/verify-2026-08-26-provision-tenant.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'migrations');
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'server.mjs');
const DB = 'tenant_provision_probe';
const ROLE = 'probe_provision_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const PORT = 9107;
const BASE = `http://127.0.0.1:${PORT}`;

const ALIKHAN_DOMAIN = 'vladislaavkozlov.github.io';
const KARINA_DOMAIN = 'crm.karinaurbashevichus.ru';

// Ровно та заявка, которая поедет в панель Amvera. PIN здесь задан - значит в лог он
// не уйдёт, и это отдельно проверяется ниже
const KARINA = {
  name: 'Урбашевичус - клиника авторской ортодонтии',
  domains: [KARINA_DOMAIN],
  vertical: 'clinic',
  owner: { name: 'Карина Урбашевичус', email: 'karina@urbashevichus.ru', pin: '482913' },
  services: [
    { name: 'Консультация', durationMin: 30, price: 0 },
    { name: 'Повторный сеанс', durationMin: 30, price: 0 },
  ],
};

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

async function asSystem(db, sql, params = []) {
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

// Каждый старт сервера - отдельный процесс с собственной переменной NEW_TENANT.
// Именно так это и происходит на Amvera: переменная в панели плюс перезапуск.
async function runServer(newTenant, fn) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable',
      TENANT_CACHE_TTL_MS: '200',
      ...(newTenant === undefined ? {} : { NEW_TENANT: newTenant }),
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

// Снимок всех данных клиники: сколько чего лежит и каким хэшем закрыт PIN владельца.
// Идемпотентность доказывается сравнением ДВУХ таких снимков, а не доверием к логу
async function snapshot(db) {
  const tenants = await asSystem(db, 'SELECT id, name, vertical, domains, modules FROM tenants ORDER BY id');
  const counts = {};
  for (const table of ['staff', 'services', 'master_services', 'locations', 'bookings']) {
    const res = await asSystem(db, `SELECT tenant_id, count(*)::int AS n FROM ${table} GROUP BY tenant_id ORDER BY tenant_id`);
    counts[table] = res.rows;
  }
  const owner = await asSystem(
    db,
    "SELECT id, tenant_id, name, email, role, pin_hash, must_change_pin, protected_owner, provides_services FROM staff WHERE email = $1",
    [KARINA.owner.email]
  );
  return { tenants: tenants.rows, counts, owner: owner.rows };
}

async function main() {
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
  await applyMigrations(db);

  console.log('Подключение арендатора, живой прогон на настоящем Postgres:\n');

  // ── 1. Заведение ──────────────────────────────────────────────────────────
  let afterFirst;
  await runServer(JSON.stringify(KARINA), async (logOf) => {
    await step('арендатор, владелец и две процедуры созданы при старте', async () => {
      afterFirst = await snapshot(db);
      assert.equal(afterFirst.tenants.length, 2, 'в справочнике должно стать два арендатора');
      const karina = afterFirst.tenants.find((t) => t.id !== 1);
      assert.equal(karina.name, KARINA.name);
      assert.equal(karina.vertical, 'clinic');
      assert.deepEqual(karina.domains, [KARINA_DOMAIN]);
      assert.deepEqual(karina.modules, {}, 'флаги не заданы - значит как по умолчанию для вертикали');

      const [owner] = afterFirst.owner;
      assert.ok(owner, 'владелец не создан');
      assert.equal(owner.tenant_id, karina.id, 'владелец обязан принадлежать своей клинике');
      assert.equal(owner.role, 'owner');
      assert.equal(owner.must_change_pin, true, 'вход по временному PIN обязан требовать смены');
      assert.equal(owner.protected_owner, true, 'последнего владельца нельзя разжаловать');
      assert.equal(owner.provides_services, true);

      const services = afterFirst.counts.services.find((r) => r.tenant_id === karina.id);
      assert.equal(services.n, 2, 'должны появиться ровно две процедуры');
      const links = afterFirst.counts.master_services.find((r) => r.tenant_id === karina.id);
      assert.equal(links.n, 2, 'обе процедуры делает владелец');
    });

    await step('в логе подтверждение, но НЕ заданный руками PIN', () => {
      const log = logOf();
      assert.match(log, /Арендатор подключён/);
      assert.match(log, new RegExp(KARINA_DOMAIN.replace(/\./g, '\\.')));
      assert.doesNotMatch(log, /482913/, 'PIN, заданный в переменной, в лог уходить не должен');
    });

    await step('кабинет на её домене отвечает и говорит словами клиники', async () => {
      const res = await api('tenant/appearance', { origin: KARINA_DOMAIN });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.vertical, 'clinic');
      assert.equal(body.name, KARINA.name);
      assert.equal(body.terms.master.nom, 'врач');
      assert.equal(body.terms.client.nom, 'пациент');
      assert.deepEqual(body.modules, { missedProfit: true, payroll: true }, 'оба раздела включены');
    });

    await step('Алихан на своём домене говорит прежними словами', async () => {
      const res = await api('tenant/appearance', { origin: ALIKHAN_DOMAIN });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.vertical, 'barbershop');
      assert.equal(body.terms.master.nom, 'мастер');
    });

    await step('первый вход: временный PIN, требование смены, смена, вход новым', async () => {
      const login = (pin) => api('auth/login', { origin: KARINA_DOMAIN, method: 'POST', body: { email: KARINA.owner.email, pin } });
      const first = await login('482913');
      assert.equal(first.status, 200, 'вход по временному PIN не прошёл');
      const body = await first.json();
      assert.equal(body.staff.mustChangePin, true);
      assert.equal(body.staff.role, 'owner');

      const changed = await api(`staff/${body.staff.id}/pin`, {
        origin: KARINA_DOMAIN, token: body.token, method: 'PUT', body: { newPin: '135790' },
      });
      assert.equal(changed.status, 200, 'владелец обязан менять PIN себе сам');

      const again = await login('135790');
      assert.equal(again.status, 200, 'вход новым PIN не прошёл');
      assert.equal((await again.json()).staff.mustChangePin, false, 'требование смены обязано погаснуть');

      const old = await login('482913');
      assert.equal(old.status, 401, 'старый PIN обязан перестать работать');
    });

    await step('атака: под токеном Карины ни одной строки Алихана', async () => {
      const login = await api('auth/login', { origin: KARINA_DOMAIN, method: 'POST', body: { email: KARINA.owner.email, pin: '135790' } });
      const { token } = await login.json();
      const karinaId = afterFirst.tenants.find((t) => t.id !== 1).id;
      for (const path of ['staff', 'services', 'master-services', 'locations', 'clients', 'bookings', 'notifications']) {
        const res = await api(path, { origin: KARINA_DOMAIN, token });
        assert.ok(res.status < 500, `${path}: ${res.status}`);
        const text = await res.text();
        assert.doesNotMatch(text, /Алихан|master-1|master-2|master-3/, `${path}: в ответе видны данные Алихана`);
        assert.doesNotMatch(text, /@alikhan\.test/, `${path}: в ответе видны логины Алихана`);
        void karinaId;
      }
    });
  });

  // ── 2. Повторный старт с той же переменной ───────────────────────────────
  await runServer(JSON.stringify(KARINA), async (logOf) => {
    await step('повторный старт: ни одной новой строки, PIN не сброшен', async () => {
      const after = await snapshot(db);
      assert.equal(after.tenants.length, 2, 'второго Карину заводить нельзя');
      assert.deepEqual(after.counts, afterFirst.counts, 'количество строк изменилось');
      // PIN уже сменён на 135790 - и повторное заведение НЕ имеет права вернуть его
      // к временному. Это и есть самое опасное последствие неидемпотентности
      const login = await api('auth/login', { origin: KARINA_DOMAIN, method: 'POST', body: { email: KARINA.owner.email, pin: '135790' } });
      assert.equal(login.status, 200, 'PIN, заданный клиентом, обязан пережить перезапуск');
      assert.match(logOf(), /уже подключён/);
    });
  });

  // ── 3. Опечатка в переменной ─────────────────────────────────────────────
  await runServer('{"name":"Клиника","domains":["сrm.example.ru"],"vertical":"clinic","owner":{"name":"К","email":"k@example.ru"}}', async (logOf) => {
    await step('опечатка в домене: приложение живо, Алихан отвечает, никого не завели', async () => {
      const health = await api('health');
      assert.equal(health.status, 200, 'сервер обязан подняться даже с кривой заявкой');
      const alikhan = await api('tenant/appearance', { origin: ALIKHAN_DOMAIN });
      assert.equal(alikhan.status, 200, 'салон Алихана не должен пострадать от чужой опечатки');
      const after = await snapshot(db);
      assert.equal(after.tenants.length, 2, 'кривая заявка не имеет права никого завести');
      assert.match(logOf(), /NEW_TENANT/);
    });

    await step('в /health появилось время старта - им отличают перезапущенный контейнер от старого', async () => {
      const body = await (await api('health')).json();
      assert.match(String(body.startedAt), /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ── 4. Попытка увести чужой домен ────────────────────────────────────────
  await runServer(JSON.stringify({ ...KARINA, name: 'Чужой захват', domains: [ALIKHAN_DOMAIN] }), async (logOf) => {
    await step('заявка с доменом Алихана упирается в занятость, а не уводит его', async () => {
      const after = await snapshot(db);
      assert.equal(after.tenants.length, 2, 'третьего арендатора появиться не должно');
      const alikhan = after.tenants.find((t) => t.id === 1);
      assert.equal(alikhan.name, 'Барбершоп Алихан', 'имя арендатора Алихана переписано');
      assert.ok(alikhan.domains.includes(ALIKHAN_DOMAIN), 'домен Алихана уехал');
      assert.match(logOf(), /уже подключён/);
      const res = await api('tenant/appearance', { origin: ALIKHAN_DOMAIN });
      assert.equal((await res.json()).vertical, 'barbershop', 'домен Алихана обязан остаться барбершопом');
    });
  });

  // ── 5. Чувствительность прогона ──────────────────────────────────────────
  await runServer(undefined, async () => {
    await step('без переменной сервер просто работает: ни заведения, ни ошибок', async () => {
      const after = await snapshot(db);
      assert.equal(after.tenants.length, 2);
      assert.equal((await api('health')).status, 200);
    });
  });

  await db.end();
  console.log(`\nГотово: ${results.length} проверок, все зелёные`);
}

main().catch((err) => {
  console.error('\nПРОГОН КРАСНЫЙ:', err.message);
  process.exit(1);
});
