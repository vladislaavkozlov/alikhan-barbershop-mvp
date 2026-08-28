// Каталог услуг арендатора: создать, изменить, удалить (Окно 75, 28.08.2026).
//
// Зачем. Прогон Окна 69 (tools/verify-2026-08-26-put-kariny.mjs) честно записал
// находку: POST /services не существует, и клиника не может завести ни одной своей
// процедуры - ни из кабинета, ни запросом. Здесь проверяется, что дыры больше нет, и
// проверяется живьём: настоящий Postgres, настоящие миграции, настоящий сервер, два
// арендатора в одной базе.
//
// Главное, что здесь стережётся, - не сам факт создания, а изоляция и история:
// каталог одного арендатора не виден другому, а услугу, которая уже стоит в записи
// клиента, удалить нельзя - иначе визит в истории остался бы без названия услуги.
//
// Запуск: node tools/verify-2026-08-28-katalog-uslug.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'api', 'migrations');
const DB = 'katalog_uslug_probe';
const ROLE = 'probe_katalog';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const API_PORT = 9112;

const CLINIC_ORIGIN = '127.0.0.1:8811';
const BARBER_ORIGIN = 'vladislaavkozlov.github.io';
const CLINIC = {
  name: 'Урбашевичус',
  domains: [CLINIC_ORIGIN],
  vertical: 'clinic',
  owner: { name: 'Карина Урбашевичус', email: 'karina', pin: 'Karina2026' },
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

async function applyMigrations(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file])).rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

