// Окно 54 (10.08.2026, Задача B) - перенос записи, PATCH /bookings/:id/reschedule.
// Контракт под Окно 55: у УЖЕ существующей записи можно менять мастера и дату/время,
// а не только статус и услуги. До этого окна такого эндпоинта не было вообще - услуга
// менялась через PATCH /bookings/:id/services (Окно 51), мастер и время не менялись
// никак, только удалить и создать заново (терялись actual_price, id, история).
//
// ЧТО ПОКРЫТО ЗДЕСЬ: единая проверка доступности слота checkSlotAvailability -
// вынесена из createBookingTx и теперь обслуживает и создание, и перенос. Юниты бьют
// ровно по ней, потому что именно её переиспользование - суть требования ТЗ ("не пиши
// вторую версию с нуля"): если рубежи разъедутся, перенос станет дырой в правилах,
// которые соблюдает создание. Плюс resolveRescheduleDuration - расчёт длительности
// нового слота по услугам брони и прайсу НОВОГО мастера.
//
// ЧТО ПОКРЫТО ЖИВЫМ ПРОГОНОМ, а не здесь: сценарии на уровне транзакции и роута -
// 409 booking_cancelled, гонка двух переносов на один слот (pg_advisory_xact_lock),
// сохранение того же id брони с её booking_services/actual_price, освобождение старого
// слота. Причина та же, что уже зафиксирована в tests/api.master-not-bookable.test.js:
// createBookingTx/rescheduleBookingTx работают на pool.connect(), под fake client их
// не подставить без рефакторинга стабильного кода. Живьём - tools/verify-2026-08-10-okno54.mjs
// на эфемерной локальной базе (QA-фикстуры внутри скрипта, не миграцией - CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlotAvailability, resolveRescheduleDuration } from '../api/server.mjs';

// Дата заведомо в будущем - past_time зависит от реального времени (shopNow), а не от
// фикстуры, поэтому в юнитах на overlap/schedule она не должна мешать.
const FUTURE = '2099-01-05';
const PAST = '2000-01-05';

function makeFakeClient({ workingMasters = ['master-1'], bookings = [], shiftRows = [], weeklyRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      // Порядок веток важен: master_weekly_schedule читают ДВЕ разные функции -
      // mastersWithWorkingSchedule (SELECT DISTINCT master_id) и getEffectiveSchedule
      // (SELECT is_working, work_start...). Сначала более узкая.
      if (sql.includes('DISTINCT master_id')) {
        const ids = params[0].filter((id) => workingMasters.includes(id));
        return { rows: ids.map((master_id) => ({ master_id })) };
      }
      if (sql.includes('FROM schedule_shifts')) return { rows: shiftRows };
      if (sql.includes('FROM master_weekly_schedule')) return { rows: weeklyRow ? [weeklyRow] : [] };
      if (sql.includes('FROM bookings')) return { rows: bookings };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

// ── Свободный слот ───────────────────────────────────────────────────────────

test('Сценарий 1 (единица): свободный слот у работающего мастера - препятствий нет (null)', async () => {
  const client = makeFakeClient({ bookings: [] });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.equal(blocked, null);
});

// ── Сценарий 2: слот занят другой броней ─────────────────────────────────────

test('Сценарий 2: слот занят другой броней - 409 overlap, тот же код, что при создании', async () => {
  const client = makeFakeClient({ bookings: [{ start_time: '12:30', end_time: '13:10' }] });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.deepEqual(blocked, { status: 409, body: { ok: false, reason: 'overlap' } });
});

test('overlap: соседняя бронь встык (кончается ровно когда начинается новая) - НЕ конфликт', async () => {
  const client = makeFakeClient({ bookings: [{ start_time: '11:20', end_time: '12:00' }] });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.equal(blocked, null);
});

// ── Сценарий 4: перенос "без изменений" - запись не конфликтует сама с собой ──

test('Сценарий 4: переносимая запись исключена из проверки пересечений по своему id', async () => {
  const client = makeFakeClient({ bookings: [] });
  await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
    excludeBookingId: 'b-1',
  });
  const overlapCall = client.calls.find((c) => c.sql.includes('FROM bookings'));
  assert.match(overlapCall.sql, /id != \$3/);
  assert.equal(overlapCall.params[2], 'b-1');
});

test('checkSlotAvailability: без excludeBookingId запрос остаётся прежним по смыслу - исключать нечего', async () => {
  // Тот же SQL обслуживает создание брони: $3 = null и условие исключения
  // самонейтрализуется ($3::text IS NULL), отдельной версии запроса нет.
  const client = makeFakeClient({ bookings: [] });
  await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  const overlapCall = client.calls.find((c) => c.sql.includes('FROM bookings'));
  assert.match(overlapCall.sql, /\$3::text IS NULL/);
  assert.equal(overlapCall.params[2], null);
});
// ── Сценарий 3: вне рабочего графика (выходной/отпуск/за рамками смены) ──────

