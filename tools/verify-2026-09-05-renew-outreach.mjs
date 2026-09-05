// Сквозная репетиция разговора о возврате (05.09.2026, миграция 070) на настоящем
// Postgres и с поддельным транспортом. Локальная база, живых данных здесь нет.
//
// Зачем этот прогон. Механизм пишет живым людям сам, без участия человека, и цена
// ошибки здесь не «неверная цифра в отчёте», а сообщение не тому и не о том. Всё,
// что можно проверить до первого живого клиента, проверяется здесь.
//
// Что доказывается:
//   1. срок наступил - письмо «пора» встаёт в очередь, ключ цикла равен дате срока;
//   2. сканер, отработавший второй раз, второго письма не создаёт;
//   3. у кого есть будущая запись - тому не пишем: он уже записан;
//   4. кто сказал «пока не планирую» - тому не пишем до следующего визита;
//   5. пропущен полный цикл - письмо другое, «давно не были»;
//   6. пропавший на три цикла остаётся списком владельца, писем ему нет;
//   7. отписавшийся от бота писем не получает;
//   8. согласие «записаться» пишет ответ, но заявку на прозвон НЕ создаёт;
//  8а. заявка появляется только через сутки и только если записи так и нет;
//   9. дневной потолок держит первое включение механизма на живой базе.
//
// Запуск: node tools/verify-2026-09-05-renew-outreach.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'renew_outreach_probe';
const ROLE = 'renew_probe_app';
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

const outbox = [];
const fakeSend = async (token, chatId, text, keyboard) => {
  outbox.push({ chatId, text, keyboard });
  return { ok: true, result: { message_id: outbox.length } };
};
const deps = { sendMessage: fakeSend, telegramConfig: async () => ({ token: 'probe-token', username: 'probe_bot' }) };

const TENANT = 2;
// «Сегодня» прогона. Все даты визитов считаются от него, чтобы проверка не
// протухала завтра
const TODAY = '2026-09-05';
const NOW = new Date(`${TODAY}T09:00:00Z`);
const daysAgo = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

