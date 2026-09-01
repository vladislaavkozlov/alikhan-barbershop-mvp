// Сквозная репетиция движка сообщений клиенту (01.09.2026, Волна 1) на настоящем
// Postgres и с поддельным транспортом: настоящий Telegram здесь не нужен, нас
// интересует логика очереди, а не чужой HTTP.
//
// Что доказывается:
//   1. запись порождает ровно четыре сообщения с правильными сроками;
//   2. непривязанному клиенту ничего не уходит, и это видно отдельным счётчиком;
//   3. приглашение одноразовое: второй раз тем же токеном привязаться нельзя;
//   4. после привязки подтверждение уходит, текст на языке вертикали клиники;
//   5. перенос записи гасит неотправленные напоминания, отправленные не трогает;
//   6. блокировка бота гасит привязку, а не копит ошибки в очереди;
//   7. сетевой сбой оставляет сообщение в очереди на повтор, а не хоронит его.
//
// Запуск: node tools/verify-2026-09-01-messaging-engine.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'messaging_engine_probe';
const ROLE = 'messaging_probe_app';
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

// Движок берёт соединение из api/lib/db.js, поэтому окружение готовим ДО импорта
process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

const { runInTenant, runDetached, pool, registryQuery } = await import('../api/lib/db.js');
const engine = await import('../api/lib/client-messaging.js');

// Поддельный Telegram: запоминает отправленное и умеет притворяться сломанным
const outbox = [];
let mode = 'ok';
const fakeSend = async (token, chatId, text, keyboard) => {
  // Медленная отправка: именно она открывала окно, в которое влезал соседний тик
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 300));
  if (mode === 'blocked') return { ok: false, fatal: true, retriable: false, error: '403: bot was blocked by the user' };
  if (mode === 'network') return { ok: false, retriable: true, error: 'network: timeout' };
  outbox.push({ chatId, text, keyboard });
  return { ok: true, result: { message_id: outbox.length } };
};
const deps = { sendMessage: fakeSend, telegramConfig: async () => ({ token: 'probe-token', username: 'probe_bot' }) };

const TENANT = 2;
const NOW = new Date('2026-09-01T09:00:00Z');

