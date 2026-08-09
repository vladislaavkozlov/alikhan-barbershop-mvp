// GET/POST /bookings, /bookings/:id/cancel, /bookings/:id/status, GET/POST /sales -
// вынесено из server.mjs при декомпозиции (Этап 2 структурного рефакторинга,
// 07.08.2026), код перенесён без изменений.
import { randomBytes } from 'node:crypto';
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { addMinutes, intervalsOverlap, shopNow } from '../lib/time.js';
import { mastersWithWorkingSchedule, getEffectiveSchedule, blockedIntervalsFor } from '../lib/schedule-core.js';
import { notifyStaff } from '../lib/notify-core.js';

// Задача 2 промпта корректировки Окна 13 (01.08.2026, Блок 5 в.19, Алихан): "отмена не
// позже 2 часов" - до порога полный возврат/бесплатная отмена, после - без возврата.
const CANCEL_FULL_REFUND_HOURS = 2;

// ── Бронирование поверх нормализованной схемы (Шаг 1-2 Окна 8) ────────────
// Та же гарантия, что раньше давал casWrite по kv_store: pg_advisory_xact_lock
// сериализует все параллельные попытки одного мастера на одну дату, поэтому два
// устройства не могут обе "выиграть" один слот (см. storage.js/createBooking).
// Задача Окна 11 (найдено Владом 30.07.2026): клиент выбирает НЕСКОЛЬКО услуг за
// один визит, не одну - serviceIds теперь массив (минимум 1 элемент). Длительность
// слота = сумма duration_min всех выбранных услуг ПО ЭТОМУ МАСТЕРУ (master_services,
// Окно 10 - у Екатерины другая цена/длительность на части услуг), не общий прайс.
// isStaff (08.08.2026, жалоба Влада: "интернет отключили / администратор отвлёкся,
// клиента обслужили, а внести в систему нечем - должна быть возможность занести
// визит задним числом из CRM") - ИСКЛЮЧИТЕЛЬНО из authenticate(req) (см. handleBookings
// ниже), НЕ из тела запроса. Публичный виджет записи (index.html/app.js) шлёт этот же
// POST /bookings анонимно (auth===null) - past_time для него остаётся строгим, как и
// было: клиенту самому в прошлое не записаться. Разграничение по channel (строке из
// body) было бы небезопасным - анонимный запрос мог бы просто прислать
// channel:'admin' и обойти проверку, isStaff подделать нельзя, потому что это флаг с
// сервера, не эхо входных данных.
async function createBookingTx({ masterId, serviceIds, date, startTime, clientName, clientPhone, channel, isStaff }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${masterId}:${date}`]);

    const msRes = await client.query(
      'SELECT service_id, duration_min, price FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
      [masterId, serviceIds]
    );
    if (msRes.rows.length !== serviceIds.length) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master_service' } };
    }
    const totalDuration = msRes.rows.reduce((sum, r) => sum + r.duration_min, 0);
    const totalPrice = msRes.rows.reduce((sum, r) => sum + r.price, 0);
    const endTime = addMinutes(startTime, totalDuration);

    // Задача C промпта Окна 29 (05.08.2026) - финальный рубеж: мастер без единого
    // рабочего дня в стандартном графике физически ещё не готов принимать записи
    // (только что нанят, график не выставлен). До этой правки getEffectiveSchedule
    // молча фолбэчился на GLOBAL_DEFAULT "10:00-20:00, без перерыва" - день выглядел
    // полностью свободным. Проверка тем же критерием, что уже видит владелец в CRM
    // (hasWorkingSchedule, Окно 22) - защищает и от прямого вызова API в обход
    // фронта, по тому же принципу, что и существующая защита от гонки (schedule_blocked).
    const workingSet = await mastersWithWorkingSchedule(client, [masterId]);
    if (!workingSet.has(masterId)) {
      await client.query('ROLLBACK');
      return { status: 409, body: { ok: false, reason: 'master_not_bookable' } };
    }

    const { date: today, time: nowTime } = shopNow();
    const isPast = date < today || (date === today && startTime < nowTime);
    if (isPast && !isStaff) {
      await client.query('ROLLBACK');
      return { status: 409, body: { ok: false, reason: 'past_time' } };
    }

    const existingRes = await client.query(
      `SELECT start_time, end_time FROM bookings WHERE master_id = $1 AND date = $2 AND status != 'cancelled'`,
      [masterId, date]
    );
    const hasOverlap = existingRes.rows.some((b) =>
      intervalsOverlap(startTime, endTime, b.start_time, b.end_time)
    );
    if (hasOverlap) {
      await client.query('ROLLBACK');
      return { status: 409, body: { ok: false, reason: 'overlap' } };
    }

    // Задача 3 (Окно 14, 02.08.2026) - одобренный перерыв/выходной реально блокирует
    // онлайн-запись, не только показывается в интерфейсе. Правка 03.08.2026 (Окно 16):
    // getEffectiveSchedule() отдаёт ПОЛНУЮ картину дня (рабочее окно + перерывы) - до
    // этой правки бронь никак не проверялась на попадание в рамки смены, только на
    // перерывы, теперь запись за пределами рабочего окна тоже blocked.
    const effectiveSchedule = await getEffectiveSchedule(client, masterId, date);
    const hitsBlocked = blockedIntervalsFor(effectiveSchedule).some((b) => intervalsOverlap(startTime, endTime, b.startTime, b.endTime));
    if (hitsBlocked) {
      await client.query('ROLLBACK');
      return { status: 409, body: { ok: false, reason: 'schedule_blocked' } };
    }

    const staffRes = await client.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
    if (staffRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master' } };
    }
    const locationId = staffRes.rows[0].location_id;

    let clientId = null;
    let requiresPrepayment = false;
    if (clientPhone) {
      const clientRes = await client.query(
        `INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name)
         RETURNING id, no_show_streak`,
        [`client-${randomBytes(6).toString('hex')}`, clientName ?? null, clientPhone]
      );
      clientId = clientRes.rows[0].id;
      // Задача 3 (Окно 13, 01.08.2026, Блок 5 в.22): 2 неявки без предупреждения →
      // на 3-ю запись нужна 100% предоплата. Онлайн-оплаты в MVP нет - это ручная
      // пометка для владельца/администратора, не блокирующий автомат (см. миграцию
      // 008_booking_flags.sql).
      requiresPrepayment = clientRes.rows[0].no_show_streak >= 2;
    }

    const bookingId = `${date}-${startTime}-${masterId}-${randomBytes(4).toString('hex')}`;
    // service_id (единичное поле) намеренно оставляем NULL для новых броней - список
    // услуг живёт только в booking_services, чтобы не было двух источников правды
    // (см. миграцию 013_booking_services.sql, там же бэкфилл старых броней).
    await client.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel, requires_prepayment)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'planned', $8, $9)`,
      [bookingId, locationId, masterId, clientId, date, startTime, endTime, channel ?? 'client', requiresPrepayment]
    );
    for (const serviceId of serviceIds) {
      await client.query('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [bookingId, serviceId]);
    }
    // Задача 5 (Окно 14) - мастер узнаёт о новой записи в личном кабинете сразу,
    // без ожидания фонового сканера (тот покрывает только "за 15 минут"/"время пришло").
    await notifyStaff(client, masterId, 'booking_new', {
      bookingId,
      title: 'Новая запись',
      body: `${startTime}–${endTime}${clientName ? ' · ' + clientName : ''}`,
    });
    // Задача 5 (Окно 14) - Мамедхан (admin) управляет точкой день в день, тоже
    // получает уведомления о новых записях своей точки, только просмотр (Задача 3
    // approve/reject остаётся исключительно у owner, здесь этого и нет).
    if (locationId != null) {
      const admins = await client.query(`SELECT id FROM staff WHERE role = 'admin' AND location_id = $1`, [locationId]);
      for (const admin of admins.rows) {
        await notifyStaff(client, admin.id, 'booking_new', {
          bookingId,
          title: 'Новая запись на точке',
          body: `${startTime}–${endTime}${clientName ? ' · ' + clientName : ''}`,
        });
      }
    }
    await client.query('COMMIT');
    return {
      status: 200,
      body: {
        ok: true,
        booking: {
          id: bookingId,
          masterId,
          serviceIds,
          date,
          startTime,
          endTime,
          clientName,
          clientPhone,
          requiresPrepayment,
          totalDurationMin: totalDuration,
          totalPrice,
        },
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// GET /bookings - анонимный запрос (виджет записи клиента) получает только занятость
// слотов, без данных о клиентах. Роль сотрудника сужает выдачу по матрице разд.7 ТЗ:
// owner - всё; admin - только своя точка (даже если явно попросили чужую); master -
// только свои записи, без телефона клиента (п.1 разд.12 ТЗ).
async function listBookingsForRequest(url, auth) {
  const masterId = url.searchParams.get('masterId');
  const date = url.searchParams.get('date');
  const dateFrom = url.searchParams.get('from');
  const dateTo = url.searchParams.get('to');

  let query = `SELECT b.id, b.master_id, b.service_id, b.date, b.start_time, b.end_time, b.status,
                      b.client_confirmed, b.location_id, b.requires_prepayment, b.review_request_pending,
                      b.actual_price,
                      c.name AS client_name, c.phone AS client_phone, c.birthday AS client_birthday,
                      c.no_show_streak AS client_no_show_streak
               FROM bookings b LEFT JOIN clients c ON c.id = b.client_id WHERE 1=1`;
  const params = [];
  if (masterId) {
    params.push(masterId);
    query += ` AND b.master_id = $${params.length}`;
  }
  if (date) {
    params.push(date);
    query += ` AND b.date = $${params.length}`;
  }
  // Диапазон дат (правка 28.07.2026) - для вкладок Неделя/Месяц/Квартал/Год в CRM
  // владельца: одним запросом забираем весь нужный период, дальше бакетируем на
  // фронте, вместо отдельного запроса на каждый день (было бы до 365 запросов на год).
  if (dateFrom) {
    params.push(dateFrom);
    query += ` AND b.date >= $${params.length}`;
  }
  if (dateTo) {
    params.push(dateTo);
    query += ` AND b.date <= $${params.length}`;
  }
  if (auth?.role === 'admin') {
    params.push(auth.locationId);
    query += ` AND b.location_id = $${params.length}`;
  } else if (auth?.role === 'master') {
    params.push(auth.id);
    query += ` AND b.master_id = $${params.length}`;
  }
  // owner и анонимный запрос - без дополнительного фильтра по точке/мастеру

  query += ' ORDER BY b.date, b.start_time';
  const result = await pool.query(query, params);

  // Окно 11: несколько услуг за визит живут в booking_services (см. миграцию 013),
  // не в единичном bookings.service_id - один доп. запрос на все id из выборки,
  // тот же паттерн, что уже есть у schedule_breaks в обработчике /schedule ниже.
  const bookingIds = result.rows.map((r) => r.id);
  const servicesRes = bookingIds.length
    ? await pool.query('SELECT booking_id, service_id FROM booking_services WHERE booking_id = ANY($1)', [bookingIds])
    : { rows: [] };
  const serviceIdsByBooking = new Map();
  for (const row of servicesRes.rows) {
    if (!serviceIdsByBooking.has(row.booking_id)) serviceIdsByBooking.set(row.booking_id, []);
    serviceIdsByBooking.get(row.booking_id).push(row.service_id);
  }

  return result.rows.map((r) => {
    const base = {
      id: r.id,
      masterId: r.master_id,
      // serviceId (единичное значение) остаётся для старого кода, который его ещё
      // читает - первая услуга из списка. serviceIds - полный список, актуальный источник.
      serviceId: r.service_id ?? serviceIdsByBooking.get(r.id)?.[0] ?? null,
      serviceIds: serviceIdsByBooking.get(r.id) ?? (r.service_id ? [r.service_id] : []),
      locationId: r.location_id,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      status: r.status,
      clientConfirmed: r.client_confirmed,
    };
    if (!auth) return base; // клиент без входа - карточек других клиентов вообще не видит
    // Блок В (ТЗ-готовность-к-продакшену, 01.08.2026): день рождения клиента - не
    // персональные данные уровня телефона (разд.12 п.1 ограничивает только phone),
    // и crm-master.html уже показывает поле "Дата рождения клиента" - мастеру нужно
    // знать дату, чтобы поздравить. Видна owner/admin/master, не анонимному запросу.
    const clientBirthday = r.client_birthday instanceof Date ? r.client_birthday.toISOString().slice(0, 10) : r.client_birthday;
    if (auth.role === 'owner' || auth.role === 'admin') {
      // requiresPrepayment/reviewRequestPending - видно только владельцу/администратору
      // (Задачи 3 и 6, Окно 13, 01.08.2026) - мастеру эти пометки не нужны для работы.
      // clientNoShowStreak - правка 03.08.2026: карточка записи показывала пример-
      // баннер про неявку клиента, хотя реальное число уже копилось в БД (Окно 13) и
      // просто никогда не отдавалось наружу - тот же уровень видимости, что и телефон.
      return {
        ...base,
        clientName: r.client_name,
        clientPhone: r.client_phone,
        clientBirthday,
        requiresPrepayment: r.requires_prepayment,
        reviewRequestPending: r.review_request_pending,
        clientNoShowStreak: r.client_no_show_streak ?? 0,
        // actualPrice (08.08.2026, вечер) - видно только owner/admin, тем же
        // уровнем доступа, что и сама возможность её редактировать
        // (handleBookingActualPrice) - мастеру эта цифра не нужна для работы.
        actualPrice: r.actual_price,
      };
    }
    return { ...base, clientName: r.client_name, clientBirthday }; // master: имя и ДР видно, телефон - нет
  });
}

// ── /bookings - GET публичный (без клиентских данных) + по роли, POST для записи ──
export async function handleBookings(req, res, url) {
  if (req.method === 'GET') {
    const auth = await authenticate(req);
    const bookings = await listBookingsForRequest(url, auth);
    return sendJson(res, 200, { bookings });
  }
  if (req.method === 'POST') {
    const auth = await authenticate(req);
    // Правка 08.08.2026 (Влад: реальный процесс работы точки - мастер обслуживает
    // клиента и называет услуги/сумму администратору, ЗАПИСЬ и оплату проводит
    // администратор, не мастер сам себе: "нужно, чтобы только у администратора
    // была возможность записывать клиентов"). Анонимный запрос (auth===null, клиент
    // с публичного сайта) этой проверки не касается вообще - остаётся как был.
    if (auth && auth.role === 'master') {
      return sendJson(res, 403, { error: 'forbidden', reason: 'master_cannot_create_bookings' });
    }
    const body = await readBody(req);
    // Окно 11: контракт принимает serviceIds (массив, 1+) - serviceId (единичное
    // значение) остаётся принят для обратной совместимости со старыми клиентами,
    // оборачивается в массив из одного элемента.
    const serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds : body.serviceId ? [body.serviceId] : [];
    if (!body.masterId || !body.date || !body.startTime || serviceIds.length === 0) {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    const result = await createBookingTx({
      masterId: body.masterId,
      serviceIds,
      date: body.date,
      startTime: body.startTime,
      clientName: body.clientName ?? null,
      clientPhone: body.clientPhone ?? null,
      channel: body.channel ?? (auth ? 'admin' : 'client'),
      isStaff: !!auth,
    });
    return sendJson(res, result.status, result.body);
  }
}

// ── /bookings/:id - НАСТОЯЩЕЕ удаление (08.08.2026, Влад: "мастер зашёл случайно,
// сохранил не на ту дату - её же можно спокойно удалить?"). /cancel ниже только
// меняет статус на 'cancelled' - но computeMasterPayroll (api/routes/payroll.js) не
// фильтрует брони по статусу вообще, значит отменённая запись всё равно продолжила
// бы считаться в выручке/зарплате мастера. Для "случайно не туда нажал" это не
// годится - нужно, чтобы записи как будто не было. owner - любая запись, admin -
// только своя точка (та же матрица, что у /cancel), master сюда не допущен вовсе
// (см. отдельную правку в этом же окне - "только администратор записывает клиентов",
// тем же принципом и удаляет). booking_services/notifications подчищаются сами (ON
// DELETE CASCADE, миграции 013/015) - ручной DELETE по ним не нужен.
//
// force (08.08.2026, вторая правка того же вечера) - sales.booking_id БЕЗ каскада
// (002_schema.sql): к записи может быть привязана РЕАЛЬНАЯ продажа, которая уже
// участвует в расчёте зарплаты. Первый заход без force=true - явная 409 has_sale, не
// сырая FK-ошибка (тот же урок, что и инцидент с schedule_change_requests, см. память
// reference_barbershop-crm-tech.md). Если сотрудник ПОДТВЕРДИЛ (force=true из
// повторного запроса после предупреждения на фронте) - продажи по этой записи
// удаляются вместе с ней, одной транзакцией.
export async function handleBookingDelete(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query('SELECT id, location_id FROM bookings WHERE id = $1', [bookingId]);
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  const body = await readBody(req);
  const force = body?.force === true;
  const saleRes = await pool.query('SELECT id, amount FROM sales WHERE booking_id = $1', [bookingId]);
  if (saleRes.rows.length > 0 && !force) {
    return sendJson(res, 409, {
      ok: false,
      reason: 'has_sale',
      saleCount: saleRes.rows.length,
      saleTotal: saleRes.rows.reduce((sum, r) => sum + r.amount, 0),
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (saleRes.rows.length > 0) {
      await client.query('DELETE FROM sales WHERE booking_id = $1', [bookingId]);
    }
    await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return sendJson(res, 200, { ok: true });
}

// ── /bookings/:id/cancel - Задача 2 (Окно 13, 01.08.2026, Блок 5 в.19). Отмена
// сама по себе ничем не ограничена по времени - ограничено только право на полный
// возврат. Онлайн-оплаты в MVP нет (см. Ограничения промпта), поэтому "возврат"
// здесь не реальная транзакция, а флаг refundEligible в ответе, на который
// ориентируется сотрудник в разговоре с клиентом. Доступ сужен той же матрицей,
// что и видимость самой брони (listBookingsForRequest): owner - любая, admin -
// только своя точка, master - только свои записи.
export async function handleBookingCancel(req, res, parts) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query(
    'SELECT id, master_id, location_id, date, start_time, status FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (auth.role === 'master' && booking.master_id !== auth.id) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (booking.status === 'cancelled') return sendJson(res, 409, { error: 'already_cancelled' });

  // Ставрополь = московское время, UTC+3 круглый год (нет перехода на летнее/
  // зимнее в РФ с 2014). Без явного смещения Date парсит строку в таймзоне
  // процесса Node - на Amvera это UTC, а не MSK, что даёт разницу в 3 часа
  // между реальным дедлайном клиента и тем, что здесь посчитано (поймано живым
  // тестом при проверке этого окна, не только по коду).
  const bookingDate = booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date;
  const hoursUntilBooking = (new Date(`${bookingDate}T${booking.start_time}:00+03:00`).getTime() - Date.now()) / (1000 * 60 * 60);
  const refundEligible = hoursUntilBooking >= CANCEL_FULL_REFUND_HOURS;

  await pool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);
  return sendJson(res, 200, {
    ok: true,
    status: 'cancelled',
    refundEligible,
    hoursUntilBooking: Math.round(hoursUntilBooking * 100) / 100,
  });
}

// ── /bookings/:id/status - Задачи 3 и 6 (Окно 13, 01.08.2026). Простановка факта
// визита (владелец/администратор/мастер). 'cancelled' сюда намеренно не входит -
// для отмены есть отдельный /bookings/:id/cancel с проверкой порога 2 часа
// (Задача 2), общий сеттер статуса не должен давать возможность обойти эту
// проверку.
export async function handleBookingStatus(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner', 'admin', 'master'])) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const allowedStatuses = ['planned', 'done', 'no_show'];
  if (!allowedStatuses.includes(body.status)) {
    return sendJson(res, 400, { error: 'invalid_status', allowed: allowedStatuses });
  }
  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query(
    'SELECT id, master_id, location_id, client_id, status FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (auth.role === 'master' && booking.master_id !== auth.id) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE bookings SET status = $1 WHERE id = $2', [body.status, bookingId]);
    // Правка 03.08.2026 (кнопка "Клиент не пришёл" в bd-1 - раньше не вызывала
    // этот эндпоинт вообще): проверяем ПРЕЖНИЙ статус (booking.status), не только
    // новый - иначе повторный клик/повторный PATCH на уже no_show booking удваивал
    // бы счётчик неявок за один и тот же реальный факт. Симметрично - отмена
    // отметки (no_show → planned, "передумал"/опечатался) откатывает счётчик назад,
    // не оставляя его задвоенным навсегда.
    if (booking.client_id && body.status === 'no_show' && booking.status !== 'no_show') {
      // Задача 3, Блок 5 в.22: счётчик неявок - поле no_show_streak уже было в
      // схеме (002_schema.sql), просто нигде не инкрементировалось.
      await client.query('UPDATE clients SET no_show_streak = no_show_streak + 1 WHERE id = $1', [booking.client_id]);
    } else if (booking.client_id && body.status === 'planned' && booking.status === 'no_show') {
      await client.query('UPDATE clients SET no_show_streak = GREATEST(no_show_streak - 1, 0) WHERE id = $1', [booking.client_id]);
    } else if (booking.client_id && body.status === 'done') {
      // "Streak" = подряд идущие неявки - успешный визит сбрасывает счётчик. Это
      // не слова Алихана, а прямое прочтение названия поля (см. комментарий в
      // 002_schema.sql); решение зафиксировано отдельно в отчёте по этому окну,
      // не выдаётся за факт от владельца.
      await client.query('UPDATE clients SET no_show_streak = 0 WHERE id = $1', [booking.client_id]);
    }
    if (body.status === 'done') {
      // Задача 6, Блок 11 в.45: только точка расширения - канал отправки отзыва
      // не выбран (см. Ограничения промпта корректировки), реальной отправки нет.
      await client.query('UPDATE bookings SET review_request_pending = true WHERE id = $1', [bookingId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return sendJson(res, 200, { ok: true, status: body.status });
}

// ── /bookings/:id/services - добавление услуги(й) К УЖЕ СУЩЕСТВУЮЩЕЙ записи
// (08.08.2026, жалоба Влада: мастер во время/после визита обнаруживает, что клиенту
// нужна ещё услуга - например, подстригли и уже потом попросили бритьё - а внести
// это было физически некуда, "Корректировка услуги" в карточке записи с 03.08.2026
// была статичным макетом без сохранения, см. assets/mockup-crm.js pickServiceForBooking).
// Намеренно ТОЛЬКО добавление, не полная замена списка - убрать уже оказанную услугу
// этой ручкой нельзя, только дописать новую, поэтому past_time-проверки из
// createBookingTx здесь нет вообще: это не бронирование нового времени, а честная
// фиксация уже случившегося визита, время может быть каким угодно в прошлом.
// revenue/payroll (computeMasterPayroll, api/routes/payroll.js) считают сумму по
// booking_services на лету при каждом запросе - простой INSERT сюда автоматически
// даёт верную статистику без отдельного пересчёта.
export async function handleBookingAddServices(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner', 'admin', 'master'])) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const newServiceIds = Array.isArray(body.serviceIds) ? [...new Set(body.serviceIds)] : [];
  if (newServiceIds.length === 0) return sendJson(res, 400, { error: 'missing_fields' });

  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query(
    'SELECT id, master_id, location_id, date, start_time, end_time, status FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (auth.role === 'master' && booking.master_id !== auth.id) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (booking.status === 'cancelled') return sendJson(res, 409, { error: 'booking_cancelled' });

  const msRes = await pool.query(
    'SELECT service_id, duration_min, price FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
    [booking.master_id, newServiceIds]
  );
  if (msRes.rows.length !== newServiceIds.length) {
    return sendJson(res, 400, { error: 'unknown_master_service' });
  }
  const addedDuration = msRes.rows.reduce((sum, r) => sum + r.duration_min, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const serviceId of newServiceIds) {
      await client.query(
        'INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [bookingId, serviceId]
      );
    }
    // Длительность карточки в календаре растягиваем на реально добавленное время -
    // без этого визуальный слот молчаливо расходился бы с фактическим списком услуг
    // (см. bk-duration в карточке записи). Пересечения с чужими бронями НЕ проверяем -
    // сознательно (это правка уже случившегося визита, не новое бронирование).
    const newEndTime = addMinutes(booking.end_time, addedDuration);
    await client.query('UPDATE bookings SET end_time = $1 WHERE id = $2', [newEndTime, bookingId]);
    await client.query('COMMIT');
    const allServicesRes = await client.query('SELECT service_id FROM booking_services WHERE booking_id = $1', [bookingId]);
    return sendJson(res, 200, {
      ok: true,
      booking: { id: bookingId, serviceIds: allServicesRes.rows.map((r) => r.service_id), endTime: newEndTime },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── /bookings/:id/actual-price - фактически взятая с клиента сумма (08.08.2026,
// вечер, Влад: "Али иногда говорит администратору 'пробей по старой цене'" -
// скидка клиенту). owner/admin - та же матрица, что у handleBookingAddServices
// (master сюда не допущен - тем же принципом "только администратор" из этой же
// сессии). actualPrice: null - явный сброс "фактическая = списочная" (например,
// скидку отменили/ошиблись при вводе), не только положительное число. Влияет ли
// это на зарплату мастера - решает discount_settings (handleDiscountSettings),
// не эта ручка - здесь только фиксация факта, не расчёт.
export async function handleBookingActualPrice(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query('SELECT id, location_id FROM bookings WHERE id = $1', [bookingId]);
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  const body = await readBody(req);
  if (body.actualPrice !== null && (typeof body.actualPrice !== 'number' || body.actualPrice < 0)) {
    return sendJson(res, 400, { error: 'invalid_actual_price' });
  }
  await pool.query('UPDATE bookings SET actual_price = $1 WHERE id = $2', [body.actualPrice, bookingId]);
  return sendJson(res, 200, { ok: true, actualPrice: body.actualPrice });
}

// ── /sales - продажа (косметика и т.п.), привязана к визиту (разд.14.3 п.2) ──
export async function handleSales(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const bookingId = url.searchParams.get('bookingId');
    let query = `SELECT s.id, s.booking_id, s.item_name, s.amount, s.created_at FROM sales s
                 JOIN bookings b ON b.id = s.booking_id WHERE 1=1`;
    const params = [];
    if (bookingId) {
      params.push(bookingId);
      query += ` AND s.booking_id = $${params.length}`;
    }
    if (auth.role === 'admin') {
      params.push(auth.locationId);
      query += ` AND b.location_id = $${params.length}`;
    }
    const result = await pool.query(query, params);
    return sendJson(res, 200, result.rows.map((r) => ({ id: r.id, bookingId: r.booking_id, itemName: r.item_name, amount: r.amount })));
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body.bookingId || !body.itemName || typeof body.amount !== 'number') {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    const bookingRes = await pool.query('SELECT location_id FROM bookings WHERE id = $1', [body.bookingId]);
    if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
    if (auth.role === 'admin' && bookingRes.rows[0].location_id !== auth.locationId) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const id = `sale-${randomBytes(6).toString('hex')}`;
    await pool.query('INSERT INTO sales (id, booking_id, item_name, amount) VALUES ($1, $2, $3, $4)', [
      id,
      body.bookingId,
      body.itemName,
      body.amount,
    ]);
    return sendJson(res, 200, { ok: true, id });
  }
}
