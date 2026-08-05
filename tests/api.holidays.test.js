// Окно 24 (05.08.2026) - контракт производственного календаря: таблица holidays,
// GET /holidays, POST /holidays/close. Тот же приём, что в api.schedule-range.test.js -
// in-memory fake client с интерфейсом .query(sql, params), без реального Postgres:
// server.mjs экспортирует чистые функции, сам сервер при импорте не стартует.
//
// Живое применение (applyScheduleDay пишет в schedule_shifts/schedule_breaks) юнитами
// НЕ покрывается сознательно - оно проверяется прогоном против настоящей базы
// (tools/verify-2026-08-05-okno24-prazdniki-api.mjs), потому что смысл там ровно в
// поведении Postgres (ON CONFLICT, FK, каскад), а не в нашей арифметике.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listHolidays,
  planHolidayClose,
  holidayCloseTargets,
  holidayDayOffWindow,
  isScheduleDayOff,
} from '../api/server.mjs';

// Названия/даты те же, что в миграции 034 (перенесены из статики вкладки "Год").
const HOLIDAY_ROWS_2026 = [
  { date: '2026-01-01', name: 'Новогодние каникулы' },
  { date: '2026-01-07', name: 'Рождество Христово' },
  { date: '2026-03-08', name: 'Международный женский день' },
];

function makeFakeClient({
  holidayRows = HOLIDAY_ROWS_2026,
  shiftsByKey = {}, // "masterId|date" → строки schedule_shifts JOIN schedule_breaks
  bookingsByKey = {}, // "masterId|date" → строки bookings
  masters = [{ id: 'master-1' }, { id: 'master-2' }],
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM holidays')) {
        // Роут отдаёт только запрошенный год - фильтр здесь такой же, как в SQL
        // (EXTRACT(YEAR FROM date)). DATE-колонка приходит из pg объектом Date, так
        // что год берём одинаково для обоих представлений.
        const year = params?.[0];
        const yearOf = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 4);
        return { rows: holidayRows.filter((r) => !year || yearOf(r.date) === String(year)) };
      }
      if (sql.includes('FROM staff')) {
        return { rows: masters };
      }
      if (sql.includes('FROM schedule_shifts')) {
        return { rows: shiftsByKey[`${params[0]}|${params[1]}`] ?? [] };
      }
      if (sql.includes('FROM master_weekly_schedule')) {
        return { rows: [] }; // недельного графика нет - глобальный дефолт 10:00-20:00
      }
      if (sql.includes('FROM bookings')) {
        return { rows: bookingsByKey[`${params[0]}|${params[1]}`] ?? [] };
      }
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

// ── GET /holidays ──────────────────────────────────────────────────────────
test('listHolidays: возвращает список года в формате {date,name}, дата - строка', async () => {
  const client = makeFakeClient();
  const rows = await listHolidays(client, 2026);
  assert.deepEqual(rows, HOLIDAY_ROWS_2026);
});

test('listHolidays: DATE-колонка из pg приходит объектом Date - наружу отдаём строку YYYY-MM-DD', async () => {
  const client = makeFakeClient({
    holidayRows: [{ date: new Date('2026-05-09T00:00:00Z'), name: 'День Победы' }],
  });
  const rows = await listHolidays(client, 2026);
  assert.deepEqual(rows, [{ date: '2026-05-09', name: 'День Победы' }]);
});

test('listHolidays: год чужого календаря не подмешивается', async () => {
  const client = makeFakeClient({
    holidayRows: [...HOLIDAY_ROWS_2026, { date: '2027-01-01', name: 'Новогодние каникулы' }],
  });
  const rows = await listHolidays(client, 2026);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.date.startsWith('2026-')));
});

// ── POST /holidays/close: кого закрываем ───────────────────────────────────
test('holidayCloseTargets: без явного списка мастеров - все, кто оказывает услуги', async () => {
  const client = makeFakeClient({ masters: [{ id: 'master-1' }, { id: 'master-2' }, { id: 'master-3' }] });
  const ids = await holidayCloseTargets(client, undefined);
  assert.deepEqual(ids, ['master-1', 'master-2', 'master-3']);
});

test('holidayCloseTargets: явный список мастеров сужает выборку до него', async () => {
  const client = makeFakeClient({ masters: [{ id: 'master-1' }, { id: 'master-2' }, { id: 'master-3' }] });
  const ids = await holidayCloseTargets(client, ['master-2']);
  assert.deepEqual(ids, ['master-2']);
});

test('holidayCloseTargets: несуществующий мастер в списке отсеивается, а не роняет запрос', async () => {
  const client = makeFakeClient({ masters: [{ id: 'master-1' }, { id: 'master-2' }] });
  const ids = await holidayCloseTargets(client, ['master-2', 'нет-такого']);
  assert.deepEqual(ids, ['master-2']);
});

// ── POST /holidays/close: план закрытия ────────────────────────────────────
const JAN = ['2026-01-01', '2026-01-02', '2026-01-03'];

test('planHolidayClose: 1-3 января всем мастерам - закрываются все даты каждому', async () => {
  const client = makeFakeClient();
  const plan = await planHolidayClose(client, ['master-1', 'master-2'], JAN);
  assert.equal(plan.closed.length, 6);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.conflicts, []);
  for (const masterId of ['master-1', 'master-2']) {
    for (const date of JAN) {
      assert.ok(
        plan.closed.some((c) => c.masterId === masterId && c.date === date),
        `нет пары ${masterId}/${date} в плане закрытия`
      );
    }
  }
});

