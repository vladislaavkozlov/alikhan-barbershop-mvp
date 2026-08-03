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

const { Pool } = pg;

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней - простой логин, не нужен рефреш-стек
// Задача 2 промпта корректировки Окна 13 (01.08.2026, Блок 5 в.19, Алихан): "отмена не
// позже 2 часов" - до порога полный возврат/бесплатная отмена, после - без возврата.
const CANCEL_FULL_REFUND_HOURS = 2;
// Правка 03.08.2026: "стандартное" правило графика действует бессрочно (нет
// конечной даты), поэтому проверка конфликтов с уже существующими бронями при
// одобрении делается на конечном окне вперёд, а не "навсегда" - после одобрения
// НОВЫЕ конфликтующие брони уже не создать (createBookingTx сверяется с
// getEffectiveBreaks), риск есть только для броней, сделанных ДО одобрения правила.
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
function toMinutes(value) {
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
function isoWeekday(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

// Правка Влада 03.08.2026: "стандартный" перерыв/выходной по дням недели, без
// конечной даты (schedule_recurring_rules) - действует ТОЛЬКО если для этой
// конкретной даты ещё нет явной записи в schedule_shifts. Явная правка одного дня
// (owner напрямую через POST /schedule, или одобренный разовый отгул/отпуск через
// applyScheduleDay) всегда побеждает стандартное правило - так и "редактировать на
// конкретный день" уже работает само, без отдельного механизма override.
async function getEffectiveBreaks(client, masterId, date) {
  const shiftRes = await client.query(
    `SELECT sb.start_time, sb.end_time FROM schedule_shifts ss
     LEFT JOIN schedule_breaks sb ON sb.shift_id = ss.id
     WHERE ss.master_id = $1 AND ss.date = $2`,
    [masterId, date]
  );
  if (shiftRes.rows.length > 0) {
    return shiftRes.rows.filter((r) => r.start_time).map((r) => ({ startTime: r.start_time, endTime: r.end_time }));
  }
  const weekday = isoWeekday(date);
  const rulesRes = await client.query(
    `SELECT rule_type, start_time, end_time FROM schedule_recurring_rules
     WHERE master_id = $1 AND active = true AND starts_on <= $2 AND $3 = ANY(weekdays)`,
    [masterId, date, weekday]
  );
  return rulesRes.rows.map((r) =>
    r.rule_type === 'day_off' ? { startTime: '10:00', endTime: '20:00' } : { startTime: r.start_time, endTime: r.end_time }
  );
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
    // онлайн-запись, не только показывается в интерфейсе. Правка 03.08.2026:
    // getEffectiveBreaks() дополнительно учитывает "стандартные" (по дням недели,
    // бессрочные) правила, если для этой даты нет явной записи на конкретный день.
    const effectiveBreaks = await getEffectiveBreaks(client, masterId, date);
    const hitsBreak = effectiveBreaks.some((b) => intervalsOverlap(startTime, endTime, b.startTime, b.endTime));
    if (hitsBreak) {
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

// Влад (03.08.2026) - если ставится перерыв/выходной на время, где у мастера уже
// есть реальная запись клиента, раньше об этом никто не узнавал (бронь просто
// оставалась "в силе" рядом с новым перерывом - клиент бы просто не застал
// мастера). Возвращает список пересекающихся броней с именем/телефоном клиента -
// вызывающий код решает, кого уведомить (см. notifications_type_check, миграция
// 019 добавляет тип 'schedule_conflict').
async function findScheduleConflicts(client, masterId, date, breaks) {
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

function conflictNotificationBody(masterName, date, conflicts) {
  const list = conflicts
    .map((c) => `${c.client_name || 'клиент'} (${c.start_time}–${c.end_time}${c.client_phone ? ', ' + c.client_phone : ''})`)
    .join('; ');
  return `${masterName}, ${date}: на это время уже назначены люди - ${list}. Свяжитесь и договоритесь с ними на другое время`;
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
        // Правка 03.08.2026: конкретный мастер+дата без явной записи на этот день -
        // подмешиваем "стандартное" правило (schedule_recurring_rules), тот же
        // эффективный перерыв, что уже реально проверяет createBookingTx
        // (getEffectiveBreaks) - иначе публичный виджет/календарь предложили бы
        // как свободное время, которое сервер потом всё равно отклонит.
        if (effectiveMasterId && date && !results.some((s) => s.date === date)) {
          const recurringBreaks = await getEffectiveBreaks(pool, effectiveMasterId, date);
          if (recurringBreaks.length) {
            results.push({ id: null, masterId: effectiveMasterId, date, startTime: '10:00', endTime: '20:00', breaks: recurringBreaks });
          }
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
          const shiftRes = await client.query(
            `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, $3, $4)
             ON CONFLICT (master_id, date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time
             RETURNING id`,
            [body.masterId, body.date, body.startTime, body.endTime]
          );
          const shiftId = shiftRes.rows[0].id;
          await client.query('DELETE FROM schedule_breaks WHERE shift_id = $1', [shiftId]);
          const newBreaks = body.breaks ?? [];
          for (const b of newBreaks) {
            await client.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
              shiftId,
              b.startTime,
              b.endTime,
            ]);
          }
          const conflicts = await findScheduleConflicts(client, body.masterId, body.date, newBreaks);
          if (conflicts.length) {
            const masterName = (await client.query('SELECT name FROM staff WHERE id = $1', [body.masterId])).rows[0]?.name ?? 'Мастер';
            await notifyStaff(client, auth.id, 'schedule_conflict', {
              title: 'Перерыв пересекается с записью',
              body: conflictNotificationBody(masterName, body.date, conflicts),
            });
          }
          await client.query('COMMIT');
          return sendJson(res, 200, { ok: true, id: shiftId, conflicts: conflicts.length });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }

    // ── /schedule-recurring - "стандартный" перерыв/выходной по дням недели, без
    // конечной даты (правка 03.08.2026). В отличие от /schedule-requests (мастер
    // просит → владелец одобряет), здесь владелец правит НАПРЯМУЮ - тот же уровень
    // прямого доступа, что уже есть у POST /schedule для разовых дат.
    if (parts[0] === 'schedule-recurring' && parts.length === 1) {
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET') {
        const masterId = url.searchParams.get('masterId');
        if (auth.role === 'master' && masterId && masterId !== auth.id) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
        const effectiveMasterId = auth.role === 'master' ? auth.id : masterId;
        let query = `SELECT id, master_id, rule_type, weekdays, start_time, end_time, starts_on, active
                     FROM schedule_recurring_rules WHERE active = true`;
        const params = [];
        if (effectiveMasterId) {
          params.push(effectiveMasterId);
          query += ` AND master_id = $${params.length}`;
        } else if (auth.role === 'admin') {
          const staffIds = await pool.query('SELECT id FROM staff WHERE location_id = $1', [auth.locationId]);
          params.push(staffIds.rows.map((r) => r.id) || [null]);
          query += ` AND master_id = ANY($${params.length})`;
        }
        const result = await pool.query(query, params);
        return sendJson(
          res,
          200,
          result.rows.map((r) => ({
            id: r.id,
            masterId: r.master_id,
            ruleType: r.rule_type,
            weekdays: r.weekdays,
            startTime: r.start_time,
            endTime: r.end_time,
            startsOn: r.starts_on instanceof Date ? r.starts_on.toISOString().slice(0, 10) : r.starts_on,
          }))
        );
      }

      if (req.method === 'POST') {
        if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readBody(req);
        if (!body.masterId || !['break', 'day_off'].includes(body.ruleType)) {
          return sendJson(res, 400, { error: 'missing_fields' });
        }
        const weekdays = Array.isArray(body.weekdays) ? body.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
        if (weekdays.length === 0) return sendJson(res, 400, { error: 'missing_weekdays' });
        if (body.ruleType === 'break' && (!body.startTime || !body.endTime)) {
          return sendJson(res, 400, { error: 'missing_time' });
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
          await client.query(
            `UPDATE schedule_recurring_rules SET active = false WHERE master_id = $1 AND rule_type = $2 AND active = true`,
            [body.masterId, body.ruleType]
          );
          const startTime = body.ruleType === 'day_off' ? null : body.startTime;
          const endTime = body.ruleType === 'day_off' ? null : body.endTime;
          const startsOn = body.startsOn || shopNow().date;
          const ruleRes = await client.query(
            `INSERT INTO schedule_recurring_rules (master_id, rule_type, weekdays, start_time, end_time, starts_on)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [body.masterId, body.ruleType, weekdays, startTime, endTime, startsOn]
          );
          await client.query('COMMIT');
          return sendJson(res, 200, { ok: true, id: ruleRes.rows[0].id });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }

    if (parts[0] === 'schedule-recurring' && parts[1] && parts.length === 2 && req.method === 'DELETE') {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
      const ruleId = Number(parts[1]);
      if (auth.role === 'admin') {
        const ruleRes = await pool.query(
          `SELECT s.location_id FROM schedule_recurring_rules r JOIN staff s ON s.id = r.master_id WHERE r.id = $1`,
          [ruleId]
        );
        if (ruleRes.rows.length === 0 || ruleRes.rows[0].location_id !== auth.locationId) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
      }
      const result = await pool.query('UPDATE schedule_recurring_rules SET active = false WHERE id = $1 RETURNING id', [ruleId]);
      if (result.rows.length === 0) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, { ok: true });
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
        // Правка 03.08.2026: 4 категории вместо 2 - category описывает, ЧТО выбрал
        // мастер (ярлык Влада), requestType - ЧЕМ это оказывается механически
        // (break/day_off). Для стандартных категорий requestType выводится из
        // category на сервере, а не приходит отдельно - чтобы UI не мог их рассинхронить.
        const category = body.category;
        const validCategories = ['otgul', 'otpusk', 'pereryv_standard', 'vyhodnoy_standard'];
        if (!validCategories.includes(category)) return sendJson(res, 400, { error: 'invalid_category' });
        const isRecurring = category === 'pereryv_standard' || category === 'vyhodnoy_standard';
        const requestType = category === 'pereryv_standard' ? 'break' : category === 'vyhodnoy_standard' ? 'day_off' : body.requestType;
        if (!['break', 'day_off'].includes(requestType)) return sendJson(res, 400, { error: 'invalid_request_type' });
        if (!body.dateFrom) return sendJson(res, 400, { error: 'missing_fields' });
        if (requestType === 'break' && (!body.startTime || !body.endTime)) {
          return sendJson(res, 400, { error: 'missing_time' });
        }
        let weekdays = null;
        if (isRecurring) {
          weekdays = Array.isArray(body.weekdays) ? body.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
          if (weekdays.length === 0) return sendJson(res, 400, { error: 'missing_weekdays' });
        }
        const dateTo = isRecurring ? null : body.dateTo || body.dateFrom;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const reqRes = await client.query(
            `INSERT INTO schedule_change_requests (master_id, request_type, category, date_from, date_to, start_time, end_time, weekdays, master_comment)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [auth.id, requestType, category, body.dateFrom, dateTo, body.startTime ?? null, body.endTime ?? null, weekdays, body.masterComment ?? null]
          );
          const requestId = reqRes.rows[0].id;
          const masterName = (await client.query('SELECT name FROM staff WHERE id = $1', [auth.id])).rows[0]?.name ?? 'Мастер';
          const owners = await client.query(`SELECT id FROM staff WHERE role = 'owner'`);
          const WEEKDAY_LABEL = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
          const categoryLabel = { otgul: 'отгул', otpusk: 'отпуск', pereryv_standard: 'стандартный перерыв', vyhodnoy_standard: 'стандартный выходной' }[category];
          const period = isRecurring
            ? `по ${weekdays.map((d) => WEEKDAY_LABEL[d - 1]).join(',')}${requestType === 'break' ? ` ${body.startTime}–${body.endTime}` : ''} с ${body.dateFrom}`
            : requestType === 'day_off'
              ? `${body.dateFrom}–${dateTo}`
              : `${body.dateFrom} ${body.startTime}–${body.endTime}`;
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
                             weekdays, master_comment, status, owner_comment, decided_by, decided_at
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
            weekdays: r.weekdays,
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
        await client.query(
          `UPDATE schedule_change_requests SET status = $1, owner_comment = $2, decided_by = $3, decided_at = now() WHERE id = $4`,
          [body.decision, body.ownerComment ?? null, auth.id, requestId]
        );
        if (body.decision === 'approved') {
          const isRecurring = reqRow.category === 'pereryv_standard' || reqRow.category === 'vyhodnoy_standard';
          const conflictsByDate = [];

          if (isRecurring) {
            // Правка 03.08.2026: "стандартное" правило - не материализуется по датам
            // (schedule_shifts/schedule_breaks), а живёт отдельно (schedule_recurring_rules)
            // и резолвится на лету (getEffectiveBreaks) - см. её комментарий выше.
            // Только ОДНО активное правило каждого типа на мастера - новое одобрение
            // заменяет прежнее (деактивирует), а не накапливается рядом с ним.
            const startsOn = reqRow.date_from instanceof Date ? reqRow.date_from.toISOString().slice(0, 10) : reqRow.date_from;
            const startTime = reqRow.request_type === 'day_off' ? null : reqRow.start_time;
            const endTime = reqRow.request_type === 'day_off' ? null : reqRow.end_time;
            await client.query(
              `UPDATE schedule_recurring_rules SET active = false WHERE master_id = $1 AND rule_type = $2 AND active = true`,
              [reqRow.master_id, reqRow.request_type]
            );
            await client.query(
              `INSERT INTO schedule_recurring_rules (master_id, rule_type, weekdays, start_time, end_time, starts_on, source_request_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [reqRow.master_id, reqRow.request_type, reqRow.weekdays, startTime, endTime, startsOn, requestId]
            );
            const effStart = reqRow.request_type === 'day_off' ? '10:00' : reqRow.start_time;
            const effEnd = reqRow.request_type === 'day_off' ? '20:00' : reqRow.end_time;
            for (let d = new Date(`${startsOn}T00:00:00Z`), i = 0; i < RECURRING_CONFLICT_LOOKAHEAD_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
              const dateStr = d.toISOString().slice(0, 10);
              if (!reqRow.weekdays.includes(isoWeekday(dateStr))) continue;
              const conflicts = await findScheduleConflicts(client, reqRow.master_id, dateStr, [{ startTime: effStart, endTime: effEnd }]);
              if (conflicts.length) conflictsByDate.push({ date: dateStr, conflicts });
            }
          } else {
            const dateFrom = reqRow.date_from instanceof Date ? reqRow.date_from.toISOString().slice(0, 10) : reqRow.date_from;
            const dateTo = reqRow.date_to instanceof Date ? reqRow.date_to.toISOString().slice(0, 10) : reqRow.date_to;
            const startTime = reqRow.request_type === 'day_off' ? '10:00' : reqRow.start_time;
            const endTime = reqRow.request_type === 'day_off' ? '20:00' : reqRow.end_time;
            // Влад (03.08.2026) - подтверждение выходного/перерыва реально блокирует
            // время (applyScheduleDay), но раньше молча накладывалось поверх уже
            // существующих записей клиентов - владелец узнавал о столкновении только
            // если сам заметил в календаре. Собираем конфликты по КАЖДОМУ дню диапазона
            // (day_off может растянуться на несколько дней = по сути отпуск).
            for (let d = new Date(`${dateFrom}T00:00:00Z`); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
              const dateStr = d.toISOString().slice(0, 10);
              await applyScheduleDay(client, reqRow.master_id, dateStr, startTime, endTime);
              const conflicts = await findScheduleConflicts(client, reqRow.master_id, dateStr, [{ startTime, endTime }]);
              if (conflicts.length) conflictsByDate.push({ date: dateStr, conflicts });
            }
          }

          if (conflictsByDate.length) {
            const masterName = (await client.query('SELECT name FROM staff WHERE id = $1', [reqRow.master_id])).rows[0]?.name ?? 'Мастер';
            await notifyStaff(client, auth.id, 'schedule_conflict', {
              scheduleRequestId: requestId,
              title: 'Одобренный график пересекается с записью',
              body: conflictsByDate.map(({ date, conflicts }) => conflictNotificationBody(masterName, date, conflicts)).join(' | '),
            });
          }
        }
        await notifyStaff(client, reqRow.master_id, 'schedule_request_decided', {
          scheduleRequestId: requestId,
          title: body.decision === 'approved' ? 'Запрос одобрен' : 'Запрос отклонён',
          body: body.ownerComment || (reqRow.request_type === 'day_off' ? 'Выходной' : 'Перерыв'),
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

await runMigrations();

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
setInterval(scanBookingReminders, 60 * 1000);

server.listen(PORT, () => {
  console.log(`API alikhan-crm слушает порт ${PORT}`);
});
