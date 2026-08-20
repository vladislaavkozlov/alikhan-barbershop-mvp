// Окно 40 (06.08.2026) - юнит на computeOwnerAlerts: агрегатор дашборда владельца
// "Сегодня" (мастера без графика + необработанные заявки + клиенты в риске) одним
// вызовом. Тот же приём in-memory fake client, что уже применён в
// tests/api.clients-risk.test.js/tests/api.revenue-today.test.js - реальный SQL
// (JOIN, ORDER BY, роль owner без фильтра) проверяется живым прогоном (DoD этого
// окна), здесь - форма данных и переиспользование mastersWithWorkingSchedule/
// findMastersMissingSchedule/listClientsAtRisk без пересчёта заново.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOwnerAlerts } from '../api/server.mjs';

function makeFakeClient({ staffRows = [], scheduledRows = [], riskRows = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM master_weekly_schedule WHERE master_id = ANY')) return { rows: scheduledRows };
      if (sql.includes('FROM clients c JOIN bookings')) return { rows: riskRows };
      if (sql.includes('FROM staff WHERE employed')) return { rows: staffRows };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

test('computeOwnerAlerts: пустая база - все три списка пустые массивы, не ошибка', async () => {
  const client = makeFakeClient();
  const result = await computeOwnerAlerts(client);
  assert.deepEqual(result, { mastersWithoutSchedule: [], clientsAtRisk: [] });
});

test('computeOwnerAlerts: мастер без единой рабочей строки в графике попадает в mastersWithoutSchedule с именем', async () => {
  const client = makeFakeClient({
    staffRows: [
      { id: 'master-1', name: 'Алиовсад' },
      { id: 'master-2', name: 'Мамедхан' },
    ],
    scheduledRows: [{ master_id: 'master-1' }],
  });
  const result = await computeOwnerAlerts(client);
  assert.deepEqual(result.mastersWithoutSchedule, [{ id: 'master-2', name: 'Мамедхан' }]);
});

test('computeOwnerAlerts: все мастера с графиком - mastersWithoutSchedule пустой', async () => {
  const client = makeFakeClient({
    staffRows: [{ id: 'master-1', name: 'Алиовсад' }],
    scheduledRows: [{ master_id: 'master-1' }],
  });
  const result = await computeOwnerAlerts(client);
  assert.deepEqual(result.mastersWithoutSchedule, []);
});

// Тесты про pendingRequests удалены 20.08.2026: computeOwnerAlerts больше не собирает
// список необработанных заявок - механизм заявок на отгул снят целиком (форма у мастера,
// роуты /schedule-requests, уведомления). Ключа нет в ответе, проверять нечего.

test('computeOwnerAlerts: клиенты в риске приходят через listClientsAtRisk без фильтра (владелец видит всех)', async () => {
  const client = makeFakeClient({
    riskRows: [{ id: 'c1', name: 'Пётр', phone: '+7111', no_show_streak: 2 }],
  });
  const result = await computeOwnerAlerts(client);
  assert.equal(result.clientsAtRisk.length, 1);
  assert.equal(result.clientsAtRisk[0].risk.level, 'high');
  const riskQuery = client.queries.find((q) => q.sql.includes('FROM clients c JOIN bookings'));
  assert.doesNotMatch(riskQuery.sql, /location_id|b\.master_id/);
});
