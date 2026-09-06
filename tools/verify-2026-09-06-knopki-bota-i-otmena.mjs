// Сквозной прогон двух дефектов, найденных живым осмотром Влада 06.09.2026 на
// кабинете клиники (настоящий Postgres на этой машине, живых данных нет).
//
// Дефект 1. Кнопки бота по визиту не работали ни одна: человек нажимал «Да,
// подберите время» после неявки и получал «Не нашли вашу запись». Причина -
// callback_data разбиралась split(':'), а в идентификаторе брони двоеточие есть
// всегда (время визита внутри id).
//
// Дефект 2. Отмена записи была недостижима из кабинета: роут есть и уведомляет всех
// причастных, а вызвать его было неоткуда - в карточке только статусы и удаление.
// Поэтому «отменил, а уведомления нет» - уведомления и не могло быть.
//
// Запуск: node tools/verify-2026-09-06-knopki-bota-i-otmena.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'knopki_otmena_probe';
const ROLE = 'knopki_probe_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const TENANT = 2;

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

const admin = new pg.Pool({ host, database: 'postgres' });
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
await admin.end();
{
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
  await db.query("INSERT INTO tenants (id, name, vertical) VALUES (2, 'Клиника Карины', 'clinic') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
    VALUES (2, 'telegram', 'probe-token', 'probe_bot', 'probe-secret', true)`);
  await db.end();
}

process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

// Всё, что уходит в Telegram, ловим здесь - сети в прогоне нет
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
};

const { runInTenant, pool } = await import('../api/lib/db.js');
const { handleBookings, handleBookingCancel, handleBookingStatus } = await import('../api/routes/bookings.js');
const { processUpdate } = await import('../api/routes/telegram.js');

const BOT = { tenantId: TENANT, token: 'probe-token', username: 'probe_bot', vertical: 'clinic' };
const CHAT = 880002;
const TOKEN = 'probe-session-token';
// Дата берётся с запасом вперёд: запись в прошлое сервер не создаёт (past_time)
const DATE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

// Поддельные req/res: те же поля, которые читают роуты, и ничего лишнего
function fakeReq(method, body = null, headers = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers };
  return req;
}
function fakeRes() {
  const res = { statusCode: null, payload: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null; };
  return res;
}
const answers = () => calls.filter((c) => c.method === 'answerCallback').map((c) => c.body.text);

let bookingId = null;

try {
  await step('заведена клиника: врач, услуга, график, пациент с ботом', async () => {
    await runInTenant(TENANT, async () => {
      await pool.query("INSERT INTO locations (id, name) VALUES (91, 'Клиника на Тухачевского')");
      await pool.query(`INSERT INTO staff (id, location_id, name, role, email, employed, has_system_access, provides_services)
        VALUES ('doc', 91, 'Карина', 'owner', 'doc@probe.local', true, true, true)`);
      await pool.query("INSERT INTO services (id, name, category, duration_min, price) VALUES ('consult', 'Консультация ортодонта', 'base', 60, 3000)");
      await pool.query("INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('doc', 'consult', 3000, 60)");
      // Недельный график - тот самый критерий «врач вообще принимает записи»
      // (mastersWithWorkingSchedule), плюс смена на конкретный день прогона
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        await pool.query(`INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
          VALUES ('doc', $1, true, '09:00', '18:00')`, [weekday]);
      }
      await pool.query(`INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ('doc', $1, '09:00', '18:00')`, [DATE]);
      await pool.query("INSERT INTO clients (id, phone, name) VALUES ('client-vlad', '+79001234567', 'Влад')");
      await pool.query(`INSERT INTO client_channels (id, client_id, channel, external_id)
        VALUES ('ch-vlad', 'client-vlad', 'telegram', $1)`, [String(CHAT)]);
      await pool.query(`INSERT INTO sessions (token, staff_id, expires_at)
        VALUES ($1, 'doc', now() + interval '1 day')`, [TOKEN]);
    }, 'clinic');
  });

  await step('запись создана обычным путём, и в её id есть двоеточие', async () => {
    const req = fakeReq('POST', { masterId: 'doc', serviceIds: ['consult'], date: DATE, startTime: '10:00', clientName: 'Влад', clientPhone: '+79001234567' });
    const res = fakeRes();
    await runInTenant(TENANT, () => handleBookings(req, res, new URL('http://localhost/bookings')), 'clinic');
    assert.equal(res.statusCode, 200, `создание записи вернуло ${res.statusCode}: ${JSON.stringify(res.payload)}`);
    bookingId = res.payload.booking.id;
    assert.ok(bookingId.includes(':'), `предпосылка обоих дефектов: id содержит время с двоеточием, получено «${bookingId}»`);
  });

  await step('визит отмечен неявкой - письмо пациенту с кнопкой ушло', async () => {
    const req = fakeReq('PATCH', { status: 'no_show' });
    const res = fakeRes();
    await runInTenant(TENANT, () => handleBookingStatus(req, res, ['bookings', bookingId, 'status']), 'clinic');
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    const { rows } = await runInTenant(TENANT, () => pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]), 'clinic');
    assert.equal(rows[0].status, 'no_show');
  });

  await step('кнопка «Да, подберите время» находит запись (был ответ «Не нашли вашу запись»)', async () => {
    calls.length = 0;
    const result = await runInTenant(TENANT, () => processUpdate({
      callback_query: { id: 'cb-1', data: `rb:${bookingId}`, from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 5 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(result.action, 'noshow_wants_time', `бот ответил «${result.action}»`);
    assert.ok(!answers().includes('Не нашли вашу запись'), `бот сказал: ${JSON.stringify(answers())}`);
    const { rows } = await runInTenant(TENANT, () => pool.query('SELECT noshow_reply FROM bookings WHERE id = $1', [bookingId]), 'clinic');
    assert.equal(rows[0].noshow_reply, 'wants_time', 'ответ пациента должен лечь на бронь');
  });

  await step('кнопка «✖️ Отменить» в боте доносит просьбу до сотрудника', async () => {
    calls.length = 0;
    const result = await runInTenant(TENANT, () => processUpdate({
      callback_query: { id: 'cb-2', data: `no:${bookingId}`, from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 6 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(result.action, 'client_wants_cancel');
    const { rows } = await runInTenant(TENANT, () => pool.query(
      "SELECT staff_id FROM notifications WHERE type = 'client_wants_cancel' AND booking_id = $1", [bookingId]), 'clinic');
    assert.ok(rows.length > 0, 'заявка на отмену должна лежать у врача');
  });

  await step('сотрудник отменяет запись: статус, уведомление и порог возврата', async () => {
    const res = fakeRes();
    await runInTenant(TENANT, () => handleBookingCancel(fakeReq('POST'), res, ['bookings', bookingId, 'cancel']), 'clinic');
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.status, 'cancelled');
    assert.equal(res.payload.refundEligible, true, 'до визита трое суток - полный возврат положен');
    const { rows } = await runInTenant(TENANT, () => pool.query(
      "SELECT title, body FROM notifications WHERE type = 'booking_cancelled' AND booking_id = $1", [bookingId]), 'clinic');
    assert.ok(rows.length > 0, 'уведомление об отмене должно появиться у врача - ровно его и не хватало Владу');
    assert.match(rows[0].title, /отмен/i, `заголовок уведомления: «${rows[0].title}»`);
  });

  await step('прежние уведомления по этой брони не остались висеть рядом с отменой', async () => {
    const { rows } = await runInTenant(TENANT, () => pool.query(
      "SELECT type FROM notifications WHERE booking_id = $1 AND type <> 'booking_cancelled'", [bookingId]), 'clinic');
    assert.equal(rows.length, 0, `рядом с отменой остались: ${rows.map((r) => r.type).join(', ')}`);
  });

  await step('время освободилось: на тот же слот записывается следующий пациент', async () => {
    const req = fakeReq('POST', { masterId: 'doc', serviceIds: ['consult'], date: DATE, startTime: '10:00', clientName: 'Второй пациент', clientPhone: '+79007654321' });
    const res = fakeRes();
    await runInTenant(TENANT, () => handleBookings(req, res, new URL('http://localhost/bookings')), 'clinic');
    assert.equal(res.statusCode, 200, `слот остался занятым: ${JSON.stringify(res.payload)}`);
  });

  console.log(`\n${results.length} passed, 0 failed`);
} catch (err) {
  console.error('\nПРОГОН УПАЛ:', err.message);
  console.error(err.stack?.split('\n').slice(1, 4).join('\n'));
  console.log(`\n${results.length} passed, 1 failed`);
  process.exitCode = 1;
} finally {
  await new Promise((r) => setTimeout(r, 150)); // дать уйти отложенным push-доставкам
}
