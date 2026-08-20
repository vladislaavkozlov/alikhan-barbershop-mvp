// 20.08.2026, находка Влада: сотрудник с галкой «не работает в компании» продолжал
// занимать колонку в календаре, потому что фронт отбирал мастеров только по
// providesServices. Сервер employed проверял всегда - записать к такому было нельзя,
// но место в дне он занимал и путал.
//
// Тест держит ОБА флага в критерии: снятие любого из них убирает человека из списка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsClients, mastersOf } from '../assets/crm-calendar.js';

const working = { id: 'm1', name: 'Мамедхан', providesServices: true, employed: true };
const firedButStillHasServices = { id: 'm2', name: 'Тест Сценарии', providesServices: true, employed: false };
const workingWithoutServices = { id: 'a1', name: 'Администратор', providesServices: false, employed: true };

test('acceptsClients: услуги включены и человек в составе - принимает клиентов', () => {
  assert.equal(acceptsClients(working), true);
});

test('acceptsClients: уволен, но галка услуг осталась - клиентов не принимает', () => {
  assert.equal(acceptsClients(firedButStillHasServices), false);
});

test('acceptsClients: в составе, но услуг не оказывает - клиентов не принимает', () => {
  assert.equal(acceptsClients(workingWithoutServices), false);
});

// Поле employed может не приехать из старого снимка состава - в этом случае человека
// нельзя терять молча, иначе календарь останется вообще без колонок
test('acceptsClients: поля employed нет вовсе - считаем, что человек в составе', () => {
  assert.equal(acceptsClients({ providesServices: true }), true);
});

test('acceptsClients: пустой вход не роняет расчёт', () => {
  assert.equal(acceptsClients(null), false);
  assert.equal(acceptsClients(undefined), false);
});

test('mastersOf: уволенный не попадает в колонки календаря', () => {
  const columns = mastersOf([working, firedButStillHasServices, workingWithoutServices]);
  assert.deepEqual(columns.map((m) => m.id), ['m1']);
});

test('mastersOf: мастер без рабочего графика по-прежнему отсеивается', () => {
  const columns = mastersOf([working, { ...working, id: 'm3', hasWorkingSchedule: false }]);
  assert.deepEqual(columns.map((m) => m.id), ['m1']);
});
