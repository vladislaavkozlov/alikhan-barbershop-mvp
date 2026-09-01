// Живая репетиция миграции 062 (очередь сообщений клиенту, Волна 1, 01.09.2026)
// на настоящем Postgres. База эфемерная, собранная теми же миграциями 001-062.
//
// Что доказывается:
//   1. миграция применяется на базе, собранной всеми предыдущими;
//   2. замок арендатора закрыт на всех трёх новых таблицах с данными клиентов:
//      арендатор №2 не видит ни привязок, ни приглашений, ни очереди арендатора №1;
//   3. вставка без контекста арендатора падает (fail-closed), как и везде;
//   4. дедуп очереди работает: одна бронь - одно сообщение каждого вида;
//   5. один диалог с ботом не может принадлежать двум клиентам сразу;
//   6. справочник ботов (tenant_channels) читается БЕЗ контекста арендатора -
//      иначе входящий webhook, который и определяет арендатора, себя не найдёт.
//
// Запуск: node tools/verify-2026-09-01-client-messaging.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'migrations');
const PROBE_DB = 'client_messaging_probe';
const ROLE = 'client_msg_probe_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

// Роль-владелец без суперправ - ровно та ситуация, что на Amvera: под
// суперпользователем замок арендаторов не действует и проверка была бы пустой
async function recreateDb() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  await admin.query(`CREATE DATABASE ${PROBE_DB} OWNER ${ROLE}`);
  await admin.end();
}

async function applyMigrations(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (applied.rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

// Один запрос от лица арендатора - ровно так же, как это делает сервер
async function asTenant(db, tenantId, sql, params = []) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', String(tenantId)]);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  await recreateDb();
  const db = new pg.Pool({ host, database: PROBE_DB, user: ROLE, password: PASSWORD });
  try {
    await step('миграции 001-062 применились на чистой базе', async () => {
      await applyMigrations(db);
      const has = await db.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_name IN ('tenant_channels','client_channels','client_channel_invites','client_messages')`
      );
      assert.equal(has.rows[0].n, 4, 'созданы не все четыре таблицы');
    });

    // Два заведения с одинаковым устройством данных - как Алихан и Карина
    await step('подготовлены два арендатора со своими клиентами и бронями', async () => {
      await db.query("INSERT INTO tenants (id, name, vertical) VALUES (2, 'Клиника Карины', 'clinic') ON CONFLICT DO NOTHING");
      await asTenant(db, 1, "INSERT INTO locations (id, name) VALUES (1, 'Точка 1') ON CONFLICT DO NOTHING");
      await asTenant(db, 2, "INSERT INTO locations (id, name) VALUES (2, 'Кабинет') ON CONFLICT DO NOTHING");
      for (const [tid, tag] of [[1, 'a'], [2, 'k']]) {
        await asTenant(db, tid, `INSERT INTO staff (id, location_id, name, role, email) VALUES ('staff-${tag}', ${tid}, 'Мастер', 'master', '${tag}@probe.local')`);
        await asTenant(db, tid, `INSERT INTO services (id, name, category, duration_min, price) VALUES ('srv-${tag}', 'Услуга', 'base', 60, 1000)`);
        await asTenant(db, tid, `INSERT INTO clients (id, phone, name) VALUES ('cl-${tag}', '+7900000000${tid}', 'Клиент')`);
        await asTenant(db, tid, `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status)
          VALUES ('bk-${tag}', ${tid}, 'staff-${tag}', 'srv-${tag}', 'cl-${tag}', '2026-09-02', '10:00', '11:00', 'planned')`);
      }
    });

    await step('привязка, приглашение и очередь заводятся от лица арендатора', async () => {
      await asTenant(db, 1, `INSERT INTO client_channels (id, client_id, channel, external_id) VALUES ('ch-a', 'cl-a', 'telegram', '111')`);
      await asTenant(db, 2, `INSERT INTO client_channels (id, client_id, channel, external_id) VALUES ('ch-k', 'cl-k', 'telegram', '222')`);
      await asTenant(db, 1, `INSERT INTO client_channel_invites (token, client_id, channel, expires_at) VALUES ('tok-a', 'cl-a', 'telegram', now() + interval '1 day')`);
      await asTenant(db, 2, `INSERT INTO client_channel_invites (token, client_id, channel, expires_at) VALUES ('tok-k', 'cl-k', 'telegram', now() + interval '1 day')`);
      await asTenant(db, 1, `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at) VALUES ('m-a', 'cl-a', 'bk-a', 'reminder_24h', now())`);
      await asTenant(db, 2, `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at) VALUES ('m-k', 'cl-k', 'bk-k', 'reminder_24h', now())`);
    });

    await step('арендатор №2 не видит ни одной строки арендатора №1', async () => {
      for (const table of ['client_channels', 'client_channel_invites', 'client_messages']) {
        const seen = await asTenant(db, 2, `SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(seen.rows[0].n, 1, `${table}: видно ${seen.rows[0].n} строк вместо своей одной`);
      }
      // Прицельно: чужой id известен, но подставить его нельзя
      const stolen = await asTenant(db, 2, `SELECT count(*)::int AS n FROM client_messages WHERE id = 'm-a'`);
      assert.equal(stolen.rows[0].n, 0, 'чужое сообщение достаётся по прямому id');
    });

    await step('вставка без контекста арендатора падает (fail-closed)', async () => {
      await assert.rejects(
        () => db.query(`INSERT INTO client_channels (id, client_id, channel, external_id) VALUES ('ch-x', 'cl-a', 'telegram', '333')`),
        'строка завелась без арендатора'
      );
    });

    await step('одна бронь - одно сообщение каждого вида', async () => {
      await assert.rejects(
        () => asTenant(db, 1, `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at) VALUES ('m-a2', 'cl-a', 'bk-a', 'reminder_24h', now())`),
        'дубль напоминания по той же брони прошёл'
      );
      // Другой вид по той же брони - законен
      await asTenant(db, 1, `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at) VALUES ('m-a3', 'cl-a', 'bk-a', 'reminder_2h', now())`);
    });

    await step('один диалог с ботом не принадлежит двум клиентам', async () => {
      await asTenant(db, 1, `INSERT INTO clients (id, phone, name) VALUES ('cl-a2', '+79000000099', 'Второй')`);
      await assert.rejects(
        () => asTenant(db, 1, `INSERT INTO client_channels (id, client_id, channel, external_id) VALUES ('ch-a2', 'cl-a2', 'telegram', '111')`),
        'один chat_id привязался к двум клиентам'
      );
      // У соседнего арендатора тот же chat_id - законен: это разные боты
      await asTenant(db, 2, `INSERT INTO clients (id, phone, name) VALUES ('cl-k2', '+79000000098', 'Второй')`);
      await asTenant(db, 2, `INSERT INTO client_channels (id, client_id, channel, external_id) VALUES ('ch-k2', 'cl-k2', 'telegram', '111')`);
    });

    await step('справочник ботов читается без контекста арендатора', async () => {
      await db.query(`INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
        VALUES (2, 'telegram', 'token-probe', 'karina_probe_bot', 'secret-probe', true)`);
      const found = await db.query(`SELECT tenant_id FROM tenant_channels WHERE webhook_secret = 'secret-probe'`);
      assert.equal(found.rows[0].tenant_id, 2, 'по секрету webhook арендатор не находится');
    });

    console.log(`\nГОТОВО: ${results.length} проверок пройдено`);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error('\nПРОВАЛ:', e.message); process.exit(1); });
