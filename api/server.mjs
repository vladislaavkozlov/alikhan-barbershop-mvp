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
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

// Окно 17 (04.08.2026) - найдено живым тестом при проверке Задач 0/1/2 (не гипотеза):
// pg парсит SQL `date` (schedule_shifts.date, schedule_change_requests.date_from/
// date_to, bookings.date, clients.birthday) в JS Date как ЛОКАЛЬНУЮ полночь этого
// календарного дня. Файл в нескольких местах (GET /schedule, GET /bookings, GET/PATCH
// /schedule-requests) читает эти значения через `.toISOString().slice(0, 10)`, что
// конвертирует в UTC - если процесс Node работает не в UTC, дата съезжает на день.
// Живой репро на MSK (UTC+3): разовая правка на 2026-08-11 отображалась как
// 2026-08-10, применённый day_off на 2026-08-25 писался в БД как 2026-08-24.
// Комментарий выше по файлу уже предупреждал "часовой пояс сервера Amvera
// неизвестен, может быть UTC" - явный пин TZ здесь превращает это в гарантию, а не
// предположение, без переписывания всех мест с этим паттерном (не в этом окне,
// но подряд - см. отчёт Окна 17). Ставим ДО создания Pool - конструктор pg
// регистрирует парсеры типов один раз при первом использовании модуля.
process.env.TZ = 'UTC';

