// Тонкая API-прослойка между статическим сайтом (index.html/admin.html, GitHub Pages)
// и реальной базой Postgres на Amvera. Браузер не умеет напрямую говорить по
// протоколу Postgres - этот сервер переводит простые HTTP-запросы в SQL и обратно.
//
// Окно 8 (27.07.2026): нормализованная схема (миграция 002_schema.sql) заменила
// временный kv_store (Окно 7) как источник истины для bookings/staff/services и т.д.
// /kv/:key остаётся - старый общий контракт, ничего не удаляет и не ломает, просто
// bookings теперь не через него.
//
// Обязательные переменные окружения (задаются в интерфейсе Amvera при создании
// "Приложения", не хардкодятся в коде):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - те же, что при создании базы alikhan-crm
//   ALLOWED_ORIGIN - домен фронтенда, которому разрешено обращаться сюда (CORS)
//   PORT - опционально, порт, на котором слушает сам сервер (по умолчанию 8080)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setCors, sendJson, readBody } from './lib/http.js';
import { pool, casWrite } from './lib/db.js';
import { hashPin, verifyPin, createSession, authenticate, requireRole } from './lib/auth.js';
import {
  getEffectiveSchedule,
  filterStaffForViewer,
  mastersWithWorkingSchedule,
  hasAvailableSlot,
  isScheduleDayOff,
  SCHEDULE_RANGE_MAX_DAYS,
  rangeDayCount,
  computeScheduleRangeDays,
  SCHEDULE_AVAILABILITY_MAX_DAYS,
  computeAvailabilityRangeDays,
  MASTER_NEXT_AVAILABILITY_WINDOW_DAYS,
  computeMasterNextAvailability,
  validateWeeklyChanges,
  writeWeeklySchedule,
  formatWeeklyChangesSummary,
  findWeeklyScheduleConflicts,
  findScheduleConflicts,
  applyScheduleDay,
  listHolidays,
  holidayCloseTargets,
  fullDayOffWindow,
  dayOffWindowsForRequest,
  planHolidayClose,
  HOLIDAY_CLOSE_MAX_DAYS,
} from './lib/schedule-core.js';
// Ре-экспорт для tests/*.test.js, которые импортируют эти имена напрямую из
// server.mjs (in-memory юниты без реального Postgres).
export {
  getEffectiveSchedule,
  filterStaffForViewer,
  mastersWithWorkingSchedule,
  hasAvailableSlot,
  isScheduleDayOff,
  SCHEDULE_RANGE_MAX_DAYS,
  rangeDayCount,
  computeScheduleRangeDays,
  SCHEDULE_AVAILABILITY_MAX_DAYS,
  computeAvailabilityRangeDays,
  MASTER_NEXT_AVAILABILITY_WINDOW_DAYS,
  computeMasterNextAvailability,
  findWeeklyScheduleConflicts,
  findScheduleConflicts,
  listHolidays,
  holidayCloseTargets,
  fullDayOffWindow,
  dayOffWindowsForRequest,
  planHolidayClose,
  HOLIDAY_CLOSE_MAX_DAYS,
} from './lib/schedule-core.js';
import { notifyStaff, findMastersMissingSchedule, notifyOwnerAboutMastersMissingSchedule } from './lib/notify-core.js';
export { findMastersMissingSchedule, notifyOwnerAboutMastersMissingSchedule } from './lib/notify-core.js';
import {
  toMinutes,
  minutesToTime,
  addMinutes,
  addDaysIso,
  intervalsOverlap,
  shopNow,
  isoWeekday,
  enumerateDateRange,
  dateColToStr,
} from './lib/time.js';
// Ре-экспорт для tests/*.test.js, которые импортируют эти имена напрямую из
// server.mjs (in-memory юниты без реального Postgres) - см. правило 6 плана
// декомпозиции, plans/2026-08-07-server-mjs-decomposition.md.
export { isoWeekday, enumerateDateRange } from './lib/time.js';

const PORT = Number(process.env.PORT) || 8080;
// Задача 2 промпта корректировки Окна 13 (01.08.2026, Блок 5 в.19, Алихан): "отмена не
// позже 2 часов" - до порога полный возврат/бесплатная отмена, после - без возврата.
const CANCEL_FULL_REFUND_HOURS = 2;
// Окно 37 (06.08.2026, Задача 1) - единый резолвер ЗП мастера за произвольный
// период. До этого окна одна и та же формула (сумма цены броней × ставка мастера
// / 100) жила в двух местах: мёртвый calcPayrollEstimate в storage.js (хардкод
// 45%/50%, ни один живой вызов не найден grep-аудитом) и рабочий client-side дубль
// в assets/crm-auth.js (bookingPrice+pctOf, читает /bookings + /payroll-settings).
// Здесь та же формула переносится на бэкенд как единственный источник цифры для
// "Моей зарплаты" мастера (crm-master.html) - День/Неделя/Месяц/произвольный
// период через один вызов, не три реализации. Статус брони намеренно НЕ
// фильтруется - сохраняет 1:1 поведение уже работающих Недели/Месяца (регрессия
// 0), фильтрация по статусу вне скоупа этого окна.
export async function computeMasterPayroll(client, masterId, from, to) {
  const pctRes = await client.query('SELECT pct FROM master_payroll_settings WHERE master_id = $1', [masterId]);
  const pct = pctRes.rows[0]?.pct ?? 0;

  const bookingsRes = await client.query(
    'SELECT id, service_id AS "serviceId" FROM bookings WHERE master_id = $1 AND date >= $2 AND date <= $3',
    [masterId, from, to]
  );
  const bookingIds = bookingsRes.rows.map((r) => r.id);
  const linkRes = bookingIds.length
    ? await client.query(
        'SELECT booking_id AS "bookingId", service_id AS "serviceId" FROM booking_services WHERE booking_id = ANY($1)',
        [bookingIds]
      )
    : { rows: [] };
  const serviceIdsByBooking = new Map();
  for (const row of linkRes.rows) {
    if (!serviceIdsByBooking.has(row.bookingId)) serviceIdsByBooking.set(row.bookingId, []);
    serviceIdsByBooking.get(row.bookingId).push(row.serviceId);
  }

  // Цена - как у /master-services на фронте (priceOf): своя цена мастера в
  // приоритете, общий прайс services - только страховка на случай пары, которую
  // почему-то не завели в master_services.
  const masterPriceRes = await client.query('SELECT service_id AS "serviceId", price FROM master_services WHERE master_id = $1', [
    masterId,
  ]);
  const priceByService = new Map(masterPriceRes.rows.map((r) => [r.serviceId, r.price]));
  const basePriceRes = await client.query('SELECT id, price FROM services');
  const basePriceByService = new Map(basePriceRes.rows.map((r) => [r.id, r.price]));
  const priceOf = (serviceId) => priceByService.get(serviceId) ?? basePriceByService.get(serviceId) ?? 0;

  let revenue = 0;
  for (const b of bookingsRes.rows) {
    const serviceIds = serviceIdsByBooking.get(b.id)?.length ? serviceIdsByBooking.get(b.id) : b.serviceId ? [b.serviceId] : [];
    revenue += serviceIds.reduce((sum, id) => sum + priceOf(id), 0);
  }
  const payroll = (revenue * pct) / 100;
  return { revenue, payroll };
}

