// /schedule, /schedule-range, /holidays(+close), /schedule-availability,
// /masters-next-availability, /master-weekly-schedule - вынесено из server.mjs при
// декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код перенесён без
// изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
// Правка 28.08.2026 (Влад): график работы меняют только владелец и управляющий.
// До неё изменение стояло на BOOKING_OPERATOR_ROLES - туда входит администратор, и
// он мог править смены мастеров своей точки. Чтение осталось прежним: администратор
// график видит, иначе он не сможет работать с записями.
import { canManageStaff } from '../lib/permissions.js';
import { addDaysIso, enumerateDateRange, shopNow, toMinutes } from '../lib/time.js';
// Живое обновление (17.08.2026): изменённый график перерисовывает расписание у всех
import { publish } from '../lib/events.js';
import {
  getEffectiveSchedule,
  findScheduleConflicts,
  rangeDayCount,
  computeScheduleRangeDays,
  SCHEDULE_RANGE_MAX_DAYS,
  listHolidays,
  holidayCloseTargets,
  planHolidayClose,
  applyScheduleDay,
  HOLIDAY_CLOSE_MAX_DAYS,
  computeAvailabilityRangeDays,
  SCHEDULE_AVAILABILITY_MAX_DAYS,
  mastersWithWorkingSchedule,
  computeMasterNextAvailability,
  MASTER_NEXT_AVAILABILITY_WINDOW_DAYS,
  analyzeWeeklyChanges,
  findWeeklyScheduleConflicts,
  writeWeeklySchedule,
  freeSlotsFor,
  isScheduleDayOff,
} from '../lib/schedule-core.js';

export function scheduleExceptionBreaks(type, effective, breakStart, breakEnd) {
  if (!effective?.startTime || !effective?.endTime) return null;
  if (type === 'dayOff') return [{ startTime: effective.startTime, endTime: effective.endTime }];
  if (type !== 'break' || !/^\d{2}:\d{2}$/.test(breakStart ?? '') || !/^\d{2}:\d{2}$/.test(breakEnd ?? '')) return null;
  if (toMinutes(breakStart) >= toMinutes(breakEnd) || toMinutes(breakStart) < toMinutes(effective.startTime) || toMinutes(breakEnd) > toMinutes(effective.endTime)) return null;
  return [{ startTime: breakStart, endTime: breakEnd }];
}

