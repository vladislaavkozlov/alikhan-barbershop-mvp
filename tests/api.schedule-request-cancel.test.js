// Окно 23 (04.08.2026, Задача 1) - юниты на чистую часть контракта отмены одобренной
// заявки: enumerateDateRange. Именно эта функция решает, по КАКИМ датам пройдёт откат
// (PATCH /schedule-requests/:id/cancel) - и она же теперь задаёт список дат при
// одобрении (PATCH .../decision). Разойдись эти два списка хоть на день - часть
// отпуска осталась бы заблокированной после отмены, поэтому функция общая и покрыта
// здесь без реального Postgres (тот же приём, что у tests/api.schedule-availability.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateDateRange } from '../api/server.mjs';

test('enumerateDateRange: один день (dateFrom == dateTo) -> ровно одна дата', () => {
  assert.deepEqual(enumerateDateRange('2026-08-10', '2026-08-10'), ['2026-08-10']);
});

test('enumerateDateRange: обычный трёхдневный отгул -> обе границы включительно', () => {
  assert.deepEqual(enumerateDateRange('2026-08-10', '2026-08-12'), ['2026-08-10', '2026-08-11', '2026-08-12']);
});

test('enumerateDateRange: диапазон через границу месяца', () => {
  assert.deepEqual(enumerateDateRange('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});

test('enumerateDateRange: диапазон через границу года', () => {
  assert.deepEqual(enumerateDateRange('2026-12-31', '2027-01-01'), ['2026-12-31', '2027-01-01']);
});

test('enumerateDateRange: 29 февраля високосного года не пропускается', () => {
  assert.deepEqual(enumerateDateRange('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
});

test('enumerateDateRange: перевёрнутый диапазон (dateTo раньше dateFrom) -> пусто, ничего не удалим вслепую', () => {
  assert.deepEqual(enumerateDateRange('2026-08-12', '2026-08-10'), []);
});

// Заявки на постоянный график (category=grafik_standard) хранятся с date_to = NULL
// (см. INSERT в POST /schedule-requests). Роут /cancel отбивает их отдельным 409
// ДО этого вызова - но если бы не отбивал, функция всё равно не удалила бы ни одной
// даты вслепую. Тест фиксирует это как страховку, а не как рабочий путь.
test('enumerateDateRange: dateTo = null -> пусто (страховка для заявок недельного графика)', () => {
  assert.deepEqual(enumerateDateRange('2026-08-10', null), []);
});
