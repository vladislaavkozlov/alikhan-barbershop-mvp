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
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней - простой логин, не нужен рефреш-стек

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
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

// ── Бронирование поверх нормализованной схемы (Шаг 1-2 Окна 8) ────────────
// Та же гарантия, что раньше давал casWrite по kv_store: pg_advisory_xact_lock
// сериализует все параллельные попытки одного мастера на одну дату, поэтому два
// устройства не могут обе "выиграть" один слот (см. storage.js/createBooking).
async function createBookingTx({ masterId, serviceId, date, startTime, clientName, clientPhone, channel }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${masterId}:${date}`]);

    const msRes = await client.query(
      'SELECT duration_min FROM master_services WHERE master_id = $1 AND service_id = $2',
      [masterId, serviceId]
    );
    if (msRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master_service' } };
    }
    const endTime = addMinutes(startTime, msRes.rows[0].duration_min);

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

    const staffRes = await client.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
    if (staffRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master' } };
    }
    const locationId = staffRes.rows[0].location_id;

    let clientId = null;
    if (clientPhone) {
      const clientRes = await client.query(
        `INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name)
         RETURNING id`,
        [`client-${randomBytes(6).toString('hex')}`, clientName ?? null, clientPhone]
      );
      clientId = clientRes.rows[0].id;
    }

    const bookingId = `${date}-${startTime}-${masterId}-${randomBytes(4).toString('hex')}`;
    await client.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'planned', $9)`,
      [bookingId, locationId, masterId, serviceId, clientId, date, startTime, endTime, channel ?? 'client']
    );
    await client.query('COMMIT');
    return {
      status: 200,
      body: { ok: true, booking: { id: bookingId, masterId, serviceId, date, startTime, endTime, clientName, clientPhone } },
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

  let query = `SELECT b.id, b.master_id, b.service_id, b.date, b.start_time, b.end_time, b.status,
                      b.client_confirmed, b.location_id, c.name AS client_name, c.phone AS client_phone
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

  return result.rows.map((r) => {
    const base = {
      id: r.id,
      masterId: r.master_id,
      serviceId: r.service_id,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      status: r.status,
      clientConfirmed: r.client_confirmed,
    };
    if (!auth) return base; // клиент без входа - карточек других клиентов вообще не видит
    if (auth.role === 'owner' || auth.role === 'admin') {
      return { ...base, clientName: r.client_name, clientPhone: r.client_phone };
    }
    return { ...base, clientName: r.client_name }; // master: имя видно, телефон - нет
  });
}

function requireRole(auth, roles) {
  return auth && roles.includes(auth.role);
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
      let query = `SELECT id, location_id, name, photo_url, phone, email, role, employed, provides_services, has_system_access FROM staff WHERE 1=1`;
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
        }))
      );
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
        const required = ['masterId', 'serviceId', 'date', 'startTime'];
        if (required.some((k) => !body[k])) return sendJson(res, 400, { error: 'missing_fields' });
        const result = await createBookingTx({
          masterId: body.masterId,
          serviceId: body.serviceId,
          date: body.date,
          startTime: body.startTime,
          clientName: body.clientName ?? null,
          clientPhone: body.clientPhone ?? null,
          channel: body.channel ?? (auth ? 'admin' : 'client'),
        });
        return sendJson(res, result.status, result.body);
      }
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
      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET') {
        const masterId = url.searchParams.get('masterId');
        if (auth.role === 'master' && masterId && masterId !== auth.id) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
        const effectiveMasterId = auth.role === 'master' ? auth.id : masterId;
        let shiftQuery = 'SELECT id, master_id, date, start_time, end_time FROM schedule_shifts WHERE 1=1';
        const params = [];
        if (effectiveMasterId) {
          params.push(effectiveMasterId);
          shiftQuery += ` AND master_id = $${params.length}`;
        }
        if (auth.role === 'admin') {
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
        return sendJson(
          res,
          200,
          shifts.rows.map((s) => ({
            id: s.id,
            masterId: s.master_id,
            date: s.date instanceof Date ? s.date.toISOString().slice(0, 10) : s.date,
            startTime: s.start_time,
            endTime: s.end_time,
            breaks: breaksByShift.get(s.id) ?? [],
          }))
        );
      }

      if (req.method === 'POST') {
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
          for (const b of body.breaks ?? []) {
            await client.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
              shiftId,
              b.startTime,
              b.endTime,
            ]);
          }
          await client.query('COMMIT');
          return sendJson(res, 200, { ok: true, id: shiftId });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }

    // ── /payroll-settings - только владелец (разд.7 ТЗ: "Изменение прайса - я") ──
    if (parts[0] === 'payroll-settings' && parts.length === 1) {
      const auth = await authenticate(req);
      if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET') {
        const result = await pool.query('SELECT * FROM payroll_settings WHERE id = 1');
        const r = result.rows[0];
        return sendJson(res, 200, {
          baseRatePerShift: r.base_rate_per_shift,
          pctBaseService: Number(r.pct_base_service),
          pctComplexService: Number(r.pct_complex_service),
          pctCosmetics: Number(r.pct_cosmetics),
          newClientBonus: r.new_client_bonus,
        });
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        await pool.query(
          `UPDATE payroll_settings SET
             base_rate_per_shift = COALESCE($1, base_rate_per_shift),
             pct_base_service = COALESCE($2, pct_base_service),
             pct_complex_service = COALESCE($3, pct_complex_service),
             pct_cosmetics = COALESCE($4, pct_cosmetics),
             new_client_bonus = COALESCE($5, new_client_bonus)
           WHERE id = 1`,
          [
            body.baseRatePerShift ?? null,
            body.pctBaseService ?? null,
            body.pctComplexService ?? null,
            body.pctCosmetics ?? null,
            body.newClientBonus ?? null,
          ]
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

server.listen(PORT, () => {
  console.log(`API alikhan-crm слушает порт ${PORT}`);
});