// Атомарное применение разового перерыва или выходного на один день/диапазон.
// Нельзя собирать диапазон циклом на браузере: при конфликте на последней дате
// половина изменений уже сохранилась бы. Здесь сначала проверяются все даты, затем
// одна транзакция либо применяет их все, либо не меняет ничего
export async function handleScheduleExceptions(req, res) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const { masterId, dateFrom, dateTo, type, breakStart, breakEnd } = body;
  if (!masterId || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo ?? '')) return sendJson(res, 400, { error: 'missing_fields' });
  const dates = enumerateDateRange(dateFrom, dateTo);
  if (!dates.length || dates.length > 31) return sendJson(res, 400, { error: 'invalid_range', maxDays: 31 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const changes = [];
    const conflictsByDate = [];
    for (const date of dates) {
      const effective = await getEffectiveSchedule(client, masterId, date);
      const breaks = scheduleExceptionBreaks(type, effective, breakStart, breakEnd);
      if (!breaks) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { error: 'invalid_schedule_exception' });
      }
      const conflicts = await findScheduleConflicts(client, masterId, date, breaks);
      if (conflicts.length) conflictsByDate.push({ date, conflicts });
      changes.push({ date, startTime: effective.startTime, endTime: effective.endTime, breaks });
    }
    if (conflictsByDate.length) {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { error: 'schedule_conflict', conflicts: conflictsByDate });
    }
    for (const change of changes) {
      const shift = await client.query(
        `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, master_id, date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time
         RETURNING id`,
        [masterId, change.date, change.startTime, change.endTime]
      );
      await client.query('DELETE FROM schedule_breaks WHERE shift_id = $1', [shift.rows[0].id]);
      for (const item of change.breaks) {
        await client.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [shift.rows[0].id, item.startTime, item.endTime]);
      }
    }
    await client.query('COMMIT');
    publish('schedule', { reason: 'weekly' });
    return sendJson(res, 200, { ok: true, count: changes.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ── /schedule - смены + перерывы (список интервалов, разд.14.1) ──────
export async function handleSchedule(req, res, url) {
  if (req.method === 'GET') {
    // Баг Влада (02.08.2026): публичный виджет записи (index.html, анонимный,
    // без логина) не знал про реальные перерывы мастера - список "свободное
    // время" предлагал слоты, которые сервер всё равно отклонял при отправке
    // (schedule_blocked, см. createBookingTx). Раньше этот GET требовал auth
    // безусловно - теперь анонимный запрос тоже разрешён, но ТОЛЬКО с явными
    // masterId+date (узкий запрос на один день одного мастера, не дамп всей
    // истории смен всех сотрудников).
    const auth = await authenticate(req);
    const masterId = url.searchParams.get('masterId');
    const date = url.searchParams.get('date');
    if (!auth && (!masterId || !date)) return sendJson(res, 401, { error: 'unauthorized' });
    if (auth?.role === 'master' && masterId && masterId !== auth.id) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const effectiveMasterId = auth?.role === 'master' ? auth.id : masterId;
    let shiftQuery = 'SELECT id, master_id, date, start_time, end_time FROM schedule_shifts WHERE 1=1';
    const params = [];
    if (effectiveMasterId) {
      params.push(effectiveMasterId);
      shiftQuery += ` AND master_id = $${params.length}`;
    }
    // Дата раньше принималась в query, но никогда не участвовала в SQL (только
    // клиентский фильтр в crm-auth.js/app.js) - теперь фильтруем и на сервере,
    // существующие вызыватели передают то же значение и просто получают точный
    // результат вместо всей истории смен этого мастера.
    if (date) {
      params.push(date);
      shiftQuery += ` AND date = $${params.length}`;
    }
    if (auth?.role === 'admin') {
      const staffIds = await pool.query('SELECT id FROM staff WHERE location_id = $1', [auth.locationId]);
      const ids = staffIds.rows.map((r) => r.id);
      params.push(ids.length ? ids : [null]);
      shiftQuery += ` AND master_id = ANY($${params.length})`;
    }
    const shifts = await pool.query(shiftQuery, params);
    const shiftIds = shifts.rows.map((s) => s.id);
    const breaksRes = shiftIds.length
      ? await pool.query('SELECT shift_id, start_time, end_time FROM schedule_breaks WHERE shift_id = ANY($1)', [shiftIds])
      : { rows: [] };
    const breaksByShift = new Map();
    for (const b of breaksRes.rows) {
      if (!breaksByShift.has(b.shift_id)) breaksByShift.set(b.shift_id, []);
      breaksByShift.get(b.shift_id).push({ startTime: b.start_time, endTime: b.end_time });
    }
    const results = shifts.rows.map((s) => ({
      id: s.id,
      masterId: s.master_id,
      date: s.date instanceof Date ? s.date.toISOString().slice(0, 10) : s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      breaks: breaksByShift.get(s.id) ?? [],
    }));
    // Правка 03.08.2026 (Окно 16): конкретный мастер+дата без явной записи на этот
    // день - подмешиваем эффективный график (master_weekly_schedule или глобальный
    // дефолт), тот же getEffectiveSchedule, что реально проверяет createBookingTx.
    // Раньше подмешивали, только если были перерывы - теперь ВСЕГДА, потому что
    // рабочее окно (start/end) само по себе может отличаться от дефолта 10:00-20:00
    // (публичный виджет/getFreeSlots иначе предложили бы слоты вне реальной смены).
    if (effectiveMasterId && date && !results.some((s) => s.date === date)) {
      const eff = await getEffectiveSchedule(pool, effectiveMasterId, date);
      results.push({ id: null, masterId: effectiveMasterId, date, startTime: eff.startTime, endTime: eff.endTime, breaks: eff.breaks });
    }
    return sendJson(res, 200, results);
  }

  if (req.method === 'POST') {
    const auth = await authenticate(req);
    if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    if (!body.masterId || !body.date || !body.startTime || !body.endTime) {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Решение Влада (04.08.2026, Задача 0 промпта Окна 17): раньше правка
      // применялась И уведомляла постфактум - теперь при конфликте с живой бронью
      // ничего не пишется вообще, тот же формат 409, что у PUT /master-weekly-schedule
      // и PATCH /schedule-requests/:id/decision ниже (см. их комментарии).
      const newBreaks = body.breaks ?? [];
      const conflicts = await findScheduleConflicts(client, body.masterId, body.date, newBreaks);
      if (conflicts.length) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { error: 'schedule_conflict', conflicts: [{ date: body.date, conflicts }] });
      }
      const shiftRes = await client.query(
        `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, master_id, date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time
         RETURNING id`,
        [body.masterId, body.date, body.startTime, body.endTime]
      );
      const shiftId = shiftRes.rows[0].id;
      await client.query('DELETE FROM schedule_breaks WHERE shift_id = $1', [shiftId]);
      for (const b of newBreaks) {
        await client.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
          shiftId,
          b.startTime,
          b.endTime,
        ]);
      }
      await client.query('COMMIT');
      publish('schedule', { reason: 'shift' });
      return sendJson(res, 200, { ok: true, id: shiftId, conflicts: 0 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Задача 2 промпта Окна 17 (04.08.2026) - "вернуть день к стандартному графику"
  // после разовой правки (POST выше). Удаляет строку schedule_shifts на эту
  // дату у этого мастера - schedule_breaks уходят каскадом (shift_id REFERENCES
  // schedule_shifts(id) ON DELETE CASCADE, см. api/migrations/002_schema.sql:90),
  // отдельный DELETE по schedule_breaks не нужен. После удаления getEffectiveSchedule
  // на эту дату сам откатывается на недельный график/глобальный дефолт - ничего
  // специально восстанавливать не нужно, это уже гарантия резолвера.
  if (req.method === 'DELETE') {
    const auth = await authenticate(req);
    if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
    const masterId = url.searchParams.get('masterId');
    const date = url.searchParams.get('date');
    if (!masterId || !date) return sendJson(res, 400, { error: 'missing_fields' });
    const result = await pool.query('DELETE FROM schedule_shifts WHERE master_id = $1 AND date = $2 RETURNING id', [
      masterId,
      date,
    ]);
    if (result.rows.length === 0) return sendJson(res, 404, { error: 'shift_not_found' });
    return sendJson(res, 200, { ok: true });
  }
}

// ── /schedule-range - Задача 1 промпта Окна 17 (04.08.2026). Эффективный график
// на каждый день диапазона одним запросом - без него Неделя/Месяц в CRM слали бы
// до 31 отдельного GET /schedule?date=... (тот же принцип экономии запросов, что
// уже применён у GET /bookings?from=&to=, см. listBookingsForRequest выше).
export async function handleScheduleRange(req, res, url) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const masterId = url.searchParams.get('masterId');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!masterId || !from || !to) return sendJson(res, 400, { error: 'missing_fields' });
  // Та же матрица доступа, что у GET /schedule: owner - любой мастер, admin -
  // только своей точки, master - только себя.
  if (auth.role === 'master' && masterId !== auth.id) return sendJson(res, 403, { error: 'forbidden' });
  if (auth.role === 'admin') {
    const staffRes = await pool.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
    if (staffRes.rows.length === 0 || staffRes.rows[0].location_id !== auth.locationId) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
  }
  const dayCount = rangeDayCount(from, to);
  if (!Number.isFinite(dayCount) || dayCount < 1 || dayCount > SCHEDULE_RANGE_MAX_DAYS) {
    return sendJson(res, 400, { error: 'invalid_range', maxDays: SCHEDULE_RANGE_MAX_DAYS });
  }
  const days = await computeScheduleRangeDays(pool, masterId, from, to);
  return sendJson(res, 200, days);
}