test('planHolidayClose: дата, где мастер УЖЕ выходной, пропускается - второй перерыв поверх не кладём', async () => {
  const client = makeFakeClient({
    shiftsByKey: {
      'master-1|2026-01-02': [{ start_time: '10:00', end_time: '20:00', b_start: '10:00', b_end: '20:00' }],
    },
  });
  const plan = await planHolidayClose(client, ['master-1'], JAN);
  assert.equal(plan.closed.length, 2);
  assert.deepEqual(plan.skipped, [{ masterId: 'master-1', date: '2026-01-02', reason: 'already_day_off' }]);
});

test('planHolidayClose: живая бронь на дате - дата НЕ закрывается, попадает в conflicts', async () => {
  const client = makeFakeClient({
    bookingsByKey: {
      'master-1|2026-01-03': [
        { start_time: '12:00', end_time: '13:00', client_name: 'Иван', client_phone: '+79990000000' },
      ],
    },
  });
  const plan = await planHolidayClose(client, ['master-1'], JAN);
  assert.equal(plan.closed.length, 2);
  assert.ok(plan.closed.every((c) => c.date !== '2026-01-03'));
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].masterId, 'master-1');
  assert.equal(plan.conflicts[0].date, '2026-01-03');
  assert.equal(plan.conflicts[0].conflicts[0].client_name, 'Иван');
});

test('planHolidayClose: конфликт у одного мастера не мешает закрыть ту же дату другому', async () => {
  const client = makeFakeClient({
    bookingsByKey: {
      'master-1|2026-01-01': [{ start_time: '11:00', end_time: '12:00', client_name: 'Пётр', client_phone: '+79990000001' }],
    },
  });
  const plan = await planHolidayClose(client, ['master-1', 'master-2'], JAN);
  assert.equal(plan.conflicts.length, 1);
  assert.ok(
    plan.closed.some((c) => c.masterId === 'master-2' && c.date === '2026-01-01'),
    'второму мастеру 1 января обязано закрыться - чужая бронь его не касается'
  );
});

test('planHolidayClose: отменённая бронь конфликтом не считается', async () => {
  const client = makeFakeClient({
    bookingsByKey: {
      // Запрос к bookings в findScheduleConflicts сам отсекает status != cancelled,
      // fake-клиент отдаёт уже отфильтрованное - здесь пустой список ровно поэтому.
      'master-1|2026-01-03': [],
    },
  });
  const plan = await planHolidayClose(client, ['master-1'], JAN);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.closed.length, 3);
});

test('planHolidayClose: пустой список мастеров - пустой план, не падение', async () => {
  const client = makeFakeClient();
  const plan = await planHolidayClose(client, [], JAN);
  assert.deepEqual(plan, { closed: [], skipped: [], conflicts: [] });
});

// ── Границы перерыва, которым закрывается день ─────────────────────────────
// applyScheduleDay при ОТСУТСТВИИ строки в schedule_shifts создаёт смену жёстко
// 10:00-20:00, а при наличии - оставляет уже сохранённое окно нетронутым (ON CONFLICT
// DO UPDATE SET master_id). Значит фиксированный перерыв 10:00-20:00 закрыл бы день
// не всегда: смену 09:00-18:00 он не покрывает слева, и isScheduleDayOff вернул бы
// false - день остался бы "рабочим с длинным перерывом". Окно перерыва обязано
// накрывать И эффективный график мастера, И то окно, которое может создать сама
// applyScheduleDay.
test('holidayDayOffWindow: обычный день по глобальному дефолту - ровно 10:00-20:00', () => {
  assert.deepEqual(holidayDayOffWindow({ startTime: '10:00', endTime: '20:00', breaks: [] }), {
    startTime: '10:00',
    endTime: '20:00',
  });
});

test('holidayDayOffWindow: ранняя смена 09:00-18:00 - перерыв расширяется влево до 09:00 и вправо до 20:00', () => {
  const win = holidayDayOffWindow({ startTime: '09:00', endTime: '18:00', breaks: [] });
  assert.deepEqual(win, { startTime: '09:00', endTime: '20:00' });
  // Ключевой ассерт: именно этот перерыв делает день выходным по правилу проекта.
  assert.equal(isScheduleDayOff({ startTime: '09:00', endTime: '18:00', breaks: [win] }), true);
});

test('holidayDayOffWindow: длинная смена 08:00-22:00 - перерыв покрывает её целиком', () => {
  const win = holidayDayOffWindow({ startTime: '08:00', endTime: '22:00', breaks: [] });
  assert.deepEqual(win, { startTime: '08:00', endTime: '22:00' });
  assert.equal(isScheduleDayOff({ startTime: '08:00', endTime: '22:00', breaks: [win] }), true);
});

test('planHolidayClose: у мастера с ранней сменой день реально закрывается (окно перерыва по его графику)', async () => {
  const client = makeFakeClient({
    shiftsByKey: {
      'master-1|2026-01-01': [{ start_time: '09:00', end_time: '18:00', b_start: null, b_end: null }],
    },
  });
  const plan = await planHolidayClose(client, ['master-1'], ['2026-01-01']);
  assert.deepEqual(plan.closed, [
    { masterId: 'master-1', date: '2026-01-01', startTime: '09:00', endTime: '20:00' },
  ]);
});