try {
  await step('заведена клиника с врачом, пациентом и приёмом на завтра', async () => {
    // Справочники заводим напрямую: registryQuery намеренно умеет только читать
    const admin = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
    await admin.query("INSERT INTO tenants (id, name, vertical) VALUES (2, 'Клиника Карины', 'clinic') ON CONFLICT DO NOTHING");
    await admin.query(`INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
      VALUES (2, 'telegram', 'probe-token', 'probe_bot', 'probe-secret', true) ON CONFLICT DO NOTHING`);
    await admin.end();
    await runInTenant(TENANT, async () => {
      await pool.query("INSERT INTO locations (id, name) VALUES (91, 'Клиника на Тухачевского')");
      await pool.query("INSERT INTO staff (id, location_id, name, role, email) VALUES ('doc', 91, 'Карина Урбашевичус', 'owner', 'doc@probe.local')");
      await pool.query("INSERT INTO services (id, name, category, duration_min, price) VALUES ('consult', 'Консультация ортодонта', 'base', 60, 3000)");
      await pool.query("INSERT INTO clients (id, phone, name) VALUES ('pat', '+79001112233', 'Мария')");
      await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
        VALUES ('bk', 91, 'doc', 'consult', 'pat', '2026-09-02', '15:00', '16:00', 'planned')`);
    }, 'clinic');
  });

  await step('приём порождает четыре сообщения с верными сроками', async () => {
    const rows = await runInTenant(TENANT, async () => {
      const booking = (await pool.query("SELECT id, client_id, date, start_time, end_time FROM bookings WHERE id = 'bk'")).rows[0];
      booking.date = '2026-09-02';
      await engine.enqueueForBooking(booking, NOW);
      return (await pool.query('SELECT kind, due_at, status FROM client_messages ORDER BY due_at')).rows;
    }, 'clinic');
    assert.equal(rows.length, 4, `сообщений ${rows.length}, а не 4`);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    // Приём назначен на 15:00 ПО МОСКВЕ, то есть 12:00 UTC. Сроки считаются от него,
    // а не от того же числа, прочитанного как UTC: до исправления 01.09.2026 система
    // ошибалась ровно на три часа и присылала «за два часа» за пять
    assert.equal(byKind.reminder_24h.due_at.toISOString(), '2026-09-01T12:00:00.000Z', 'напоминание за сутки не за сутки');
    assert.equal(byKind.reminder_2h.due_at.toISOString(), '2026-09-02T10:00:00.000Z', 'напоминание за два часа не за два часа');
    assert.equal(byKind.review_request.due_at.toISOString(), '2026-09-02T15:00:00.000Z', 'просьба об отзыве не через два часа после конца');
  });

  await step('непривязанному пациенту ничего не уходит, счётчик это показывает', async () => {
    const stats = await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', NOW, deps), 'clinic');
    assert.equal(stats.sent, 0, 'сообщение ушло человеку, который бота не открывал');
    assert.equal(stats.noChannel, 1, `без канала помечено ${stats.noChannel} вместо 1`);
    assert.equal(outbox.length, 0);
  });

  let invite;
  await step('приглашение одноразовое', async () => {
    await runInTenant(TENANT, async () => {
      invite = await engine.createInvite('pat');
      const first = await engine.redeemInvite(invite, '555001');
      assert.equal(first, 'pat', 'первая привязка не сработала');
      const second = await engine.redeemInvite(invite, '555002');
      assert.equal(second, null, 'той же ссылкой привязался второй человек');
    }, 'clinic');
  });

  await step('после привязки уходит и подтверждение, и напоминание, языком клиники', async () => {
    // Напоминание за сутки вернём руками - его срок наступает позже привязки.
    // А вот подтверждение воскрешает сама привязка: оно сгорело «без канала» ещё
    // до того, как человек открыл бота (исправление 01.09.2026 по живому прогону)
    await runInTenant(TENANT, () => pool.query("UPDATE client_messages SET status = 'pending', last_error = NULL WHERE kind = 'reminder_24h'"), 'clinic');
    const revived = await runInTenant(TENANT, async () => (await pool.query("SELECT status FROM client_messages WHERE kind = 'booking_confirm'")).rows[0], 'clinic');
    assert.equal(revived.status, 'pending', 'подтверждение не воскресло при привязке');
    // Тикаем в срок самого напоминания: движок не отправляет раньше времени
    const stats = await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', new Date('2026-09-01T12:00:00Z'), deps), 'clinic');
    assert.equal(stats.sent, 2, `отправлено ${stats.sent} вместо 2 (подтверждение + напоминание)`);
    const sent = outbox.at(-1);
    assert.equal(sent.chatId, '555001');
    assert.match(sent.text, /врач/i, `в тексте нет слова врач: ${sent.text}`);
    assert.doesNotMatch(sent.text, /мастер/i, `в текст клиники попал мастер: ${sent.text}`);
    assert.ok(sent.keyboard.inline_keyboard.flat().some((b) => b.text.includes('Приду')), 'нет кнопки подтверждения');
  });

  await step('перенос гасит неотправленное и не трогает отправленное', async () => {
    const killed = await runInTenant(TENANT, () => engine.cancelPendingForBooking('bk'), 'clinic');
    assert.ok(killed >= 1, 'ничего не отменилось');
    const rows = await runInTenant(TENANT, async () => (await pool.query('SELECT kind, status FROM client_messages ORDER BY kind')).rows, 'clinic');
    const sent = rows.find((r) => r.kind === 'reminder_24h');
    assert.equal(sent.status, 'sent', 'отправленное напоминание перезаписано отменой');
  });

  await step('блокировка бота гасит привязку, а не копит ошибки', async () => {
    mode = 'blocked';
    await runInTenant(TENANT, () => pool.query("UPDATE client_messages SET status = 'pending' WHERE kind = 'reminder_2h'"), 'clinic');
    const stats = await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', new Date('2026-09-02T11:00:00Z'), deps), 'clinic');
    assert.equal(stats.failed, 1, 'ошибка доставки не посчитана');
    const ch = await runInTenant(TENANT, async () => (await pool.query("SELECT unsubscribed_at, last_error FROM client_channels WHERE client_id = 'pat'")).rows[0], 'clinic');
    assert.ok(ch.unsubscribed_at, 'привязка осталась живой после блокировки бота');
    assert.match(ch.last_error, /403/);
  });

  await step('сетевой сбой оставляет сообщение на повтор', async () => {
    mode = 'network';
    await runInTenant(TENANT, async () => {
      await pool.query("UPDATE client_channels SET unsubscribed_at = NULL WHERE client_id = 'pat'");
      await pool.query("UPDATE client_messages SET status = 'pending', attempts = 0 WHERE kind = 'review_request'");
    }, 'clinic');
    await runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', new Date('2026-09-02T16:00:00Z'), deps), 'clinic');
    const row = await runInTenant(TENANT, async () => (await pool.query("SELECT status, attempts FROM client_messages WHERE kind = 'review_request'")).rows[0], 'clinic');
    assert.equal(row.status, 'pending', 'сообщение похоронено после первой же сетевой ошибки');
    assert.equal(row.attempts, 1);
  });

  await step('два тика разом не отправляют одно сообщение дважды', async () => {
    // Ровно то, что случилось на живом прогоне 01.09.2026: медленная отправка,
    // следующий тик видит строку всё ещё ждущей, человек получает подтверждение
    // четыре раза. Здесь отправка нарочно медленная, а тиков сразу три
    mode = 'slow';
    outbox.length = 0;
    await runInTenant(TENANT, async () => {
      await pool.query("UPDATE client_messages SET status = 'cancelled' WHERE status <> 'sent'");
      await pool.query(`INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status)
        VALUES ('race-1', 'pat', 'bk', 'reminder_2h', now() - interval '1 minute', 'pending')
        ON CONFLICT (tenant_id, booking_id, kind) WHERE booking_id IS NOT NULL
        DO UPDATE SET status = 'pending', due_at = EXCLUDED.due_at, claimed_at = NULL, attempts = 0`);
      await pool.query("UPDATE client_channels SET unsubscribed_at = NULL WHERE client_id = 'pat'");
    }, 'clinic');
    const now = new Date();
    await Promise.all([
      runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', now, deps), 'clinic'),
      runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', now, deps), 'clinic'),
      runDetached(TENANT, () => engine.tickTenant(TENANT, 'clinic', now, deps), 'clinic'),
    ]);
    assert.equal(outbox.length, 1, `человек получил ${outbox.length} одинаковых сообщения вместо одного`);
    const row = await runInTenant(TENANT, async () => (await pool.query("SELECT status, attempts FROM client_messages WHERE kind = 'reminder_2h'")).rows[0], 'clinic');
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1, `попыток ${row.attempts} вместо одной`);
    mode = 'ok';
  });

  console.log(`\nГОТОВО: ${results.length} проверок пройдено`);
  process.exit(0);
} catch (e) {
  console.error('\nПРОВАЛ:', e.message);
  process.exit(1);
}
