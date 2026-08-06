// Окно 39 (06.08.2026, Задача 1) - юниты на getClientCard/listClientsAtRisk/
// describeClientRisk: карточка клиента + список "требует внимания" поверх уже
// собираемого no_show_streak (PRODUCT_ARCHITECTURE_PLAN, Модуль 2). Честная
// оговорка промпта: requiresPrepayment ничего не блокирует технически - текст
// риска всегда "стоит позвонить", никогда "клиент заблокирован" - проверяется
// явно в тестах describeClientRisk ниже. Тот же паттерн in-memory fake client, что
// уже применён в tests/api.payroll-period.test.js/tests/api.revenue-today.test.js -
// реальный scoping по роли (admin/master) и SQL-фильтры проверяются живым прогоном
// (DoD этого окна), здесь - только форма данных и arithmetics резолверов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientCard, listClientsAtRisk, describeClientRisk } from '../api/server.mjs';

function makeFakeClient({ clientRows = [], visitRows = [], serviceLinkRows = [], riskRows = [] } = {}) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM booking_services')) return { rows: serviceLinkRows };
      if (sql.includes('FROM bookings')) return { rows: visitRows };
      if (sql.includes('FROM clients c JOIN bookings')) return { rows: riskRows };
      if (sql.includes('FROM clients')) return { rows: clientRows };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

// ── describeClientRisk ──────────────────────────────────────────────────────

test('describeClientRisk: 0 (или отсутствует) - level none, label null, индикатор не показывается тревожно', () => {
  assert.deepEqual(describeClientRisk(0), { level: 'none', label: null });
  assert.deepEqual(describeClientRisk(null), { level: 'none', label: null });
  assert.deepEqual(describeClientRisk(undefined), { level: 'none', label: null });
});

test('описание риска никогда не говорит "заблокирован" - только "стоит позвонить" (честная оговорка промпта)', () => {
  for (const n of [1, 2, 3, 5, 11, 21]) {
    const { label } = describeClientRisk(n);
    assert.ok(label.includes('стоит позвонить'), `n=${n}: "${label}"`);
    assert.ok(!label.toLowerCase().includes('заблокирова'), `n=${n}: "${label}"`);
  }
});

test('describeClientRisk: 1 - level watch, мягкая формулировка без числа предоплаты', () => {
  const risk = describeClientRisk(1);
  assert.equal(risk.level, 'watch');
  assert.match(risk.label, /Пропустил последнюю запись/);
});

test('describeClientRisk: >=2 - level high, число и русское склонение "раз/раза" верны', () => {
  // \b не работает с кириллицей в JS-regex без /u + \p{L} - сравниваем точными подстроками.
  assert.ok(describeClientRisk(2).label.includes('2 раза подряд'));
  assert.ok(describeClientRisk(3).label.includes('3 раза подряд'));
  assert.ok(describeClientRisk(4).label.includes('4 раза подряд'));
  assert.ok(describeClientRisk(5).label.includes('5 раз подряд'));
  assert.ok(describeClientRisk(11).label.includes('11 раз подряд'));
  assert.ok(describeClientRisk(21).label.includes('21 раз подряд'));
  assert.equal(describeClientRisk(5).level, 'high');
});

// ── getClientCard ────────────────────────────────────────────────────────────

test('getClientCard: неизвестный id - null, не ошибка', async () => {
  const client = makeFakeClient({ clientRows: [] });
  const result = await getClientCard(client, 'nope');
  assert.equal(result, null);
});

test('getClientCard: клиент без единого визита - visits пустой массив, lastVisit null, risk none', async () => {
  const client = makeFakeClient({
    clientRows: [{ id: 'c1', name: 'Тест', phone: '+70000000000', birthday: null, no_show_streak: 0 }],
    visitRows: [],
  });
  const card = await getClientCard(client, 'c1');
  assert.equal(card.id, 'c1');
  assert.deepEqual(card.visits, []);
  assert.equal(card.lastVisit, null);
  assert.deepEqual(card.risk, { level: 'none', label: null });
});

