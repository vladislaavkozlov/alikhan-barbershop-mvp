// 17.08.2026 - вместе с суточными опциями времени («круглосуточно», Влад) резко
// вырос риск сохранить перевёрнутое окно: в списке 97 значений 23:00 и 01:00 стоят
// рядом по смыслу «ночь», и график 23:00-01:00 раньше сохранялся молча - CHECK в
// миграции 022 проверяет только заполненность, а мастер с таким окном просто выпадал
// из записи (hasAvailableSlot не находит ни одного слота, ошибки нигде нет).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWeeklyChanges } from '../api/lib/schedule-core.js';

const workday = { weekday: 1, isWorking: true, workStart: '10:00', workEnd: '20:00' };

test('обычный рабочий день проходит как раньше', () => {
  const rows = validateWeeklyChanges([workday]);
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].workStart, '10:00');
});

test('круглосуточное окно 00:00-23:59 принимается', () => {
  const rows = validateWeeklyChanges([{ weekday: 2, isWorking: true, workStart: '00:00', workEnd: '23:59' }]);
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].workStart, '00:00');
  assert.equal(rows[0].workEnd, '23:59');
});

test('конец раньше начала отклоняется', () => {
  assert.equal(validateWeeklyChanges([{ ...workday, workStart: '23:00', workEnd: '01:00' }]), null);
});

test('нулевая смена (начало = конец) отклоняется', () => {
  assert.equal(validateWeeklyChanges([{ ...workday, workStart: '12:00', workEnd: '12:00' }]), null);
});

test('перерыв концом раньше начала отклоняется', () => {
  assert.equal(validateWeeklyChanges([{ ...workday, breakStart: '15:00', breakEnd: '14:00' }]), null);
});

test('перерыв за границами смены отклоняется', () => {
  assert.equal(validateWeeklyChanges([{ ...workday, breakStart: '09:00', breakEnd: '11:00' }]), null);
  assert.equal(validateWeeklyChanges([{ ...workday, breakStart: '19:00', breakEnd: '21:00' }]), null);
});

test('перерыв внутри круглосуточной смены принимается', () => {
  const rows = validateWeeklyChanges([
    { weekday: 3, isWorking: true, workStart: '00:00', workEnd: '23:59', breakStart: '03:00', breakEnd: '04:00' },
  ]);
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].breakStart, '03:00');
});

test('битое время отклоняется, а не пролетает в базу', () => {
  assert.equal(validateWeeklyChanges([{ ...workday, workEnd: '25:00' }]), null);
  assert.equal(validateWeeklyChanges([{ ...workday, workEnd: 'вечер' }]), null);
});

test('выходной день не проверяется на часы - их там нет', () => {
  const rows = validateWeeklyChanges([{ weekday: 4, isWorking: false, workStart: '23:00', workEnd: '01:00' }]);
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].workStart, null);
  assert.equal(rows[0].workEnd, null);
});