// ── /holidays - производственный календарь (Окно 24, 05.08.2026). Анонимный
// GET: тот же уровень доступа, что у /services и узкого /schedule - публичному
// виджету записи (index.html, без логина) он нужен, чтобы подсказать клиенту
// "выбранная дата - праздник", а приватного в списке красных дней страны ничего нет.
export async function handleHolidaysList(req, res, url) {
  const yearParam = url.searchParams.get('year');
  const year = yearParam ? Number(yearParam) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return sendJson(res, 400, { error: 'invalid_year' });
  }
  return sendJson(res, 200, await listHolidays(pool, year));
}

// POST /holidays/close - "закрыть эти даты всем мастерам" одним действием, вместо
// ручного прохода по каждому мастеру и каждому дню в модалке дня. Owner-only: это
// решение по всему салону сразу, у админа точки таких прав нет нигде (ср. PUT
// /payroll-settings). Закрытие дня выполняет ТА ЖЕ applyScheduleDay, что применяет
// одобренный отгул (PATCH /schedule-requests/:id/decision) - отдельной механики
// "выходной по празднику" в базе не заводим, иначе в графике появилось бы два
// разных выходных с разным поведением.
export async function handleHolidaysClose(req, res) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  if (!body.from || !body.to) return sendJson(res, 400, { error: 'missing_fields' });
  if (body.masterIds != null && !Array.isArray(body.masterIds)) {
    return sendJson(res, 400, { error: 'invalid_master_ids' });
  }
  const dayCount = rangeDayCount(body.from, body.to);
  if (!Number.isFinite(dayCount) || dayCount < 1 || dayCount > HOLIDAY_CLOSE_MAX_DAYS) {
    return sendJson(res, 400, { error: 'invalid_range', maxDays: HOLIDAY_CLOSE_MAX_DAYS });
  }
  const dates = enumerateDateRange(body.from, body.to);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // План считается ВНУТРИ той же транзакции, что и применение: иначе между
    // "проверили конфликты" и "записали выходной" клиент успел бы записаться на
    // эту дату через публичный виджет, и бронь оказалась бы внутри выходного.
    const targets = await holidayCloseTargets(client, body.masterIds ?? null);
    const plan = await planHolidayClose(client, targets, dates);
    for (const item of plan.closed) {
      await applyScheduleDay(client, item.masterId, item.date, item.startTime, item.endTime);
    }
    await client.query('COMMIT');
    publish('schedule', { reason: 'holiday' });
    return sendJson(res, 200, { ok: true, ...plan });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── /schedule-availability - Задача 1 промпта Окна 21 (04.08.2026). Реальная
