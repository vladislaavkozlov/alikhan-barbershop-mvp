// Живой прогон контракта Фазы 1 мультиарендности против НАСТОЯЩЕГО Postgres
// (локальный кластер, эфемерная база - боевая база не участвует).
// Офлайн-тесты tests/api.tenant-context.test.js проверяют контракт на поддельном
// пуле: какие команды и в каком порядке уходят. Здесь проверяется то, чего подделка
// доказать не может, - что Postgres ведёт себя так, как мы на это рассчитываем:
//   - `set_config(..., true)` (SET LOCAL) умирает вместе с транзакцией и НЕ уезжает
//     в следующий запрос по тому же физическому соединению (ловушка 2 спеки);
//   - точки сохранения дают роутам прежний частичный откат внутри общей транзакции;
//   - падение обработчика откатывает всё, что он успел записать;
//   - обращение к базе вне контекста арендатора невозможно.
// Запуск: node tools/verify-2026-08-24-tenant-context.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { pool, runInTenant, runDetached, __setBasePoolForTests } from '../api/lib/db.js';

const ADMIN_DB = 'postgres';
const PROBE_DB = 'tenant_ctx_probe';
const host = process.env.PGHOST || '/tmp';

async function recreateProbeDb() {
  const admin = new pg.Pool({ host, database: ADMIN_DB });
  await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
  await admin.query(`CREATE DATABASE ${PROBE_DB}`);
  await admin.end();
}

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function main() {
  await recreateProbeDb();
  // max: 1 - все запросы обязаны идти по ОДНОМУ физическому соединению. Именно так
  // ловится утечка контекста через пул: если бы соединений было много, «чисто» могло
  // бы получиться случайно.
  const base = new pg.Pool({ host, database: PROBE_DB, max: 1 });
  __setBasePoolForTests(base);

  await runInTenant('*', async () => {
    await pool.query(`CREATE TABLE probe (
      id integer primary key,
      tenant text not null default current_setting('app.tenant_id')
    )`);
  });

  console.log('Живой прогон контракта арендатора:');

  await step('арендатор проставляется базой сам, без правки SQL роутов', async () => {
    await runInTenant(1, () => pool.query('INSERT INTO probe (id) VALUES (1)'));
    await runInTenant(2, () => pool.query('INSERT INTO probe (id) VALUES (2)'));
    const rows = (await runInTenant('*', () => pool.query('SELECT id, tenant FROM probe ORDER BY id'))).rows;
    assert.deepEqual(rows, [
      { id: 1, tenant: '1' },
      { id: 2, tenant: '2' },
    ]);
  });

  await step('контекст не переживает транзакцию и не уезжает в следующий запрос', async () => {
    const leaked = await base.query("SELECT current_setting('app.tenant_id', true) AS value");
    const value = leaked.rows[0].value ?? '';
    // Живая находка 24.08.2026: после COMMIT Postgres возвращает такой настройке НЕ
    // NULL, а пустую строку - имя параметра в сессии уже известно, значение сброшено.
    // Для Фазы 3 это в нашу пользу: `''::int` падает, то есть запрос без арендатора
    // получает ошибку, а не «арендатор ноль».
    assert.ok(value === '' , `на соединении осталось значение арендатора: ${value}`);
    assert.notEqual(value, '1');
    assert.notEqual(value, '2');
  });

  await step('откат по точке сохранения работает как прежний ROLLBACK роута', async () => {
    await runInTenant(1, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO probe (id) VALUES (10)');
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query('INSERT INTO probe (id) VALUES (11)');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
    const ids = (await runInTenant('*', () => pool.query('SELECT id FROM probe ORDER BY id'))).rows.map((r) => r.id);
    assert.deepEqual(ids, [1, 2, 11], 'откаченная строка не сохранилась, соседняя - сохранилась');
  });

  await step('ошибка после отката точки сохранения не ломает транзакцию запроса', async () => {
    await runInTenant(1, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO probe (id) VALUES (1)').catch(() => {});
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      // Если бы точки сохранения не было, транзакция запроса после ошибки уникального
      // ключа была бы уже мертва и этот INSERT упал бы с 25P02
      await pool.query('INSERT INTO probe (id) VALUES (12)');
    });
    const has12 = (await runInTenant('*', () => pool.query('SELECT 1 FROM probe WHERE id = 12'))).rowCount;
    assert.equal(has12, 1);
  });

  await step('падение обработчика откатывает всю его запись', async () => {
    await assert.rejects(
      () =>
        runInTenant(1, async () => {
          await pool.query('INSERT INTO probe (id) VALUES (99)');
          throw new Error('роут упал');
        }),
      /роут упал/
    );
    const has99 = (await runInTenant('*', () => pool.query('SELECT 1 FROM probe WHERE id = 99'))).rowCount;
    assert.equal(has99, 0);
  });

  await step('долгий ответ соединение не держит', async () => {
    await runDetached(1, async () => {
      await pool.query('SELECT 1');
      assert.equal(base.idleCount, 1, 'соединение вернулось в пул сразу после запроса');
      assert.equal(base.waitingCount, 0);
    });
  });

  await step('обращение к базе вне контекста арендатора невозможно', async () => {
    await assert.rejects(() => pool.query('SELECT 1'), /tenant_context_missing/);
    await assert.rejects(() => pool.connect(), /tenant_context_missing/);
  });

  await base.end();
  console.log(`\nЖивой прогон пройден: ${results.length} проверок против настоящего Postgres`);
}

await main();
