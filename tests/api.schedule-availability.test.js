// Окно 21 (04.08.2026, Задача 1 промпта) - юниты на GET /schedule-availability:
// hasAvailableSlot (чистая функция, прямой анализ интервалов) + computeAvailabilityRangeDays
// (цикл по дням диапазона поверх getEffectiveSchedule + брони, тот же паттерн, что уже
// применён в tests/api.schedule-range.test.js). In-memory, без реального Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAvailableSlot, computeAvailabilityRangeDays, isoWeekday } from '../api/server.mjs';

// ── hasAvailableSlot: сценарии 1-5 промпта ─────────────────────────────────

test('hasAvailableSlot: мастер выходной весь день -> hasSlots false', () => {
  const schedule = { startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] };
  assert.equal(hasAvailableSlot(schedule, [], 60), false);
});

test('hasAvailableSlot: обычный рабочий день, броней нет -> hasSlots true', () => {
  const schedule = { startTime: '10:00', endTime: '20:00', breaks: [] };
  assert.equal(hasAvailableSlot(schedule, [], 60), true);
});

test('hasAvailableSlot: день полностью занят бронями -> hasSlots false', () => {
  const schedule = { startTime: '10:00', endTime: '20:00', breaks: [] };
  const bookings = [{ startTime: '10:00', endTime: '20:00', status: 'confirmed' }];
  assert.equal(hasAvailableSlot(schedule, bookings, 60), false);
});

test('hasAvailableSlot: день частично занят, остаток окна короче услуги -> hasSlots false', () => {
  // окно 10:00-20:00, свободно только 19:30-20:00 (30 минут) - услуга 60 минут не влезает
  const schedule = { startTime: '10:00', endTime: '20:00', breaks: [] };
  const bookings = [{ startTime: '10:00', endTime: '19:30', status: 'confirmed' }];
  assert.equal(hasAvailableSlot(schedule, bookings, 60), false);
});

test('hasAvailableSlot: день частично занят, остаток окна длиннее услуги -> hasSlots true', () => {
  // окно 10:00-20:00, свободно 18:00-20:00 (2 часа) - услуга 60 минут влезает
  const schedule = { startTime: '10:00', endTime: '20:00', breaks: [] };
  const bookings = [{ startTime: '10:00', endTime: '18:00', status: 'confirmed' }];
  assert.equal(hasAvailableSlot(schedule, bookings, 60), true);
});

test('hasAvailableSlot: отменённая бронь не считается занятостью (та же логика, что у createBookingTx/getFreeSlots)', () => {
  const schedule = { startTime: '10:00', endTime: '20:00', breaks: [] };
  const bookings = [{ startTime: '10:00', endTime: '20:00', status: 'cancelled' }];
  assert.equal(hasAvailableSlot(schedule, bookings, 60), true);
});

// ── computeAvailabilityRangeDays: сценарий 6 промпта (фолбэк без графика) + интеграция ──

function makeFakeClient({ shiftsByDate = {}, weeklyByWeekday = {}, bookingsRows = [] } = {}) {
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
      if (sql.includes('FROM bookings')) {
        return { rows: bookingsRows };
      }
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

const DATE = '2026-08-10';

test('computeAvailabilityRangeDays: мастер без единой строки в master_weekly_schedule -> фолбэк 10:00-20:00, hasSlots true на все дни', async () => {
  const client = makeFakeClient({ shiftsByDate: {}, weeklyByWeekday: {}, bookingsRows: [] });
  const days = await computeAvailabilityRangeDays(client, 'm1', 60, DATE, DATE);
  assert.deepEqual(days, [{ date: DATE, hasSlots: true }]);
});

test('computeAvailabilityRangeDays: 3 дня диапазона, брони одним запросом группируются по дате', async () => {
  const d1 = '2026-08-10';
  const d2 = '2026-08-11';
  const d3 = '2026-08-12';
  const wd = isoWeekday(d2);
  const client = makeFakeClient({
    shiftsByDate: {},
    weeklyByWeekday: { [wd]: { is_working: true, work_start: '10:00', work_end: '20:00', break_start: null, break_end: null } },
    bookingsRows: [
      { date: d1, startTime: '10:00', endTime: '20:00', status: 'confirmed' }, // d1 полностью занят
      { date: d2, startTime: '10:00', endTime: '11:00', status: 'confirmed' }, // d2 - только начало занято
    ],
  });
  const days = await computeAvailabilityRangeDays(client, 'm1', 60, d1, d3);
  assert.deepEqual(days, [
    { date: d1, hasSlots: false },
    { date: d2, hasSlots: true },
    { date: d3, hasSlots: true },
  ]);
});
