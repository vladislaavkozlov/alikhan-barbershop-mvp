// Замер тика очереди сообщений (01.09.2026): сколько стоит одна минута работы
// планировщика, когда заведений и клиентов становится много.
//
// Вопрос Влада: «тики раз в минуту по каждому клиенту? а если их сотня?» Ответ
// должен быть измерен, а не прикинут, поэтому здесь настоящая база, настоящие
// запросы и поддельный только Telegram (иначе меряли бы чужую сеть).
//
// Запуск: node tools/bench-2026-09-01-messaging-tick.mjs [арендаторов] [сообщений на арендатора]
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'messaging_bench_probe';
const ROLE = 'messaging_bench_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';

const TENANTS = Number(process.argv[2] || 100);
const DUE_PER_TENANT = Number(process.argv[3] || 20);

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

console.log(`Готовлю ${TENANTS} заведений по ${DUE_PER_TENANT} созревших сообщений в каждом...`);
const t0 = Date.now();
for (let t = 2; t <= TENANTS + 1; t += 1) {
  await seed.query("INSERT INTO tenants (id, name, vertical) VALUES ($1, $2, 'barbershop')", [t, `Заведение ${t}`]);
  await seed.query(`INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
    VALUES ($1, 'telegram', 'probe-token', $2, $3, true)`, [t, `bot_${t}`, `secret_${t}`]);
  await seed.query('BEGIN');
  await seed.query('SELECT set_config($1, $2, true)', ['app.tenant_id', String(t)]);
  await seed.query('INSERT INTO locations (id, name) VALUES ($1, $2)', [1000 + t, `Точка ${t}`]);
  await seed.query(`INSERT INTO staff (id, location_id, name, role, email) VALUES ($1, $2, 'Мастер', 'master', $3)`, [`st-${t}`, 1000 + t, `st${t}@probe.local`]);
  await seed.query(`INSERT INTO services (id, name, category, duration_min, price) VALUES ($1, 'Стрижка', 'base', 60, 1000)`, [`sv-${t}`]);
  for (let i = 0; i < DUE_PER_TENANT; i += 1) {
    const cl = `cl-${t}-${i}`;
    const bk = `bk-${t}-${i}`;
    await seed.query('INSERT INTO clients (id, phone, name) VALUES ($1, $2, $3)', [cl, `+7900${String(t).padStart(3, '0')}${String(i).padStart(4, '0')}`, 'Клиент']);
    await seed.query(`INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
      VALUES ($1, $2, $3, $4, $5, '2026-09-05', '15:00', '16:00', 'planned')`, [bk, 1000 + t, `st-${t}`, `sv-${t}`, cl]);
    await seed.query(`INSERT INTO client_channels (id, client_id, channel, external_id) VALUES ($1, $2, 'telegram', $3)`, [`cc-${t}-${i}`, cl, `${t}${i}`]);
    await seed.query(`INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status)
      VALUES ($1, $2, $3, 'reminder_24h', now() - interval '1 minute', 'pending')`, [`cm-${t}-${i}`, cl, bk]);
  }
  await seed.query('COMMIT');
}
await seed.end();
console.log(`подготовка: ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);

process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

// Telegram подделан и отвечает мгновенно: меряем свою работу, не чужую сеть
// Задержка одного ответа Telegram задаётся третьим аргументом: с нулём меряем
// свою работу, со 120 мс - жизнь, в которой каждое сообщение это круг до Дублина
const NET_MS = Number(process.argv[4] || 0);
let sentCount = 0;
globalThis.fetch = async () => {
  sentCount += 1;
  if (NET_MS) await new Promise((r) => setTimeout(r, NET_MS));
  return { json: async () => ({ ok: true, result: { message_id: sentCount } }) };
};

const { tickAll } = await import('../api/lib/client-messaging.js');

const started = Date.now();
const stats = await tickAll();
const ms = Date.now() - started;
const totals = Object.values(stats).reduce((a, s) => ({ sent: a.sent + s.sent, failed: a.failed + s.failed, noChannel: a.noChannel + s.noChannel }), { sent: 0, failed: 0, noChannel: 0 });

console.log(`ЗАВЕДЕНИЙ: ${TENANTS} · СОЗРЕЛО СООБЩЕНИЙ: ${TENANTS * DUE_PER_TENANT} · ответ Telegram: ${NET_MS} мс`);
console.log(`ОДИН ТИК: ${ms} мс (${(ms / 1000).toFixed(1)} с из 60 доступных)`);
console.log(`отправлено ${totals.sent}, без канала ${totals.noChannel}, ошибок ${totals.failed}`);
console.log(`на одно сообщение: ${(ms / Math.max(totals.sent, 1)).toFixed(1)} мс`);

// Холостой тик: столько стоит минута, когда отправлять нечего - а так проходит
// большинство минут в сутках
const idleStart = Date.now();
await tickAll();
console.log(`ХОЛОСТОЙ ТИК (очередь пуста): ${Date.now() - idleStart} мс`);
process.exit(0);
