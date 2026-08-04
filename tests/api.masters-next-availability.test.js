// Окно 26 (04.08.2026, Задача 1 промпта) - юниты на computeMasterNextAvailability:
// первая доступная дата в окне [from; to] для мастера (минимальная длительность
// среди его услуг), либо null если весь диапазон занят. Переиспользует
// hasAvailableSlot/getEffectiveSchedule (Окно 21/16), не пишет доступность заново -
// тот же паттерн in-memory fake client, что уже применён в tests/api.schedule-availability.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMasterNextAvailability, isoWeekday } from '../api/server.mjs';

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

const D1 = '2026-08-10';
const D2 = '2026-08-11';
const D3 = '2026-08-12';

test('computeMasterNextAvailability: мастер без графика (фолбэк 10:00-20:00), первый день диапазона свободен -> возвращает первый день', async () => {
  const client = makeFakeClient();
  const date = await computeMasterNextAvailability(client, 'm1', 60, D1, D3);
  assert.equal(date, D1);
});

test('computeMasterNextAvailability: первый день полностью занят бронями, второй свободен -> возвращает второй день', async () => {
  const client = makeFakeClient({
    bookingsRows: [{ date: D1, startTime: '10:00', endTime: '20:00', status: 'confirmed' }],
  });
  const date = await computeMasterNextAvailability(client, 'm1', 60, D1, D3);
  assert.equal(date, D2);
});

test('computeMasterNextAvailability: весь диапазон занят/выходной -> null (недоступен в этом окне)', async () => {
  const wd1 = isoWeekday(D1);
  const wd2 = isoWeekday(D2);
  const wd3 = isoWeekday(D3);
  const dayOff = { is_working: false, work_start: null, work_end: null, break_start: null, break_end: null };
  const client = makeFakeClient({
    weeklyByWeekday: { [wd1]: dayOff, [wd2]: dayOff, [wd3]: dayOff },
  });
  const date = await computeMasterNextAvailability(client, 'm1', 60, D1, D3);
  assert.equal(date, null);
});

test('computeMasterNextAvailability: разовая правка (schedule_shifts) открывает день, который по недельному графику выходной', async () => {
  const wd1 = isoWeekday(D1);
  const dayOff = { is_working: false, work_start: null, work_end: null, break_start: null, break_end: null };
  const client = makeFakeClient({
    weeklyByWeekday: { [wd1]: dayOff }, // D1 - выходной по стандартному недельному графику...
    shiftsByDate: { [D1]: [{ start_time: '10:00', end_time: '20:00', b_start: null, b_end: null }] }, // ...но разово открыт
  });
  const date = await computeMasterNextAvailability(client, 'm1', 60, D1, D1);
  assert.equal(date, D1);
});

test('computeMasterNextAvailability: минимальная длительность короче остатка окна -> доступен, даже если бы длинная услуга не влезла', async () => {
  // окно 10:00-20:00, свободно только 19:30-20:00 (30 минут) - услуга 60 минут не влезла бы,
  // но если у мастера есть услуга 20 минут (минимальная), он всё равно "доступен" этот день.
  const client = makeFakeClient({
    bookingsRows: [{ date: D1, startTime: '10:00', endTime: '19:30', status: 'confirmed' }],
  });
  const date = await computeMasterNextAvailability(client, 'm1', 20, D1, D1);
  assert.equal(date, D1);
});

test('computeMasterNextAvailability: отменённая бронь не считается занятостью', async () => {
  const client = makeFakeClient({
    bookingsRows: [{ date: D1, startTime: '10:00', endTime: '20:00', status: 'cancelled' }],
  });
  const date = await computeMasterNextAvailability(client, 'm1', 60, D1, D1);
  assert.equal(date, D1);
});
