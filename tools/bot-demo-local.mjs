// Живой прогон бота на этой машине, без выката в прод (01.09.2026, Волна 1).
//
// Зачем. Webhook требует публичного адреса, то есть боевого сервера. Но Telegram
// умеет отдавать обновления и опросом (getUpdates), и для проверки этого достаточно:
// логика бота одна и та же, меняется только способ доставки обновлений до неё.
// Значит нажать «Старт», получить подтверждение и потыкать кнопки можно здесь,
// ничего не выкатывая и не трогая салон Алихана.
//
// База отдельная, на этой машине, создаётся с нуля при каждом запуске. Ни одной
// строки боевых данных здесь нет.
//
// Запуск:
//   node tools/bot-demo-local.mjs
// Остановить - Ctrl+C.
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'bot_demo_local';
const ROLE = 'bot_demo_app';
const PASSWORD = 'demo';
const host = process.env.PGHOST || '/tmp';
const TOKEN_FILE = join(homedir(), '.config', 'barbershop-crm', 'telegram-test-bot.token');

const token = process.env.TG_TOKEN || readFileSync(TOKEN_FILE, 'utf8').trim();

console.log('Готовлю отдельную базу для демонстрации...');
const admin = new pg.Pool({ host, database: 'postgres' });
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
await admin.end();

const seed = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD });
await seed.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())');
for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  await seed.query('BEGIN');
  await seed.query("SELECT set_config('app.tenant_id', '*', true)");
  await seed.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  await seed.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  await seed.query('COMMIT');
}
await seed.query("INSERT INTO tenants (id, name, vertical) VALUES (2, 'Песочница (демо)', 'clinic')");
await seed.end();

process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

const { runInTenant, pool } = await import('../api/lib/db.js');
const { hashPin } = await import('../api/lib/auth.js');
const { getMe, deleteWebhook } = await import('../api/lib/channel-telegram.js');
const engine = await import('../api/lib/client-messaging.js');
const { processUpdate } = await import('../api/routes/telegram.js');

const me = await getMe(token);
if (!me.ok) { console.error('Бот не отвечает:', me.error); process.exit(1); }
const bot = { tenantId: 2, token, username: me.result.username, vertical: 'clinic' };
// Опрос и webhook одновременно Telegram не разрешает
await deleteWebhook(token);

// Домены локального кабинета: сервер узнаёт арендатора по адресу страницы, и без
// этой строки кабинет получил бы 404 «неизвестный домен»
await runInTenant(2, async () => {
  // Домены локального кабинета: сервер узнаёт арендатора по адресу страницы, и без
  // этой строки кабинет получает 404 «неизвестный домен». Запрос идёт в контексте
  // арендатора - к базе мимо него ходить нельзя вовсе (lib/db.js)
  await pool.query("UPDATE tenants SET domains = ARRAY['localhost:8793','127.0.0.1:8793'] WHERE id = 2");
  await pool.query("INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, enabled) VALUES (2, 'telegram', $1, $2, true)", [token, bot.username]);
  await pool.query("INSERT INTO locations (id, name) VALUES (91, 'Клиника на Тухачевского')");
  // Владелец с логином: без него в кабинет не войти, а сквозной прогон Волны 1
  // проверяет как раз путь администратора - создать запись и пригласить в бота
  await pool.query("INSERT INTO staff (id, location_id, name, role, email, pin_hash) VALUES ('doc', 91, 'Карина Урбашевичус', 'owner', 'doc@demo.local', $1)", [hashPin('1234')]);
  await pool.query("INSERT INTO services (id, name, category, duration_min, price) VALUES ('consult', 'Консультация ортодонта', 'base', 60, 3000)");
  // Врач попадает на сайт только при трёх условиях сразу (routes/public-masters.js):
  // он принимает клиентов, у него есть компетенция и есть недельный график. Найдено
  // живым прогоном 01.09.2026: без этих строк форма записи молча показывала пустой
  // список услуг, и выглядело это как поломка виджета
  await pool.query("UPDATE staff SET provides_services = true WHERE id = 'doc'");
  await pool.query("INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('doc', 'consult', 3000, 60)");
  for (let weekday = 1; weekday <= 6; weekday += 1) {
    await pool.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end, break_start, break_end)
       VALUES ('doc', $1, true, '10:00', '20:00', '13:00', '14:00')`,
      [weekday],
    );
  }
  await pool.query("INSERT INTO clients (id, phone, name) VALUES ('demo-client', '+79000000001', 'Влад')");
}, 'clinic');

// Приём через два с половиной часа: подтверждение уходит сразу, напоминание
// «за два часа» созреет через полчаса - видно, что очередь живёт по срокам.
//
// Время визита в базе - МОСКОВСКОЕ, без зоны (так его пишет вся система, см.
// lib/client-messaging.js). Первая версия стенда писала UTC, и на московской
// машине приём оказывался на три часа раньше, чем показывал стенд: 01.09.2026
// из-за этого подтверждение не пришло - система считала визит прошедшим.
const start = new Date(Date.now() + 2.5 * 3600e3);
const msk = new Date(start.getTime() + 3 * 3600e3); // читаем поля как московские
const pad = (n) => String(n).padStart(2, '0');
const date = msk.toISOString().slice(0, 10);
const startTime = `${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())}`;
const endTime = `${pad((msk.getUTCHours() + 1) % 24)}:${pad(msk.getUTCMinutes())}`;

let link;
await runInTenant(2, async () => {
  await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
    VALUES ('demo-bk', 91, 'doc', 'consult', 'demo-client', $1, $2, $3, 'planned')`, [date, startTime, endTime]);
  await engine.enqueueForBooking({ id: 'demo-bk', client_id: 'demo-client', date, start_time: startTime, end_time: endTime });
  const inviteToken = await engine.createInvite('demo-client');
  link = engine.inviteLink(bot.username, inviteToken);
}, 'clinic');

