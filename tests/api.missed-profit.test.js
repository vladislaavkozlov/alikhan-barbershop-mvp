// Окно 59 (22.08.2026) - «Недополученная прибыль» в «Финансах» владельца.
//
// Тот же приём in-memory fake client, что в tests/api.analytics.test.js и
// tests/api.payroll-period.test.js: фильтрация по датам живёт в SQL и проверяется
// живым прогоном, здесь - разбор людей на три состояния и рубли по ним. Главное, что
// эти тесты держат: деньги считаются тем же резолвером цены, что и зарплата, и «нет
// данных» не превращается в ноль.
//
// last_date - последний визит клиента на конец периода (может быть и до его начала),
// period_last_date - последний визит ВНУТРИ периода. Разделение появилось после живого
// прогона 22.08.2026: считать отвал только по клиентам с визитом внутри окна значило
// прятать самых потерянных - см. loadClientVisits, api/routes/missed-profit.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMissedProfit, isDateStr } from '../api/routes/missed-profit.js';

// Сегодня для всех тестов ниже - 22.08.2026 (дата окна), чтобы просроченность не
// зависела от дня прогона
const TODAY = '2026-08-22';

function fakeDb({ clients = [], noShows = [], links = [], masterServices = [], services = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('last_visit AS')) return { rows: clients };
      if (sql.includes("status = 'no_show'")) return { rows: noShows };
      if (sql.includes('FROM booking_services')) return { rows: links };
      if (sql.includes('FROM master_services')) return { rows: masterServices };
      if (sql.includes('FROM services')) return { rows: services };
      throw new Error(`unexpected SQL in fake db: ${sql}`);
    },
  };
}

// Клиент, закрытый визит которого стоил 2000 у мастера m1
const PRICE_ROWS = {
  links: [{ booking_id: 'b1', service_id: 'strizhka' }],
  masterServices: [{ masterId: 'm1', serviceId: 'strizhka', price: 2000 }],
  services: [{ id: 'strizhka', price: 1500 }],
};

test('период принимается только календарной датой', () => {
  assert.equal(isDateStr('2026-08-22'), true);
  assert.equal(isDateStr('22.08.2026'), false);
  assert.equal(isDateStr(''), false);
  assert.equal(isDateStr(null), false);
});

test('просроченный клиент: пропущенные визиты по ЕГО сроку, цена - его мастера', async () => {
  const db = fakeDb({
    ...PRICE_ROWS,
    clients: [
      {
        client_id: 'c1', visits: 1, first_date: '2026-06-01', period_last_date: '2026-06-01', last_date: '2026-06-01',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Иван', phone: '+79990001111', renew_days: 28, renew_days_recommended: 28, renew_reason: 'recommended',
      },
    ],
  });
  const out = await computeMissedProfit(db, '2026-01-01', TODAY, TODAY);
  assert.equal(out.overdue.length, 1);
  // с 01.06 по 22.08 - 82 дня при сроке 28: два визита прошли мимо
  assert.equal(out.overdue[0].missedVisits, 2);
  // цена мастера (2000), а не общий прайс (1500) - тот же приоритет, что в зарплате
  assert.equal(out.overdue[0].visitPrice, 2000);
  assert.equal(out.lostLapsed, 4000);
  assert.equal(out.potentialSparse, 0);
});

test('клиент в сроке в потери не попадает вовсе', async () => {
  const db = fakeDb({
    ...PRICE_ROWS,
    clients: [
      {
        client_id: 'c1', visits: 2, first_date: '2026-07-25', period_last_date: '2026-08-15', last_date: '2026-08-15',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Пётр', phone: '+79990002222', renew_days: 28, renew_days_recommended: 28, renew_reason: 'recommended',
      },
    ],
  });
  const out = await computeMissedProfit(db, '2026-01-01', TODAY, TODAY);
  assert.equal(out.overdue.length, 0);
  assert.equal(out.sparse.length, 0);
  assert.equal(out.total, 0, 'визиты были, потерь нет - это честный ноль, а не «нет данных»');
});

test('разрежённый: согласились ходить вдвое реже, чем считает нужным мастер', async () => {
  const db = fakeDb({
    ...PRICE_ROWS,
    clients: [
      {
        client_id: 'c1', visits: 3, first_date: '2026-05-01', period_last_date: '2026-08-20', last_date: '2026-08-20',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Сергей', phone: '+79990003333', renew_days: 56, renew_days_recommended: 28, renew_reason: 'price',
      },
    ],
  });
  const out = await computeMissedProfit(db, '2026-01-01', TODAY, TODAY);
  assert.equal(out.sparse.length, 1);
  // 111 дней между первым и последним визитом, по рекомендованным 28 уместилось бы 3
  // интервала, по факту 2 - один визит недобора
  assert.equal(out.sparse[0].shortfallVisits, 1);
  assert.equal(out.potentialSparse, 2000);
  assert.equal(out.lostLapsed, 0, 'разрежённость не приплюсовывается к потерям');
});