// доступность мастер+услуга по каждой дате диапазона - календарь клиента (Задача 2
// этого же окна) красит недоступные даты серым ДО клика, вместо того чтобы узнавать
// про занятость только после выбора даты (GET /schedule) или вовсе на POST /bookings
// (schedule_blocked). Анонимный доступ - тот же уровень, что у GET /schedule (публичный
// виджет записи, без логина), только с явными masterId+serviceId+узкий диапазон дат.
// Свободные начала визита на конкретный день (01.09.2026, виджет записи).
// Публичный роут: он отдаёт ровно то, что и так видно любому на форме записи -
// когда у врача свободно. Считает сервер, а не страница: иначе каждый новый сайт
// клиента повторял бы сетку слотов у себя.
export async function handleFreeSlots(req, res, url) {
  const masterId = url.searchParams.get('masterId');
  const serviceIds = url.searchParams.getAll('serviceId');
  const date = url.searchParams.get('date');
  if (!masterId || serviceIds.length === 0 || !date) return sendJson(res, 400, { error: 'missing_fields' });

  // Длительность - сумма выбранных услуг ИМЕННО у этого мастера, как и при записи
  const msRes = await pool.query(
    'SELECT service_id, duration_min FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
    [masterId, serviceIds]
  );
  if (msRes.rows.length !== serviceIds.length) return sendJson(res, 400, { error: 'unknown_master_service' });
  const durationMin = msRes.rows.reduce((sum, r) => sum + r.duration_min, 0);

  const schedule = await getEffectiveSchedule(pool, masterId, date);
  if (!schedule || isScheduleDayOff(schedule)) return sendJson(res, 200, { date, durationMin, slots: [] });

  const bookingsRes = await pool.query(
    `SELECT start_time AS "startTime", end_time AS "endTime", status
       FROM bookings WHERE master_id = $1 AND date = $2`,
    [masterId, date]
  );
  const slots = freeSlotsFor(schedule, bookingsRes.rows, durationMin, date);
  return sendJson(res, 200, { date, durationMin, slots });
}