// Самопроверка перед тем, как звать человека: 01.09.2026 стенд дважды показал
// ссылку, по которой подтверждение не приходило (сначала сгорало до привязки,
// потом визит оказывался «в прошлом» из-за часового пояса). Проверяем на
// временном клиенте, что после привязки подтверждение действительно готово уйти -
// и только потом печатаем ссылку.
await runInTenant(2, async () => {
  await pool.query("INSERT INTO clients (id, phone, name) VALUES ('selfcheck', '+79000000099', 'Самопроверка')");
  await pool.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
    VALUES ('selfcheck-bk', 91, 'doc', 'consult', 'selfcheck', $1, $2, $3, 'planned')`, [date, startTime, endTime]);
  await pool.query(`INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status, last_error)
    VALUES ('selfcheck-cm', 'selfcheck', 'selfcheck-bk', 'booking_confirm', now() - interval '1 minute', 'skipped', 'no_channel')`);
  const probeToken = await engine.createInvite('selfcheck');
  await engine.redeemInvite(probeToken, '999999999');
  // Отправку не делаем - чат 999999999 не существует. Проверяем главное: строка
  // после привязки готова уйти немедленно, а не ждёт следующего тика
  const row = (await pool.query("SELECT status FROM client_messages WHERE id = 'selfcheck-cm'")).rows[0];
  // Прибираем за собой до всякой отправки: этому клиенту писать некуда и незачем
  await pool.query("DELETE FROM client_messages WHERE client_id = 'selfcheck'");
  await pool.query("DELETE FROM client_channels WHERE client_id = 'selfcheck'");
  await pool.query("DELETE FROM client_channel_invites WHERE client_id = 'selfcheck'");
  await pool.query("DELETE FROM bookings WHERE id = 'selfcheck-bk'");
  await pool.query("DELETE FROM clients WHERE id = 'selfcheck'");
  if (row.status !== 'pending') {
    console.error(`\nСТЕНД НЕ ГОТОВ: после привязки подтверждение осталось в статусе «${row.status}».`);
    console.error('Ссылку не показываю - она снова привела бы к молчанию бота');
    process.exit(1);
  }
  console.log('Самопроверка пройдена: после привязки подтверждение уходит\n');
}, 'clinic');

console.log('\n  Сайт с формой записи (в другом окне терминала):');
console.log('    node tools/site-demo.mjs        # копия сайта клиники на локальный API');
console.log('\n  Кабинет (запустить рядом, в другом окне терминала):');
console.log('    node tools/pesochnica.mjs --api=http://localhost:8794');
console.log('    вход: doc@demo.local · PIN 1234');
console.log('\n──────────────────────────────────────────────');
console.log('  ОТКРОЙ ЭТУ ССЫЛКУ В TELEGRAM И НАЖМИ «СТАРТ»:');
console.log(`  ${link}`);
console.log('──────────────────────────────────────────────');
console.log(`  Демо-приём: ${date} в ${startTime} по Москве, врач Карина Урбашевичус`);
console.log('  Дальше придёт подтверждение с кнопками. Жми любую - увидишь здесь, что произошло');
console.log('  Ctrl+C чтобы остановить\n');

// Разбор очереди: в демо чаще, чем раз в минуту, чтобы не ждать
// Тики не накладываются - как и на боевом сервере. Сам по себе этот флаг от
// дублей уже не защищает (строки занимаются в базе), но и гонять лишние запросы
// поверх незакончившегося тика незачем
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    const stats = await engine.tickAll();
    const moved = Object.values(stats).some((s) => s.sent || s.failed);
    if (moved) console.log('  → отправлено:', JSON.stringify(stats));
  } catch (e) { console.error('  тик не прошёл:', e.message); }
  finally { ticking = false; }
}, 5000);

// Опрос обновлений вместо webhook
let offset = 0;
async function poll() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.timeout(30000) });
    const body = await res.json();
    for (const update of body.result ?? []) {
      offset = update.update_id + 1;
      const kind = update.message?.text ? `текст «${update.message.text}»` : update.callback_query ? `кнопка «${update.callback_query.data}»` : 'событие';
      const result = await runInTenant(2, () => processUpdate(update, bot, 'clinic'), 'clinic');
      console.log(`  ← ${kind} → ${result?.action}`);
      if (result?.action === 'confirmed') {
        const row = await runInTenant(2, async () => (await pool.query("SELECT client_confirmed FROM bookings WHERE id = 'demo-bk'")).rows[0], 'clinic');
        console.log(`     в базе client_confirmed = ${row.client_confirmed}`);
      }
      if (result?.action?.startsWith('client_wants')) {
        const n = await runInTenant(2, async () => (await pool.query('SELECT type, title FROM notifications')).rows, 'clinic');
        console.log('     уведомления сотрудникам:', JSON.stringify(n));
      }
    }
  } catch (e) {
    if (!/timeout|aborted/i.test(e.message)) console.error('  опрос:', e.message);
  }
  setTimeout(poll, 200);
}
poll();
