// Окно 65 (21.08.2026) - полоска дней недели под "Днём" (assets/crm-schedule-daystrip.js).
// Юниты на чистые функции модели и подписи месяца; рендер и клики - DOM, проверяются
// живым прогоном (tools/verify-59-*.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayStripModel, dayStripMonthLabel } from '../assets/crm-schedule-daystrip.js';

test('полоска: всегда семь дней той недели, где стоит выбранная дата, с понедельника', () => {
  // 2026-08-19 - среда
  const days = dayStripModel('2026-08-19', '2026-08-21');
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.date), [
    '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23',
  ]);
  assert.deepEqual(days.map((d) => d.weekdayShort), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
});

test('полоска: выбранный и сегодняшний день - РАЗНЫЕ признаки, а не один', () => {
  const days = dayStripModel('2026-08-19', '2026-08-21');
  assert.deepEqual(days.filter((d) => d.isSelected).map((d) => d.date), ['2026-08-19']);
  assert.deepEqual(days.filter((d) => d.isToday).map((d) => d.date), ['2026-08-21']);
  // Сегодня вне показанной недели - подсветки "сегодня" в полоске просто нет
  assert.equal(dayStripModel('2026-08-19', '2026-09-10').some((d) => d.isToday), false);
});

test('полоска: суббота и воскресенье помечены выходными днями календаря', () => {
  const days = dayStripModel('2026-08-19', '2026-08-19');
  assert.deepEqual(days.filter((d) => d.isWeekend).map((d) => d.weekdayShort), ['Сб', 'Вс']);
});

test('полоска: неделя на стыке месяцев называет оба месяца', () => {
  // 2026-08-31 (Пн) - 2026-09-06 (Вс)
  assert.equal(dayStripMonthLabel('2026-09-02'), 'августа - сентября 2026');
  assert.equal(dayStripMonthLabel('2026-08-19'), 'августа 2026');
});