test('Сценарий 3: слот за рамками рабочего окна мастера - 409 schedule_blocked, тот же код, что при создании', async () => {
  // Нет строки в master_weekly_schedule на этот день недели - глобальный дефолт
  // 10:00-20:00 (getEffectiveSchedule), 09:00 в него не попадает.
  const client = makeFakeClient({ bookings: [] });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '09:00', endTime: '09:40', isStaff: true,
  });
  assert.deepEqual(blocked, { status: 409, body: { ok: false, reason: 'schedule_blocked' } });
});

test('Сценарий 3 (выходной): is_working=false на этот день недели - весь день заблокирован', async () => {
  const client = makeFakeClient({ bookings: [], weeklyRow: { is_working: false, work_start: null, work_end: null, break_start: null, break_end: null } });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.deepEqual(blocked, { status: 409, body: { ok: false, reason: 'schedule_blocked' } });
});

test('Сценарий 3 (перерыв): попадание в перерыв смены - тот же schedule_blocked', async () => {
  const client = makeFakeClient({
    bookings: [],
    weeklyRow: { is_working: true, work_start: '10:00', work_end: '20:00', break_start: '13:00', break_end: '14:00' },
  });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '13:30', endTime: '14:10', isStaff: true,
  });
  assert.deepEqual(blocked, { status: 409, body: { ok: false, reason: 'schedule_blocked' } });
});

test('Сценарий 3 (разовая правка дня): schedule_shifts побеждает недельный график - перенос сверяется с фактической сменой', async () => {
  const client = makeFakeClient({
    bookings: [],
    shiftRows: [{ start_time: '15:00', end_time: '18:00', b_start: null, b_end: null }],
    weeklyRow: { is_working: true, work_start: '10:00', work_end: '20:00', break_start: null, break_end: null },
  });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-1', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.deepEqual(blocked, { status: 409, body: { ok: false, reason: 'schedule_blocked' } });
});

// ── Мастер, который ещё не готов принимать записи ────────────────────────────

test('перенос на мастера без единого рабочего дня - 409 master_not_bookable (тот же рубеж, что у создания)', async () => {
  const client = makeFakeClient({ workingMasters: [] });
  const blocked = await checkSlotAvailability(client, {
    masterId: 'master-new', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.deepEqual(blocked, { status: 409, body: { ok: false, reason: 'master_not_bookable' } });
});

test('порядок рубежей сохранён: master_not_bookable проверяется ДО пересечений (ни одного запроса к bookings)', async () => {
  const client = makeFakeClient({ workingMasters: [], bookings: [{ start_time: '12:00', end_time: '13:00' }] });
  await checkSlotAvailability(client, {
    masterId: 'master-new', date: FUTURE, startTime: '12:00', endTime: '12:40', isStaff: true,
  });
  assert.equal(client.calls.some((c) => c.sql.includes('FROM bookings')), false);
});

// ── past_time - тот же смысл, что и при создании ─────────────────────────────

test('прошлое время: сотруднику разрешено (визит задним числом), анонимному запросу - 409 past_time', async () => {
  const staffClient = makeFakeClient({ bookings: [] });
  assert.equal(
    await checkSlotAvailability(staffClient, { masterId: 'master-1', date: PAST, startTime: '12:00', endTime: '12:40', isStaff: true }),
    null
  );
  const publicClient = makeFakeClient({ bookings: [] });
  assert.deepEqual(
    await checkSlotAvailability(publicClient, { masterId: 'master-1', date: PAST, startTime: '12:00', endTime: '12:40', isStaff: false }),
    { status: 409, body: { ok: false, reason: 'past_time' } }
  );
});

// ── resolveRescheduleDuration - длительность нового слота ────────────────────

test('длительность нового слота - сумма услуг брони по прайсу НОВОГО мастера (Окно 10: у Екатерины свои длительности)', () => {
  const result = resolveRescheduleDuration({
    serviceIds: ['strizhka', 'boroda'],
    masterServiceRows: [{ service_id: 'strizhka', duration_min: 45 }, { service_id: 'boroda', duration_min: 25 }],
    currentStartTime: '10:00',
    currentEndTime: '10:30',
  });
  assert.deepEqual(result, { durationMin: 70 });
});

test('новый мастер не оказывает услугу из брони - unknown_master_service, переносить некуда', () => {
  const result = resolveRescheduleDuration({
    serviceIds: ['strizhka', 'boroda'],
    masterServiceRows: [{ service_id: 'strizhka', duration_min: 45 }],
    currentStartTime: '10:00',
    currentEndTime: '10:30',
  });
  assert.deepEqual(result, { error: 'unknown_master_service' });
});

test('бронь без строк в booking_services - сохраняется ПРЕЖНЯЯ длительность, слот не схлопывается в нулевой', () => {
  // Легаси-брони до миграции 013 забэкфилены, но пустой список технически возможен -
  // считать 0 минут значило бы отдать вырожденный слот 12:00-12:00.
  const result = resolveRescheduleDuration({
    serviceIds: [],
    masterServiceRows: [],
    currentStartTime: '10:00',
    currentEndTime: '10:50',
  });
  assert.deepEqual(result, { durationMin: 50 });
});