test('getClientCard: история визитов собирается вместе с услугами через booking_services, сортировка от новых уже приходит из SQL (ORDER BY в самом запросе - здесь просто проверяем маппинг)', async () => {
  const client = makeFakeClient({
    clientRows: [{ id: 'c1', name: 'Иван', phone: '+79990001122', birthday: null, no_show_streak: 2 }],
    visitRows: [
      { id: 'b2', date: '2026-08-05', start_time: '11:00', end_time: '11:40', status: 'done', master_id: 'master-1', location_id: 1, master_name: 'Иван 1 (пример)' },
      { id: 'b1', date: '2026-07-20', start_time: '10:00', end_time: '10:30', status: 'no_show', master_id: 'master-2', location_id: 1, master_name: 'Иван 2 (пример)' },
    ],
    serviceLinkRows: [
      { booking_id: 'b2', service_id: 'strizhka', service_name: 'Стрижка' },
      { booking_id: 'b1', service_id: 'boroda', service_name: 'Борода' },
    ],
  });
  const card = await getClientCard(client, 'c1');
  assert.equal(card.visits.length, 2);
  assert.equal(card.visits[0].id, 'b2');
  assert.deepEqual(card.visits[0].services, [{ id: 'strizhka', name: 'Стрижка' }]);
  assert.equal(card.visits[1].id, 'b1');
  assert.deepEqual(card.visits[1].services, [{ id: 'boroda', name: 'Борода' }]);
  // lastVisit = первый элемент visits (SQL уже отдаёт по убыванию даты) - сырьё для "Записать снова"
  assert.equal(card.lastVisit.masterId, 'master-1');
  assert.equal(card.lastVisit.masterName, 'Иван 1 (пример)');
  assert.deepEqual(card.lastVisit.services, [{ id: 'strizhka', name: 'Стрижка' }]);
  assert.equal(card.risk.level, 'high');
});

test('getClientCard: визит без строк в booking_services - services пустой массив, не падает', async () => {
  const client = makeFakeClient({
    clientRows: [{ id: 'c1', name: 'Иван', phone: '+7', birthday: null, no_show_streak: 0 }],
    visitRows: [{ id: 'b1', date: '2026-08-01', start_time: '10:00', end_time: '10:30', status: 'done', master_id: 'master-1', location_id: 1, master_name: 'Иван 1' }],
    serviceLinkRows: [],
  });
  const card = await getClientCard(client, 'c1');
  assert.deepEqual(card.visits[0].services, []);
});

// ── listClientsAtRisk ─────────────────────────────────────────────────────────

test('listClientsAtRisk: без фильтра (владелец) - все клиенты с no_show_streak >= 1, риск размечен', async () => {
  const client = makeFakeClient({
    riskRows: [
      { id: 'c1', name: 'Пётр', phone: '+7111', no_show_streak: 3 },
      { id: 'c2', name: 'Олег', phone: '+7222', no_show_streak: 1 },
    ],
  });
  const list = await listClientsAtRisk(client, {});
  assert.equal(list.length, 2);
  assert.equal(list[0].risk.level, 'high');
  assert.equal(list[1].risk.level, 'watch');
});

test('listClientsAtRisk: locationId (администратор) - в SQL и параметрах есть фильтр по location_id', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const client = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  };
  await listClientsAtRisk(client, { locationId: 1 });
  assert.match(capturedSql, /location_id/);
  assert.ok(capturedParams.includes(1));
  assert.doesNotMatch(capturedSql, /b\.master_id/);
});

test('listClientsAtRisk: masterId (мастер) - в SQL и параметрах есть фильтр по master_id, без location_id', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const client = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  };
  await listClientsAtRisk(client, { masterId: 'master-1' });
  assert.match(capturedSql, /b\.master_id/);
  assert.ok(capturedParams.includes('master-1'));
  assert.doesNotMatch(capturedSql, /b\.location_id/);
});

test('listClientsAtRisk: без визитов в риске - пустой массив, не ошибка', async () => {
  const client = makeFakeClient({ riskRows: [] });
  const list = await listClientsAtRisk(client, {});
  assert.deepEqual(list, []);
});