// Окно 38 (06.08.2026) - дневная выручка (SUM sales.amount за сегодня МСК).
// Администратор физически не мог ответить на "сколько мы заработали сегодня" без
// звонка владельцу (PRODUCT_AUDIT_REPORT, разд. "Администратор"; FINAL_PRODUCT_
// DECISION, Epic 6) - read-only режим администратора в остальном сделан правильно,
// это единственный реальный пробел. Данные (sales) уже собираются /sales (POST) -
// здесь только агрегация, не новый сбор данных.
//
// nowMs - инъекция текущего времени для юнит-тестов (граница суток), в проде
// вызывается без третьего аргумента (реальный Date.now()). МСК = UTC+3 круглый
// год (тот же приём, что computeMasterPayroll/scanBookingReminders/bookings-
// cancel - Amvera работает в UTC, не MSK).
//
// locationId=null (владелец без явной точки) - без фильтра по location_id,
// сумма по ВСЕМ точкам. Контракт не ломается при появлении второй точки: SQL не
// хардкодит число точек, просто не сужает выборку.
export async function computeRevenueToday(client, locationId, nowMs = Date.now()) {
  const todayStr = new Date(nowMs + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dayStart = new Date(`${todayStr}T00:00:00+03:00`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  let query = `SELECT s.amount FROM sales s JOIN bookings b ON b.id = s.booking_id
               WHERE s.created_at >= $1 AND s.created_at < $2`;
  const params = [dayStart, dayEnd];
  if (locationId) {
    params.push(locationId);
    query += ` AND b.location_id = $${params.length}`;
  }
  const result = await client.query(query, params);
  const revenue = result.rows.reduce((sum, r) => sum + Number(r.amount), 0);
  return { revenue };
}

// Окно 39 (06.08.2026) - индикатор риска ухода клиента. no_show_streak уже
// собирается (Окно 13) и уже управляет requiresPrepayment (>=2, см. createBookingTx
// выше), но нигде не превращается в решение человека - PRODUCT_ARCHITECTURE_PLAN,
// Модуль 2. Честная оговорка промпта: requiresPrepayment ничего не блокирует
// технически (комментарий у createBookingTx - "предоплата ручная, оплат в MVP нет"),
// поэтому текст статуса всегда "стоит позвонить", никогда "клиент заблокирован".
// >=1 - клиент уже пропустил последний визит, стоит присмотреться; >=2 - тот же
// порог, что уже требует предоплаты при следующей записи (createBookingTx).
function pluralRaz(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'раз';
  if (mod10 === 1) return 'раз';
  if (mod10 >= 2 && mod10 <= 4) return 'раза';
  return 'раз';
}

export function describeClientRisk(noShowStreak) {
  const n = Number(noShowStreak) || 0;
  if (n <= 0) return { level: 'none', label: null };
  if (n === 1) return { level: 'watch', label: 'Пропустил последнюю запись - стоит позвонить' };
  return { level: 'high', label: `Не пришёл ${n} ${pluralRaz(n)} подряд - стоит позвонить` };
}

// Карточка клиента: сам клиент + история визитов (мастер, услуги через
// booking_services - миграция 013 уже backfill-нула старые брони, отдельный
// фолбэк на bookings.service_id не нужен). Роль-агностичный резолвер (тот же
// принцип, что у computeRevenueToday/computeMasterPayroll) - видимость телефона и
// scoping по точке/мастеру решает вызывающий роут по auth.role, не эта функция.
export async function getClientCard(client, clientId) {
  const clientRes = await client.query(
    'SELECT id, name, phone, birthday, no_show_streak FROM clients WHERE id = $1',
    [clientId]
  );
  if (clientRes.rows.length === 0) return null;
  const row = clientRes.rows[0];

  const visitsRes = await client.query(
    `SELECT b.id, b.date, b.start_time, b.end_time, b.status, b.master_id, b.location_id,
            st.name AS master_name
     FROM bookings b LEFT JOIN staff st ON st.id = b.master_id
     WHERE b.client_id = $1
     ORDER BY b.date DESC, b.start_time DESC`,
    [clientId]
  );

  const bookingIds = visitsRes.rows.map((r) => r.id);
  const servicesRes = bookingIds.length
    ? await client.query(
        `SELECT bs.booking_id, bs.service_id, s.name AS service_name
         FROM booking_services bs JOIN services s ON s.id = bs.service_id
         WHERE bs.booking_id = ANY($1)`,
        [bookingIds]
      )
    : { rows: [] };
  const servicesByBooking = new Map();
  for (const r of servicesRes.rows) {
    if (!servicesByBooking.has(r.booking_id)) servicesByBooking.set(r.booking_id, []);
    servicesByBooking.get(r.booking_id).push({ id: r.service_id, name: r.service_name });
  }

  const visits = visitsRes.rows.map((r) => ({
    id: r.id,
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
    startTime: r.start_time,
    endTime: r.end_time,
    status: r.status,
    masterId: r.master_id,
    masterName: r.master_name,
    locationId: r.location_id,
    services: servicesByBooking.get(r.id) ?? [],
  }));

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    birthday: row.birthday instanceof Date ? row.birthday.toISOString().slice(0, 10) : row.birthday,
    noShowStreak: row.no_show_streak,
    risk: describeClientRisk(row.no_show_streak),
    visits,
    // Готовое сырьё для "Записать снова" (Задача 2, фронтенд) - мастер/услуги
    // последнего визита, дата и время выбираются заново на актуальной доступности.
    lastVisit: visits[0]
      ? { masterId: visits[0].masterId, masterName: visits[0].masterName, services: visits[0].services }
      : null,
  };
}

// Список "требует внимания" - клиенты с no_show_streak >= 1. locationId/masterId
// опциональны и взаимоисключающи (тот же паттерн, что у computeRevenueToday) -
// роут передаёт ровно один по роли вызывающего (admin -> своя точка, master ->
// свои клиенты), owner - без фильтра, все клиенты всех точек.
export async function listClientsAtRisk(client, { locationId, masterId } = {}) {
  let query = `SELECT DISTINCT c.id, c.name, c.phone, c.no_show_streak
               FROM clients c JOIN bookings b ON b.client_id = c.id
               WHERE c.no_show_streak >= 1`;
  const params = [];
  if (locationId) {
    params.push(locationId);
    query += ` AND b.location_id = $${params.length}`;
  }
  if (masterId) {
    params.push(masterId);
    query += ` AND b.master_id = $${params.length}`;
  }
  query += ' ORDER BY c.no_show_streak DESC, c.name';
  const result = await client.query(query, params);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    noShowStreak: r.no_show_streak,
    risk: describeClientRisk(r.no_show_streak),
  }));
}