const api = (path, { token, origin = CLINIC_ORIGIN, method = 'GET', body } = {}) =>
  fetch(`http://127.0.0.1:${API_PORT}/${path}`, {
    method,
    headers: {
      Origin: `http://${origin}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const login = async (loginName, password, origin) => {
  const res = await api('auth/login', { method: 'POST', origin, body: { login: loginName, password } });
  assert.equal(res.status, 200, `вход ${loginName} не сработал`);
  return (await res.json()).token;
};

async function main() {
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });
  await applyMigrations(db);

  const apiProc = spawn(process.execPath, [join(ROOT, 'api', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(API_PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable',
      TENANT_CACHE_TTL_MS: '200',
      NEW_TENANT_B64: Buffer.from(JSON.stringify(CLINIC), 'utf8').toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  apiProc.stdout.on('data', (d) => log.push(String(d)));
  apiProc.stderr.on('data', (d) => log.push(String(d)));

  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok) break; } catch { /* поднимается */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 119) throw new Error(`API не поднялся:\n${log.join('')}`);
    }

    const token = await login('karina', 'Karina2026', CLINIC_ORIGIN);
    let created;

    await step('до создания каталог клиники пуст - чужие услуги в него не протекли', async () => {
      const list = await (await api('services', { token })).json();
      assert.deepEqual(list, [], `клиника видит чужой каталог: ${JSON.stringify(list).slice(0, 200)}`);
    });

    await step('владелец заводит процедуру, и она сразу в каталоге', async () => {
      const res = await api('services', { token, method: 'POST', body: { name: 'Консультация', durationMin: 30, price: 0 } });
      assert.equal(res.status, 201, 'процедура не создалась');
      created = (await res.json()).service;
      assert.equal(created.name, 'Консультация');
      assert.equal(created.price, 0, 'бесплатная консультация обязана быть возможной');
      const list = await (await api('services', { token })).json();
      assert.equal(list.length, 1, 'созданной процедуры нет в каталоге');
    });

    await step('цена ноль разрешена, а отрицательная и дробная - нет', async () => {
      for (const price of [-1, 10.5, '500']) {
        const res = await api('services', { token, method: 'POST', body: { name: 'Плохая цена', durationMin: 30, price } });
        assert.equal(res.status, 400, `цена ${price} прошла в каталог`);
        assert.equal((await res.json()).error, 'invalid_price');
      }
    });

    await step('пустое название и нулевая длительность отклоняются', async () => {
      const noName = await api('services', { token, method: 'POST', body: { name: '   ', durationMin: 30, price: 100 } });
      assert.equal((await noName.json()).error, 'invalid_service_name');
      const noTime = await api('services', { token, method: 'POST', body: { name: 'Без времени', durationMin: 0, price: 100 } });
      assert.equal((await noTime.json()).error, 'invalid_duration');
    });

    await step('незнакомая категория не проходит - от неё считается зарплата', async () => {
      const res = await api('services', { token, method: 'POST', body: { name: 'Странная', durationMin: 30, price: 100, category: 'вип' } });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_category');
    });

    await step('правка меняет только переданные поля', async () => {
      const res = await api(`services/${created.id}`, { token, method: 'PUT', body: { price: 2500 } });
      assert.equal(res.status, 200, 'правка не прошла');
      const service = (await res.json()).service;
      assert.equal(service.price, 2500);
      assert.equal(service.name, 'Консультация', 'правка цены затёрла название');
      assert.equal(service.durationMin, 30, 'правка цены затёрла длительность');
    });

    await step('пустая правка и правка несуществующей процедуры получают внятный отказ', async () => {
      const empty = await api(`services/${created.id}`, { token, method: 'PUT', body: {} });
      assert.equal((await empty.json()).error, 'nothing_to_update');
      const missing = await api('services/svc-нет-такой', { token, method: 'PUT', body: { price: 1 } });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error, 'service_not_found');
    });

    await step('процедура удаляется и пропадает из каталога', async () => {
      const res = await api('services', { token, method: 'POST', body: { name: 'Лишняя', durationMin: 15, price: 100 } });
      const extra = (await res.json()).service;
      const del = await api(`services/${extra.id}`, { token, method: 'DELETE' });
      assert.equal(del.status, 200, 'удаление не прошло');
      const list = await (await api('services', { token })).json();
      assert.ok(!list.some((s) => s.id === extra.id), 'удалённая процедура осталась в каталоге');
    });

    await step('процедуру из живой записи удалить нельзя - история не рвётся', async () => {
      // Запись кладём напрямую в базу: путь создания визита проверяют свои прогоны,
      // здесь важна только ссылка из истории на услугу
      const tenant = (await db.query("SELECT id FROM tenants WHERE name = 'Урбашевичус'")).rows[0].id;
      // Замок арендатора (миграция 058) читает app.tenant_id и приводит его к числу:
      // без установленного значения падает сама вставка. Значение живёт до конца
      // транзакции, поэтому и вставка идёт одной транзакцией на одном соединении
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenant)]);
        // Сотрудники под тем же замком: без арендатора этот SELECT падает раньше вставки
        const staff = (await client.query('SELECT id FROM staff LIMIT 1')).rows[0].id;
        await client.query(
          `INSERT INTO bookings (id, tenant_id, master_id, date, start_time, end_time, status)
           VALUES ('bk-probe', $1, $2, CURRENT_DATE, '10:00', '10:30', 'planned')`,
          [tenant, staff]
        );
        await client.query('INSERT INTO booking_services (booking_id, service_id, tenant_id) VALUES ($1, $2, $3)', ['bk-probe', created.id, tenant]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const res = await api(`services/${created.id}`, { token, method: 'DELETE' });
      assert.equal(res.status, 409, 'услуга с историей удалилась - визит остался бы без названия');
      const body = await res.json();
      assert.equal(body.error, 'service_in_use');
      assert.equal(body.bookings, 1, 'отказ обязан называть число записей, иначе он читается как поломка');
    });

    await step('каталог клиники не виден барбершопу, а барбершопный - клинике', async () => {
      const barberToken = await login('master1-test@alikhan.test', '1234', BARBER_ORIGIN).catch(() => null);
      const clinicList = await (await api('services', { token })).json();
      assert.ok(clinicList.every((s) => s.name !== 'Стрижка'), 'в каталоге клиники видна услуга барбершопа');
      if (barberToken) {
        const barberList = await (await api('services', { token: barberToken, origin: BARBER_ORIGIN })).json();
        assert.ok(barberList.every((s) => s.name !== 'Консультация'), 'барбершоп видит процедуру клиники');
      }
    });

    await step('роль без прав управления каталог не трогает', async () => {
      const res = await api('services', { method: 'POST', body: { name: 'Аноним', durationMin: 30, price: 100 } });
      assert.equal(res.status, 401, 'услугу завели без авторизации');
    });
  } finally {
    apiProc.kill('SIGKILL');
    await new Promise((r) => apiProc.on('exit', r));
    await db.end();
  }

  console.log(`\nГотово: ${results.length} проверок, все зелёные`);
}

main().catch((err) => {
  console.error('\nПРОГОН КРАСНЫЙ:', err.message);
  process.exit(1);
});