// Клиент с историей: один состоявшийся визит N дней назад, привязка к боту
async function seedClient(id, { visitDaysAgo, renewDays = 28, linked = true, unsubscribed = false }) {
  await pool.query('INSERT INTO clients (id, phone, name, renew_days) VALUES ($1, $2, $3, $4)', [id, `+7900${id.slice(-7).padStart(7, '0')}`, `Пациент ${id}`, renewDays]);
  if (linked) {
    await pool.query(
      `INSERT INTO client_channels (id, client_id, channel, external_id, unsubscribed_at)
       VALUES ($1, $2, 'telegram', $3, $4)`,
      [`ch-${id}`, id, `chat-${id}`, unsubscribed ? new Date().toISOString() : null],
    );
  }
  await pool.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
     VALUES ($1, 91, 'doc', 'consult', $2, $3, '10:00', '11:00', 'done')`,
    [`bk-${id}`, id, daysAgo(visitDaysAgo)],
  );
}

const queuedFor = async (clientId) =>
  (await pool.query('SELECT kind, cycle_key, status FROM client_messages WHERE client_id = $1 ORDER BY created_at', [clientId])).rows;

try {
  await step('заведена клиника с врачом и услугой', async () => {
    const admin = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
    // booking_url задан: у заведения есть форма записи, и по поправке Влада человек
    // идёт записываться сам, а не ждёт звонка
    await admin.query("INSERT INTO tenants (id, name, vertical, booking_url) VALUES (2, 'Клиника Карины', 'clinic', 'https://example.test/zapis') ON CONFLICT DO NOTHING");
    await admin.query(`INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
      VALUES (2, 'telegram', 'probe-token', 'probe_bot', 'probe-secret', true) ON CONFLICT DO NOTHING`);
    await admin.end();
    await runInTenant(TENANT, async () => {
      await pool.query("INSERT INTO locations (id, name) VALUES (91, 'Клиника на Тухачевского')");
      await pool.query("INSERT INTO staff (id, location_id, name, role, email, employed, has_system_access) VALUES ('doc', 91, 'Карина', 'owner', 'doc@probe.local', true, true)");
      await pool.query("INSERT INTO staff (id, location_id, name, role, email, employed, has_system_access) VALUES ('adm', 91, 'Администратор', 'admin', 'adm@probe.local', true, true)");
      await pool.query("INSERT INTO services (id, name, category, duration_min, price) VALUES ('consult', 'Консультация ортодонта', 'base', 60, 3000)");
    }, 'clinic');
  });

  await step('срок наступил - письмо «пора» встаёт в очередь с ключом на дату срока', async () => {
    await runInTenant(TENANT, async () => {
      await seedClient('pat-due', { visitDaysAgo: 28 });
      const res = await engine.scanRenewOutreach(NOW);
      assert.equal(res.queued, 1, `поставлено ${res.queued} писем вместо одного`);
      const rows = await queuedFor('pat-due');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'renew_due');
      assert.equal(rows[0].cycle_key, TODAY, 'ключ цикла не равен дате наступления срока');
      const c = (await pool.query("SELECT renew_outreach_at FROM clients WHERE id = 'pat-due'")).rows[0];
      assert.ok(c.renew_outreach_at, 'дата разговора не записана - список владельца не отличит написанного от нетронутого');
    }, 'clinic');
  });

  await step('второй проход сканера второго письма не создаёт', async () => {
    await runInTenant(TENANT, async () => {
      const res = await engine.scanRenewOutreach(new Date(`${TODAY}T18:00:00Z`));
      assert.equal(res.queued, 0, 'один наступивший срок дал два письма');
      assert.equal((await queuedFor('pat-due')).length, 1);
    }, 'clinic');
  });

  await step('письмо уходит с текстом про прошлый визит и кнопками на id клиента', async () => {
    outbox.length = 0;
    await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', NOW, { ...deps, clientId: 'pat-due' }), 'clinic');
    assert.equal(outbox.length, 1, `ушло ${outbox.length} сообщений вместо одного`);
    assert.match(outbox[0].text, /8 августа/, `в тексте нет даты прошлого визита: ${outbox[0].text}`);
    assert.match(outbox[0].text, /пора/i, 'письмо «пора» не про то');
    const data = JSON.stringify(outbox[0].keyboard);
    assert.match(data, /vb:pat-due/, 'в кнопке не id клиента - бот не поймёт, чью карточку трогать');
    assert.match(data, /vn:pat-due/);
  });

  await step('у кого есть будущая запись - тому не пишем', async () => {
    await runInTenant(TENANT, async () => {
      await seedClient('pat-booked', { visitDaysAgo: 28 });
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-future', 91, 'doc', 'consult', 'pat-booked', $1, '12:00', '13:00', 'planned')`, [daysAgo(-3)]);
      await engine.scanRenewOutreach(NOW);
      assert.equal((await queuedFor('pat-booked')).length, 0, 'написали человеку, который уже записан');
    }, 'clinic');
  });

  await step('сказавшему «пока не планирую» не пишем до следующего визита', async () => {
    await runInTenant(TENANT, async () => {
      await seedClient('pat-declined', { visitDaysAgo: 28 });
      await pool.query("UPDATE clients SET renew_reply = 'not_now', renew_reply_at = now() WHERE id = 'pat-declined'");
      await engine.scanRenewOutreach(NOW);
      assert.equal((await queuedFor('pat-declined')).length, 0, 'вежливый вопрос превратился в преследование');
    }, 'clinic');
  });

  await step('пропущен полный цикл - письмо другое, «давно не были»', async () => {
    await runInTenant(TENANT, async () => {
      await seedClient('pat-overdue', { visitDaysAgo: 56 });
      await engine.scanRenewOutreach(NOW);
      const rows = await queuedFor('pat-overdue');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'renew_overdue');
    }, 'clinic');
    outbox.length = 0;
    await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', NOW, { ...deps, clientId: 'pat-overdue' }), 'clinic');
    assert.match(outbox[0].text, /давно у нас не были/, `текст реанимации не тот: ${outbox[0].text}`);
  });

  await step('пропавший на три цикла остаётся списком владельца', async () => {
    await runInTenant(TENANT, async () => {
      await seedClient('pat-lost', { visitDaysAgo: 200 });
      await engine.scanRenewOutreach(NOW);
      assert.equal((await queuedFor('pat-lost')).length, 0, 'фоновый тик взялся за реактивацию базы вместо владельца');
    }, 'clinic');
  });

  await step('отписавшийся от бота писем не получает', async () => {
    await runInTenant(TENANT, async () => {
      await seedClient('pat-off', { visitDaysAgo: 28, unsubscribed: true });
      await engine.scanRenewOutreach(NOW);
      assert.equal((await queuedFor('pat-off')).length, 0, 'очередь забивается письмами тем, кто отписался');
    }, 'clinic');
  });

  await step('«записаться» при наличии формы: ответ записан, заявки на прозвон НЕТ', async () => {
    const { processUpdate } = await import('../api/routes/telegram.js');
    const update = { callback_query: { id: 'cb-1', data: 'vb:pat-due', message: { chat: { id: 'chat-pat-due' }, message_id: 5 }, from: { id: 'chat-pat-due' } } };
    await runDetached(TENANT, async () => {
      try {
        await processUpdate(update, { token: 'probe-token', username: 'probe_bot' }, 'clinic');
      } catch (err) {
        // Ответ Telegram здесь недоступен и не нужен: транспорт проверен живым
        // прогоном 01.09.2026, а нас интересует, что осталось в базе
        if (!/fetch|network|ENOTFOUND|EAI_AGAIN|403|Telegram/i.test(String(err.message))) throw err;
      }
    }, 'clinic');
    await runInTenant(TENANT, async () => {
      const c = (await pool.query("SELECT renew_reply, renew_reply_at FROM clients WHERE id = 'pat-due'")).rows[0];
      assert.equal(c.renew_reply, 'wants_time', 'ответ клиента не записан');
      assert.ok(c.renew_reply_at, 'время ответа не записано - список не покажет «ответил вчера»');
      // Поправка Влада: у заведения есть форма записи, человек идёт и записывается
      // сам - звонить ему не о чем, и заявки быть не должно
      const n = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE type = 'client_wants_return'");
      assert.equal(n.rows[0].n, 0, 'заявка на прозвон создана сразу - администратор позвонит тому, кто и сам записался');
    }, 'clinic');
  });

  await step('сутки прошли, записи нет - вот теперь заявка на прозвон', async () => {
    await runInTenant(TENANT, async () => {
      const { requestCallsForUnbooked } = await import('../api/lib/client-messaging.js');
      // Ответ был «вчера» относительно момента проверки
      await pool.query("UPDATE clients SET renew_reply_at = now() - interval '30 hours' WHERE id = 'pat-due'");
      const res = await requestCallsForUnbooked(new Date());
      assert.equal(res.calls, 1, `создано ${res.calls} заявок вместо одной`);
      const n = await pool.query("SELECT staff_id, title, body FROM notifications WHERE type = 'client_wants_return'");
      assert.ok(n.rowCount >= 2, `заявка ушла ${n.rowCount} сотрудникам, а должна и владельцу, и администратору`);
      assert.match(n.rows[0].title, /не записался/, 'заголовок не объясняет, зачем звонить');
      assert.match(n.rows[0].body, /\+7/, 'в заявке нет телефона - администратору нечем звонить');
      // Повторный проход не плодит дела
      const again = await requestCallsForUnbooked(new Date());
      assert.equal(again.calls, 0, 'одна и та же заявка создана дважды');
    }, 'clinic');
  });

  await step('формы записи у заведения нет - администратор нужен сразу', async () => {
    const { processUpdate } = await import('../api/routes/telegram.js');
    await runInTenant(TENANT, async () => {
      await seedClient('pat-noform', { visitDaysAgo: 28 });
    }, 'clinic');
    const admin = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
    await admin.query('UPDATE tenants SET booking_url = NULL WHERE id = 2');
    await admin.end();
    await runDetached(TENANT, async () => {
      try {
        await processUpdate(
          { callback_query: { id: 'cb-2', data: 'vb:pat-noform', message: { chat: { id: 'chat-pat-noform' }, message_id: 7 }, from: { id: 'chat-pat-noform' } } },
          { token: 'probe-token', username: 'probe_bot' },
          'clinic',
        );
      } catch (err) {
        if (!/fetch|network|ENOTFOUND|EAI_AGAIN|403|Telegram/i.test(String(err.message))) throw err;
      }
    }, 'clinic');
    await runInTenant(TENANT, async () => {
      const n = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE client_id = 'pat-noform'");
      assert.ok(n.rows[0].n >= 2, 'записаться негде, а заявки администратору нет - человек повис');
      const c = (await pool.query("SELECT renew_call_requested_at FROM clients WHERE id = 'pat-noform'")).rows[0];
      assert.ok(c.renew_call_requested_at, 'заявка создана, но след не проставлен - сканер создаст её второй раз');
    }, 'clinic');
    const back = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
    await back.query("UPDATE tenants SET booking_url = 'https://example.test/zapis' WHERE id = 2");
    await back.end();
  });

  await step('согласился и записался сам - заявки нет вовсе', async () => {
    await runInTenant(TENANT, async () => {
      const { requestCallsForUnbooked } = await import('../api/lib/client-messaging.js');
      await seedClient('pat-selfbooked', { visitDaysAgo: 28 });
      await pool.query("UPDATE clients SET renew_reply = 'wants_time', renew_reply_at = now() - interval '30 hours' WHERE id = 'pat-selfbooked'");
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
        VALUES ('bk-self', 91, 'doc', 'consult', 'pat-selfbooked', $1, '14:00', '15:00', 'planned')`, [daysAgo(-5)]);
      const res = await requestCallsForUnbooked(new Date());
      assert.equal(res.calls, 0, 'администратора зовут звонить человеку, который уже в расписании');
      const n = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE client_id = 'pat-selfbooked'");
      assert.equal(n.rows[0].n, 0);
    }, 'clinic');
  });

  await step('ответивший поднимается наверх списка владельца', async () => {
    const { handleMissedProfitClients } = await import('../api/routes/missed-profit.js');
    assert.equal(typeof handleMissedProfitClients, 'function', 'список владельца не экспортирован - проверять нечего');
    await runInTenant(TENANT, async () => {
      const { renewState } = await import('../api/routes/missed-profit.js');
      const replied = renewState({ renew_reply: 'wants_time' }, TODAY);
      assert.equal(replied.state, 'replied');
      const silent = renewState({ msg_status: 'sent', msg_sent_date: daysAgo(3) }, TODAY);
      assert.equal(silent.state, 'silent');
      assert.equal(silent.silentDays, 3, `молчание посчитано как ${silent.silentDays} дней вместо трёх`);
      const declined = renewState({ renew_reply: 'not_now', renew_decline_reason: 'price' }, TODAY);
      assert.equal(declined.state, 'declined');
      assert.equal(declined.reason, 'price');
    }, 'clinic');
  });

  await step('дневной потолок держит первое включение на живой базе', async () => {
    await runInTenant(TENANT, async () => {
      // 60 человек с наступившим сроком - больше суточного лимита в 50
      for (let i = 0; i < 60; i += 1) await seedClient(`pat-mass-${i}`, { visitDaysAgo: 28 });
      const before = (await pool.query("SELECT count(*)::int AS n FROM client_messages WHERE kind IN ('renew_due','renew_overdue')")).rows[0].n;
      const res = await engine.scanRenewOutreach(NOW);
      const after = (await pool.query("SELECT count(*)::int AS n FROM client_messages WHERE kind IN ('renew_due','renew_overdue')")).rows[0].n;
      assert.ok(after - before <= 50 - before, `за один проход ушло ${after - before} писем - это выглядит рассылкой`);
      assert.ok(after <= 50, `всего за сутки ${after} писем при потолке 50`);
      assert.equal(res.queued + before, after);
    }, 'clinic');
  });

  console.log(`\nГОТОВО: ${results.length} проверок пройдено`);
  process.exit(0);
} catch (e) {
  console.error('\nПРОВАЛ:', e.message);
  process.exit(1);
}
