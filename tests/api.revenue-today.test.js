// Окно 38 (06.08.2026) - юниты на computeRevenueToday: единый агрегат дневной
// выручки (SUM sales.amount за сегодня МСК), которого администратору не хватало
// (PRODUCT_AUDIT_REPORT, разд. "Администратор" - "не может проверить дневную
// выручку без звонка владельцу"). Тот же приём in-memory fake client, что уже
// применён в tests/api.payroll-period.test.js - реальная фильтрация по
// created_at/location_id живёт в SQL и проверяется живым прогоном (DoD этого
// окна), здесь - только арифметика суммы и то, что locationId попадает/не
// попадает в запрос.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRevenueToday } from '../api/server.mjs';

function makeFakeClient(rows, { captureQuery } = {}) {
  return {
    async query(sql, params) {
      if (captureQuery) captureQuery(sql, params);
      if (sql.includes('FROM sales')) return { rows };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

const FIXED_NOW = new Date('2026-08-06T12:00:00+03:00').getTime();

test('computeRevenueToday: несколько продаж за сегодня суммируются', async () => {
  const client = makeFakeClient([{ amount: 500 }, { amount: 1200 }, { amount: 300 }]);
  const result = await computeRevenueToday(client, 'loc1', FIXED_NOW);
  assert.equal(result.revenue, 2000);
});

test('computeRevenueToday: продаж сегодня нет - revenue 0, не ошибка', async () => {
  const client = makeFakeClient([]);
  const result = await computeRevenueToday(client, 'loc1', FIXED_NOW);
  assert.equal(result.revenue, 0);
});

test('computeRevenueToday: с locationId - в SQL и параметрах есть фильтр по location_id', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const client = makeFakeClient([{ amount: 100 }], {
    captureQuery: (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
    },
  });
  await computeRevenueToday(client, 'loc1', FIXED_NOW);
  assert.match(capturedSql, /location_id/);
  assert.ok(capturedParams.includes('loc1'));
});

test('computeRevenueToday: без locationId (владелец, одна точка сейчас) - в SQL нет фильтра по location_id, контракт не ломается при второй точке', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const client = makeFakeClient([{ amount: 700 }, { amount: 300 }], {
    captureQuery: (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
    },
  });
  const result = await computeRevenueToday(client, null, FIXED_NOW);
  assert.doesNotMatch(capturedSql, /location_id/);
  assert.equal(capturedParams.length, 2); // только dayStart/dayEnd, без locationId
  assert.equal(result.revenue, 1000);
});

test('computeRevenueToday: границы дня МСК - dayStart/dayEnd переданы как параметры запроса, разница ровно 24ч', async () => {
  let capturedParams = [];
  const client = makeFakeClient([], {
    captureQuery: (sql, params) => {
      capturedParams = params;
    },
  });
  await computeRevenueToday(client, null, FIXED_NOW);
  const [dayStart, dayEnd] = capturedParams;
  assert.ok(dayStart instanceof Date);
  assert.ok(dayEnd instanceof Date);
  assert.equal(dayEnd.getTime() - dayStart.getTime(), 24 * 60 * 60 * 1000);
  // FIXED_NOW = 2026-08-06T12:00:00+03:00 -> начало суток МСК = 2026-08-06T00:00:00+03:00 = 2026-08-05T21:00:00Z
  assert.equal(dayStart.toISOString(), '2026-08-05T21:00:00.000Z');
});

test('computeRevenueToday: суммы строкового типа из pg (numeric) корректно приводятся к числу', async () => {
  const client = makeFakeClient([{ amount: '500' }, { amount: '1200' }]);
  const result = await computeRevenueToday(client, 'loc1', FIXED_NOW);
  assert.equal(result.revenue, 1700);
});
