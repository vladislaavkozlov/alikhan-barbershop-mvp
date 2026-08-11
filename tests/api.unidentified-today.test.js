// 09.08.2026 - юниты на countUnidentifiedToday: сколько walk-in визитов сегодня
// прошли без телефона (client_id IS NULL), решение Алихана по найденному живьём
// багу потери имени walk-in-клиента (Окно 53, Задача J) - клиента без телефона
// система не пытается опознать между визитами (нет уникального ключа), но обязана
// честно посчитать, сколько таких визитов было. Тот же приём in-memory fake
// client, что уже применён в tests/api.revenue-today.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countUnidentifiedToday } from '../api/server.mjs';

function makeFakeClient(rows, { captureQuery } = {}) {
  return {
    async query(sql, params) {
      if (captureQuery) captureQuery(sql, params);
      if (sql.includes('FROM bookings')) return { rows };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

const FIXED_NOW = new Date('2026-08-09T12:00:00+03:00').getTime();

test('countUnidentifiedToday: возвращает count как число', async () => {
  const client = makeFakeClient([{ count: '3' }]);
  const result = await countUnidentifiedToday(client, 'loc1', FIXED_NOW);
  assert.equal(result.unidentifiedCount, 3);
  assert.equal(typeof result.unidentifiedCount, 'number');
});

test('countUnidentifiedToday: 0, если неидентифицированных сегодня нет', async () => {
  const client = makeFakeClient([{ count: '0' }]);
  const result = await countUnidentifiedToday(client, 'loc1', FIXED_NOW);
  assert.equal(result.unidentifiedCount, 0);
});

test('countUnidentifiedToday: SQL фильтрует client_id IS NULL и исключает отменённые', async () => {
  let capturedSql = '';
  const client = makeFakeClient([{ count: '0' }], { captureQuery: (sql) => { capturedSql = sql; } });
  await countUnidentifiedToday(client, 'loc1', FIXED_NOW);
  assert.match(capturedSql, /client_id IS NULL/);
  assert.match(capturedSql, /status != 'cancelled'/);
});

test('countUnidentifiedToday: с locationId - фильтр по точке в SQL и параметрах', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const client = makeFakeClient([{ count: '0' }], {
    captureQuery: (sql, params) => { capturedSql = sql; capturedParams = params; },
  });
  await countUnidentifiedToday(client, 'loc1', FIXED_NOW);
  assert.match(capturedSql, /location_id/);
  assert.ok(capturedParams.includes('loc1'));
});

test('countUnidentifiedToday: без locationId (владелец) - без фильтра по точке', async () => {
  let capturedSql = '';
  const client = makeFakeClient([{ count: '5' }], { captureQuery: (sql) => { capturedSql = sql; } });
  const result = await countUnidentifiedToday(client, null, FIXED_NOW);
  assert.doesNotMatch(capturedSql, /location_id/);
  assert.equal(result.unidentifiedCount, 5);
});

test('countUnidentifiedToday: граница дня МСК - date-параметр совпадает с сегодняшней датой МСК', async () => {
  let capturedParams = [];
  const client = makeFakeClient([{ count: '0' }], { captureQuery: (_sql, params) => { capturedParams = params; } });
  await countUnidentifiedToday(client, null, FIXED_NOW);
  // FIXED_NOW = 2026-08-09T12:00:00+03:00 -> дата МСК = 2026-08-09
  assert.equal(capturedParams[0], '2026-08-09');
});
