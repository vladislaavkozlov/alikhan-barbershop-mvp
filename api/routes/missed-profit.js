// GET /finance/missed-profit, GET /finance/missed-profit/clients - карточка
// «Недополученная прибыль» в разделе «Финансы» владельца (Окно 59, 22.08.2026).
//
// Зачем это в «Финансах», а не в «Аналитике» (решение Влада, не переигрывать):
// «Аналитика» отвечает процентами на вопрос «как ведут себя люди», а недополученная
// прибыль - это рубли, и владелец ставит их мысленно рядом с выручкой. В «Аналитике»
// цифра читается как справка, в «Финансах» - как удар.
//
// Три слагаемых и почему они подписаны по-разному:
//   отвал        - ПОТЕРЯ. Срок клиента прошёл, он не пришёл, визитов не было;
//   неявки       - ПОТЕРЯ. Бронь была, время мастера держали, клиент не явился;
//   разрежённость- ПОТЕНЦИАЛ, не потеря. Клиент не обещал ходить чаще: он согласился
//                  на свой срок, а мастер считает правильным более короткий. Написать
//                  «вы потеряли» на этих людях было бы враньём, поэтому и поле, и
//                  подпись на экране другие.
//
// Деньги считаются по РЕАЛЬНОЙ цене визита конкретного клиента у конкретного мастера
// (loadPriceResolver, api/lib/pricing.js - тот же резолвер, что считает зарплату), а
// не по среднему чеку салона: у Елизаветы стрижка дешевле, чем у Алиовсада, и средний
// чек соврал бы в обе стороны.
import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { MANAGEMENT_ROLES } from '../lib/permissions.js';
import { loadPriceResolver } from '../lib/pricing.js';
import { classifyClient, missedVisits, shortfallVisits, summarizeMissedProfit, daysBetween, renewDaysOf } from '../lib/renew.js';

// Тот же круг, что и вся остальная «Финансы»: владелец и управляющий (правка Влада
// 17.08.2026 - «администратору не даём данных к финансам»). Здесь и деньги, и телефоны
// клиентов сразу, прятать такое только в вёрстке нельзя.
const MONEY_VIEWERS = MANAGEMENT_ROLES;

const LIST_LIMIT = 200;

// Дата 'YYYY-MM-DD' из значения колонки date
function dstr(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d ?? null;
}

export function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Сырьё для расчёта: по каждому клиенту с состоявшимися визитами в периоде - сколько
// раз был, когда впервые и когда последний раз, его срок, и последний визит целиком
// (мастер и услуги) - по нему считается цена типичного визита этого человека.
async function loadClientVisits(db, from, to) {
  const res = await db.query(
    `WITH period AS (
       SELECT b.* FROM bookings b
       WHERE b.status = 'done' AND b.client_id IS NOT NULL AND b.date >= $1 AND b.date <= $2
     ),
     agg AS (
       SELECT client_id, count(*)::int AS visits, min(date) AS first_date, max(date) AS last_date
       FROM period GROUP BY client_id
     ),
     last_visit AS (
       SELECT DISTINCT ON (client_id) client_id, id AS booking_id, master_id, service_id
       FROM period ORDER BY client_id, date DESC, start_time DESC
     )
     SELECT a.client_id, a.visits, a.first_date, a.last_date,
            l.booking_id, l.master_id, l.service_id,
            c.name, c.phone, c.renew_days, c.renew_days_recommended, c.renew_reason
     FROM agg a
     JOIN last_visit l ON l.client_id = a.client_id
     JOIN clients c ON c.id = a.client_id`,
    [from, to]
  );
  return res.rows;
}

// Неявки периода. Считаются по цене визита, который не состоялся: время мастера было
// занято этой бронью, и её цена - ровно то, чего салон не получил.
async function loadNoShows(db, from, to) {
  const res = await db.query(
    `SELECT b.id, b.master_id, b.service_id, b.date, b.client_id, c.name, c.phone
     FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
     WHERE b.status = 'no_show' AND b.date >= $1 AND b.date <= $2`,
    [from, to]
  );
  return res.rows;
}

async function loadServiceIds(db, bookingIds) {
  if (bookingIds.length === 0) return new Map();
  const res = await db.query(
    'SELECT booking_id, service_id FROM booking_services WHERE booking_id = ANY($1)',
    [bookingIds]
  );
  const map = new Map();
  for (const r of res.rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push(r.service_id);
  }
  return map;
}

