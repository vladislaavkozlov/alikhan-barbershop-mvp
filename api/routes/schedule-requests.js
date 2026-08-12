// POST/GET /schedule-requests, PATCH /schedule-requests/:id/decision,
// PATCH /schedule-requests/:id/cancel - вынесено из server.mjs при декомпозиции
// (Этап 2 структурного рефакторинга, 07.08.2026), код перенесён без изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { canManageStaff } from '../lib/permissions.js';
import { enumerateDateRange, dateColToStr, shopNow } from '../lib/time.js';
import {
  validateWeeklyChanges,
  formatWeeklyChangesSummary,
  findWeeklyScheduleConflicts,
  dayOffWindowsForRequest,
  findScheduleConflicts,
  applyScheduleDay,
  writeWeeklySchedule,
} from '../lib/schedule-core.js';
import { notifyStaff } from '../lib/notify-core.js';

// ── /schedule-requests - согласование графика (Задача 3, Окно 14, 02.08.2026).
// Мастер запрашивает перерыв/выходной → владелец получает уведомление →
// одобряет/отклоняет → только при одобрении время реально блокируется
// (applyScheduleDay + проверка в createBookingTx выше).
export async function handleScheduleRequests(req, res, url) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });

  if (req.method === 'POST') {
    if (!requireRole(auth, ['master'])) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    // Правка 03.08.2026 (Окно 16): 3 категории - otgul/otpusk остаются как были
    // (разовая дата/диапазон, механика не менялась), grafik_standard заменяет
    // прежние pereryv_standard/vyhodnoy_standard - теперь это ВЕСЬ недельный
    // график целиком (weeklyChanges, тот же формат, что PUT /master-weekly-schedule
    // у владельца), не отдельное правило на перерыв или на выходной.
    const category = body.category;
    // Задача 3 промпта Окна 17 (04.08.2026) - решение: 'grafik_standard' ОСТАЁТСЯ
    // в списке валидных категорий, хотя фронтенд мастера (Окно 19) больше никогда
    // её не отправит (его форма графика становится read-only просмотром, владелец
    // правит напрямую через PUT /master-weekly-schedule выше). Вариант "убрать из
    // списка и отвечать 400" отклонён - он ничего не выигрывает (фронт и так её не
    // шлёт) и требует решения по уже существующим записям в БД с этой категорией
    // (см. "хвосты" тестовых заявок id 1/3/4 на master-3, задача 4 промпта), которое
    // никто не просил принимать. Держать поле валидным - нулевой риск.
    const validCategories = ['otgul', 'otpusk', 'grafik_standard'];
    if (!validCategories.includes(category)) return sendJson(res, 400, { error: 'invalid_category' });

    if (category === 'grafik_standard') {
      const rows = validateWeeklyChanges(body.weeklyChanges);
      if (!rows) return sendJson(res, 400, { error: 'invalid_weekly_changes' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reqRes = await client.query(
          `INSERT INTO schedule_change_requests (master_id, request_type, category, date_from, date_to, weekly_changes, master_comment)
           VALUES ($1, 'weekly_schedule', 'grafik_standard', $2, NULL, $3, $4) RETURNING id`,
          [auth.id, shopNow().date, JSON.stringify(rows), body.masterComment ?? null]
        );
        const requestId = reqRes.rows[0].id;
        const masterName = (await client.query('SELECT name FROM staff WHERE id = $1', [auth.id])).rows[0]?.name ?? 'Мастер';
        const owners = await client.query(`SELECT id FROM staff WHERE role = 'owner'`);
        for (const owner of owners.rows) {
          await notifyStaff(client, owner.id, 'schedule_request_new', {
            scheduleRequestId: requestId,
            title: 'Запрос на график',
            body: `${masterName} · новый график работы · ${formatWeeklyChangesSummary(rows)}`,
          });
        }
        await client.query('COMMIT');
        return sendJson(res, 200, { ok: true, id: requestId });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    const requestType = body.requestType;
    if (!['break', 'day_off'].includes(requestType)) return sendJson(res, 400, { error: 'invalid_request_type' });
    if (!body.dateFrom) return sendJson(res, 400, { error: 'missing_fields' });
    if (requestType === 'break' && (!body.startTime || !body.endTime)) {
      return sendJson(res, 400, { error: 'missing_time' });
    }
    const dateTo = body.dateTo || body.dateFrom;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reqRes = await client.query(
        `INSERT INTO schedule_change_requests (master_id, request_type, category, date_from, date_to, start_time, end_time, master_comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [auth.id, requestType, category, body.dateFrom, dateTo, body.startTime ?? null, body.endTime ?? null, body.masterComment ?? null]
      );
      const requestId = reqRes.rows[0].id;
      const masterName = (await client.query('SELECT name FROM staff WHERE id = $1', [auth.id])).rows[0]?.name ?? 'Мастер';
      const owners = await client.query(`SELECT id FROM staff WHERE role = 'owner'`);
      const categoryLabel = { otgul: 'отгул', otpusk: 'отпуск' }[category];
      const period = requestType === 'day_off' ? `${body.dateFrom}–${dateTo}` : `${body.dateFrom} ${body.startTime}–${body.endTime}`;
      for (const owner of owners.rows) {
        await notifyStaff(client, owner.id, 'schedule_request_new', {
          scheduleRequestId: requestId,
          title: 'Запрос на график',
          body: `${masterName} · ${categoryLabel} · ${period}`,
        });
      }
      await client.query('COMMIT');
      return sendJson(res, 200, { ok: true, id: requestId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  if (req.method === 'GET') {
    const masterId = url.searchParams.get('masterId');
    const status = url.searchParams.get('status');
    let query = `SELECT id, master_id, request_type, category, date_from, date_to, start_time, end_time,
                         weekly_changes, master_comment, status, owner_comment, decided_by, decided_at
                  FROM schedule_change_requests WHERE 1=1`;
    const params = [];
    if (auth.role === 'master') {
      params.push(auth.id);
      query += ` AND master_id = $${params.length}`;
    } else if (auth.role === 'admin') {
      params.push(auth.locationId);
      query += ` AND master_id IN (SELECT id FROM staff WHERE location_id = $${params.length})`;
    } else if (masterId) {
      params.push(masterId);
      query += ` AND master_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    return sendJson(
      res,
      200,
      result.rows.map((r) => ({
        id: r.id,
        masterId: r.master_id,
        requestType: r.request_type,
        category: r.category,
        dateFrom: r.date_from instanceof Date ? r.date_from.toISOString().slice(0, 10) : r.date_from,
        dateTo: r.date_to instanceof Date ? r.date_to.toISOString().slice(0, 10) : r.date_to,
        startTime: r.start_time,
        endTime: r.end_time,
        weeklyChanges: r.weekly_changes,
        masterComment: r.master_comment,
        status: r.status,
        ownerComment: r.owner_comment,
        decidedBy: r.decided_by,
        decidedAt: r.decided_at,
      }))
    );
  }
}

// ── /schedule-requests/:id/decision - owner-only (Задача 3, Окно 14). Admin -
// только просмотр списка выше, решает исключительно владелец (см. Ограничения
// промпта - Мамедхан approve/reject не получает).
export async function handleScheduleRequestDecision(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const requestId = Number(parts[1]);
  const body = await readBody(req);
  if (!['approved', 'rejected'].includes(body.decision)) return sendJson(res, 400, { error: 'invalid_decision' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query('SELECT * FROM schedule_change_requests WHERE id = $1 FOR UPDATE', [requestId]);
    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { error: 'request_not_found' });
    }
    const reqRow = reqRes.rows[0];
    if (reqRow.status !== 'pending') {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { error: 'already_decided' });
    }

    // Решение Влада (04.08.2026, Задача 0 промпта Окна 17): при одобрении сначала
    // СЧИТАЕМ конфликты с живыми бронями, ничего не пишем и не меняем статус
    // заявки, пока не убедились, что конфликтов нет. Раньше (Окно 16) правка
    // применялась И уведомляла постфактум - теперь конфликт блокирует одобрение
    // целиком, заявка остаётся pending, владелец сначала переносит/отменяет
    // брони и заново нажимает "одобрить" (applyScheduleDay/writeWeeklySchedule
    // ниже вызываются только когда conflictsByDate пуст).
    const isWeeklySchedule = reqRow.category === 'grafik_standard';
    let weeklyRows, dayOffDates, dayOffWindows;
    const conflictsByDate = [];

    if (body.decision === 'approved') {
      if (isWeeklySchedule) {
        // Окно 16 (03.08.2026) - весь недельный график заменяется целиком, той же
        // функцией, что и прямое сохранение владельцем (PUT /master-weekly-schedule) -
        // одобрение запроса мастера и прямая правка владельца пишут в одно и то же
        // место (master_weekly_schedule), это и есть единственный источник истины.
        weeklyRows = reqRow.weekly_changes;
        conflictsByDate.push(...(await findWeeklyScheduleConflicts(client, reqRow.master_id, weeklyRows)));
      } else {
        // Влад (03.08.2026) - подтверждение выходного/перерыва реально блокирует
        // время (applyScheduleDay), но раньше молча накладывалось поверх уже
        // существующих записей клиентов. Собираем конфликты по КАЖДОМУ дню
        // диапазона (day_off может растянуться на несколько дней = по сути отпуск)
        // ДО применения - applyScheduleDay ниже вызывается вторым проходом по тем
        // же датам, только если весь диапазон чист.
        //
        // Фикс 05.08.2026: границы выходного берутся из dayOffWindowsForRequest (по
        // реальному графику мастера на каждую дату), а не из литералов '10:00'/'20:00' -
        // на смене 09:00-18:00 такой перерыв не накрывал день, и одобренный отгул
        // оставался доступен для записи (баг воспроизведён живьём, см. комментарий
        // к fullDayOffWindow выше).
        dayOffDates = enumerateDateRange(dateColToStr(reqRow.date_from), dateColToStr(reqRow.date_to));
        dayOffWindows = await dayOffWindowsForRequest(
          client,
          reqRow.master_id,
          dayOffDates,
          reqRow.request_type,
          reqRow.start_time,
          reqRow.end_time
        );
        for (const dateStr of dayOffDates) {
          const conflicts = await findScheduleConflicts(client, reqRow.master_id, dateStr, [
            dayOffWindows.get(dateStr),
          ]);
          if (conflicts.length) conflictsByDate.push({ date: dateStr, conflicts });
        }
      }
      if (conflictsByDate.length) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { error: 'schedule_conflict', conflicts: conflictsByDate });
      }
    }

    await client.query(
      `UPDATE schedule_change_requests SET status = $1, owner_comment = $2, decided_by = $3, decided_at = now() WHERE id = $4`,
      [body.decision, body.ownerComment ?? null, auth.id, requestId]
    );
    if (body.decision === 'approved') {
      if (isWeeklySchedule) {
        await writeWeeklySchedule(client, reqRow.master_id, weeklyRows);
      } else {
        for (const dateStr of dayOffDates) {
          const window = dayOffWindows.get(dateStr);
          await applyScheduleDay(client, reqRow.master_id, dateStr, window.startTime, window.endTime);
        }
      }
    }
    const decidedBodyFallback =
      reqRow.request_type === 'weekly_schedule' ? 'Новый график работы' : reqRow.request_type === 'day_off' ? 'Выходной' : 'Перерыв';
    await notifyStaff(client, reqRow.master_id, 'schedule_request_decided', {
      scheduleRequestId: requestId,
      title: body.decision === 'approved' ? 'Запрос одобрен' : 'Запрос отклонён',
      body: body.ownerComment || decidedBodyFallback,
    });
    await client.query('COMMIT');
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── /schedule-requests/:id/cancel - owner-only (Окно 23, 04.08.2026). Отменяет
// УЖЕ ОДОБРЕННУЮ заявку на отгул/отпуск целиком: снимает блокировку со ВСЕХ дат
// диапазона одним действием и переводит саму заявку в 'cancelled'. До этого окна
// владелец мог только точечно сбросить одну дату (DELETE /schedule?masterId=&date=,
// кнопка "Сбросить к стандартному") - на трёхдневном отпуске это три отдельных
// действия, а статус заявки всё равно оставался "approved" и врал в истории.
//
// Откат каждой даты - ровно та же операция, что у DELETE /schedule: удаляем строку
// schedule_shifts, schedule_breaks уходят каскадом (002_schema.sql:90), и
// getEffectiveSchedule сам возвращается на недельный график/глобальный дефолт.
// Следствие, осознанное (то же, что у кнопки "Сбросить к стандартному"): если на
// дату из диапазона у мастера была ЕЩЁ и разовая правка владельца (свои часы на
// этот день), она удалится вместе с отгулом - отдельного слоя "чей это shift" в
// схеме нет, и заводить его в рамках этого окна никто не просил.
export async function handleScheduleRequestCancel(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const requestId = Number(parts[1]);
  if (!Number.isInteger(requestId)) return sendJson(res, 400, { error: 'invalid_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query('SELECT * FROM schedule_change_requests WHERE id = $1 FOR UPDATE', [requestId]);
    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { error: 'request_not_found' });
    }
    const reqRow = reqRes.rows[0];
    // Отменить можно только то, что реально действует. pending нечего снимать
    // (время не блокировалось), rejected/cancelled - уже терминальные.
    if (reqRow.status !== 'approved') {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { error: 'not_approved', status: reqRow.status });
    }
    // Одобренный ПОСТОЯННЫЙ график (category=grafik_standard) отменить нечем:
    // writeWeeklySchedule заменяет master_weekly_schedule целиком, прежний график
    // нигде не сохраняется, а date_to у таких заявок вообще NULL. Честный 409
    // вместо тихого "cancelled" на заявке, эффект которой на деле остался в силе.
    if (reqRow.category === 'grafik_standard' || reqRow.request_type === 'weekly_schedule') {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { error: 'cannot_cancel_weekly' });
    }

    const dates = enumerateDateRange(dateColToStr(reqRow.date_from), dateColToStr(reqRow.date_to));
    for (const dateStr of dates) {
      await client.query('DELETE FROM schedule_shifts WHERE master_id = $1 AND date = $2', [reqRow.master_id, dateStr]);
    }
    await client.query(`UPDATE schedule_change_requests SET status = 'cancelled' WHERE id = $1`, [requestId]);

    // Мастер уже считает эти дни своими выходными - молча забрать одобренный
    // отгул нельзя. Тип ОТДЕЛЬНЫЙ ('schedule_request_cancelled', миграция 033), не
    // 'schedule_request_decided': дедуп-индекс notifications_schedreq_dedup
    // (staff_id, type, schedule_request_id, миграция 015) на этой же заявке уже
    // держит уведомление об одобрении, и повторная вставка того же типа гаснет в
    // ON CONFLICT DO NOTHING - найдено живым прогоном 04.08.2026, мастер не узнавал
    // об отмене вообще.
    const categoryLabel = { otgul: 'отгул', otpusk: 'отпуск' }[reqRow.category] ?? 'изменение графика';
    await notifyStaff(client, reqRow.master_id, 'schedule_request_cancelled', {
      scheduleRequestId: requestId,
      title: 'Одобрение отменено',
      body: `${categoryLabel} ${dates[0]}–${dates[dates.length - 1]} больше не действует`,
    });
    await client.query('COMMIT');
    return sendJson(res, 200, { ok: true, clearedDates: dates });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
