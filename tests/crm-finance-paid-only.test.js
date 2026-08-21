// Правка Влада 21.08.2026 ("это супер-ПУПЕР ВАЖНО") - в "Финансы" идут только те
// визиты, где оплата фактически зафиксирована: клиент обслужен, карточка в расписании
// зелёная. Юниты на правила, которые этим управляют - они вынесены в
// assets/crm-shared.js чистыми функциями ровно для того, чтобы их можно было
// проверить без DOM (тот же приём, что у tests/schedule-views.navigation.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAID_STATUS,
  bookingPrice,
  defaultPctFor,
  paidBookings,
  payrollBookingAmount,
  payrollStaff,
} from '../assets/crm-shared.js';

const priceOf = (_masterId, serviceId) => ({ strizhka: 2000, boroda: 1600 }[serviceId] ?? 0);

test('зелёная карточка расписания - это status "done": именно её и берут "Финансы"', () => {
  // .appt--done в assets/crm-calendar.js красит зелёным ровно этот статус
  assert.equal(PAID_STATUS, 'done');
});

test('paidBookings: запланированные, неявки и отменённые в деньги не идут', () => {
  const rows = [
    { id: 'b1', status: 'done' },
    { id: 'b2', status: 'planned' },
    { id: 'b3', status: 'no_show' },
    { id: 'b4', status: 'cancelled' },
    { id: 'b5', status: 'done' },
  ];
  assert.deepEqual(paidBookings(rows).map((b) => b.id), ['b1', 'b5']);
});

test('paidBookings: бронь без статуса в деньги не идёт (нет доказательства, что визит состоялся)', () => {
  assert.deepEqual(paidBookings([{ id: 'b1' }, { id: 'b2', status: null }]), []);
  assert.deepEqual(paidBookings(undefined), []);
});

test('выручка и зарплата за день: отменённая бронь не добавляет ни рубля', () => {
  const bookings = [
    { masterId: 'm1', status: 'done', serviceIds: ['strizhka'] },
    { masterId: 'm1', status: 'cancelled', serviceIds: ['strizhka'] },
    { masterId: 'm1', status: 'planned', serviceIds: ['boroda'] },
  ];
  const paid = paidBookings(bookings);
  const revenue = paid.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
  const payroll = paid.reduce((sum, b) => sum + (payrollBookingAmount(b, priceOf, false) * 40) / 100, 0);
  assert.equal(revenue, 2000);
  assert.equal(payroll, 800);
});

test('payrollStaff: в "Зарплаты мастеров" попадает каждый, кто принимает клиентов - включая владельца и управляющего', () => {
  const staffList = [
    { id: 'master-1', role: 'owner', providesServices: true },
    { id: 'master-2', role: 'master', providesServices: true },
    { id: 'admin-1', role: 'admin', providesServices: false },
    { id: 'manager-1', role: 'manager', providesServices: true },
    { id: 'new-1', role: 'master', providesServices: true },
  ];
  assert.deepEqual(payrollStaff(staffList).map((s) => s.id), ['master-1', 'master-2', 'manager-1', 'new-1']);
});

test('payrollStaff: новый сотрудник с включённым "Принимает клиентов" виден без правки разметки', () => {
  // До 21.08.2026 список был захардкожен тремя id (master-1/2/3) - именно поэтому
  // четвёртый человек в "Финансы" не попадал вовсе
  const before = [{ id: 'master-1', providesServices: true }];
  const after = [...before, { id: 'staff-777', providesServices: true }];
  assert.equal(payrollStaff(before).length, 1);
  assert.deepEqual(payrollStaff(after).map((s) => s.id), ['master-1', 'staff-777']);
});

// Процент - доля выручки, которая УХОДИТ мастеру. У владельца она равна нулю: его
// собственные стрижки не расход бизнеса, эти деньги и так его, и должны оставаться
// в "Чистом доходе". Ставку любому сотруднику задаёт владелец сам, выдумывать её за
// него нельзя - поэтому дефолт нулевой у всех ролей без исключения
test('defaultPctFor: ставку не выдумывают ни за кого - дефолт 0 у любой роли', () => {
  assert.equal(defaultPctFor({ role: 'owner' }), 0);
  assert.equal(defaultPctFor({ role: 'manager' }), 0);
  assert.equal(defaultPctFor({ role: 'master' }), 0);
  assert.equal(defaultPctFor(undefined), 0);
});