// ── Бронирование поверх нормализованной схемы (Шаг 1-2 Окна 8) ────────────
// Та же гарантия, что раньше давал casWrite по kv_store: pg_advisory_xact_lock
// сериализует все параллельные попытки одного мастера на одну дату, поэтому два
// устройства не могут обе "выиграть" один слот (см. storage.js/createBooking).
// Задача Окна 11 (найдено Владом 30.07.2026): клиент выбирает НЕСКОЛЬКО услуг за
// один визит, не одну - serviceIds теперь массив (минимум 1 элемент). Длительность
// слота = сумма duration_min всех выбранных услуг ПО ЭТОМУ МАСТЕРУ (master_services,
// Окно 10 - у Екатерины другая цена/длительность на части услуг), не общий прайс.
async function createBookingTx({ masterId, serviceIds, date, startTime, clientName, clientPhone, channel }) {
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
    if (date < today || (date === today && startTime < nowTime)) {
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
      };
    }
    return { ...base, clientName: r.client_name, clientBirthday }; // master: имя и ДР видно, телефон - нет
  });
}

// Окно 40 (06.08.2026) - агрегатор дашборда владельца "Сегодня"
// (PRODUCT_ARCHITECTURE_PLAN разд.1, UX_UI_REDESIGN_SPECIFICATION разд.5). Один
// роут вместо трёх - избегает N+1 запросов с фронта. Мастера без графика -
// ровно тот же расчёт, что уже даёт notifyOwnerAboutMastersMissingSchedule выше
// (findMastersMissingSchedule/mastersWithWorkingSchedule, Окно 35), не
// пересчитывается заново. Клиенты на грани ухода - listClientsAtRisk без
// фильтра (Окно 39), владелец видит всех. Единственный НОВЫЙ агрегат - список
// необработанных заявок (schedule_change_requests, status='pending') - раньше
// такого списка для владельца в едином виде не было (только полная история в
// GET /schedule-requests, assets/crm-schedule-requests.js).
export async function computeOwnerAlerts(client) {
  const staffRes = await client.query('SELECT id, name FROM staff WHERE employed = true AND provides_services = true');
  const serviceMasterIds = staffRes.rows.map((r) => r.id);
  const scheduledIds = await mastersWithWorkingSchedule(client, serviceMasterIds);
  const missingIds = findMastersMissingSchedule(serviceMasterIds, scheduledIds);
  const nameById = new Map(staffRes.rows.map((r) => [r.id, r.name]));
  const mastersWithoutSchedule = missingIds.map((id) => ({ id, name: nameById.get(id) ?? id }));

  const pendingRes = await client.query(
    `SELECT r.id, r.master_id, st.name AS master_name, r.request_type, r.category,
            r.date_from, r.date_to, r.start_time, r.end_time, r.master_comment, r.created_at
     FROM schedule_change_requests r LEFT JOIN staff st ON st.id = r.master_id
     WHERE r.status = 'pending'
     ORDER BY r.created_at ASC`
  );
  const pendingRequests = pendingRes.rows.map((r) => ({
    id: r.id,
    masterId: r.master_id,
    masterName: r.master_name,
    requestType: r.request_type,
    category: r.category,
    dateFrom: r.date_from instanceof Date ? r.date_from.toISOString().slice(0, 10) : r.date_from,
    dateTo: r.date_to instanceof Date ? r.date_to.toISOString().slice(0, 10) : r.date_to,
    startTime: r.start_time,
    endTime: r.end_time,
    masterComment: r.master_comment,
    createdAt: r.created_at,
  }));

  const clientsAtRisk = await listClientsAtRisk(client, {});

  return { mastersWithoutSchedule, pendingRequests, clientsAtRisk };
}

