// Окно 24 (05.08.2026) - чистые функции вкладки "Год" и бейджа праздника, вынесенные
// из wireScheduleViews ровно чтобы их можно было проверить без браузера (тот же приём,
// что у mondayOf/addMonths/viewAnchorLabel в schedule-views.navigation.test.js).
// Кликовая часть (рендер сетки, чекбоксы, POST) проверяется живым CDP-прогоном
// tools/verify-2026-08-05-okno24-prazdniki.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDatesToRanges, groupHolidaysByMonth, holidayNameOf, ruPluralDate } from '../assets/crm-schedule-views.js';

// ── groupDatesToRanges ─────────────────────────────────────────────────────
// POST /holidays/close принимает диапазон from-to, а владелец отмечает галочками
// произвольный набор дат - подряд идущие даты схлопываем в один запрос, разрывы
// разносим по разным. Без этого "закрыть 1-8 января" ушло бы восемью запросами.
test('groupDatesToRanges: подряд идущие даты - один диапазон', () => {
  assert.deepEqual(groupDatesToRanges(['2026-01-01', '2026-01-02', '2026-01-03']), [
    { from: '2026-01-01', to: '2026-01-03' },
  ]);
});

test('groupDatesToRanges: разрыв в датах разбивает на два диапазона', () => {
  assert.deepEqual(groupDatesToRanges(['2026-01-01', '2026-01-02', '2026-03-08']), [
    { from: '2026-01-01', to: '2026-01-02' },
    { from: '2026-03-08', to: '2026-03-08' },
  ]);
});

test('groupDatesToRanges: даты приходят в произвольном порядке - результат отсортирован', () => {
  assert.deepEqual(groupDatesToRanges(['2026-05-09', '2026-01-02', '2026-01-01']), [
    { from: '2026-01-01', to: '2026-01-02' },
    { from: '2026-05-09', to: '2026-05-09' },
  ]);
});

test('groupDatesToRanges: переход через границу месяца - это тоже непрерывный диапазон', () => {
  assert.deepEqual(groupDatesToRanges(['2026-01-31', '2026-02-01']), [{ from: '2026-01-31', to: '2026-02-01' }]);
});

test('groupDatesToRanges: одна дата - диапазон из одного дня', () => {
  assert.deepEqual(groupDatesToRanges(['2026-06-12']), [{ from: '2026-06-12', to: '2026-06-12' }]);
});

test('groupDatesToRanges: пустой выбор - ни одного запроса', () => {
  assert.deepEqual(groupDatesToRanges([]), []);
});

test('groupDatesToRanges: дубли не создают лишний диапазон', () => {
  assert.deepEqual(groupDatesToRanges(['2026-01-01', '2026-01-01', '2026-01-02']), [
    { from: '2026-01-01', to: '2026-01-02' },
  ]);
});

// ── groupHolidaysByMonth ───────────────────────────────────────────────────
// Вкладка "Год" остаётся сеткой из 12 карточек-месяцев (как в статике, которую она
// заменяет) - месяцы без праздников не исчезают, а честно говорят "без праздников".
const HOLIDAYS = [
  { date: '2026-01-07', name: 'Рождество Христово' },
  { date: '2026-01-01', name: 'Новогодние каникулы' },
  { date: '2026-03-08', name: 'Международный женский день' },
];

test('groupHolidaysByMonth: ровно 12 месяцев, включая пустые', () => {
  const months = groupHolidaysByMonth(HOLIDAYS);
  assert.equal(months.length, 12);
  assert.equal(months[0].name, 'Январь');
  assert.equal(months[11].name, 'Декабрь');
  assert.deepEqual(months[3].holidays, []); // апрель - "без праздников"
});

test('groupHolidaysByMonth: внутри месяца даты идут по возрастанию, а не в порядке ответа', () => {
  const jan = groupHolidaysByMonth(HOLIDAYS)[0];
  assert.deepEqual(
    jan.holidays.map((h) => h.date),
    ['2026-01-01', '2026-01-07']
  );
});

test('groupHolidaysByMonth: пустой ответ сервера - всё равно 12 пустых месяцев, не падение', () => {
  const months = groupHolidaysByMonth([]);
  assert.equal(months.length, 12);
  assert.ok(months.every((m) => m.holidays.length === 0));
});

// ── holidayNameOf ──────────────────────────────────────────────────────────
test('holidayNameOf: дата-праздник отдаёт название', () => {
  const map = new Map(HOLIDAYS.map((h) => [h.date, h.name]));
  assert.equal(holidayNameOf(map, '2026-01-07'), 'Рождество Христово');
});

test('holidayNameOf: обычная дата отдаёт null', () => {
  const map = new Map(HOLIDAYS.map((h) => [h.date, h.name]));
  assert.equal(holidayNameOf(map, '2026-08-05'), null);
});

test('holidayNameOf: календарь ещё не загрузился - null, а не исключение', () => {
  assert.equal(holidayNameOf(null, '2026-01-07'), null);
});

// ── ruPluralDate ───────────────────────────────────────────────────────────
test('ruPluralDate: русское склонение в подписи кнопки закрытия', () => {
  assert.equal(ruPluralDate(1), 'дату');
  assert.equal(ruPluralDate(3), 'даты');
  assert.equal(ruPluralDate(8), 'дат'); // новогодние каникулы целиком
  assert.equal(ruPluralDate(11), 'дат'); // 11-14 - исключение из правила единицы
  assert.equal(ruPluralDate(21), 'дату');
  assert.equal(ruPluralDate(22), 'даты');
});