const { Pool } = pg;

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней - простой логин, не нужен рефреш-стек
// Задача 2 промпта корректировки Окна 13 (01.08.2026, Блок 5 в.19, Алихан): "отмена не
// позже 2 часов" - до порога полный возврат/бесплатная отмена, после - без возврата.
const CANCEL_FULL_REFUND_HOURS = 2;
// Правка 03.08.2026: недельный график (master_weekly_schedule) действует бессрочно
// (нет конечной даты), поэтому проверка конфликтов с уже существующими бронями при
// сохранении/одобрении делается на конечном окне вперёд, а не "навсегда" - после
// сохранения НОВЫЕ конфликтующие брони уже не создать (createBookingTx сверяется с
// getEffectiveSchedule), риск есть только для броней, сделанных ДО правки графика.
const RECURRING_CONFLICT_LOOKAHEAD_DAYS = 90;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// ── PIN-хэш (email+PIN логин, Шаг 3 Окна 8) ────────────────────────────────
// scrypt из node:crypto - без внешней зависимости (bcrypt пришлось бы ставить через
// npm install, который в песочнице ненадёжен - см. память проекта). Формат хранения:
// "saltHex:hashHex".
function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const candidate = scryptSync(pin, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

async function createSession(staffId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (token, staff_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    staffId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

// Возвращает { id, name, role, locationId } текущего сотрудника по Bearer-токену,
// или null (анонимный запрос - легален для GET/POST /bookings, см. ниже).
async function authenticate(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.id, s.name, s.role, s.location_id, sess.expires_at
     FROM sessions sess JOIN staff s ON s.id = sess.staff_id
     WHERE sess.token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, name: row.name, role: row.role, locationId: row.location_id };
}

// ── Время/интервалы (те же правила, что storage.js на фронтенде) ──────────
export function toMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function addMinutes(time, minutes) {
  return minutesToTime(toMinutes(time) + minutes);
}
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const aS = toMinutes(aStart);
  const aE = toMinutes(aEnd);
  const bS = toMinutes(bStart);
  const bE = toMinutes(bEnd);
  return aS < bE && bS < aE;
}

// Баг Влада (02.08.2026): ничего не мешало забронировать уже прошедшее сегодняшнее
// время (например 10:00, когда на часах 13:38) - ни фронт, ни сервер это не
// проверяли. Все date/time в этой системе - наивные строки в местном времени
// барбершопа (Ставрополь = московское, UTC+3, переводов часов в РФ с 2014 нет,
// см. api/migrations/*) - не полагаемся на часовой пояс самого сервера Amvera
// (неизвестен, может быть UTC), считаем "сейчас" явно со сдвигом +3.
function shopNow() {
  const shopMs = Date.now() + 3 * 60 * 60 * 1000;
  const d = new Date(shopMs);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return { date, time };
}

// Атомарная compare-and-swap запись поверх kv_store - оставлена для обратной
// совместимости общего /kv/:key контракта (Окно 7), bookings им больше не пишутся.
async function casWrite(key, expected, value) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const current = await client.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const currentValue = current.rows[0]?.value ?? null;
    if (currentValue !== (expected ?? null)) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
    }
    await client.query(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ISO-номер дня недели (1=Пн..7=Вс) для строки "YYYY-MM-DD" - полдень UTC, чтобы
// не словить сдвиг даты на TZ-границе (тот же приём, что уже используется в этом
// файле для дат из Postgres, см. shopNow()/дата-циклы выше).
export function isoWeekday(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

// Глобальный дефолт рабочего окна, когда для мастера нет ни явной правки на дату
// (schedule_shifts), ни строки в master_weekly_schedule на этот день недели - тот
// же фолбэк 10:00-20:00, что и раньше (см. storage.js MASTERS[].workWindow).
const GLOBAL_DEFAULT_START = '10:00';
const GLOBAL_DEFAULT_END = '20:00';

// Правка Влада 03.08.2026 (Окно 16): единый блок "График работы" - рабочее окно
// (старт/конец смены) теперь тоже часть стандартного графика по дням недели
// (master_weekly_schedule), не только перерыв/выходной. Явная правка одного дня
// (owner напрямую через POST /schedule, или одобренный разовый отгул/отпуск через
// applyScheduleDay) всегда побеждает стандартный график - так и "редактировать на
// конкретный день" уже работает само, без отдельного механизма override.
export async function getEffectiveSchedule(client, masterId, date) {
  const shiftRes = await client.query(
    `SELECT ss.start_time, ss.end_time, sb.start_time AS b_start, sb.end_time AS b_end
     FROM schedule_shifts ss
     LEFT JOIN schedule_breaks sb ON sb.shift_id = ss.id
     WHERE ss.master_id = $1 AND ss.date = $2`,
    [masterId, date]
  );
  if (shiftRes.rows.length > 0) {
    const { start_time: startTime, end_time: endTime } = shiftRes.rows[0];
    const breaks = shiftRes.rows.filter((r) => r.b_start).map((r) => ({ startTime: r.b_start, endTime: r.b_end }));
    return { startTime, endTime, breaks };
  }
  const weekday = isoWeekday(date);
  const weeklyRes = await client.query(
    `SELECT is_working, work_start, work_end, break_start, break_end
     FROM master_weekly_schedule WHERE master_id = $1 AND weekday = $2`,
    [masterId, weekday]
  );
  if (weeklyRes.rows.length === 0) {
    return { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [] };
  }
  const row = weeklyRes.rows[0];
  if (!row.is_working) {
    return { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }] };
  }
  const breaks = row.break_start ? [{ startTime: row.break_start, endTime: row.break_end }] : [];
  return { startTime: row.work_start, endTime: row.work_end, breaks };
}

// Единое представление "занятого" времени дня - до начала смены, после конца смены
// и сами перерывы - как один список интервалов. Позволяет и createBookingTx, и
// findScheduleConflicts проверять пересечение брони с ЛЮБОЙ причиной блокировки
// одной и той же функцией (intervalsOverlap), не дублируя отдельную проверку границ
// рабочего окна.
function blockedIntervalsFor(schedule) {
  return [
    { startTime: '00:00', endTime: schedule.startTime },
    { startTime: schedule.endTime, endTime: '23:59' },
    ...schedule.breaks,
  ].filter((b) => b.startTime < b.endTime);
}

