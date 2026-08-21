// Окно 65 (21.08.2026) - "График работы": матрица мастера × даты, общий компонент
// Недели и Месяца (assets/crm-schedule-matrix.js). Юниты на чистую часть - модель и
// разметку: DOM здесь не нужен, обращения к document живут в wireMatrixClicks и в
// самих видах (тот же приём, что в schedule-views.navigation.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesBetween, buildMatrixModel, matrixHtml, dayStatusOf } from '../assets/crm-schedule-matrix.js';

const MASTERS = [
  { id: 'm1', name: 'Али' },
  { id: 'm2', name: 'Мамедхан' },
];

function workDay(date, startTime = '10:00', endTime = '20:00', breaks = []) {
  return { date, isDayOff: false, startTime, endTime, breaks };
}

test('datesBetween: диапазон включает обе границы и переходит через границу месяца', () => {
  assert.deepEqual(datesBetween('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  assert.deepEqual(datesBetween('2026-08-05', '2026-08-05'), ['2026-08-05']);
  assert.equal(datesBetween('2026-08-01', '2026-08-31').length, 31);
  // Февраль високосного 2028-го - длину месяца никто не хардкодит
  assert.equal(datesBetween('2028-02-01', '2028-02-29').length, 29);
});

test('модель: строка на мастера, колонка на дату, брони разложены по своему мастеру', () => {
  const model = buildMatrixModel({
    masters: MASTERS,
    from: '2026-08-17',
    to: '2026-08-18',
    schedulesByMasterId: new Map([
      ['m1', [workDay('2026-08-17'), workDay('2026-08-18')]],
      ['m2', [workDay('2026-08-17'), { date: '2026-08-18', isDayOff: true, startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] }]],
    ]),
    weeklyByMasterId: new Map([['m1', []], ['m2', []]]),
    bookings: [
      { masterId: 'm1', date: '2026-08-17', startTime: '11:00', endTime: '12:00', status: 'confirmed' },
      { masterId: 'm2', date: '2026-08-17', startTime: '11:00', endTime: '12:00', status: 'confirmed' },
      { masterId: 'm2', date: '2026-08-17', startTime: '12:00', endTime: '13:00', status: 'confirmed' },
    ],
    holidayMap: new Map(),
    today: '2026-08-17',
  });
  assert.deepEqual(model.days.map((d) => d.date), ['2026-08-17', '2026-08-18']);
  assert.deepEqual(model.rows.map((r) => r.master.id), ['m1', 'm2']);
  assert.equal(model.rows[0].cells[0].bookingCount, 1);
  assert.equal(model.rows[1].cells[0].bookingCount, 2);
  assert.equal(model.rows[1].cells[1].isDayOff, true);
  assert.equal(model.days[0].isToday, true);
});

test('модель: отменённая запись не считается ни в число записей, ни в загрузку', () => {
  const model = buildMatrixModel({
    masters: [MASTERS[0]],
    from: '2026-08-17',
    to: '2026-08-17',
    schedulesByMasterId: new Map([['m1', [workDay('2026-08-17')]]]),
    weeklyByMasterId: new Map([['m1', []]]),
    bookings: [
      { masterId: 'm1', date: '2026-08-17', startTime: '11:00', endTime: '12:00', status: 'cancelled' },
      { masterId: 'm1', date: '2026-08-17', startTime: '13:00', endTime: '14:00', status: 'confirmed' },
    ],
    holidayMap: new Map(),
    today: '2026-08-01',
  });
  const cell = model.rows[0].cells[0];
  assert.equal(cell.bookingCount, 1);
  assert.equal(cell.loadPct, 10); // 60 минут из 600 доступных
});

test('модель: дня нет в ответе /schedule-range - это "нет данных", а не рабочий день по умолчанию', () => {
  // Мастера приняли позже начала диапазона: выдуманные 10:00-20:00 в такой ячейке
  // соврали бы про его график и завысили бы загрузку команды.
  const model = buildMatrixModel({
    masters: [MASTERS[0]],
    from: '2026-08-17',
    to: '2026-08-18',
    schedulesByMasterId: new Map([['m1', [workDay('2026-08-18')]]]),
    weeklyByMasterId: new Map([['m1', []]]),
    bookings: [],
    holidayMap: new Map(),
    today: '2026-08-01',
  });
  assert.equal(model.rows[0].cells[0].missing, true);
  assert.equal(model.rows[0].cells[0].status, 'none');
  assert.equal(model.rows[0].cells[1].missing, false);
});

test('статус дня: совпал со стандартным графиком - обычный, разошёлся - правка, закрыт - выходной', () => {
  const weekly = new Map([[1, { weekday: 1, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: null, breakEnd: null }]]);
  // 2026-08-17 - понедельник
  assert.equal(dayStatusOf(workDay('2026-08-17'), weekly), 'work');
  assert.equal(dayStatusOf(workDay('2026-08-17', '12:00', '18:00'), weekly), 'edit');
  assert.equal(dayStatusOf({ date: '2026-08-17', isDayOff: true }, weekly), 'off');
});

test('праздник - признак КОЛОНКИ (даты), а не ячейки мастера', () => {
  // Праздничность не зависит от того, работает ли конкретный мастер в этот день -
  // тот же принцип, что был в старой сетке Месяца (Окно 24).
  const model = buildMatrixModel({
    masters: MASTERS,
    from: '2027-01-01',
    to: '2027-01-01',
    schedulesByMasterId: new Map([['m1', [workDay('2027-01-01')]], ['m2', [{ date: '2027-01-01', isDayOff: true }]]]),
    weeklyByMasterId: new Map(),
    bookings: [],
    holidayMap: new Map([['2027-01-01', 'Новый год']]),
    today: '2026-08-01',
  });
  assert.equal(model.days[0].holidayName, 'Новый год');
  assert.ok(!('holidayName' in model.rows[0].cells[0]));
});

test('разметка: у владельца ячейка - кнопка (правка дня), у мастера - неинтерактивный блок', () => {
  const base = {
    masters: [MASTERS[0]],
    from: '2026-08-17',
    to: '2026-08-17',
    schedulesByMasterId: new Map([['m1', [workDay('2026-08-17')]]]),
    weeklyByMasterId: new Map(),
    bookings: [],
    holidayMap: new Map(),
    today: '2026-08-01',
  };
  const model = buildMatrixModel(base);
  assert.match(matrixHtml(model, { editable: true }), /<button type="button" class="sm-cell/);
  assert.doesNotMatch(matrixHtml(model, { editable: false }), /<button type="button" class="sm-cell/);
  // Шапка даты ведёт в "День" в обоих режимах - смотреть день мастеру никто не запрещает
  assert.match(matrixHtml(model, { editable: false }), /data-open-day="2026-08-17"/);
});

test('разметка: число колонок уходит в CSS-переменную, а не в захардкоженные 7', () => {
  const model = buildMatrixModel({
    masters: [MASTERS[0]],
    from: '2026-08-01',
    to: '2026-08-31',
    schedulesByMasterId: new Map([['m1', []]]),
    weeklyByMasterId: new Map(),
    bookings: [],
    holidayMap: new Map(),
    today: '2026-08-01',
  });
  assert.match(matrixHtml(model), /--sm-cols:31/);
});

test('разметка: имя клиента и мастера экранируются (в матрицу приходит пользовательский ввод)', () => {
  const model = buildMatrixModel({
    masters: [{ id: 'm1', name: '<img src=x onerror=alert(1)>' }],
    from: '2026-08-17',
    to: '2026-08-17',
    schedulesByMasterId: new Map([['m1', [workDay('2026-08-17')]]]),
    weeklyByMasterId: new Map(),
    bookings: [],
    holidayMap: new Map(),
    today: '2026-08-01',
  });
  const html = matrixHtml(model);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('разметка: плашка загрузки не берёт общий класс .is-busy (он занят спиннером)', () => {
  // .is-busy в assets/crm-loading.css - состояние "ждём сервер": color: transparent
  // !important плюс крутящийся ::after. Совпадение имён давало золотой овал со
  // спиннером вместо "10% · 1" (замер живьём 21.08.2026, color rgba(0,0,0,0)).
  const model = buildMatrixModel({
    masters: [MASTERS[0]],
    from: '2026-08-17',
    to: '2026-08-17',
    schedulesByMasterId: new Map([['m1', [workDay('2026-08-17')]]]),
    weeklyByMasterId: new Map(),
    bookings: [{ masterId: 'm1', date: '2026-08-17', startTime: '11:00', endTime: '12:00', status: 'planned' }],
    holidayMap: new Map(),
    today: '2026-08-01',
  });
  const html = matrixHtml(model);
  assert.match(html, /class="sm-cell-load sm-cell-load--busy"/);
  assert.doesNotMatch(html, /class="[^"]*\bis-busy\b/);
});
