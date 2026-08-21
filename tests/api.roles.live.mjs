// ⚠️ ЖИВОЙ ПРОГОН ПО ПРОДУ, НЕ ОФЛАЙН-ТЕСТ. Расширение .live.mjs (21.08.2026) выводит
// файл из автоматического `node --test`: он создаёт сотрудников и брони в БОЕВОЙ базе через прод-API,
// и попадал в каждый обычный прогон тестов. Итог - лишняя нагрузка на боевой сервер
// (в мониторинге 21.08.2026 видны ответы 429 «too many requests» ровно в такие
// моменты) и тестовый мусор в живых данных салона.
//
// Запускать осознанно и по одному: `node --test tests/api.roles.live.mjs`
// Окно 8, Шаг 5: живые тесты ролевого доступа поверх реально задеплоенного API
// (не in-memory, как storage.test.js/storage.stress.test.js - тем 14 тестам этот
// файл не мешает и от них не зависит). Нужны:
//   - применённая миграция api/migrations/002_schema.sql на боевой Amvera-базе
//   - задеплоенный новый api/server.mjs (роли/логин/эндпоинты Окна 8)
//   - переменная окружения DB_PASSWORD (или файл ~/Desktop/alikhan-crm-api.env) -
//     тест сам создаёт и подчищает временные фикстуры (2 точки, 4 тестовых
//     аккаунта - owner/admin1/admin2/master, 2 брони), реальных данных Алихана
//     и реальных сотрудников (Алиовсад/Мамедхан/Елизавета) не трогает.
// Если API/БД недоступны - тесты падают явно с понятной причиной, не молчат.
//
// Правка Окна 14 (02.08.2026, Задача 1): раньше логинился через ПОСТОЯННЫЕ тестовые
// персоны, заранее засеянные в 002_schema.sql (owner-test/admin-loc1-test/
// admin-loc2-test) - миграция 014_cleanup_test_accounts_and_roles.sql их удаляет
// (владелец видел "сотрудников: 7" вместо 3 живых людей). Плюс один из старых
// тестов уже был тихо сломан по факту: master1-test@alikhan.test (master-1) с
// 01.08.2026 (011_real_master_names.sql) реально владелец 'owner' (Алиовсад), не
// 'master' - тест ожидал старую роль и не перезапускался с тех пор. Решение - тест
// больше не зависит ни от постоянных тестовых персон, ни от реальных сотрудников:
// создаёт СВОИ ephemeral-аккаунты (тот же паттерн, что уже был у
// FIXTURE_MASTER_LOC1/LOC2 ниже), с паролями, которые тест сам хэширует тем же
// scrypt-алгоритмом, что и api/server.mjs (hashPin) - никаких угаданных чужих PIN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';

const API_URL = process.env.ALIKHAN_API_URL || 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const DB_HOST = process.env.DB_HOST || 'alikhan-crm-vladislaavkozlov.db-msk0.amvera.tech';

function loadDbPassword() {
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD;
  const envPath = '/Users/user/Desktop/alikhan-crm-api.env';
  if (!fs.existsSync(envPath)) return null;
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DB_PASSWORD='));
  return line ? line.slice('DB_PASSWORD='.length).trim() : null;
}

