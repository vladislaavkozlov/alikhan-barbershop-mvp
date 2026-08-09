// GET/PUT /payroll-settings, GET /payroll, GET /revenue/today - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';

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
// Правка 08.08.2026 (вечер, Влад: "Али иногда говорит администратору 'пробей по
// старой цене' - скидка клиенту") - bookings.actual_price (миграция 040) хранит
// фактически взятую сумму, если она отличается от списочной цены услуг. Влияет ли
// это на ЗП мастера - решает САМ владелец через discount_settings.
// payroll_from_actual_price (переключатель "Финансы" → "Управление скидками" на
// фронте), не жёстко зашито здесь. По умолчанию выключено - до этой правки ни у
// одной брони actual_price не было (NULL), значит без явного включения настройки
// и без явно вписанной фактической суммы расчёт byte-for-byte совпадает со старым.
export async function computeMasterPayroll(client, masterId, from, to) {
  const pctRes = await client.query('SELECT pct FROM master_payroll_settings WHERE master_id = $1', [masterId]);
  const pct = pctRes.rows[0]?.pct ?? 0;

  const settingsRes = await client.query('SELECT payroll_from_actual_price AS "payrollFromActualPrice" FROM discount_settings LIMIT 1');
  const payrollFromActualPrice = settingsRes.rows[0]?.payrollFromActualPrice ?? false;

  const bookingsRes = await client.query(
    'SELECT id, service_id AS "serviceId", actual_price AS "actualPrice" FROM bookings WHERE master_id = $1 AND date >= $2 AND date <= $3',
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

  // revenue - как и раньше, всегда по списочной цене услуг (выручка бизнеса не
  // трогается этой правкой, вне её скоупа). payrollBase - отдельная база для ЗП:
  // если владелец включил "считать от факта" И для этой ЗАПИСИ реально вписана
  // фактическая сумма - идёт она, иначе (выключено, или факт не вписан) - тот же
  // список, что и revenue, поведение не отличается от исходного.
  let revenue = 0;
  let payrollBase = 0;
  for (const b of bookingsRes.rows) {
    const serviceIds = serviceIdsByBooking.get(b.id)?.length ? serviceIdsByBooking.get(b.id) : b.serviceId ? [b.serviceId] : [];
    const listPrice = serviceIds.reduce((sum, id) => sum + priceOf(id), 0);
    revenue += listPrice;
    payrollBase += payrollFromActualPrice && b.actualPrice != null ? b.actualPrice : listPrice;
  }
  const payroll = (payrollBase * pct) / 100;
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

// ── /payroll-settings - ставка ПО МАСТЕРУ (Окно 10, разд.17.3 ТЗ). Заменяет
// единую строку payroll_settings (% по категории услуги + бонус за нового
// клиента - оба подтверждённо не соответствуют реальной формуле Алихана,
// разд.17.3/17.4) на master_payroll_settings: у каждого мастера одна
// редактируемая ставка pct. Читать может любая роль (мастеру нужна своя ставка
// для "Моей зарплаты"), но выдача сужена по той же матрице, что и /staff -
// мастер видит только себя, админ только свою точку, владелец - всех. Менять
// ставку может только владелец (разд.7 ТЗ: "Изменение прайса - я").
export async function handlePayrollSettings(req, res, url) {
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

// ── /discount-settings - "Управление скидками" (08.08.2026, вечер). Читать может
// любая роль (админ/мастер должны видеть текущую политику, чтобы понимать, откуда
// цифра ЗП), менять - только владелец (та же логика доступа, что у /payroll-settings
// PUT: "Изменение прайса/политики расчёта - я"). Singleton-таблица discount_settings
// (миграция 040) - ровно одна строка, UPDATE без WHERE её не размножает.
export async function handleDiscountSettings(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const result = await pool.query('SELECT payroll_from_actual_price AS "payrollFromActualPrice" FROM discount_settings LIMIT 1');
    return sendJson(res, 200, { payrollFromActualPrice: result.rows[0]?.payrollFromActualPrice ?? false });
  }

  if (req.method === 'PUT') {
    if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    if (typeof body.payrollFromActualPrice !== 'boolean') {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    await pool.query('UPDATE discount_settings SET payroll_from_actual_price = $1', [body.payrollFromActualPrice]);
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
export async function handlePayroll(req, res, url) {
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
export async function handleRevenueToday(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner', 'admin'])) return sendJson(res, 401, { error: 'unauthorized' });
  const locationId = auth.role === 'admin' ? auth.locationId : url.searchParams.get('locationId');
  const result = await computeRevenueToday(pool, locationId);
  return sendJson(res, 200, result);
}
