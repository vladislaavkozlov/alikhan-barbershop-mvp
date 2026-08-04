// Окно 17 (04.08.2026, Задача 1 промпта) - юниты на резолвер GET /schedule-range:
// разовая правка (schedule_shifts) побеждает недельный график (master_weekly_schedule),
// недельный график побеждает глобальный дефолт 10:00-20:00, isDayOff считается верно
// на всех трёх случаях. In-memory, без реального Postgres - api/server.mjs экспортирует
// чистые функции (getEffectiveSchedule/isScheduleDayOff/computeScheduleRangeDays/
// rangeDayCount), сервер сам не стартует при импорте (see guard в самом низу файла,
// та же причина, что уже объясняется в комментарии рядом с ним).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEffectiveSchedule,
  isScheduleDayOff,
  computeScheduleRangeDays,
  rangeDayCount,
  isoWeekday,
  SCHEDULE_RANGE_MAX_DAYS,
} from '../api/server.mjs';

// Мок client с тем же интерфейсом .query(sql, params), что реальный pg Pool/Client -
// getEffectiveSchedule делает ровно 2 вида запросов (schedule_shifts JOIN
// schedule_breaks, потом master_weekly_schedule), различаем их по тексту SQL.
function makeFakeClient({ shiftsByDate = {}, weeklyByWeekday = {} } = {}) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM schedule_shifts')) {
        const date = params[1];
        return { rows: shiftsByDate[date] ?? [] };
      }
      if (sql.includes('FROM master_weekly_schedule')) {
        const weekday = params[1];
        const row = weeklyByWeekday[weekday];
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

const DATE = '2026-08-10';
const WEEKDAY = isoWeekday(DATE); // реальная функция проекта, не выдумываем число

test('getEffectiveSchedule: разовая правка (schedule_shifts) побеждает недельный график', async () => {
  const client = makeFakeClient({
    shiftsByDate: { [DATE]: [{ start_time: '09:00', end_time: '15:00', b_start: null, b_end: null }] },
    weeklyByWeekday: { [WEEKDAY]: { is_working: true, work_start: '10:00', work_end: '20:00', break_start: null, break_end: null } },
  });
  const eff = await getEffectiveSchedule(client, 'm1', DATE);
  assert.deepEqual(eff, { startTime: '09:00', endTime: '15:00', breaks: [] });
});

test('getEffectiveSchedule: недельный график побеждает глобальный дефолт', async () => {
  const client = makeFakeClient({
    shiftsByDate: {},
    weeklyByWeekday: { [WEEKDAY]: { is_working: true, work_start: '08:00', work_end: '18:00', break_start: '12:00', break_end: '13:00' } },
  });
  const eff = await getEffectiveSchedule(client, 'm1', DATE);
  assert.deepEqual(eff, { startTime: '08:00', endTime: '18:00', breaks: [{ startTime: '12:00', endTime: '13:00' }] });
});

test('getEffectiveSchedule: ни правки, ни недельного графика - глобальный дефолт 10:00-20:00', async () => {
  const client = makeFakeClient({ shiftsByDate: {}, weeklyByWeekday: {} });
  const eff = await getEffectiveSchedule(client, 'm1', DATE);
  assert.deepEqual(eff, { startTime: '10:00', endTime: '20:00', breaks: [] });
});

test('isScheduleDayOff: разовая правка с перерывом на весь рабочий день - выходной', () => {
  const eff = { startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] };
  assert.equal(isScheduleDayOff(eff), true);
});

test('isScheduleDayOff: недельный график is_working=false - выходной', async () => {
  const client = makeFakeClient({
    shiftsByDate: {},
    weeklyByWeekday: { [WEEKDAY]: { is_working: false, work_start: null, work_end: null, break_start: null, break_end: null } },
  });
  const eff = await getEffectiveSchedule(client, 'm1', DATE);
  assert.equal(isScheduleDayOff(eff), true);
});

test('isScheduleDayOff: обеденный перерыв не на весь день - не выходной', async () => {
  const client = makeFakeClient({
    shiftsByDate: {},
    weeklyByWeekday: { [WEEKDAY]: { is_working: true, work_start: '10:00', work_end: '20:00', break_start: '13:00', break_end: '14:00' } },
  });
  const eff = await getEffectiveSchedule(client, 'm1', DATE);
  assert.equal(isScheduleDayOff(eff), false);
});

test('isScheduleDayOff: глобальный дефолт без перерывов - не выходной', () => {
  const eff = { startTime: '10:00', endTime: '20:00', breaks: [] };
  assert.equal(isScheduleDayOff(eff), false);
});

test('computeScheduleRangeDays: 3 дня подряд, три разных источника (правка/график/дефолт), каждый день правильный isDayOff', async () => {
  const d1 = '2026-08-10';
  const d2 = '2026-08-11';
  const d3 = '2026-08-12';
  const wd2 = isoWeekday(d2);
  const client = makeFakeClient({
    shiftsByDate: {
      [d1]: [{ start_time: '10:00', end_time: '20:00', b_start: '10:00', b_end: '20:00' }], // разовый выходной
    },
    weeklyByWeekday: {
      [wd2]: { is_working: true, work_start: '08:00', work_end: '18:00', break_start: null, break_end: null }, // рабочий день
    },
    // d3 - ни правки, ни недельного графика -> глобальный дефолт
  });
  const days = await computeScheduleRangeDays(client, 'm1', d1, d3);
  assert.equal(days.length, 3);
  assert.deepEqual(days.map((d) => d.date), [d1, d2, d3]);
  assert.equal(days[0].isDayOff, true);
  assert.deepEqual(days[0], { date: d1, startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }], isDayOff: true });
  assert.deepEqual(days[1], { date: d2, startTime: '08:00', endTime: '18:00', breaks: [], isDayOff: false });
  assert.deepEqual(days[2], { date: d3, startTime: '10:00', endTime: '20:00', breaks: [], isDayOff: false });
});

test('rangeDayCount: включительный подсчёт дней', () => {
  assert.equal(rangeDayCount('2026-08-10', '2026-08-10'), 1);
  assert.equal(rangeDayCount('2026-08-10', '2026-08-11'), 2);
  assert.equal(rangeDayCount('2026-08-01', '2026-08-31'), 31);
});

test('rangeDayCount: некорректные даты дают NaN, не тихо валидное число', () => {
  assert.ok(Number.isNaN(rangeDayCount('not-a-date', '2026-08-11')));
});

test('SCHEDULE_RANGE_MAX_DAYS соответствует ограничению из промпта (62 дня, ~2 месяца)', () => {
  assert.equal(SCHEDULE_RANGE_MAX_DAYS, 62);
});