// ── Окно 33 (06.08.2026), Задача C: реестр роутов default-deny ─────────────
// Ровно та дыра, которую эксплуатировали /kv/:key (Задача A этого же окна) -
// роут существовал в if/else ниже без единой проверки auth. Реестр делает
// авторизацию декларативной и обязательной: у каждого роута явное поле auth,
// 'public' - осознанное решение, не отсутствие проверки. Роут без записи здесь
// получает 404 РАНЬШЕ, чем дойдёт до if/else - забыть зарегистрировать новый
// роут теперь равносильно "роута не существует", а не "существует без проверки".
//
// 'owner' - реестр сам требует роль owner до обработчика. 'any-staff' - реестр
// требует любой валидный токен (роль не сужена); более узкое требование
// конкретного роута (только admin+owner, только master и т.п.) как и раньше
// проверяет свой requireRole() внутри обработчика - реестр его не заменяет,
// только гарантирует, что аноним до этой проверки вообще не дойдёт.
const ROUTES = [
  { method: 'GET', path: 'health', auth: 'public' },
  { method: 'POST', path: 'auth/login', auth: 'public' },
  { method: 'GET', path: 'auth/me', auth: 'any-staff' },
  { method: 'GET', path: 'staff', auth: 'any-staff' },
  { method: 'PUT', path: 'staff/:id/portfolio', auth: 'owner' },
  { method: 'PUT', path: 'staff/:id/role', auth: 'owner' },
  { method: 'GET', path: 'services', auth: 'any-staff' },
  { method: 'GET', path: 'master-services', auth: 'public' },
  { method: 'PUT', path: 'master-services/:masterId/:serviceId', auth: 'owner' },
  { method: 'GET', path: 'bookings', auth: 'public' },
  { method: 'POST', path: 'bookings', auth: 'public' },
  { method: 'POST', path: 'bookings/:id/cancel', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/status', auth: 'any-staff' },
  { method: 'GET', path: 'sales', auth: 'any-staff' },
  { method: 'POST', path: 'sales', auth: 'any-staff' },
  { method: 'GET', path: 'schedule', auth: 'public' },
  { method: 'POST', path: 'schedule', auth: 'any-staff' },
  { method: 'DELETE', path: 'schedule', auth: 'any-staff' },
  { method: 'GET', path: 'schedule-range', auth: 'any-staff' },
  { method: 'GET', path: 'holidays', auth: 'public' },
  { method: 'POST', path: 'holidays/close', auth: 'owner' },
  { method: 'GET', path: 'schedule-availability', auth: 'public' },
  { method: 'GET', path: 'masters-next-availability', auth: 'public' },
  { method: 'GET', path: 'master-weekly-schedule', auth: 'any-staff' },
  { method: 'PUT', path: 'master-weekly-schedule', auth: 'any-staff' },
  { method: 'POST', path: 'schedule-requests', auth: 'any-staff' },
  { method: 'GET', path: 'schedule-requests', auth: 'any-staff' },
  { method: 'PATCH', path: 'schedule-requests/:id/decision', auth: 'owner' },
  { method: 'PATCH', path: 'schedule-requests/:id/cancel', auth: 'owner' },
  { method: 'GET', path: 'notifications', auth: 'any-staff' },
  { method: 'GET', path: 'notifications/unread-count', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/:id/read', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/read-all', auth: 'any-staff' },
  { method: 'GET', path: 'payroll-settings', auth: 'any-staff' },
  { method: 'PUT', path: 'payroll-settings', auth: 'owner' },
  { method: 'GET', path: 'payroll', auth: 'any-staff' },
  { method: 'GET', path: 'revenue/today', auth: 'any-staff' },
  { method: 'GET', path: 'clients', auth: 'any-staff' },
  { method: 'GET', path: 'clients/:id', auth: 'any-staff' },
  { method: 'GET', path: 'owner/alerts', auth: 'owner' },
];

function matchRoute(method, parts) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const routeParts = route.path.split('/');
    if (routeParts.length !== parts.length) continue;
    if (routeParts.every((seg, i) => seg.startsWith(':') || seg === parts[i])) return route;
  }
  return null;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // Гейт реестра - до любого обработчика ниже. Незарегистрированный
    // метод+путь получает 404 здесь и не доходит до if/else вообще.
    const matchedRoute = matchRoute(req.method, parts);
    if (!matchedRoute) return sendJson(res, 404, { error: 'route_not_found' });
    if (matchedRoute.auth !== 'public') {
      const gateAuth = await authenticate(req);
      if (matchedRoute.auth === 'owner') {
        if (!requireRole(gateAuth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      } else if (!gateAuth) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
    }

    if (url.pathname === '/health') {
      await pool.query('SELECT 1');
      return sendJson(res, 200, { ok: true });
    }

    // ── Auth ────────────────────────────────────────────────────────────
    if (parts[0] === 'auth' && parts[1] === 'login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.email || !body.pin) return sendJson(res, 400, { error: 'email_and_pin_required' });
      const result = await pool.query(
        `SELECT id, name, role, location_id, pin_hash FROM staff
         WHERE email = $1 AND employed = true AND has_system_access = true`,
        [String(body.email).toLowerCase()]
      );
      if (result.rows.length === 0) return sendJson(res, 401, { error: 'invalid_credentials' });
      const staff = result.rows[0];
      if (!verifyPin(String(body.pin), staff.pin_hash)) {
        return sendJson(res, 401, { error: 'invalid_credentials' });
      }
      const { token, expiresAt } = await createSession(staff.id);
      // Окно 35 - алерт "мастер без графика" считается при входе владельца, не
      // фоновым кроном (по решению промпта - проверки при входе достаточно). Обёрнуто
      // в try/catch: сбой этой проверки не должен ронять сам логин.
      if (staff.role === 'owner') {
        try {
          await notifyOwnerAboutMastersMissingSchedule(pool, staff.id);
        } catch (err) {
          console.error('notifyOwnerAboutMastersMissingSchedule failed:', err);
        }
      }
      return sendJson(res, 200, {
        token,
        expiresAt,
        staff: { id: staff.id, name: staff.name, role: staff.role, locationId: staff.location_id },
      });
    }

    if (parts[0] === 'auth' && parts[1] === 'me' && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { staff: auth });
    }

    // ── /staff - роль ограничивает выдачу на уровне SQL, не только в UI ──
    if (parts[0] === 'staff' && parts.length === 1 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      let query = `SELECT id, location_id, name, photo_url, phone, email, role, employed, provides_services, has_system_access,
                          experience_text, strengths_text, certificates_text, before_after_urls
                   FROM staff WHERE 1=1`;
      const params = [];
      if (auth.role === 'admin') {
        params.push(auth.locationId);
        query += ` AND location_id = $${params.length}`;
      } else if (auth.role === 'master') {
        params.push(auth.id);
        query += ` AND id = $${params.length}`;
      }
      const result = await pool.query(query, params);
      const mapped = result.rows.map((r) => ({
        id: r.id,
        locationId: r.location_id,
        name: r.name,
        photoUrl: r.photo_url,
        phone: r.phone,
        email: r.email,
        role: r.role,
        employed: r.employed,
        providesServices: r.provides_services,
        hasSystemAccess: r.has_system_access,
        // Задача 4 (Окно 13, 01.08.2026, Блок 6 в.23-26) - портфолио мастера,
        // самредактируемые владельцем поля, см. миграцию 009_staff_portfolio.sql
        experienceText: r.experience_text,
        strengthsText: r.strengths_text,
        certificatesText: r.certificates_text,
        beforeAfterUrls: r.before_after_urls,
      }));
      // Окно 22 (04.08.2026, Задача 1) - мастер без ни одной строки is_working=true в
      // master_weekly_schedule фолбэчится в getEffectiveSchedule на GLOBAL_DEFAULT
      // "10:00-20:00, без перерыва" (см. комментарий выше по файлу) - выглядит для
      // не-владельца полностью свободным, хотя физически ещё не готов принимать
      // (например только что нанят). Владелец (auth.role === 'owner') видит всех как
      // раньше + hasWorkingSchedule, чтобы сам увидел, кому нужно донастроить график -
      // остальные роли таких мастеров в ответе не получают вовсе.
      const serviceMasterIds = mapped.filter((r) => r.providesServices).map((r) => r.id);
      // Задача C промпта Окна 29 - вынесено в общую mastersWithWorkingSchedule
      // (тот же SQL, теперь единственный источник, см. комментарий там же).
      const scheduledIds = await mastersWithWorkingSchedule(pool, serviceMasterIds);
      return sendJson(res, 200, filterStaffForViewer(mapped, auth.role, scheduledIds));
    }

    // ── /staff/:id/portfolio - Задача 4 (Окно 13, 01.08.2026). Только владелец
    // редактирует (тот же уровень доступа, что у /payroll-settings PUT - Алихан сам
    // ведёт карточки сотрудников). Данных для заполнения сейчас нет (Алихан заполнит
    // сам) - этот эндпоинт даёт саму возможность, не контент.
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'portfolio' && parts.length === 3 && req.method === 'PUT') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      const staffId = decodeURIComponent(parts[1]);
      const body = await readBody(req);
      const result = await pool.query(
        `UPDATE staff SET experience_text = $1, strengths_text = $2, certificates_text = $3, before_after_urls = $4
         WHERE id = $5 RETURNING id`,
        [body.experienceText ?? null, body.strengthsText ?? null, body.certificatesText ?? null, body.beforeAfterUrls ?? null, staffId]
      );
      if (result.rows.length === 0) return sendJson(res, 404, { error: 'staff_not_found' });
      return sendJson(res, 200, { ok: true });
    }

    // ── /staff/:id/role - Задача 1 (Окно 14, 02.08.2026). Владелец меняет роль
    // сотрудника (например Мамедхан master→admin) - раньше чекбоксы роли в
    // crm-owner.html были кликабельны, но физически ничего не сохраняли, эндпоинта
    // не существовало вообще. Owner-only - роль решает исключительно Алихан.
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'role' && parts.length === 3 && req.method === 'PUT') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      const staffId = decodeURIComponent(parts[1]);
      const body = await readBody(req);
      const role = body.role;
      if (!['owner', 'admin', 'master'].includes(role)) return sendJson(res, 400, { error: 'invalid_role' });
      const result = await pool.query('UPDATE staff SET role = $1 WHERE id = $2 RETURNING id, role', [role, staffId]);
      if (result.rows.length === 0) return sendJson(res, 404, { error: 'staff_not_found' });
      return sendJson(res, 200, { ok: true, id: result.rows[0].id, role: result.rows[0].role });
    }

    // ── /services - каталог, доступен любой авторизованной роли ──────────
    if (parts[0] === 'services' && parts.length === 1 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      const result = await pool.query('SELECT id, name, category, duration_min, price, composition FROM services');
      return sendJson(
        res,
        200,
        result.rows.map((r) => ({
          id: r.id,
          name: r.name,
          category: r.category,
          durationMin: r.duration_min,
          price: r.price,
          composition: r.composition,
        }))
      );
    }

    // ── /master-services - цена и длительность ПО МАСТЕРУ (Окно 10, разд.17.2 ТЗ) ──
    // Один и тот же каталог услуг, разные мастера могут стоить по-разному (Елизавета
    // дешевле Али/Мамедхана) - см. миграцию 004_master_prices.sql. Правка 03.08.2026:
    // раньше требовал логин, "публичный сайт эти данные не запрашивает" (работал на
    // статике storage.js) - это и была причина бага (клиент видел все 8 услуг у
    // любого мастера, включая те, что мастер не оказывает). Теперь анонимный доступ
    // разрешён так же, как уже сделано для /schedule (Окно 15) - ничего чувствительнее
    // цены/длительности здесь нет, эти цифры и так были видны на сайте захардкоженными.
    if (parts[0] === 'master-services' && parts.length === 1 && req.method === 'GET') {
      const result = await pool.query('SELECT master_id, service_id, price, duration_min FROM master_services');
      return sendJson(
        res,
        200,
        result.rows.map((r) => ({
          masterId: r.master_id,
          serviceId: r.service_id,
          price: r.price,
          durationMin: r.duration_min,
        }))
      );
    }

    // ── /master-services/:masterId/:serviceId - Правка 03.08.2026, только владелец.
    // Раньше в карточке сотрудника были чекбоксы "какие услуги умеет" и поле
    // длительности - оба были чистой декорацией (никакого fetch, см. отчёт сессии),
    // хотя master_services в базе уже поддерживала ровно это с самого Окна 8. Теперь
    // реально включает/выключает услугу у мастера и его личную длительность.
    // enabled:false удаляет строку (мастер больше не оказывает услугу) - не бронь
    // затрагивает, только каталог на будущее. enabled:true создаёт/обновляет строку,
    // duration_min по умолчанию берётся из общего каталога services, если не передан.
    if (
      parts[0] === 'master-services' &&
      parts[1] &&
      parts[2] &&
      parts.length === 3 &&
      req.method === 'PUT'
    ) {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      const masterId = decodeURIComponent(parts[1]);
      const serviceId = decodeURIComponent(parts[2]);
      const body = await readBody(req);
      if (body.enabled === false) {
        await pool.query('DELETE FROM master_services WHERE master_id = $1 AND service_id = $2', [masterId, serviceId]);
        return sendJson(res, 200, { ok: true, enabled: false });
      }
      const serviceRes = await pool.query('SELECT price, duration_min FROM services WHERE id = $1', [serviceId]);
      if (serviceRes.rows.length === 0) return sendJson(res, 404, { error: 'service_not_found' });
      const price = Number.isFinite(body.price) ? body.price : serviceRes.rows[0].price;
      const durationMin = Number.isFinite(body.durationMin) ? body.durationMin : serviceRes.rows[0].duration_min;
      if (durationMin <= 0) return sendJson(res, 400, { error: 'invalid_duration' });
      await pool.query(
        `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4)
         ON CONFLICT (master_id, service_id) DO UPDATE SET price = $3, duration_min = $4`,
        [masterId, serviceId, price, durationMin]
      );
      return sendJson(res, 200, { ok: true, enabled: true, price, durationMin });
    }

    // ── /bookings - GET публичный (без клиентских данных) + по роли, POST для записи ──
    if (parts[0] === 'bookings' && parts.length === 1) {
      if (req.method === 'GET') {
        const auth = await authenticate(req);
        const bookings = await listBookingsForRequest(url, auth);
        return sendJson(res, 200, { bookings });
      }
      if (req.method === 'POST') {
        const auth = await authenticate(req);
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
        });
        return sendJson(res, result.status, result.body);
      }
    }

    // ── /bookings/:id/cancel - Задача 2 (Окно 13, 01.08.2026, Блок 5 в.19). Отмена
    // сама по себе ничем не ограничена по времени - ограничено только право на полный
    // возврат. Онлайн-оплаты в MVP нет (см. Ограничения промпта), поэтому "возврат"
    // здесь не реальная транзакция, а флаг refundEligible в ответе, на который
    // ориентируется сотрудник в разговоре с клиентом. Доступ сужен той же матрицей,
    // что и видимость самой брони (listBookingsForRequest): owner - любая, admin -
    // только своя точка, master - только свои записи.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'cancel' && parts.length === 3 && req.method === 'POST') {
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
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'status' && parts.length === 3 && req.method === 'PATCH') {
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

    // ── /sales - продажа (косметика и т.п.), привязана к визиту (разд.14.3 п.2) ──
    if (parts[0] === 'sales' && parts.length === 1) {
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

    // ── /schedule - смены + перерывы (список интервалов, разд.14.1) ──────
    if (parts[0] === 'schedule' && parts.length === 1) {
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
        if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readBody(req);
        if (!body.masterId || !body.date || !body.startTime || !body.endTime) {
          return sendJson(res, 400, { error: 'missing_fields' });
        }
        if (auth.role === 'admin') {
          const staffRes = await pool.query('SELECT location_id FROM staff WHERE id = $1', [body.masterId]);
          if (staffRes.rows.length === 0 || staffRes.rows[0].location_id !== auth.locationId) {
            return sendJson(res, 403, { error: 'forbidden' });
          }
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
             ON CONFLICT (master_id, date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time
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
        if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
        const masterId = url.searchParams.get('masterId');
        const date = url.searchParams.get('date');
        if (!masterId || !date) return sendJson(res, 400, { error: 'missing_fields' });
        if (auth.role === 'admin') {
          const staffRes = await pool.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
          if (staffRes.rows.length === 0 || staffRes.rows[0].location_id !== auth.locationId) {
            return sendJson(res, 403, { error: 'forbidden' });
          }
        }
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
    if (parts[0] === 'schedule-range' && parts.length === 1 && req.method === 'GET') {
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
    if (parts[0] === 'holidays' && parts.length === 1 && req.method === 'GET') {
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
    if (parts[0] === 'holidays' && parts[1] === 'close' && parts.length === 2 && req.method === 'POST') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
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
    if (parts[0] === 'schedule-availability' && parts.length === 1 && req.method === 'GET') {
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
    if (parts[0] === 'masters-next-availability' && parts.length === 1 && req.method === 'GET') {
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
    if (parts[0] === 'master-weekly-schedule' && parts.length === 1) {
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
        if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readBody(req);
        const rows = validateWeeklyChanges(body.weeklyChanges);
        if (!body.masterId || !rows) return sendJson(res, 400, { error: 'missing_fields' });
        if (auth.role === 'admin') {
          const staffRes = await pool.query('SELECT location_id FROM staff WHERE id = $1', [body.masterId]);
          if (staffRes.rows.length === 0 || staffRes.rows[0].location_id !== auth.locationId) {
            return sendJson(res, 403, { error: 'forbidden' });
          }
        }
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
          return sendJson(res, 200, { ok: true, conflicts: 0 });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }

    // ── /schedule-requests - согласование графика (Задача 3, Окно 14, 02.08.2026).
    // Мастер запрашивает перерыв/выходной → владелец получает уведомление →
    // одобряет/отклоняет → только при одобрении время реально блокируется
    // (applyScheduleDay + проверка в createBookingTx выше).
    if (parts[0] === 'schedule-requests' && parts.length === 1) {
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
    if (parts[0] === 'schedule-requests' && parts[1] && parts[2] === 'decision' && parts.length === 3 && req.method === 'PATCH') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
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
    if (parts[0] === 'schedule-requests' && parts[1] && parts[2] === 'cancel' && parts.length === 3 && req.method === 'PATCH') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
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

    // ── /notifications - Задача 5 (Окно 14, 02.08.2026). In-app поллинг, не push -
    // список/бейдж на странице, обновляется по таймеру фронтенда.
    if (parts[0] === 'notifications' && parts.length === 1 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
      let query = 'SELECT id, type, booking_id, schedule_request_id, related_master_id, title, body, read_at, created_at FROM notifications WHERE staff_id = $1';
      const params = [auth.id];
      if (unreadOnly) query += ' AND read_at IS NULL';
      query += ' ORDER BY created_at DESC LIMIT 50';
      const result = await pool.query(query, params);
      return sendJson(
        res,
        200,
        result.rows.map((r) => ({
          id: r.id,
          type: r.type,
          bookingId: r.booking_id,
          scheduleRequestId: r.schedule_request_id,
          relatedMasterId: r.related_master_id,
          title: r.title,
          body: r.body,
          read: r.read_at !== null,
          createdAt: r.created_at,
        }))
      );
    }

    if (parts[0] === 'notifications' && parts[1] === 'unread-count' && parts.length === 2 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      const result = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE staff_id = $1 AND read_at IS NULL', [auth.id]);
      return sendJson(res, 200, { count: result.rows[0].n });
    }

    if (parts[0] === 'notifications' && parts[1] && parts[2] === 'read' && parts.length === 3 && req.method === 'POST') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      await pool.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND staff_id = $2 AND read_at IS NULL', [parts[1], auth.id]);
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === 'notifications' && parts[1] === 'read-all' && parts.length === 2 && req.method === 'POST') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      await pool.query('UPDATE notifications SET read_at = now() WHERE staff_id = $1 AND read_at IS NULL', [auth.id]);
      return sendJson(res, 200, { ok: true });
    }

    // ── /payroll-settings - ставка ПО МАСТЕРУ (Окно 10, разд.17.3 ТЗ). Заменяет
    // единую строку payroll_settings (% по категории услуги + бонус за нового
    // клиента - оба подтверждённо не соответствуют реальной формуле Алихана,
    // разд.17.3/17.4) на master_payroll_settings: у каждого мастера одна
    // редактируемая ставка pct. Читать может любая роль (мастеру нужна своя ставка
    // для "Моей зарплаты"), но выдача сужена по той же матрице, что и /staff -
    // мастер видит только себя, админ только свою точку, владелец - всех. Менять
    // ставку может только владелец (разд.7 ТЗ: "Изменение прайса - я").
    if (parts[0] === 'payroll-settings' && parts.length === 1) {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET') {
        const masterId = url.searchParams.get('masterId');
        let query = 'SELECT mps.master_id, mps.pct FROM master_payroll_settings mps WHERE 1=1';
        const params = [];
        if (auth.role === 'master') {
          params.push(auth.id);
          query += ` AND mps.master_id = $${params.length}`;
        } else if (auth.role === 'admin') {
          params.push(auth.locationId);
          query += ` AND mps.master_id IN (SELECT id FROM staff WHERE location_id = $${params.length})`;
        }
        if (masterId) {
          params.push(masterId);
          query += ` AND mps.master_id = $${params.length}`;
        }
        const result = await pool.query(query, params);
        return sendJson(res, 200, result.rows.map((r) => ({ masterId: r.master_id, pct: Number(r.pct) })));
      }

      if (req.method === 'PUT') {
        if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readBody(req);
        if (!body.masterId || typeof body.pct !== 'number') {
          return sendJson(res, 400, { error: 'missing_fields' });
        }
        await pool.query(
          `INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, $2)
           ON CONFLICT (master_id) DO UPDATE SET pct = EXCLUDED.pct`,
          [body.masterId, body.pct]
        );
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── /payroll - Окно 37 (06.08.2026, Задача 1). ЗП мастера за произвольный
    // период (masterId+from+to) через computeMasterPayroll - единый резолвер вместо
    // клиентского дубля формулы. Мастер не может запросить чужую ЗП, даже подставив
    // чужой masterId в query - роль форсирует свой id, тот же приём, что уже есть у
    // /payroll-settings и listBookingsForRequest. Админ ограничен своей точкой
    // (проверка location_id) - тот же уровень защиты денежных данных, что и у
    // /payroll-settings GET, роут не завязан только на текущего потребителя
    // (crm-master.html), должен быть безопасен и при будущем переиспользовании.
    if (parts[0] === 'payroll' && parts.length === 1 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return sendJson(res, 400, { error: 'missing_fields' });
      let masterId = url.searchParams.get('masterId');
      if (auth.role === 'master') {
        masterId = auth.id;
      } else {
        if (!masterId) return sendJson(res, 400, { error: 'missing_fields' });
        if (auth.role === 'admin') {
          const staffRes = await pool.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
          if (staffRes.rows.length === 0) return sendJson(res, 404, { error: 'staff_not_found' });
          if (staffRes.rows[0].location_id !== auth.locationId) return sendJson(res, 403, { error: 'forbidden' });
        }
      }
      const result = await computeMasterPayroll(pool, masterId, from, to);
      return sendJson(res, 200, result);
    }

    // ── /revenue/today - Окно 38 (06.08.2026). Дневная выручка через
    // computeRevenueToday. Тот же приём разграничения по роли, что у /staff и
    // /payroll: администратор форсирован на свою точку (не может передать чужой
    // locationId), владелец без locationId получает сумму по ВСЕМ точкам, с
    // locationId - по конкретной.
    if (parts[0] === 'revenue' && parts[1] === 'today' && parts.length === 2 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
      const locationId = auth.role === 'admin' ? auth.locationId : url.searchParams.get('locationId');
      const result = await computeRevenueToday(pool, locationId);
      return sendJson(res, 200, result);
    }

    // ── /owner/alerts - Окно 40 (06.08.2026). Один агрегирующий роут для дашборда
    // "Сегодня" через computeOwnerAlerts - владелец получает три источника алертов
    // (мастера без графика, необработанные заявки, клиенты в риске) одним запросом.
    if (parts[0] === 'owner' && parts[1] === 'alerts' && parts.length === 2 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      const result = await computeOwnerAlerts(pool);
      return sendJson(res, 200, result);
    }

    // ── /clients?risk=true - Окно 39 (06.08.2026, Задача 1). Список "требует
    // внимания" через listClientsAtRisk. Тот же приём разграничения по роли, что у
    // /payroll и /revenue/today: admin форсирован на свою точку, master - на своих
    // клиентов (тех, у кого есть бронь с этим мастером), owner видит всех. Телефон -
    // тот же уровень видимости, что в GET /bookings (разд.12 п.1 ТЗ): мастеру не отдаём.
    if (parts[0] === 'clients' && parts.length === 1 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner', 'admin', 'master'])) return sendJson(res, 401, { error: 'unauthorized' });
      if (url.searchParams.get('risk') !== 'true') return sendJson(res, 400, { error: 'missing_fields' });
      const locationId = auth.role === 'admin' ? auth.locationId : undefined;
      const masterId = auth.role === 'master' ? auth.id : undefined;
      const list = await listClientsAtRisk(pool, { locationId, masterId });
      const shaped = auth.role === 'master' ? list.map(({ phone, ...rest }) => rest) : list;
      return sendJson(res, 200, shaped);
    }

    // ── /clients/:id - Окно 39 (06.08.2026, Задача 1). Карточка клиента через
    // getClientCard. Резолвер роль-агностичен (всегда отдаёт полную карточку) -
    // scoping и видимость телефона решает роут: admin видит клиента только если у
    // него есть хоть один визит на точке admin'а, master - только если есть визит У
    // ЭТОГО мастера (403, не тихий пустой ответ - тот же приём, что у /payroll с
    // чужим masterId). Существование клиента проверяется ДО scope-проверки - 404
    // для несуществующего id одинаков для всех ролей, не палит своей/чужой доступ.
    if (parts[0] === 'clients' && parts.length === 2 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner', 'admin', 'master'])) return sendJson(res, 401, { error: 'unauthorized' });
      const clientId = decodeURIComponent(parts[1]);
      const card = await getClientCard(pool, clientId);
      if (!card) return sendJson(res, 404, { error: 'client_not_found' });
      if (auth.role === 'admin' && !card.visits.some((v) => v.locationId === auth.locationId)) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      if (auth.role === 'master' && !card.visits.some((v) => v.masterId === auth.id)) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      if (auth.role === 'master') {
        const { phone, ...cardWithoutPhone } = card;
        return sendJson(res, 200, cardWithoutPhone);
      }
      return sendJson(res, 200, card);
    }

    sendJson(res, 404, { error: 'route_not_found' });
  } catch (err) {
    console.error('Ошибка обработки запроса:', err);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

// Простой авто-раннер миграций (правка 28.07.2026) - раньше новые .sql-файлы в
// migrations/ применялись вручную (нет доступа к psql/консоли Amvera из Claude Code
// между сессиями, ключ для SSH-деплоя одноразовый). Теперь при каждом старте сервер
// сам догоняет непроменённые файлы по имени, по одному разу каждый - без внешнего
// инструмента, без хардкода списка версий.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function runMigrations() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );
  const applied = new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

  // Задача D промпта Окна 29 (05.08.2026): до этой правки здесь был особый случай -
  // на пустой schema_migrations 001/002 помечались "применёнными" БЕЗ выполнения
  // (на боевой базе Amvera их накатили вручную ДО появления этого раннера, а их
  // INSERT-сиды упали бы на уже существующих строках). На боевой базе это больше не
  // нужно - schema_migrations там уже содержит явные строки '001_kv_store.sql' и
  // '002_schema.sql' (тот особый случай вставил их при самом первом старте раннера),
  // поэтому обычный `if (applied.has(file)) continue` ниже пропустит их сам, без
  // особого случая. На СВЕЖЕЙ базе (schema_migrations пустая) 001/002 теперь просто
  // выполняются как все остальные файлы по порядку - оба файла сделаны идемпотентными
  // (CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING), поэтому это безопасно.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Миграция применена: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`Миграция ${file} упала, сервер не стартует:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

// Задача 5 (Окно 14, 02.08.2026) - фоновый сканер "за 15 минут"/"время пришло" по
// сегодняшним броням. Раз в минуту, не системный push - только заполняет таблицу
// notifications, которую опрашивает уже открытая страница (см. GET /notifications
// выше). Уникальные индексы миграции 015 защищают от дублей при каждом тике.
// Узкие окна ниже [now, now+16мин) и (now-2мин, now] - grace-защита от лавины
// уведомлений, если сервер был выключен и стартует спустя часы: старые брони, чьё
// время реминдера/начала давно прошло, просто не попадают в окно, не бэкфилятся пачкой.
async function scanBookingReminders() {
  try {
    const now = Date.now();
    const todayStr = new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // МСК = UTC+3 круглый год
    const result = await pool.query(
      `SELECT id, master_id, start_time FROM bookings WHERE date = $1 AND status != 'cancelled'`,
      [todayStr]
    );
    for (const row of result.rows) {
      const startMs = new Date(`${todayStr}T${row.start_time}:00+03:00`).getTime();
      const minutesUntil = (startMs - now) / (1000 * 60);
      if (minutesUntil >= 0 && minutesUntil <= 16) {
        await notifyStaff(pool, row.master_id, 'booking_reminder_15', {
          bookingId: row.id,
          title: 'Через 15 минут запись',
          body: row.start_time,
        });
      }
      if (minutesUntil <= 0 && minutesUntil >= -2) {
        await notifyStaff(pool, row.master_id, 'booking_start', {
          bookingId: row.id,
          title: 'Время записи наступило',
          body: row.start_time,
        });
      }
    }
  } catch (err) {
    console.error('scanBookingReminders упал (не критично, попробуем через минуту):', err.message);
  }
}
// Окно 17 (04.08.2026) - миграции/фоновый сканер/listen раньше запускались на верхнем
// уровне модуля безусловно, поэтому импорт server.mjs (например из node --test для
// юнитов на чистых функциях резолвера) тянул за собой реальное подключение к БД и
// висящий процесс. Guard по стандартному ESM-паттерну "это главный модуль?" - при
// прямом запуске (`node server.mjs`, см. api/package.json start) ничего не меняется,
// при импорте как модуля - побочные эффекты не срабатывают.
async function startServer() {
  await runMigrations();
  setInterval(scanBookingReminders, 60 * 1000);
  server.listen(PORT, () => {
    console.log(`API alikhan-crm слушает порт ${PORT}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