// Окно 17 (04.08.2026) - GET /schedule-range (Задача 1). "Выходной день" в рамках
// эффективного графика ОДНОГО дня - когда хотя бы один перерыв целиком покрывает
// реальное рабочее окно этого дня (schedule.startTime/endTime из getEffectiveSchedule,
// не фиксированные 10:00-20:00 - в отличие от assets/crm-calendar.js:44-49, где окно
// календаря всегда 10:00-20:00, здесь рабочее окно у разных мастеров/дней уже может
// отличаться после Окна 16). Тот же принцип проверки (перерыв ⊇ весь день), просто
// применён к фактическим границам дня, а не к константе экрана.
export function isScheduleDayOff(schedule) {
  return schedule.breaks.some(
    (b) => toMinutes(b.startTime) <= toMinutes(schedule.startTime) && toMinutes(b.endTime) >= toMinutes(schedule.endTime)
  );
}

export const SCHEDULE_RANGE_MAX_DAYS = 62; // чуть больше 2 месяцев - масштаб, о котором Влад говорил про YClients

// Число дней в диапазоне [from, to] включительно. NaN, если даты некорректны.
export function rangeDayCount(from, to) {
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return NaN;
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
}

// Эффективный график на каждый день диапазона одним проходом - цикл вокруг уже
// проверенного резолвера getEffectiveSchedule (разовая правка → недельный график →
// глобальный дефолт), логику резолва не дублирует.
export async function computeScheduleRangeDays(client, masterId, from, to) {
  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const eff = await getEffectiveSchedule(client, masterId, dateStr);
    days.push({
      date: dateStr,
      startTime: eff.startTime,
      endTime: eff.endTime,
      breaks: eff.breaks,
      isDayOff: isScheduleDayOff(eff),
    });
  }
  return days;
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

function requireRole(auth, roles) {
  return auth && roles.includes(auth.role);
}

