// Живой прогон карточки «Возвращено» (02.09.2026).
//
// Зачем отдельным скриптом, а не офлайн-тестом. tests/returned-math.test.js проверяет
// только правила атрибуции на готовых признаках. Здесь проверяется то, что офлайн
// проверить нельзя: SQL действительно достаёт эти признаки из реальной схемы, деньги
// считаются тем же резолвером, что зарплата, а мультиарендный замок не мешает счёту.
//
// База отдельная, создаётся с нуля при каждом запуске и удаляется в конце. Ни одной
// строки боевых данных здесь нет - механика та же, что в tools/bot-demo-local.mjs.
//
// Запуск: node tools/verify-2026-09-02-returned.mjs
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'api', 'migrations');
const DB = 'returned_verify';
const ROLE = 'returned_verify_app';
const PASSWORD = 'verify';
const host = process.env.PGHOST || '/tmp';
const TENANT = 2;

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
await seed.query(`INSERT INTO tenants (id, name, vertical) VALUES (${TENANT}, 'Проверка возврата', 'clinic')`);
await seed.end();

process.env.DB_HOST = host;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

const { runInTenant, pool } = await import('../api/lib/db.js');
const { computeReturned } = await import('../api/routes/returned.js');

// ── Сценарий ────────────────────────────────────────────────────────────────
// Пять пациентов, покрывающих все ветки решения. Ожидаемая сумма считается руками
// в конце файла, а не выводится из тех же формул, что проверяются
const FROM = '2026-08-01';
const TO = '2026-08-31';

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `\n      ждали: ${JSON.stringify(expected)}\n      факт:  ${JSON.stringify(actual)}`}`);
  if (!ok) fails++;
}

await runInTenant(TENANT, async () => {
  const q = (sql, params) => pool.query(sql, params);

  // Локация id=1 заводится миграциями, своя не нужна
  await q("INSERT INTO staff (id, name, role, pin_hash) VALUES ('m1', 'Врач', 'master', 'x')");
  await q("INSERT INTO services (id, name, category, price, duration_min) VALUES ('s1', 'Приём', 'base', 5000, 60)");
  await q("INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('m1', 's1', 5000, 60)");

  // Пациенты. renew_days у всех 30 дней
  const clients = [
    ['c-anna', 'Анна', '+79000000001'],
    ['c-boris', 'Борис', '+79000000002'],
    ['c-vera', 'Вера', '+79000000003'],
    ['c-gleb', 'Глеб', '+79000000004'],
    ['c-dina', 'Дина', '+79000000005'],
  ];
  for (const [id, name, phone] of clients) {
    await q('INSERT INTO clients (id, name, phone, renew_days) VALUES ($1, $2, $3, 30)', [id, name, phone]);
  }

  let n = 0;
  const booking = async (id, clientId, date, status, confirmed = false) => {
    n++;
    await q(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, client_confirmed)
       VALUES ($1, 1, 'm1', 's1', $2, $3, '10:00', '11:00', $4, $5)`,
      [id, clientId, date, status, confirmed]
    );
    await q("INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 's1')", [id]);
  };
  const sent = async (bookingId, clientId, kind = 'reminder_24h') => {
    await q(
      `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status, channel, sent_at)
       VALUES ($1, $2, $3, $4, now(), 'sent', 'telegram', $5)`,
      [`msg-${bookingId}-${kind}`, clientId, bookingId, kind, '2026-08-10T10:00:00Z']
    );
  };

  // 1. Анна: предыдущий визит в срок, нажала «Приду», сообщение ушло → confirmed
  await booking('b-anna-0', 'c-anna', '2026-07-20', 'done');
  await booking('b-anna-1', 'c-anna', '2026-08-10', 'done', true);
  await sent('b-anna-1', 'c-anna', 'booking_confirm');

  // 2. Борис: была неявка в прошлом, кнопку не нажал, сообщение ушло → reminded_risky
  await booking('b-boris-0', 'c-boris', '2026-07-15', 'done');
  await booking('b-boris-ns', 'c-boris', '2026-07-25', 'no_show');
  await booking('b-boris-1', 'c-boris', '2026-08-12', 'done');
  await sent('b-boris-1', 'c-boris');

  // 3. Вера: предыдущий визит 90 дней назад при сроке 30 → была просрочена → returned_overdue
  await booking('b-vera-0', 'c-vera', '2026-05-14', 'done');
  await booking('b-vera-1', 'c-vera', '2026-08-14', 'done');
  await sent('b-vera-1', 'c-vera');

  // 4. Глеб: в сроке, без неявок, кнопку не нажал → НЕ засчитан, хотя сообщение ушло
  await booking('b-gleb-0', 'c-gleb', '2026-07-25', 'done');
  await booking('b-gleb-1', 'c-gleb', '2026-08-16', 'done');
  await sent('b-gleb-1', 'c-gleb');

  // 5. Дина: просрочена и подтвердила бы, но сообщения НЕ было → НЕ засчитана
  await booking('b-dina-0', 'c-dina', '2026-05-01', 'done');
  await booking('b-dina-1', 'c-dina', '2026-08-18', 'done', true);

  console.log(`\nПосеяно ${n} броней у ${clients.length} пациентов\n`);
  console.log('Проверки:');

  const r = await computeReturned(pool, FROM, TO);

  check('засчитано ровно три визита', r.count, 3);
  check('сумма возврата 15 000 ₽ (три визита по 5 000)', r.total, 15000);
  check('Анна - подтверждение кнопкой', r.byReason.confirmed, 5000);
  check('Борис - напоминание сработало на человеке с неявкой', r.byReason.reminded_risky, 5000);
  check('Вера - вернулась из просрочки', r.byReason.returned_overdue, 5000);
  check('канал был активен', r.hasMessaging, true);

  const names = r.visits.map((v) => v.name).sort();
  check('в списке именно эти трое', names, ['Анна', 'Борис', 'Вера']);

  const gleb = r.visits.find((v) => v.name === 'Глеб');
  check('Глеб не засчитан, хотя сообщение ему ушло', gleb === undefined, true);
  const dina = r.visits.find((v) => v.name === 'Дина');
  check('Дина не засчитана: без доставленного сообщения возврата нет', dina === undefined, true);

  const vera = r.visits.find((v) => v.name === 'Вера');
  check('у Веры посчитан перерыв в 92 дня', vera?.daysAway, 92);

  // Период без единого сообщения: total должен быть null, а не ноль
  const empty = await computeReturned(pool, '2026-06-01', '2026-06-30');
  check('месяц без сообщений отдаёт null, а не ноль', empty.total, null);
  check('и честно говорит, что канал молчал', empty.hasMessaging, false);
});

// Соединения приложения рвутся принудительно, чтобы освободить базу под DROP. Пул
// приложения об этом не знает и кричит в лог уже после того, как все проверки
// отработали. Гасим ровно эту ошибку и ровно здесь, в конце скрипта
process.on('uncaughtException', (e) => {
  if (String(e?.message || '').includes('terminating connection')) return;
  throw e;
});

// pool из lib/db.js - прокси поверх пула арендатора, закрывать его напрямую нельзя.
// Для удаления базы нужен отдельный админский пул, а соединения приложения отпустит
// process.exit ниже
const cleanup = new pg.Pool({ host, database: 'postgres' });
await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()`);
await cleanup.query(`DROP DATABASE IF EXISTS ${DB}`);
await cleanup.query(`DROP ROLE IF EXISTS ${ROLE}`);
await cleanup.end();

console.log(fails === 0 ? '\nВсе проверки пройдены\n' : `\nПРОВАЛЕНО: ${fails}\n`);
process.exit(fails === 0 ? 0 : 1);