// Идентичный api/server.mjs::hashPin - тест сам готовит логины фикстур, не читает
// и не угадывает чужие pin_hash из живой БД.
function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const dbPassword = loadDbPassword();
const pool = dbPassword
  ? new pg.Pool({
      host: DB_HOST,
      port: 5432,
      database: process.env.DB_NAME || 'alikhancrm',
      user: process.env.DB_USER || 'alikhanadmin',
      password: dbPassword,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// Фикстура теста изоляции по точкам: два ВРЕМЕННЫХ тестовых мастера, явно
// привязанных к разным location_id, плюс 4 ephemeral RBAC-логина (owner/admin
// Точки 1/admin Точки 2/master) - id начинаются с "fixture-", чтобы не путать с
// реальными сотрудниками, всё удаляется в after().
const FIXTURE_MASTER_LOC1 = 'fixture-master-loc1';
const FIXTURE_MASTER_LOC2 = 'fixture-master-loc2';
const FIXTURE_OWNER = 'fixture-owner-rbac';
const FIXTURE_ADMIN1 = 'fixture-admin1-rbac';
const FIXTURE_ADMIN2 = 'fixture-admin2-rbac';
const FIXTURE_STAFF_IDS = [FIXTURE_MASTER_LOC1, FIXTURE_MASTER_LOC2, FIXTURE_OWNER, FIXTURE_ADMIN1, FIXTURE_ADMIN2];
// PIN-ы фикстур генерируются СЛУЧАЙНО на каждый прогон, а не зашиты в файл (правка
// 04.08.2026, Окно 23, перед тем как положить tests/ в публичный репозиторий). Тест
// создаёт эти учётки на РЕАЛЬНОМ API и удаляет их в after() - но если прогон упадёт
// посередине, учётка переживёт его. С захардкоженным PIN-ом в открытом репозитории
// такой хвост становится готовым доступом в боевую CRM; со случайным - PIN умирает
// вместе с процессом. Сам тест значения знает, наружу они не попадают.
const randomPin = () => String(randomBytes(4).readUInt32BE(0) % 900000 + 100000);
const PIN_OWNER = randomPin();
const PIN_ADMIN1 = randomPin();
const PIN_ADMIN2 = randomPin();
const PIN_MASTER = randomPin();
let fixtureBookingLoc1;
let fixtureBookingLoc2;

before(async () => {
  if (!pool) return;
  await pool.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Тестовый мастер Точка 1 (fixture)', 'master', true, true, true, 'fixture-master1@alikhan.test', $2)
     ON CONFLICT (id) DO UPDATE SET location_id = 1, has_system_access = true, pin_hash = $2`,
    [FIXTURE_MASTER_LOC1, hashPin(PIN_MASTER)]
  );
  await pool.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 2, 'Тестовый мастер Точка 2 (fixture)', 'master', true, true, false, 'fixture-master2@alikhan.test', $2)
     ON CONFLICT (id) DO UPDATE SET location_id = 2, pin_hash = $2`,
    [FIXTURE_MASTER_LOC2, hashPin(PIN_MASTER)]
  );
  await pool.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, NULL, 'Тестовый владелец (fixture)', 'owner', true, false, true, 'fixture-owner@alikhan.test', $2)
     ON CONFLICT (id) DO UPDATE SET pin_hash = $2`,
    [FIXTURE_OWNER, hashPin(PIN_OWNER)]
  );
  await pool.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Тестовый админ Точка 1 (fixture)', 'admin', true, false, true, 'fixture-admin1@alikhan.test', $2)
     ON CONFLICT (id) DO UPDATE SET location_id = 1, pin_hash = $2`,
    [FIXTURE_ADMIN1, hashPin(PIN_ADMIN1)]
  );
  await pool.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 2, 'Тестовый админ Точка 2 (fixture)', 'admin', true, false, true, 'fixture-admin2@alikhan.test', $2)
     ON CONFLICT (id) DO UPDATE SET location_id = 2, pin_hash = $2`,
    [FIXTURE_ADMIN2, hashPin(PIN_ADMIN2)]
  );
  await pool.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     VALUES ($1, 'strizhka', 2000, 40), ($2, 'strizhka', 2000, 40)
     ON CONFLICT (master_id, service_id) DO NOTHING`,
    [FIXTURE_MASTER_LOC1, FIXTURE_MASTER_LOC2]
  );
  await pool.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT master_id, weekday, true, '10:00', '20:00'
     FROM unnest($1::text[]) AS master_id CROSS JOIN generate_series(1, 7) AS weekday
     ON CONFLICT (master_id, weekday) DO UPDATE SET is_working = true, work_start = '10:00', work_end = '20:00', break_start = NULL, break_end = NULL`,
    [[FIXTURE_MASTER_LOC1, FIXTURE_MASTER_LOC2]]
  );

  async function makeBooking(masterId) {
    const res = await fetch(`${API_URL}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        masterId,
        serviceId: 'strizhka',
        date: '2026-09-01',
        startTime: '11:00',
        clientName: 'Тестовый клиент RBAC',
        clientPhone: '+79990001122',
      }),
    });
    if (!res.ok) throw new Error(`fixture booking POST /bookings → ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.booking.id;
  }
  fixtureBookingLoc1 = await makeBooking(FIXTURE_MASTER_LOC1);
  fixtureBookingLoc2 = await makeBooking(FIXTURE_MASTER_LOC2);
});

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM bookings WHERE master_id = ANY($1)', [FIXTURE_STAFF_IDS]);
  await pool.query('DELETE FROM master_weekly_schedule WHERE master_id = ANY($1)', [FIXTURE_STAFF_IDS]);
  await pool.query('DELETE FROM master_services WHERE master_id = ANY($1)', [FIXTURE_STAFF_IDS]);
  await pool.query('DELETE FROM staff WHERE id = ANY($1)', [FIXTURE_STAFF_IDS]);
  await pool.query(`DELETE FROM clients WHERE phone = '+79990001122'`);
  await pool.end();
});

async function login(email, pin) {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  assert.equal(res.status, 200, `логин ${email} должен пройти (200), получили ${res.status}`);
  const data = await res.json();
  assert.ok(data.token, 'ответ логина должен содержать token');
  return data;
}

test('auth: неверный PIN отклоняется (401)', async () => {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'fixture-owner@alikhan.test', pin: '0000' }),
  });
  assert.equal(res.status, 401);
});

test('auth: 3 фикстурные роли логинятся успешно', async () => {
  const owner = await login('fixture-owner@alikhan.test', PIN_OWNER);
  const admin1 = await login('fixture-admin1@alikhan.test', PIN_ADMIN1);
  const master1 = await login('fixture-master1@alikhan.test', PIN_MASTER);
  assert.equal(owner.staff.role, 'owner');
  assert.equal(admin1.staff.role, 'admin');
  assert.equal(master1.staff.role, 'master');
});

test('RBAC: мастер не получает телефон клиента ни в каком поле ответа /bookings', async () => {
  const { token } = await login('fixture-master1@alikhan.test', PIN_MASTER);
  const res = await fetch(`${API_URL}/bookings?masterId=${FIXTURE_MASTER_LOC1}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const json = JSON.stringify(data);
  assert.ok(!json.includes('clientPhone') || data.bookings.every((b) => !('clientPhone' in b)),
    'ни одна запись в ответе не должна содержать поле clientPhone для роли master');
  assert.ok(data.bookings.some((b) => b.id === fixtureBookingLoc1), 'фикстурная бронь мастера должна быть видна ему самому');
});

