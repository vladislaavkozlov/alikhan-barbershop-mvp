// GET /finance/returned, GET /finance/returned/visits - карточка «Возвращено»
// в разделе «Финансы» владельца (02.09.2026).
//
// Парная карточка к «Недополученной прибыли»: та показывает, сколько денег утекло,
// эта - сколько из них система вернула. Живёт в том же разделе и в том же модуле
// арендатора (missedProfit): владелец читает обе цифры рядом, порознь они неполны.
//
// Правила атрибуции и объяснение, почему они именно такие, - в api/lib/returned.js.
// Здесь только выборка сырья и деньги.
//
// Деньги считаются по РЕАЛЬНОЙ цене визита конкретного клиента у конкретного мастера
// (loadPriceResolver, api/lib/pricing.js - тот же резолвер, что считает зарплату и
// недополученную прибыль). Средний чек соврал бы в обе стороны, а цифра, на которой
// держится гарантия возврата денег, врать не может.
import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { MANAGEMENT_ROLES } from '../lib/permissions.js';
import { loadPriceResolver } from '../lib/pricing.js';
import { classifyReturn, summarizeReturned } from '../lib/returned.js';
import { daysBetween, renewDaysOf } from '../lib/renew.js';
import { isDateStr, loadServiceIds } from './missed-profit.js';

// Тот же круг, что и вся «Финансы»: владелец и управляющий. Здесь деньги и имена
// пациентов сразу, администратору такое не отдаём
const MONEY_VIEWERS = MANAGEMENT_ROLES;

const LIST_LIMIT = 200;

function dstr(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d ?? null;
}

// Сырьё: каждый состоявшийся визит периода вместе с четырьмя признаками, по которым
// решается, засчитывать ли его возвратом.
//
// Почему подзапросы, а не join с агрегацией: и «предыдущий визит», и «неявки до этой
// даты» считаются относительно ДАТЫ КОНКРЕТНОЙ БРОНИ, а не относительно периода.
// Клиент мог прийти в периоде дважды: первый визит был возвратом из просрочки, второй
// уже обычным. Агрегат на клиента этого различить не может и посчитал бы возвратом оба.
async function loadVisits(db, from, to) {
  const res = await db.query(
    `WITH done AS (
       SELECT b.id, b.client_id, b.date, b.master_id, b.service_id, b.client_confirmed
       FROM bookings b
       WHERE b.status = 'done' AND b.client_id IS NOT NULL
         AND b.date >= $1 AND b.date <= $2
     )
     SELECT d.id AS booking_id, d.client_id, d.date, d.master_id, d.service_id,
            d.client_confirmed,
            c.name, c.phone, c.renew_days,
            EXISTS (
              SELECT 1 FROM client_messages m
              WHERE m.booking_id = d.id AND m.status = 'sent'
            ) AS message_sent,
            (SELECT max(p.date) FROM bookings p
              WHERE p.client_id = d.client_id AND p.status = 'done' AND p.date < d.date
            ) AS prev_visit_date,
            (SELECT count(*) FROM bookings n
              WHERE n.client_id = d.client_id AND n.status = 'no_show' AND n.date < d.date
            )::int AS prior_no_shows
     FROM done d
     JOIN clients c ON c.id = d.client_id
     ORDER BY d.date`,
    [from, to]
  );
  return res.rows;
}

// Уходило ли за период хоть одно сообщение. Отвечает на вопрос «бот вообще заговорил
// у этого арендатора», от которого зависит null или ноль в сводке
async function hasMessagingInPeriod(db, from, to) {
  const res = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM client_messages
       WHERE status = 'sent' AND sent_at >= $1::date AND sent_at < ($2::date + 1)
     ) AS has`,
    [from, to]
  );
  return Boolean(res.rows[0]?.has);
}

export async function computeReturned(db, from, to) {
  const [rows, hasMessaging] = await Promise.all([
    loadVisits(db, from, to),
    hasMessagingInPeriod(db, from, to),
  ]);

  // Услуг может не быть в booking_services у совсем старой брони - тогда фолбэк на
  // bookings.service_id, ровно как в зарплате и в недополученной прибыли
  const [servicesByBooking, { visitPrice }] = await Promise.all([
    loadServiceIds(db, rows.map((r) => r.booking_id)),
    loadPriceResolver(db),
  ]);
  const priceOf = (row) => {
    const ids = servicesByBooking.get(row.booking_id)?.length
      ? servicesByBooking.get(row.booking_id)
      : row.service_id ? [row.service_id] : [];
    return visitPrice(row.master_id, ids);
  };

  const visits = [];
  for (const r of rows) {
    const prev = dstr(r.prev_visit_date);
    // Просрочен ли он был на момент этого визита: между предыдущим визитом и этим
    // прошло больше его собственного срока. Без предыдущего визита судить не о чем -
    // первый визит человека не может быть возвратом
    const gap = prev ? daysBetween(prev, dstr(r.date)) : null;
    const wasOverdue = gap !== null && gap > renewDaysOf(r.renew_days);

    const reason = classifyReturn({
      messageSent: Boolean(r.message_sent),
      clientConfirmed: Boolean(r.client_confirmed),
      priorNoShows: Number(r.prior_no_shows) || 0,
      wasOverdue,
    });
    if (!reason) continue;

    visits.push({
      bookingId: r.booking_id,
      clientId: r.client_id,
      name: r.name ?? null,
      phone: r.phone ?? null,
      date: dstr(r.date),
      reason,
      amount: priceOf(r),
      daysAway: gap,
    });
  }

  return { from, to, ...summarizeReturned({ visits, hasMessaging }), visits };
}

export async function handleReturned(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, MONEY_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isDateStr(from) || !isDateStr(to) || from > to) return sendJson(res, 400, { error: 'invalid_period' });

  const result = await computeReturned(pool, from, to);
  // Карточке нужны суммы и счётчики. Имена и телефоны едут отдельной ручкой, когда
  // владелец раскрыл список: дашборд не таскает базу пациентов на каждый показ раздела
  return sendJson(res, 200, {
    from: result.from,
    to: result.to,
    total: result.total,
    byReason: result.byReason,
    count: result.count,
    hasMessaging: result.hasMessaging,
  });
}

export async function handleReturnedVisits(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, MONEY_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isDateStr(from) || !isDateStr(to) || from > to) return sendJson(res, 400, { error: 'invalid_period' });

  const result = await computeReturned(pool, from, to);
  // Сверху самые дорогие возвраты: владелец смотрит список, чтобы увидеть, за что
  // именно заплачены деньги, и первым делом хочет крупное
  const sorted = [...result.visits].sort((a, b) => b.amount - a.amount || (a.date ?? '').localeCompare(b.date ?? ''));
  return sendJson(res, 200, {
    from,
    to,
    visits: sorted.slice(0, LIST_LIMIT),
    truncated: sorted.length > LIST_LIMIT,
  });
}
