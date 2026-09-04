// Сквозная репетиция разговора после неявки (04.09.2026, решение Влада по карточке
// «Неявки» в «Недополученной прибыли») на настоящем Postgres и с поддельным
// Telegram: настоящий бот здесь не нужен, проверяется цепочка, а не чужой HTTP.
//
// Что доказывается:
//   1. отметка «клиент не пришёл» ставит письмо в очередь, повторная отметка - нет;
//   2. письмо уходит с двумя кнопками и без упрёка в тексте;
//   3. нажатие «Да, подберите время» записывает ответ на бронь и зовёт администратора;
//   4. список владельца ставит ответившего первым, а молчащего - вторым со сроком
//      молчания (вопрос Влада: «а если клиент не ответит - игнорить его?» - не игнорить);
//   5. снятая по ошибке отметка неявки гасит неотправленное письмо.
//
// Запуск: node tools/verify-2026-09-04-noshow-followup.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'noshow_followup_probe';
const ROLE = 'noshow_probe_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';

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
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
  await db.end();
}

await recreate();

process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

const { runInTenant, runDetached, pool } = await import('../api/lib/db.js');
const engine = await import('../api/lib/client-messaging.js');
const missed = await import('../api/routes/missed-profit.js');

// Поддельный Telegram для очереди сообщений
const outbox = [];
const fakeSend = async (token, chatId, text, keyboard) => {
  outbox.push({ chatId, text, keyboard });
  return { ok: true, result: { message_id: outbox.length } };
};
const deps = { sendMessage: fakeSend, telegramConfig: async () => ({ token: 'probe-token', username: 'probe_bot' }) };

