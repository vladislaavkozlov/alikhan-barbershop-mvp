// 17.08.2026 - круглосуточный график мастера (00:00-23:59, задача Влада). Шкала
// "Дня" была жёстко 10:00-20:00 (DAY_START_MIN/DAY_END_MIN, assets/crm-calendar.js) -
// запись мастера, работающего ночью, получала отрицательный top и физически не была
// видна в календаре. Окно дня теперь считается от реальных смен и броней; чистый
// расчёт вынесен в assets/crm-day-window.js именно чтобы проверяться офлайн, без DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDayWindow, DEFAULT_DAY_START_MIN, DEFAULT_DAY_END_MIN, hourMarksFor } from '../assets/crm-day-window.js';

test('обычный день остаётся прежней шкалой 10:00-20:00', () => {
  const win = computeDayWindow({ shifts: [{ startTime: '10:00', endTime: '20:00', breaks: [] }] });
  assert.equal(win.startMin, DEFAULT_DAY_START_MIN);
  assert.equal(win.endMin, DEFAULT_DAY_END_MIN);
});

test('пустой день (нет смен) - тоже прежняя шкала', () => {
  const win = computeDayWindow({ shifts: [] });
  assert.equal(win.startMin, 600);
  assert.equal(win.endMin, 1200);
});

test('круглосуточная смена раздвигает шкалу на все сутки', () => {
  const win = computeDayWindow({ shifts: [{ startTime: '00:00', endTime: '23:59', breaks: [] }] });
  assert.equal(win.startMin, 0);
  assert.equal(win.endMin, 1440); // 23:59 округляется вверх до 24:00 - целые часы шкалы
});

test('ранняя смена раздвигает только вниз, вечер остаётся дефолтным', () => {
  const win = computeDayWindow({ shifts: [{ startTime: '07:30', endTime: '16:00', breaks: [] }] });
  assert.equal(win.startMin, 420); // 07:00 - вниз до целого часа
  assert.equal(win.endMin, 1200);
});

test('выходной мастера шкалу не раздвигает (перерыв накрывает смену целиком)', () => {
  const win = computeDayWindow({
    shifts: [{ startTime: '00:00', endTime: '23:59', breaks: [{ startTime: '00:00', endTime: '23:59' }] }],
  });
  assert.equal(win.startMin, 600);
  assert.equal(win.endMin, 1200);
});

test('шкалу раздвигает ТОЛЬКО график - запись вне рабочих часов на неё не влияет', () => {
  // Решение Влада 17.08.2026: «эти часы нужно ставить только если у сотрудника есть
  // рабочие часы в это время». Запись, созданную персоналом вне смены, не теряем -
  // её карточка прижимается к краю трека и помечается (positionStyle/appt--outside)
  const win = computeDayWindow({
    shifts: [{ startTime: '10:00', endTime: '20:00', breaks: [] }],
    bookings: [{ startTime: '02:15', endTime: '03:00' }],
  });
  assert.equal(win.startMin, 600);
  assert.equal(win.endMin, 1200);
});

test('несколько мастеров - берётся объединение их рабочих часов', () => {
  const win = computeDayWindow({
    shifts: [
      { startTime: '06:00', endTime: '14:00', breaks: [] },
      { startTime: '14:00', endTime: '23:00', breaks: [] },
    ],
  });
  assert.equal(win.startMin, 360);
  assert.equal(win.endMin, 1380);
});

test('битые значения времени игнорируются, а не роняют шкалу', () => {
  const win = computeDayWindow({ shifts: [{ startTime: null, endTime: undefined, breaks: null }, null] });
  assert.equal(win.startMin, 600);
  assert.equal(win.endMin, 1200);
});

test('подписи часов покрывают всё окно и совпадают с шагом 64px', () => {
  const marks = hourMarksFor({ startMin: 0, endMin: 1440 });
  assert.equal(marks.length, 25); // 00:00..24:00 включительно
  assert.deepEqual(marks[0], { label: '00:00', top: 0 });
  assert.deepEqual(marks[1], { label: '01:00', top: 64 });
  assert.equal(marks.at(-1).label, '24:00');
  assert.equal(marks.at(-1).top, 1536);

  const usual = hourMarksFor({ startMin: 600, endMin: 1200 });
  assert.equal(usual.length, 11);
  assert.deepEqual(usual[0], { label: '10:00', top: 0 });
  assert.deepEqual(usual.at(-1), { label: '20:00', top: 640 });
});
