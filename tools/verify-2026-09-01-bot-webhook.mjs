// Репетиция входящих обновлений от бота (01.09.2026, Волна 1) на настоящем
// Postgres. Настоящий Telegram подменён на уровне fetch: проверяем и свою логику,
// и то, что именно мы отправляем наружу.
//
// Что доказывается:
//   1. ссылка-приглашение привязывает человека, повторная - уже нет;
//   2. чужой id записи в кнопке ничего не подтверждает (главный вектор подделки);
//   3. «Приду» ставит client_confirmed - колонка, ждавшая с 002_schema.sql;
//   4. «Перенести» не двигает запись сам, а зовёт живого человека уведомлением;
//   5. /stop отписывает, и очередь после этого признаёт отсутствие канала;
//   6. webhook без правильного заголовка-секрета получает отказ;
//   7. отмена записи гасит неотправленные сообщения, перенос пересчитывает сроки.
//
// Запуск: node tools/verify-2026-09-01-bot-webhook.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'bot_webhook_probe';
const ROLE = 'bot_webhook_probe_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const SECRET = 'secret-probe-123';

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
    VALUES (2, 'telegram', 'probe-token', 'probe_bot', '${SECRET}', true)`);
  await db.end();
}

process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

// Подменяем сам fetch: так проверяется и то, что уходит в Telegram
const calls = [];
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  calls.push({ method, body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
};

const { runInTenant, pool } = await import('../api/lib/db.js');
const engine = await import('../api/lib/client-messaging.js');
const { processUpdate, handleTelegramWebhook } = await import('../api/routes/telegram.js');

const BOT = { tenantId: 2, token: 'probe-token', username: 'probe_bot', vertical: 'clinic' };
const CHAT = 770001;
const sentTexts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);

try {
  await step('заведена клиника с врачом, пациенткой и приёмом', async () => {
    await runInTenant(2, async () => {
      await pool.query("INSERT INTO locations (id, name) VALUES (91, 'Клиника')");
      await pool.query("INSERT INTO staff (id, location_id, name, role, email) VALUES ('doc', 91, 'Карина', 'owner', 'doc@probe.local')");
      await pool.query("INSERT INTO clients (id, phone, name) VALUES ('pat', '+79001112233', 'Мария')");
      await pool.query("INSERT INTO clients (id, phone, name) VALUES ('other', '+79004445566', 'Чужой')");
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status)
        VALUES ('bk', 91, 'doc', 'pat', '2026-09-05', '15:00', '16:00', 'planned')`);
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-other', 91, 'doc', 'other', '2026-09-05', '17:00', '18:00', 'planned')`);
    }, 'clinic');
  });

  let token;
  await step('ссылка-приглашение привязывает, повторная - уже нет', async () => {
    token = await runInTenant(2, () => engine.createInvite('pat'), 'clinic');
    const first = await runInTenant(2, () => processUpdate({ message: { text: `/start ${token}`, chat: { id: CHAT } } }, BOT, 'clinic'), 'clinic');
    assert.equal(first.action, 'linked', `первая ссылка дала ${first.action}`);
    assert.match(sentTexts().at(-1), /приёме/, 'приветствие говорит не языком клиники');
    const again = await runInTenant(2, () => processUpdate({ message: { text: `/start ${token}`, chat: { id: 770002 } } }, BOT, 'clinic'), 'clinic');
    assert.equal(again.action, 'invite_invalid', 'той же ссылкой привязался второй');
  });

  await step('привязка воскрешает подтверждение, сгоревшее до неё', async () => {
    // Боевой ход событий: запись создана, ссылка отправлена, человек открыл бота
    // через десять минут. К этому моменту подтверждение уже помечено «без канала»
    await runInTenant(2, async () => {
      await pool.query(`INSERT INTO clients (id, phone, name) VALUES ('late', '+79007778899', 'Опоздавшая')`);
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-late', 91, 'doc', 'late', to_char(now() + interval '2 days', 'YYYY-MM-DD')::date, '15:00', '16:00', 'planned')`);
      await pool.query(`INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status, last_error)
        VALUES ('cm-late', 'late', 'bk-late', 'booking_confirm', now() - interval '10 minutes', 'skipped', 'no_channel')`);
      const inviteLate = await engine.createInvite('late');
      const res = await processUpdate({ message: { text: `/start ${inviteLate}`, chat: { id: 770009 } } }, BOT, 'clinic');
      assert.equal(res.action, 'linked');
      // Не просто воскресло, а уже ушло: с 01.09.2026 подтверждение отправляется
      // в том же обработчике /start, без ожидания тика планировщика
      const row = (await pool.query("SELECT status, sent_at FROM client_messages WHERE id = 'cm-late'")).rows[0];
      assert.equal(row.status, 'sent', `после привязки подтверждение в статусе ${row.status}, а не отправлено`);
      assert.ok(row.sent_at.getTime() >= Date.now() - 5000, 'подтверждение отправлено не сейчас');
      const lastText = sentTexts().at(-1);
      assert.match(lastText, /Вы записаны/, `последним ушло не подтверждение: ${lastText}`);
    }, 'clinic');
  });

  await step('прошедший визит после привязки не воскрешается', async () => {
    await runInTenant(2, async () => {
      await pool.query(`INSERT INTO clients (id, phone, name) VALUES ('past', '+79007778800', 'Вчерашний')`);
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-past', 91, 'doc', 'past', to_char(now() - interval '2 days', 'YYYY-MM-DD')::date, '15:00', '16:00', 'planned')`);
      await pool.query(`INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status, last_error)
        VALUES ('cm-past', 'past', 'bk-past', 'reminder_24h', now() - interval '3 days', 'skipped', 'no_channel')`);
      const invitePast = await engine.createInvite('past');
      await processUpdate({ message: { text: `/start ${invitePast}`, chat: { id: 770010 } } }, BOT, 'clinic');
      const row = (await pool.query("SELECT status FROM client_messages WHERE id = 'cm-past'")).rows[0];
      assert.equal(row.status, 'skipped', 'напоминание о прошедшем визите воскресло');
    }, 'clinic');
  });

  await step('текст вместо кнопки показывает ближайшую запись с кнопками', async () => {
    const before = calls.length;
    const res = await runInTenant(2, () => processUpdate({ message: { text: 'Приду', chat: { id: CHAT } } }, BOT, 'clinic'), 'clinic');
    assert.equal(res.action, 'free_text_with_booking', `на текст ответили ${res.action}`);
    const answer = calls.slice(before).find((c) => c.method === 'sendMessage');
    assert.ok(answer.body.reply_markup, 'ответ на текст пришёл без кнопок');
    assert.match(answer.body.text, /ближайшая запись/i);
  });

  await step('чужой id записи в кнопке ничего не подтверждает', async () => {
    const res = await runInTenant(2, () => processUpdate({
      callback_query: { id: 'cb1', data: 'ok:bk-other', from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 5 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(res.action, 'callback_foreign_booking', `подделка прошла как ${res.action}`);
    const foreign = await runInTenant(2, async () => (await pool.query("SELECT client_confirmed FROM bookings WHERE id = 'bk-other'")).rows[0], 'clinic');
    assert.equal(foreign.client_confirmed, false, 'чужая запись подтверждена чужим человеком');
  });

  await step('«Приду» ставит подтверждение своей записи', async () => {
    const res = await runInTenant(2, () => processUpdate({
      callback_query: { id: 'cb2', data: 'ok:bk', from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 6 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(res.action, 'confirmed');
    const own = await runInTenant(2, async () => (await pool.query("SELECT client_confirmed FROM bookings WHERE id = 'bk'")).rows[0], 'clinic');
    assert.equal(own.client_confirmed, true, 'подтверждение не записалось');
    assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup'), 'кнопки не сняты после ответа');
  });

  await step('после подтверждения остаётся выход: «Задержусь» с выбором времени', async () => {
    // Вопрос Влада на живом прогоне: подтвердил, а потом задержался. Раньше кнопки
    // снимались и сказать об этом было нечем - оставался только телефонный звонок
    const afterConfirm = calls.filter((c) => c.method === 'sendMessage').at(-1);
    assert.match(afterConfirm.body.text, /Подтверждено/);
    const labels = afterConfirm.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((t) => t.includes('Задержусь')), `после подтверждения кнопки: ${labels.join(', ')}`);

    const ask = await runInTenant(2, () => processUpdate({
      callback_query: { id: 'cb-lt', data: 'lt:bk', from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 8 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(ask.action, 'late_ask');
    const minutes = calls.filter((c) => c.method === 'sendMessage').at(-1).body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(minutes, ['10 минут', '20 минут', '30 минут'], `спросили не про минуты: ${minutes.join(', ')}`);

    const told = await runInTenant(2, () => processUpdate({
      callback_query: { id: 'cb-l2', data: 'l2:bk', from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 9 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(told.action, 'client_will_be_late');
    assert.equal(told.minutes, 20);
    const notif = await runInTenant(2, async () => (await pool.query("SELECT type, title FROM notifications WHERE type = 'client_will_be_late'")).rows, 'clinic');
    assert.ok(notif.length > 0, 'сотрудники не узнали, что клиент задержится');
    assert.match(notif[0].title, /20 мин/, `в уведомлении нет времени: ${notif[0].title}`);
    // Запись при этом остаётся на месте: человек придёт, просто позже
    const still = await runInTenant(2, async () => (await pool.query("SELECT status, client_confirmed FROM bookings WHERE id = 'bk'")).rows[0], 'clinic');
    assert.equal(still.status, 'planned');
    assert.equal(still.client_confirmed, true, 'опоздание сняло подтверждение');
  });

  await step('«Перенести» зовёт человека, а не двигает запись сам', async () => {
    const before = await runInTenant(2, async () => (await pool.query("SELECT date, start_time FROM bookings WHERE id = 'bk'")).rows[0], 'clinic');
    const res = await runInTenant(2, () => processUpdate({
      callback_query: { id: 'cb3', data: 'mv:bk', from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 7 } },
    }, BOT, 'clinic'), 'clinic');
    assert.equal(res.action, 'client_wants_move');
    const after = await runInTenant(2, async () => (await pool.query("SELECT date, start_time FROM bookings WHERE id = 'bk'")).rows[0], 'clinic');
    assert.deepEqual(after, before, 'бот подвинул запись сам');
    const notif = await runInTenant(2, async () => (await pool.query("SELECT type, staff_id FROM notifications WHERE booking_id = 'bk'")).rows, 'clinic');
    assert.ok(notif.some((n) => n.type === 'client_wants_move'), 'сотрудники не узнали о просьбе');
  });

  await step('/stop отписывает, и очередь это видит', async () => {
    await runInTenant(2, () => processUpdate({ message: { text: '/stop', chat: { id: CHAT } } }, BOT, 'clinic'), 'clinic');
    const ch = await runInTenant(2, async () => (await pool.query("SELECT unsubscribed_at FROM client_channels WHERE client_id = 'pat'")).rows[0], 'clinic');
    assert.ok(ch.unsubscribed_at, 'отписка не записалась');
  });

  await step('webhook без правильного заголовка-секрета получает отказ', async () => {
    const seen = {};
    const res = { writeHead: (code) => { seen.code = code; }, end: (body) => { seen.body = body; }, setHeader: () => {} };
    await handleTelegramWebhook({ headers: { 'x-telegram-bot-api-secret-token': 'подделка' }, method: 'POST' }, res, SECRET);
    assert.equal(seen.code, 403, `ответ ${seen.code} вместо 403`);
    const unknown = {};
    const res2 = { writeHead: (code) => { unknown.code = code; }, end: () => {}, setHeader: () => {} };
    await handleTelegramWebhook({ headers: {}, method: 'POST' }, res2, 'секрет-которого-нет');
    assert.equal(unknown.code, 404, `неизвестный адрес получил ${unknown.code} вместо 404`);
  });

  await step('отмена записи гасит неотправленное, перенос пересчитывает сроки', async () => {
    await runInTenant(2, async () => {
      const booking = { id: 'bk', client_id: 'pat', date: '2026-09-05', start_time: '15:00', end_time: '16:00' };
      await engine.enqueueForBooking(booking, new Date('2026-09-01T09:00:00Z'));
      const moved = { ...booking, date: '2026-09-06', start_time: '11:00', end_time: '12:00' };
      await engine.enqueueForBooking(moved, new Date('2026-09-01T09:00:00Z'));
      const rows = (await pool.query("SELECT kind, due_at FROM client_messages WHERE booking_id = 'bk' AND kind = 'reminder_2h'")).rows;
      assert.equal(rows.length, 1, 'перенос завёл вторую строку вместо пересчёта');
      // Перенос на 06.09 в 11:00 ПО МОСКВЕ = 08:00 UTC, «за два часа» - 06:00 UTC
      assert.equal(rows[0].due_at.toISOString(), '2026-09-06T06:00:00.000Z', 'срок не пересчитан по новому времени');
      const killed = await engine.cancelPendingForBooking('bk');
      assert.ok(killed >= 1, 'отмена ничего не погасила');
    }, 'clinic');
  });

  console.log(`\nГОТОВО: ${results.length} проверок пройдено`);
  process.exit(0);
} catch (e) {
  console.error('\nПРОВАЛ:', e.message);
  process.exit(1);
}