// Задача 5 (Окно 14, 02.08.2026) - создаёт уведомление в личном кабинете. Уникальные
// индексы notifications_booking_dedup/notifications_schedreq_dedup (миграция 015)
// защищают от дублей при повторном вызове (например фоновый сканер + ручное
// действие в одну минуту) - ON CONFLICT DO NOTHING, не считается ошибкой.
async function notifyStaff(client, staffId, type, { bookingId = null, scheduleRequestId = null, title, body = null }) {
  await client.query(
    `INSERT INTO notifications (id, staff_id, type, booking_id, schedule_request_id, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [`ntf-${randomBytes(8).toString('hex')}`, staffId, type, bookingId, scheduleRequestId, title, body]
  );
}

// Окно 16 (03.08.2026) - валидирует payload единого блока "График работы" (владелец
// PUT /master-weekly-schedule напрямую, или мастер POST /schedule-requests с
// category=grafik_standard - обе ветки шлют один и тот же формат). Возвращает null,
// если payload некорректен (вызывающий код отвечает 400), иначе нормализованный
// массив строк (лишние поля обнулены - is_working=false никогда не хранит рабочее
// окно/перерыв, это же гарантирует и CHECK на уровне таблицы).
function validateWeeklyChanges(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seen = new Set();
  const rows = [];
  for (const c of input) {
    if (!Number.isInteger(c?.weekday) || c.weekday < 1 || c.weekday > 7 || seen.has(c.weekday)) return null;
    seen.add(c.weekday);
    const isWorking = !!c.isWorking;
    if (isWorking && (!c.workStart || !c.workEnd)) return null;
    if (!!c.breakStart !== !!c.breakEnd) return null;
    rows.push({
      weekday: c.weekday,
      isWorking,
      workStart: isWorking ? c.workStart : null,
      workEnd: isWorking ? c.workEnd : null,
      breakStart: isWorking && c.breakStart ? c.breakStart : null,
      breakEnd: isWorking && c.breakEnd ? c.breakEnd : null,
    });
  }
  return rows;
}

// Полная замена недельного графика мастера - удаляем все прежние строки и пишем
// присланные заново (не upsert по дням: массив weeklyChanges - это ВЕСЬ график,
// который прислал клиент, дни, отсутствующие в массиве, откатываются на глобальный
// дефолт 10:00-20:00, см. getEffectiveSchedule).
async function writeWeeklySchedule(client, masterId, rows) {
  await client.query('DELETE FROM master_weekly_schedule WHERE master_id = $1', [masterId]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end, break_start, break_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [masterId, r.weekday, r.isWorking, r.workStart, r.workEnd, r.breakStart, r.breakEnd]
    );
  }
}

const WEEKDAY_LABEL = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
function formatWeeklyChangesSummary(rows) {
  return [...rows]
    .sort((a, b) => a.weekday - b.weekday)
    .map((r) => {
      if (!r.isWorking) return `${WEEKDAY_LABEL[r.weekday - 1]} выходной`;
      const brk = r.breakStart ? ` (перерыв ${r.breakStart}–${r.breakEnd})` : '';
      return `${WEEKDAY_LABEL[r.weekday - 1]} ${r.workStart}–${r.workEnd}${brk}`;
    })
    .join(', ');
}

// Новый график может сузить рабочее окно или добавить перерыв на день, где у
// мастера уже есть реальные записи клиентов дальше в будущем - тот же принцип, что
// уже был у "стандартного" правила (RECURRING_CONFLICT_LOOKAHEAD_DAYS вперёd), но
// теперь через единый blockedIntervalsFor (окно + перерыв, не только перерыв).
// Дни, где на конкретную дату уже есть явная разовая правка (schedule_shifts),
// пропускаем - там всё равно побеждает не недельный график, а эта правка (см.
// getEffectiveSchedule), реального конфликта с НОВЫМ графиком там нет.
export async function findWeeklyScheduleConflicts(client, masterId, rows) {
  const changedByWeekday = new Map(rows.map((r) => [r.weekday, r]));
  const conflictsByDate = [];
  const { date: todayStr } = shopNow();
  for (let d = new Date(`${todayStr}T00:00:00Z`), i = 0; i < RECURRING_CONFLICT_LOOKAHEAD_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const change = changedByWeekday.get(isoWeekday(dateStr));
    if (!change) continue;
    const hasOverride = (await client.query('SELECT 1 FROM schedule_shifts WHERE master_id = $1 AND date = $2', [masterId, dateStr])).rows.length > 0;
    if (hasOverride) continue;
    const schedule = change.isWorking
      ? { startTime: change.workStart, endTime: change.workEnd, breaks: change.breakStart ? [{ startTime: change.breakStart, endTime: change.breakEnd }] : [] }
      : { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }] };
    const conflicts = await findScheduleConflicts(client, masterId, dateStr, blockedIntervalsFor(schedule));
    if (conflicts.length) conflictsByDate.push({ date: dateStr, conflicts });
  }
  return conflictsByDate;
}

// Влад (03.08.2026) - если ставится перерыв/выходной на время, где у мастера уже
// есть реальная запись клиента, раньше об этом никто не узнавал (бронь просто
// оставалась "в силе" рядом с новым перерывом - клиент бы просто не застал
// мастера). Возвращает список пересекающихся броней с именем/телефоном клиента -
// вызывающий код решает, кого уведомить (см. notifications_type_check, миграция
// 019 добавляет тип 'schedule_conflict').
export async function findScheduleConflicts(client, masterId, date, breaks) {
  if (!breaks.length) return [];
  const bookingsRes = await client.query(
    `SELECT b.start_time, b.end_time, c.name AS client_name, c.phone AS client_phone
     FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
     WHERE b.master_id = $1 AND b.date = $2 AND b.status != 'cancelled'`,
    [masterId, date]
  );
  return bookingsRes.rows.filter((b) =>
    breaks.some((br) => intervalsOverlap(br.startTime, br.endTime, b.start_time, b.end_time))
  );
}

// Задача 3 (Окно 14, 02.08.2026) - применяет одобренный перерыв/выходной к графику
// ОДНОГО дня. В отличие от POST /schedule (server.mjs, обработчик ниже), который
// перед вставкой удаляет ВСЕ перерывы дня целиком (транзакционная замена) - здесь
// только ДОБАВЛЯЕМ новый интервал поверх уже сохранённых, ничего не стирая. Для
// day_off (весь день) используем временный дефолт рабочего окна 10:00-20:00 (тот же,
// что storage.js:14-18) - в схеме staff пока нет своих default_start_time/end_time
// на сотрудника, заводить miграцию под это не стали (см. Ограничения промпта).
async function applyScheduleDay(client, masterId, date, startTime, endTime) {
  const shiftRes = await client.query(
    `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, '10:00', '20:00')
     ON CONFLICT (master_id, date) DO UPDATE SET master_id = EXCLUDED.master_id
     RETURNING id`,
    [masterId, date]
  );
  const shiftId = shiftRes.rows[0].id;
  await client.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
    shiftId,
    startTime,
    endTime,
  ]);
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

    // ── Устаревший общий kv-контракт (Окно 7) - оставлен как есть ────────
    if (parts[0] === 'kv' && parts[1] && !parts[2]) {
      const key = decodeURIComponent(parts[1]);

      if (req.method === 'GET') {
        const result = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
        if (result.rows.length === 0) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { value: result.rows[0].value });
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.value !== 'string') return sendJson(res, 400, { error: 'value_required' });
        await pool.query(
          `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, body.value]
        );
        return sendJson(res, 200, { ok: true });
      }
    }

    if (parts[0] === 'kv' && parts[1] && parts[2] === 'cas' && req.method === 'POST') {
      const key = decodeURIComponent(parts[1]);
      const body = await readBody(req);
      if (typeof body.value !== 'string') return sendJson(res, 400, { error: 'value_required' });
      const result = await casWrite(key, body.expected ?? null, body.value);
      if (!result.ok) return sendJson(res, 409, { error: 'conflict' });
      return sendJson(res, 200, { ok: true });
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
      return sendJson(
        res,
        200,
        result.rows.map((r) => ({
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
        }))
      );
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
        let weeklyRows, dayOffDates, dayOffStartTime, dayOffEndTime;
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
            const dateFrom = reqRow.date_from instanceof Date ? reqRow.date_from.toISOString().slice(0, 10) : reqRow.date_from;
            const dateTo = reqRow.date_to instanceof Date ? reqRow.date_to.toISOString().slice(0, 10) : reqRow.date_to;
            dayOffStartTime = reqRow.request_type === 'day_off' ? '10:00' : reqRow.start_time;
            dayOffEndTime = reqRow.request_type === 'day_off' ? '20:00' : reqRow.end_time;
            dayOffDates = [];
            // Влад (03.08.2026) - подтверждение выходного/перерыва реально блокирует
            // время (applyScheduleDay), но раньше молча накладывалось поверх уже
            // существующих записей клиентов. Собираем конфликты по КАЖДОМУ дню
            // диапазона (day_off может растянуться на несколько дней = по сути отпуск)
            // ДО применения - applyScheduleDay ниже вызывается вторым проходом по тем
            // же датам, только если весь диапазон чист.
            for (let d = new Date(`${dateFrom}T00:00:00Z`); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
              const dateStr = d.toISOString().slice(0, 10);
              dayOffDates.push(dateStr);
              const conflicts = await findScheduleConflicts(client, reqRow.master_id, dateStr, [
                { startTime: dayOffStartTime, endTime: dayOffEndTime },
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
              await applyScheduleDay(client, reqRow.master_id, dateStr, dayOffStartTime, dayOffEndTime);
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

    // ── /notifications - Задача 5 (Окно 14, 02.08.2026). In-app поллинг, не push -
    // список/бейдж на странице, обновляется по таймеру фронтенда.
    if (parts[0] === 'notifications' && parts.length === 1 && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
      const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
      let query = 'SELECT id, type, booking_id, schedule_request_id, title, body, read_at, created_at FROM notifications WHERE staff_id = $1';
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

  // 001/002 уже накатаны вручную ДО того, как появился этот раннер (staff/services/
  // bookings в проде уже работают на этой схеме) - если таблица трекинга только что
  // создана (пустая), помечаем эту пару "применённой" без повторного выполнения,
  // иначе INSERT-ы сида в 002 упадут на уже существующих строках и сервер не стартует.
  const BASELINE = ['001_kv_store.sql', '002_schema.sql'];
  if (applied.size === 0) {
    for (const file of BASELINE) {
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      applied.add(file);
    }
  }

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