export async function handleScheduleAvailability(req, res, url) {
  const masterId = url.searchParams.get('masterId');
  // Клиент реально может выбрать НЕСКОЛЬКО услуг за визит (Окно 11, ?serviceId=
  // повторяется), не одну - getAll поддерживает и старый одиночный вызов
  // (?serviceId=X), и комбо, той же формой массива, что createBookingTx.
  const serviceIds = url.searchParams.getAll('serviceId');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!masterId || serviceIds.length === 0 || !from || !to) return sendJson(res, 400, { error: 'missing_fields' });

  const dayCount = rangeDayCount(from, to);
  if (!Number.isFinite(dayCount) || dayCount < 1 || dayCount > SCHEDULE_AVAILABILITY_MAX_DAYS) {
    return sendJson(res, 400, { error: 'invalid_range', maxDays: SCHEDULE_AVAILABILITY_MAX_DAYS });
  }

  // Суммарная длительность ВСЕХ выбранных услуг ИМЕННО у этого мастера
  // (master_services, Окно 10 - у Екатерины/Елизаветы другая длительность на
  // части услуг) - тот же запрос и та же гарантия полноты (msRes.rows.length ===
  // serviceIds.length), что реально проверяет createBookingTx при записи.
  const msRes = await pool.query(
    'SELECT service_id, duration_min FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
    [masterId, serviceIds]
  );
  if (msRes.rows.length !== serviceIds.length) return sendJson(res, 400, { error: 'unknown_master_service' });
  const durationMin = msRes.rows.reduce((sum, r) => sum + r.duration_min, 0);

  const days = await computeAvailabilityRangeDays(pool, masterId, durationMin, from, to);
  return sendJson(res, 200, days);
}

// ── /masters-next-availability - Задача 1 промпта Окна 26 (04.08.2026). Батч-ответ
// для ВСЕХ бронируемых мастеров разом (не по одному запросу на мастера) - карточка
// мастера на публичном виджете (Задача 2 этого же окна) показывает бейдж доступности
// ДО того, как клиент вообще выбрал мастера или услугу, поэтому все три карточки
// обновляются одним анонимным запросом при загрузке страницы. Анонимный доступ - тот
// же уровень, что у GET /master-services (ничего чувствительнее даты здесь нет).
// "Бронируемый мастер" = мастер, у которого есть хотя бы одна строка в
// master_services (иначе бронировать у него нечего, отдаём nextAvailableDate: null,
// не 500 и не выдуманную дату).
export async function handleMastersNextAvailability(req, res) {
  const msRes = await pool.query('SELECT master_id, duration_min FROM master_services');
  const minDurationByMaster = new Map();
  for (const r of msRes.rows) {
    const cur = minDurationByMaster.get(r.master_id);
    if (cur === undefined || r.duration_min < cur) minDurationByMaster.set(r.master_id, r.duration_min);
  }

  const { date: from } = shopNow();
  const to = addDaysIso(from, MASTER_NEXT_AVAILABILITY_WINDOW_DAYS);

  // Задача C промпта Окна 29 (05.08.2026) - публичный виджет (app.js/storage.js)
  // раньше не знал, есть ли у мастера вообще стандартный график, поэтому мог
  // предложить клиенту записаться к мастеру, который физически ещё не готов
  // принимать (только что нанят). hasWorkingSchedule здесь - та же проверка, что
  // видит владелец в CRM (Окно 22) и что реально блокирует запись на бэкенде
  // (createBookingTx, master_not_bookable) - одно и то же условие в трёх местах.
  const scheduledIds = await mastersWithWorkingSchedule(pool, [...minDurationByMaster.keys()]);

  const result = [];
  for (const [masterId, durationMin] of minDurationByMaster) {
    const nextAvailableDate = await computeMasterNextAvailability(pool, masterId, durationMin, from, to);
    result.push({ masterId, nextAvailableDate, hasWorkingSchedule: scheduledIds.has(masterId) });
  }
  return sendJson(res, 200, result);
}

