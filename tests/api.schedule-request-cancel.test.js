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

// ── Регрессия бага 05.08.2026: одобренный отгул не закрывал день на нестандартной смене ──
// Воспроизведение до фикса (живьём на локальной базе): владелец ставит мастеру разовую
// смену 09:00-18:00 → мастер подаёт day_off на эту дату → владелец одобряет (200 ok) →
// GET /schedule-range отдаёт isDayOff:false, /schedule-availability - hasSlots:true, то
// есть клиент мог записаться в уже одобренный отгул на 09:00-10:00. Причина - границы
// блокировки брались литералами '10:00'/'20:00', а перерыв обязан накрывать смену
// ЦЕЛИКОМ (isScheduleDayOff). Здесь проверяется чистая часть фикса.
import { dayOffWindowsForRequest, fullDayOffWindow, isScheduleDayOff } from '../api/server.mjs';

function fakeClientWithShift(shiftsByDate = {}) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM schedule_shifts')) return { rows: shiftsByDate[params[1]] ?? [] };
      if (sql.includes('FROM master_weekly_schedule')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('day_off на ранней смене 09:00-18:00: окно блокировки накрывает смену целиком (регрессия)', async () => {
  const client = fakeClientWithShift({
    '2026-11-04': [{ start_time: '09:00', end_time: '18:00', b_start: null, b_end: null }],
  });
  const windows = await dayOffWindowsForRequest(client, 'master-3', ['2026-11-04'], 'day_off', null, null);
  const win = windows.get('2026-11-04');
  assert.deepEqual(win, { startTime: '09:00', endTime: '20:00' });
  // До фикса здесь было бы {10:00, 20:00} и, как следствие, isDayOff === false
  assert.equal(isScheduleDayOff({ startTime: '09:00', endTime: '18:00', breaks: [win] }), true);
});

test('day_off на стандартном дне: поведение не изменилось - 10:00-20:00', async () => {
  const client = fakeClientWithShift();
  const windows = await dayOffWindowsForRequest(client, 'master-1', ['2026-11-04'], 'day_off', null, null);
  assert.deepEqual(windows.get('2026-11-04'), { startTime: '10:00', endTime: '20:00' });
});

test('day_off на несколько дней: окно считается для КАЖДОЙ даты по её графику', async () => {
  const client = fakeClientWithShift({
    '2026-11-05': [{ start_time: '08:00', end_time: '22:00', b_start: null, b_end: null }],
  });
  const dates = ['2026-11-04', '2026-11-05'];
  const windows = await dayOffWindowsForRequest(client, 'master-3', dates, 'day_off', null, null);
  assert.deepEqual(windows.get('2026-11-04'), { startTime: '10:00', endTime: '20:00' });
  assert.deepEqual(windows.get('2026-11-05'), { startTime: '08:00', endTime: '22:00' });
});

test('перерыв (break) блокирует ровно те часы, что мастер указал в заявке, а не весь день', async () => {
  const client = fakeClientWithShift({
    '2026-11-04': [{ start_time: '09:00', end_time: '18:00', b_start: null, b_end: null }],
  });
  const windows = await dayOffWindowsForRequest(client, 'master-3', ['2026-11-04'], 'break', '13:00', '14:00');
  assert.deepEqual(windows.get('2026-11-04'), { startTime: '13:00', endTime: '14:00' });
  assert.equal(isScheduleDayOff({ startTime: '09:00', endTime: '18:00', breaks: [windows.get('2026-11-04')] }), false);
});

test('fullDayOffWindow одинаково работает для праздника и для отгула - одна функция на оба пути', () => {
  const eff = { startTime: '09:00', endTime: '18:00', breaks: [] };
  assert.deepEqual(fullDayOffWindow(eff), { startTime: '09:00', endTime: '20:00' });
});
