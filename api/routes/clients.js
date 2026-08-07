// GET /owner/alerts, GET /clients?risk=true, GET /clients/:id - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { mastersWithWorkingSchedule } from '../lib/schedule-core.js';
import { findMastersMissingSchedule } from '../lib/notify-core.js';

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

// ── /owner/alerts - Окно 40 (06.08.2026). Один агрегирующий роут для дашборда
// "Сегодня" через computeOwnerAlerts - владелец получает три источника алертов
// (мастера без графика, необработанные заявки, клиенты в риске) одним запросом.
export async function handleOwnerAlerts(req, res) {
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
export async function handleClientsAtRisk(req, res, url) {
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
export async function handleClientCard(req, res, parts) {
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