test('RBAC: admin Точки 1 не получает бронь Точки 2 при прямом запросе к API (и наоборот)', async () => {
  const admin1 = await login('fixture-admin1@alikhan.test', PIN_ADMIN1);
  const admin2 = await login('fixture-admin2@alikhan.test', PIN_ADMIN2);

  const res1 = await fetch(`${API_URL}/bookings?date=2026-09-01`, {
    headers: { Authorization: `Bearer ${admin1.token}` },
  });
  const body1 = await res1.json();
  const ids1 = body1.bookings.map((b) => b.id);
  assert.ok(ids1.includes(fixtureBookingLoc1), 'admin Точки 1 должен видеть бронь своей точки');
  assert.ok(!ids1.includes(fixtureBookingLoc2), 'admin Точки 1 не должен видеть бронь Точки 2');

  const res2 = await fetch(`${API_URL}/bookings?date=2026-09-01`, {
    headers: { Authorization: `Bearer ${admin2.token}` },
  });
  const body2 = await res2.json();
  const ids2 = body2.bookings.map((b) => b.id);
  assert.ok(ids2.includes(fixtureBookingLoc2), 'admin Точки 2 должен видеть бронь своей точки');
  assert.ok(!ids2.includes(fixtureBookingLoc1), 'admin Точки 2 не должен видеть бронь Точки 1');
});

test('RBAC: анонимный запрос /bookings вообще не получает клиентские данные', async () => {
  const res = await fetch(`${API_URL}/bookings?date=2026-09-01`);
  assert.equal(res.status, 200);
  const data = await res.json();
  for (const b of data.bookings) {
    assert.ok(!('clientPhone' in b) && !('clientName' in b), 'анонимный запрос не должен видеть клиента вообще');
  }
});

test('RBAC: owner может сменить роль сотрудника через PUT /staff/:id/role, admin - нет', async () => {
  const owner = await login('fixture-owner@alikhan.test', PIN_OWNER);
  const admin1 = await login('fixture-admin1@alikhan.test', PIN_ADMIN1);

  const forbidden = await fetch(`${API_URL}/staff/${FIXTURE_MASTER_LOC1}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin1.token}` },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(forbidden.status, 401, 'admin не должен иметь права менять роли');

  const ok = await fetch(`${API_URL}/staff/${FIXTURE_MASTER_LOC1}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.role, 'admin');

  // возвращаем обратно, чтобы не путать остальные тесты этого файла, если порядок изменится
  await fetch(`${API_URL}/staff/${FIXTURE_MASTER_LOC1}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ role: 'master' }),
  });
});