// Обработчик кнопок (routes/telegram.js) ходит в Telegram напрямую через fetch -
// подменяем его целиком: нас интересует, что осядет в базе, а не что увидит Telegram
const apiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) {
    apiCalls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
const telegram = await import('../api/routes/telegram.js');

const TENANT = 2;
const TODAY = '2026-09-04';

try {
  await step('заведена клиника, два пациента и два пропущенных приёма', async () => {
    const admin = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
    await admin.query("INSERT INTO tenants (id, name, vertical) VALUES (2, 'Клиника Карины', 'clinic') ON CONFLICT DO NOTHING");
    await admin.query(`INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
      VALUES (2, 'telegram', 'probe-token', 'probe_bot', 'probe-secret', true) ON CONFLICT DO NOTHING`);
    await admin.end();
    await runInTenant(TENANT, async () => {
      await pool.query("INSERT INTO locations (id, name) VALUES (91, 'Клиника на Тухачевского')");
      await pool.query("INSERT INTO staff (id, location_id, name, role, email) VALUES ('doc', 91, 'Карина Урбашевичус', 'owner', 'doc@probe.local')");
      await pool.query("INSERT INTO services (id, name, category, duration_min, price) VALUES ('consult', 'Консультация ортодонта', 'base', 60, 3000)");
      await pool.query("INSERT INTO clients (id, phone, name) VALUES ('otvetil', '+79001112233', 'Мария'), ('molchit', '+79004445566', 'Пётр')");
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-otvetil', 91, 'doc', 'consult', 'otvetil', '2026-09-02', '15:00', '16:00', 'no_show'),
               ('bk-molchit', 91, 'doc', 'consult', 'molchit', '2026-09-01', '11:00', '12:00', 'no_show')`);
      // Оба открыли бота: канал есть, значит письмо им уйдёт
      await pool.query(`INSERT INTO client_channels (id, client_id, channel, external_id)
        VALUES ('cc1', 'otvetil', 'telegram', '555001'), ('cc2', 'molchit', 'telegram', '555002')`);
    }, 'clinic');
  });

  await step('отметка неявки ставит письмо, повторная отметка второго не плодит', async () => {
    const rows = await runInTenant(TENANT, async () => {
      await engine.enqueueNoShowFollowup({ id: 'bk-otvetil', client_id: 'otvetil' });
      await engine.enqueueNoShowFollowup({ id: 'bk-molchit', client_id: 'molchit' });
      // Повторный PATCH на ту же бронь - человек не должен получить второе письмо
      await engine.enqueueNoShowFollowup({ id: 'bk-otvetil', client_id: 'otvetil' });
      return (await pool.query("SELECT booking_id, status FROM client_messages WHERE kind = 'no_show_followup' ORDER BY booking_id")).rows;
    }, 'clinic');
    assert.equal(rows.length, 2, `писем ${rows.length}, а не 2 - повторная отметка задвоила очередь`);
    assert.ok(rows.every((r) => r.status === 'pending'));
  });

  await step('письмо уходит с двумя кнопками и без упрёка в тексте', async () => {
    const stats = await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', new Date(), deps), 'clinic');
    assert.equal(stats.sent, 2, `отправлено ${stats.sent} вместо 2`);
    const sent = outbox.at(-1);
    assert.match(sent.text, /не смогли прийти/i, `текст письма не тот: ${sent.text}`);
    assert.match(sent.text, /Подобрать вам новое время/i, `в письме нет предложения времени: ${sent.text}`);
    assert.doesNotMatch(sent.text, /долж|оплат|штраф/i, `в письме упрёк или счёт: ${sent.text}`);
    const keys = sent.keyboard.inline_keyboard.flat().map((b) => b.text);
    assert.equal(keys.length, 2, `кнопок ${keys.length} вместо двух: ${keys}`);
    assert.ok(keys.some((k) => /подберите время/i.test(k)), `нет кнопки согласия: ${keys}`);
  });

  await step('нажатие «Да, подберите время» пишет ответ на бронь и зовёт администратора', async () => {
    const update = {
      callback_query: {
        id: 'cb1',
        data: 'rb:bk-otvetil',
        from: { id: 555001 },
        message: { message_id: 10, chat: { id: 555001 } },
      },
    };
    const out = await runDetached(TENANT, () => telegram.processUpdate(update, { token: 'probe-token' }, 'clinic'), 'clinic');
    assert.equal(out.action, 'noshow_wants_time', `обработчик вернул ${out.action}`);
    const row = await runInTenant(TENANT, async () => (await pool.query("SELECT noshow_reply, noshow_reply_at FROM bookings WHERE id = 'bk-otvetil'")).rows[0], 'clinic');
    assert.equal(row.noshow_reply, 'wants_time', 'ответ клиента не записан на бронь');
    assert.ok(row.noshow_reply_at, 'нет времени ответа');
    const notif = await runInTenant(TENANT, async () => (await pool.query("SELECT type, title FROM notifications WHERE staff_id = 'doc'")).rows, 'clinic');
    assert.ok(notif.length >= 1, 'администратор не узнал, что клиент ждёт звонка');
    assert.match(notif[0].title, /новое время/i, `заголовок уведомления не тот: ${notif[0].title}`);
  });

  await step('список владельца: ответивший первым, молчащий вторым со сроком молчания', async () => {
    const { noshow } = await runInTenant(TENANT, async () => {
      // Письмо молчащему ушло три дня назад - столько он и молчит
      await pool.query("UPDATE client_messages SET sent_at = '2026-09-01 12:00+03' WHERE booking_id = 'bk-molchit'");
      const result = await missed.computeMissedProfit(pool, '2026-08-01', TODAY, TODAY);
      return missed.sortLists(result);
    }, 'clinic');
    assert.deepEqual(noshow.map((r) => r.name), ['Мария', 'Пётр'], 'порядок списка не по работе владельца');
    assert.equal(noshow[0].state, 'replied', `первый в списке в состоянии ${noshow[0].state}`);
    assert.equal(noshow[1].state, 'silent', `молчащий выпал из списка или помечен как ${noshow[1].state}`);
    assert.equal(noshow[1].silentDays, 3, `срок молчания ${noshow[1].silentDays} вместо 3`);
    assert.ok(noshow.every((r) => r.phone), 'в списке нет телефона - звонить не по чему');
  });

  await step('снятая отметка неявки гасит неотправленное письмо', async () => {
    await runInTenant(TENANT, async () => {
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-oshibka', 91, 'doc', 'consult', 'molchit', '2026-09-03', '09:00', '10:00', 'no_show')`);
      await engine.enqueueNoShowFollowup({ id: 'bk-oshibka', client_id: 'molchit' });
      await engine.cancelPendingForBooking('bk-oshibka', ['no_show_followup']);
    }, 'clinic');
    const row = await runInTenant(TENANT, async () => (await pool.query("SELECT status FROM client_messages WHERE booking_id = 'bk-oshibka'")).rows[0], 'clinic');
    assert.equal(row.status, 'cancelled', `письмо осталось в состоянии ${row.status} - человек получит его зря`);
  });

  console.log(`\nГОТОВО: ${results.length} проверок пройдено`);
  process.exit(0);
} catch (e) {
  console.error('\nПРОВАЛ:', e.message);
  process.exit(1);
}
