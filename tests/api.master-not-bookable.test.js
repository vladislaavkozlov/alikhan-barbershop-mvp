// Задача C промпта Окна 29 (05.08.2026) - юниты на mastersWithWorkingSchedule
// (единый источник истины для GET /staff, GET /masters-next-availability и
// createBookingTx/master_not_bookable). In-memory fake client, тот же приём, что
// уже применён в tests/api.schedule-availability.test.js для computeAvailabilityRangeDays -
// createBookingTx не рефакторится под injectable client (риск задеть стабильный код,
// см. CLAUDE.md проекта "Surgical Changes"), поэтому реальное поведение POST /bookings
// (409 master_not_bookable / штатный проход) проверяется живым curl на локальной базе,
// не здесь - см. reference_barbershop-crm-tech.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mastersWithWorkingSchedule } from '../api/server.mjs';

function makeFakeClient(rowsByMasterId) {
  return {
    async query(sql, params) {
      assert.match(sql, /FROM master_weekly_schedule/);
      const [masterIds] = params;
      const matched = masterIds.filter((id) => rowsByMasterId.has(id));
      return { rows: matched.map((id) => ({ master_id: id })) };
    },
  };
}

// ── Сценарий 1 промпта: мастер без единой is_working=true строки → не в Set ──

test('mastersWithWorkingSchedule: мастер без единого рабочего дня - отсутствует в результате', async () => {
  const client = makeFakeClient(new Set()); // ни у одного мастера нет строк
  const result = await mastersWithWorkingSchedule(client, ['master-no-schedule']);
  assert.equal(result.has('master-no-schedule'), false);
});

// ── Сценарий 2 промпта: мастер с хотя бы одним рабочим днём → штатно в Set ───

test('mastersWithWorkingSchedule: мастер с хотя бы одним рабочим днём - присутствует в результате', async () => {
  const client = makeFakeClient(new Set(['master-with-schedule']));
  const result = await mastersWithWorkingSchedule(client, ['master-with-schedule']);
  assert.equal(result.has('master-with-schedule'), true);
});

test('mastersWithWorkingSchedule: батч из нескольких мастеров - каждый оценивается независимо', async () => {
  const client = makeFakeClient(new Set(['master-a']));
  const result = await mastersWithWorkingSchedule(client, ['master-a', 'master-b']);
  assert.equal(result.has('master-a'), true);
  assert.equal(result.has('master-b'), false);
});

test('mastersWithWorkingSchedule: пустой список id - не бьёт в базу, отдаёт пустой Set', async () => {
  let called = false;
  const client = { async query() { called = true; return { rows: [] }; } };
  const result = await mastersWithWorkingSchedule(client, []);
  assert.equal(called, false);
  assert.equal(result.size, 0);
});