// ── /master-weekly-schedule - единый блок "График работы" (Окно 16, 03.08.2026,
// заменяет прежний /schedule-recurring - разд.28/41 промпта). Одна строка на
// каждый день недели (master_weekly_schedule): работает/выходной, рабочее окно,
// опциональный перерыв - весь день описывается сразу, не два разрозненных места.
// Владелец/админ своей точки правят НАПРЯМУЮ (тот же уровень доступа, что у POST
// /schedule для разовых дат) - согласование мастера см. /schedule-requests ниже
// (category=grafik_standard).
export async function handleMasterWeeklySchedule(req, res, url) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const masterId = url.searchParams.get('masterId');
    if (auth.role === 'master' && masterId && masterId !== auth.id) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const effectiveMasterId = auth.role === 'master' ? auth.id : masterId;
    let query = `SELECT master_id, weekday, is_working, work_start, work_end, break_start, break_end
                 FROM master_weekly_schedule WHERE 1=1`;
    const params = [];
    if (effectiveMasterId) {
      params.push(effectiveMasterId);
      query += ` AND master_id = $${params.length}`;
    } else if (auth.role === 'admin') {
      const staffIds = await pool.query('SELECT id FROM staff WHERE location_id = $1', [auth.locationId]);
      params.push(staffIds.rows.map((r) => r.id) || [null]);
      query += ` AND master_id = ANY($${params.length})`;
    }
    query += ' ORDER BY weekday';
    const result = await pool.query(query, params);
    return sendJson(
      res,
      200,
      result.rows.map((r) => ({
        masterId: r.master_id,
        weekday: r.weekday,
        isWorking: r.is_working,
        workStart: r.work_start,
        workEnd: r.work_end,
        breakStart: r.break_start,
        breakEnd: r.break_end,
      }))
    );
  }

  if (req.method === 'PUT') {
    if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const { rows, error: weeklyError } = analyzeWeeklyChanges(body.weeklyChanges);
    if (!body.masterId) return sendJson(res, 400, { error: 'missing_fields' });
    // 17.08.2026 - раньше на любой невалидный график владелец получал общий
    // missing_fields («Заполнены не все обязательные поля»), хотя поля как раз
    // заполнены - неверен порядок времён. Теперь отдаём КОНКРЕТНУЮ причину и день
    // недели (замечание Влада по живому экрану: «в чём здесь конкретно ошибка?»),
    // форма собирает из этого человеческую фразу с часами
    // Код уезжает в поле error - это общий контракт ошибок API (клиент читает его в
    // describeError, assets/crm-toast.js), остальные поля (день недели и сами часы)
    // рядом, чтобы можно было собрать фразу с конкретикой
    if (!rows) return sendJson(res, 400, { error: weeklyError.code, ...weeklyError });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Решение Влада (04.08.2026, Задача 0 промпта Окна 17): конфликт с живой
      // бронью теперь блокирует запись целиком (не "применить и уведомить
      // постфактум", как было в Окне 16) - владелец сначала переносит/отменяет
      // брони, потом повторяет сохранение. notifyStaff здесь больше не нужен -
      // конфликт возвращается синхронно тому, кто сохраняет.
      const conflictsByDate = await findWeeklyScheduleConflicts(client, body.masterId, rows);
      if (conflictsByDate.length) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { error: 'schedule_conflict', conflicts: conflictsByDate });
      }
      await writeWeeklySchedule(client, body.masterId, rows);
      await client.query('COMMIT');
      // Рабочая неделя мастера - это и есть сетка расписания у всех остальных
      publish('schedule', { masterId: body.masterId, reason: 'weekly-saved' });
      return sendJson(res, 200, { ok: true, conflicts: 0 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
