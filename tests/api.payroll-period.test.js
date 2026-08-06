// Окно 37 (06.08.2026, Задача 1) - юниты на computeMasterPayroll: единый резолвер
// ЗП мастера за произвольный период (masterId+from+to), заменивший клиентский дубль
// формулы bookingPrice×pctOf (assets/crm-auth.js) и мёртвый calcPayrollEstimate
// (storage.js, хардкод 45%/50%, удалён этим окном). Тот же паттерн in-memory fake
// client, что уже применён в tests/api.masters-next-availability.test.js - реальная
// фильтрация по датам/ролям живёт в SQL и проверяется живым прогоном (DoD этого
// окна), здесь - только арифметика резолвера на фиксированном наборе строк.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMasterPayroll } from '../api/server.mjs';

function makeFakeClient({ pctRows = [], bookingsRows = [], linkRows = [], masterServiceRows = [], serviceRows = [] } = {}) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM master_payroll_settings')) return { rows: pctRows };
      if (sql.includes('FROM booking_services')) return { rows: linkRows };
      if (sql.includes('FROM master_services')) return { rows: masterServiceRows };
      if (sql.includes('FROM services')) return { rows: serviceRows };
      if (sql.includes('FROM bookings')) return { rows: bookingsRows };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

test('computeMasterPayroll: одна бронь, одна услуга (booking_services) - revenue/payroll по ставке мастера', async () => {
  const client = makeFakeClient({
    pctRows: [{ pct: 50 }],
    bookingsRows: [{ id: 'b1', serviceId: null }],
    linkRows: [{ bookingId: 'b1', serviceId: 'strizhka' }],
    masterServiceRows: [{ serviceId: 'strizhka', price: 2000 }],
  });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-07');
  assert.equal(result.revenue, 2000);
  assert.equal(result.payroll, 1000);
});

test('computeMasterPayroll: бронь с несколькими услугами - сумма по ВСЕМ услугам, не первой', async () => {
  const client = makeFakeClient({
    pctRows: [{ pct: 100 }],
    bookingsRows: [{ id: 'b1', serviceId: null }],
    linkRows: [
      { bookingId: 'b1', serviceId: 'strizhka' },
      { bookingId: 'b1', serviceId: 'boroda' },
    ],
    masterServiceRows: [
      { serviceId: 'strizhka', price: 2000 },
      { serviceId: 'boroda', price: 1600 },
    ],
  });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-07');
  assert.equal(result.revenue, 3600);
  assert.equal(result.payroll, 3600);
});

test('computeMasterPayroll: несколько броней за период суммируются', async () => {
  const client = makeFakeClient({
    pctRows: [{ pct: 40 }],
    bookingsRows: [
      { id: 'b1', serviceId: null },
      { id: 'b2', serviceId: null },
    ],
    linkRows: [
      { bookingId: 'b1', serviceId: 'strizhka' },
      { bookingId: 'b2', serviceId: 'boroda' },
    ],
    masterServiceRows: [
      { serviceId: 'strizhka', price: 2000 },
      { serviceId: 'boroda', price: 1600 },
    ],
  });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-31');
  assert.equal(result.revenue, 3600);
  assert.equal(result.payroll, 1440); // 3600 * 0.4
});

test('computeMasterPayroll: старая бронь без booking_services (только bookings.service_id) - фолбэк работает', async () => {
  const client = makeFakeClient({
    pctRows: [{ pct: 100 }],
    bookingsRows: [{ id: 'b-old', serviceId: 'strizhka' }],
    linkRows: [], // нет строк в booking_services для этой брони
    masterServiceRows: [{ serviceId: 'strizhka', price: 2000 }],
  });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-07');
  assert.equal(result.revenue, 2000);
});

test('computeMasterPayroll: цены мастера нет в master_services - фолбэк на общий прайс services', async () => {
  const client = makeFakeClient({
    pctRows: [{ pct: 100 }],
    bookingsRows: [{ id: 'b1', serviceId: null }],
    linkRows: [{ bookingId: 'b1', serviceId: 'spa-uhod' }],
    masterServiceRows: [], // нет своей цены у этого мастера
    serviceRows: [{ id: 'spa-uhod', price: 3000 }],
  });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-07');
  assert.equal(result.revenue, 3000);
});

test('computeMasterPayroll: у мастера нет строки в master_payroll_settings - ставка 0, payroll 0', async () => {
  const client = makeFakeClient({
    pctRows: [],
    bookingsRows: [{ id: 'b1', serviceId: null }],
    linkRows: [{ bookingId: 'b1', serviceId: 'strizhka' }],
    masterServiceRows: [{ serviceId: 'strizhka', price: 2000 }],
  });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-07');
  assert.equal(result.revenue, 2000);
  assert.equal(result.payroll, 0);
});

test('computeMasterPayroll: за период нет ни одной брони - revenue/payroll 0', async () => {
  const client = makeFakeClient({ pctRows: [{ pct: 50 }], bookingsRows: [] });
  const result = await computeMasterPayroll(client, 'm1', '2026-08-01', '2026-08-07');
  assert.equal(result.revenue, 0);
  assert.equal(result.payroll, 0);
});
