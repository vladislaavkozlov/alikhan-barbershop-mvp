// Окно 65 (21.08.2026) - лента месяцев в "Месяце" (скриншот Yclients от заказчика:
// "авг сент окт нояб дек" одним рядом). Юнит на чистую модель ленты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthStripModel, MONTH_STRIP_BACK, MONTH_STRIP_FORWARD } from '../assets/crm-schedule-view-month.js';

test('лента: месяц назад и шесть вперёд от сегодняшнего, активен месяц якоря', () => {
  const months = monthStripModel('2026-08-19', '2026-08-21');
  assert.equal(months.length, MONTH_STRIP_BACK + MONTH_STRIP_FORWARD + 1);
  assert.equal(months[0].first, '2026-07-01');
  assert.equal(months.at(-1).first, '2027-02-01');
  assert.deepEqual(months.filter((m) => m.isActive).map((m) => m.first), ['2026-08-01']);
});

test('лента: месяц якоря вне ленты (пролистали стрелками далеко) - добавляется на своё место', () => {
  const months = monthStripModel('2027-06-14', '2026-08-21');
  const active = months.filter((m) => m.isActive);
  assert.deepEqual(active.map((m) => m.first), ['2027-06-01']);
  // Порядок не ломается: даты идут по возрастанию
  assert.deepEqual([...months].sort((a, b) => a.first.localeCompare(b.first)).map((m) => m.first), months.map((m) => m.first));
});

test('лента: год переходит корректно, месяц называется по-русски', () => {
  const months = monthStripModel('2026-12-05', '2026-12-01');
  assert.equal(months[0].label, 'Ноябрь');
  assert.ok(months.some((m) => m.first === '2027-01-01' && m.label === 'Январь' && m.year === 2027));
});