test('неявка считается по цене того визита, который не состоялся', async () => {
  const db = fakeDb({
    links: [{ booking_id: 'ns1', service_id: 'strizhka' }],
    masterServices: [{ masterId: 'm2', serviceId: 'strizhka', price: 1200 }],
    services: [{ id: 'strizhka', price: 1500 }],
    noShows: [{ id: 'ns1', master_id: 'm2', service_id: null, date: '2026-08-10', client_id: 'c9', name: 'Олег', phone: '+79990009999' }],
  });
  const out = await computeMissedProfit(db, '2026-08-01', TODAY, TODAY);
  assert.equal(out.lostNoShow, 1200);
  assert.equal(out.counts.noShow, 1);
});

test('нет ни визитов, ни неявок за период - прочерк, а не ноль рублей', async () => {
  const db = fakeDb({});
  const out = await computeMissedProfit(db, '2026-08-01', TODAY, TODAY);
  assert.equal(out.total, null);
  assert.equal(out.lostLapsed, null);
  assert.equal(out.potentialSparse, null);
  assert.equal(out.lostNoShow, null);
});

test('клиент без своей цены у мастера считается по общему прайсу, а не по нулю', async () => {
  const db = fakeDb({
    links: [{ booking_id: 'b1', service_id: 'spa' }],
    masterServices: [],
    services: [{ id: 'spa', price: 3000 }],
    clients: [
      {
        client_id: 'c1', visits: 1, first_date: '2026-06-01', period_last_date: '2026-06-01', last_date: '2026-06-01',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Иван', phone: '+79990001111', renew_days: 28, renew_days_recommended: null, renew_reason: 'hair',
      },
    ],
  });
  const out = await computeMissedProfit(db, '2026-01-01', TODAY, TODAY);
  assert.equal(out.overdue[0].visitPrice, 3000);
});

test('пустой срок у клиента читается как месяц, а не отменяет расчёт', async () => {
  const db = fakeDb({
    ...PRICE_ROWS,
    clients: [
      {
        client_id: 'c1', visits: 1, first_date: '2026-06-01', period_last_date: '2026-06-01', last_date: '2026-06-01',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Без срока', phone: '+79990004444', renew_days: null, renew_days_recommended: null, renew_reason: null,
      },
    ],
  });
  const out = await computeMissedProfit(db, '2026-01-01', TODAY, TODAY);
  assert.equal(out.overdue.length, 1);
  assert.equal(out.overdue[0].renewDays, 30);
  // 82 дня при сроке 30 - два пропущенных визита
  assert.equal(out.overdue[0].missedVisits, 2);
});

// Регрессия на дефект, найденный живым прогоном 22.08.2026: карточка за «Месяц»
// показывала только клиентов с визитом внутри месяца - то есть чем дольше человек
// потерян, тем меньше был шанс его увидеть. Считаем не «когда он был последний раз», а
// «сколько его визитов должно было состояться в этом окне и не состоялось».
test('клиент, пропавший ДО начала периода, всё равно виден в окне периода', async () => {
  const db = fakeDb({
    ...PRICE_ROWS,
    clients: [
      {
        client_id: 'c1', visits: 0, first_date: null, period_last_date: null, last_date: '2026-05-01',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Давно пропал', phone: '+79990005555', renew_days: 28, renew_days_recommended: null, renew_reason: 'recommended',
      },
    ],
  });
  // Окно - только август. Визитов внутри него нет вовсе, но сроки 27.07+28=24.08? нет:
  // сроки клиента приходятся на 29.05, 26.06, 24.07, 21.08 - в августовское окно попал
  // ровно один пропущенный визит
  const out = await computeMissedProfit(db, '2026-08-01', TODAY, TODAY);
  assert.equal(out.overdue.length, 1);
  assert.equal(out.overdue[0].missedVisits, 1);
  assert.equal(out.lostLapsed, 2000);
});

test('один и тот же пропавший клиент не считается потерей в каждом периоде заново', async () => {
  const db = fakeDb({
    ...PRICE_ROWS,
    clients: [
      {
        client_id: 'c1', visits: 0, first_date: null, period_last_date: null, last_date: '2026-05-01',
        booking_id: 'b1', master_id: 'm1', service_id: null,
        name: 'Давно пропал', phone: '+79990005555', renew_days: 28, renew_days_recommended: null, renew_reason: 'recommended',
      },
    ],
  });
  // Узкое окно между сроками (сроки - 29.05, 26.06, 24.07, 21.08): в первую неделю
  // августа не приходится ни один, и клиента в этой карточке нет
  const out = await computeMissedProfit(db, '2026-08-01', '2026-08-07', TODAY);
  assert.equal(out.overdue.length, 0);
  assert.equal(out.total, null, 'ни визитов, ни неявок, ни пропущенных сроков - считать не из чего');
});
