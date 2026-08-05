// Задача C промпта Окна 29 (05.08.2026), сценарий 3 - публичный виджет не
// показывает клиенту мастера без настроенного графика вообще.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMasters, filterBookableMasters } from '../storage.js';

const [masterA, masterB] = getMasters();

test('filterBookableMasters: мастер без графика (hasWorkingSchedule=false) исключён из списка', () => {
  const map = new Map([[masterA.id, false], [masterB.id, true]]);
  const result = filterBookableMasters(getMasters(), map);
  assert.equal(result.some((m) => m.id === masterA.id), false);
  assert.equal(result.some((m) => m.id === masterB.id), true);
});

test('filterBookableMasters: обычная запись не сломана - мастер с графиком остаётся в списке (регресс)', () => {
  const map = new Map(getMasters().map((m) => [m.id, true]));
  const result = filterBookableMasters(getMasters(), map);
  assert.equal(result.length, getMasters().length);
});

test('filterBookableMasters: карта ещё не пришла (null) - ничего не фильтруем, виджет не ломается', () => {
  const result = filterBookableMasters(getMasters(), null);
  assert.equal(result.length, getMasters().length);
});

test('filterBookableMasters: мастер отсутствует в карте вовсе - по умолчанию показан (не смешиваем с "нет услуг")', () => {
  const map = new Map(); // ни один мастер не упомянут
  const result = filterBookableMasters(getMasters(), map);
  assert.equal(result.length, getMasters().length);
});