// Разбор периода на людей и рубли. Отдельная экспортируемая функция без HTTP - её же
// зовут обе ручки (карточка и списки), чтобы сумма в карточке и имена в списке никогда
// не разошлись: это один расчёт, показанный двумя способами.
export async function computeMissedProfit(db, from, to, todayDate = new Date().toISOString().slice(0, 10)) {
  const [rows, noShowRows] = await Promise.all([loadClientVisits(db, from, to), loadNoShows(db, from, to)]);

  const bookingIds = [...rows.map((r) => r.booking_id), ...noShowRows.map((r) => r.id)];
  const [servicesByBooking, { visitPrice }] = await Promise.all([
    loadServiceIds(db, bookingIds),
    loadPriceResolver(db),
  ]);

  // Услуг может не быть в booking_services у совсем старой брони - тогда фолбэк на
  // bookings.service_id, ровно как в зарплате (computeMasterPayroll)
  const priceOfBooking = (row, bookingId, serviceIdCol) => {
    const ids = servicesByBooking.get(bookingId)?.length ? servicesByBooking.get(bookingId) : serviceIdCol ? [serviceIdCol] : [];
    return visitPrice(row.master_id, ids);
  };

  const overdue = [];
  const sparse = [];
  for (const r of rows) {
    const lastVisitDate = dstr(r.last_date);
    const spanDays = daysBetween(dstr(r.first_date), lastVisitDate);
    const state = classifyClient({
      lastVisitDate,
      renewDays: r.renew_days,
      recommendedDays: r.renew_days_recommended,
      visits: r.visits,
      spanDays,
      todayDate,
    });
    const price = priceOfBooking(r, r.booking_id, r.service_id);
    const base = {
      clientId: r.client_id,
      name: r.name,
      phone: r.phone,
      lastVisit: lastVisitDate,
      renewDays: renewDaysOf(r.renew_days),
      recommendedDays: r.renew_days_recommended ?? null,
      renewReason: r.renew_reason ?? null,
      visitPrice: price,
    };
    if (state === 'overdue') {
      const missed = missedVisits(lastVisitDate, r.renew_days, todayDate);
      overdue.push({ ...base, missedVisits: missed, amount: missed * price, daysLate: daysBetween(lastVisitDate, todayDate) - renewDaysOf(r.renew_days) });
    } else if (state === 'sparse') {
      const shortfall = shortfallVisits({ visits: r.visits, spanDays, renewDays: r.renew_days, recommendedDays: r.renew_days_recommended });
      sparse.push({ ...base, shortfallVisits: shortfall, amount: shortfall * price });
    }
  }

  const noShows = noShowRows.map((r) => ({
    bookingId: r.id,
    date: dstr(r.date),
    clientId: r.client_id ?? null,
    name: r.name ?? null,
    amount: priceOfBooking(r, r.id, r.service_id),
  }));

  // «Нет данных» - это отсутствие состоявшихся визитов И неявок за период. Ноль рублей
  // на пустом периоде читался бы как «вы ничего не упустили», а это другое сообщение
  const hasData = rows.length > 0 || noShowRows.length > 0;
  const summary = summarizeMissedProfit({ overdue, sparse, noShowAmounts: noShows.map((n) => n.amount), hasData });

  return { from, to, ...summary, overdue, sparse, noShows };
}

// Списки сортируются так, как по ним работают: просроченных обзванивают начиная с тех,
// кто пропал давно; разрежённым объясняют срок начиная с тех, кто недодал больше денег
function sortLists(result) {
  const overdue = [...result.overdue].sort((a, b) => (a.lastVisit ?? '').localeCompare(b.lastVisit ?? '') || b.amount - a.amount);
  const sparse = [...result.sparse].sort((a, b) => b.amount - a.amount || (a.name ?? '').localeCompare(b.name ?? ''));
  return { overdue, sparse };
}

export async function handleMissedProfit(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, MONEY_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isDateStr(from) || !isDateStr(to) || from > to) return sendJson(res, 400, { error: 'invalid_period' });
  const result = await computeMissedProfit(pool, from, to);
  // Карточке нужны только суммы и счётчики - имена и телефоны едут отдельной ручкой,
  // когда владелец действительно раскрыл список. Дашборд не должен таскать всю базу
  // телефонов на каждый показ раздела «Финансы»
  return sendJson(res, 200, {
    from: result.from,
    to: result.to,
    lostLapsed: result.lostLapsed,
    potentialSparse: result.potentialSparse,
    lostNoShow: result.lostNoShow,
    total: result.total,
    counts: result.counts,
  });
}

export async function handleMissedProfitClients(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, MONEY_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isDateStr(from) || !isDateStr(to) || from > to) return sendJson(res, 400, { error: 'invalid_period' });
  const kind = url.searchParams.get('kind');
  if (kind !== 'overdue' && kind !== 'sparse') return sendJson(res, 400, { error: 'invalid_kind' });

  const result = await computeMissedProfit(pool, from, to);
  const lists = sortLists(result);
  const rows = lists[kind];
  return sendJson(res, 200, {
    from,
    to,
    kind,
    clients: rows.slice(0, LIST_LIMIT),
    // truncated - честный признак, что показаны не все (тот же приём, что в списке
    // невернувшихся): молча обрезанный список владелец принял бы за полный
    truncated: rows.length > LIST_LIMIT,
  });
}
