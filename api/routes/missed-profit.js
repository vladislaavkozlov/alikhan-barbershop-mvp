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
import { classifyClient, missedVisitsInWindow, shortfallVisits, summarizeMissedProfit, daysBetween, renewDaysOf } from '../lib/renew.js';

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
  // ВАЖНО (найдено живым прогоном 22.08.2026): «до конца периода», а не «внутри
  // периода». Первая версия брала клиентов, чей последний визит попал в окно, - и на
  // вкладке «Месяц» карточка прятала как раз самых потерянных: кто не приходил три
  // месяца, в границы месяца не попадал вовсе. Теперь берём последний визит человека
  // на конец периода, а сколько его визитов пропало ИМЕННО в окне, считает
  // missedVisitsInWindow (api/lib/renew.js).
  //
  // Разрежённость, наоборот, считается по визитам ВНУТРИ окна: она про то, как человек
  // ходил в этот период, и визиты годовой давности к ней отношения не имеют.
  const res = await db.query(
    `WITH done AS (
       SELECT b.* FROM bookings b
       WHERE b.status = 'done' AND b.client_id IS NOT NULL AND b.date <= $2
     ),
     period AS (
       SELECT * FROM done WHERE date >= $1
     ),
     agg AS (
       SELECT client_id, count(*)::int AS visits, min(date) AS first_date, max(date) AS period_last_date
       FROM period GROUP BY client_id
     ),
     last_visit AS (
       SELECT DISTINCT ON (client_id) client_id, id AS booking_id, master_id, service_id, date AS last_date
       FROM done ORDER BY client_id, date DESC, start_time DESC
     )
     SELECT l.client_id, coalesce(a.visits, 0) AS visits, a.first_date, a.period_last_date,
            l.last_date, l.booking_id, l.master_id, l.service_id,
            c.name, c.phone, c.renew_days, c.renew_days_recommended, c.renew_reason
     FROM last_visit l
     LEFT JOIN agg a ON a.client_id = l.client_id
     JOIN clients c ON c.id = l.client_id`,
    [from, to]
  );
  return res.rows;
}

// Неявки периода. Считаются по цене визита, который не состоялся: время мастера было
// занято этой бронью, и её цена - ровно то, чего салон не получил.
async function loadNoShows(db, from, to) {
  const res = await db.query(
    // Вместе с неявкой приезжает судьба письма, которое бот отправил не пришедшему
    // (04.09.2026): ответил человек, молчит или письма не было вовсе. Без этого
    // список отвечал бы только на «кому мы написали», а владельцу нужно «кому
    // звонить сейчас и кого не потерять из виду», см. lib/client-messaging.js
    `SELECT b.id, b.master_id, b.service_id, b.date, b.client_id, c.name, c.phone,
            b.noshow_reply, b.noshow_reply_at, b.noshow_reason,
            -- Записался ли человек сам после того, как ответил боту «да». Ровно это
            -- отличает «дело сделано» от «ответил и пропал»: во втором случае звонит
            -- администратор, в первом звонить незачем (04.09.2026, замечание Влада о
            -- самозаписи вместо звонка)
            (SELECT min(nb.date::text) FROM bookings nb
              WHERE nb.client_id = b.client_id AND nb.status = 'planned'
                AND nb.created_at > b.noshow_reply_at) AS rebooked_date,
            m.status AS msg_status, m.last_error AS msg_error,
            -- Дата отправки сразу строкой и сразу в московском времени: письмо,
            -- ушедшее в 00:30 по Москве, в UTC относится ко вчера, и «молчит N дней»
            -- ошибалось бы на сутки в пользу спешки. Тот же приём, что в
            -- lib/client-messaging.js - время визита там тоже приводится явно
            to_char((m.sent_at AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS msg_sent_date
     FROM bookings b
     LEFT JOIN clients c ON c.id = b.client_id
     LEFT JOIN client_messages m ON m.booking_id = b.id AND m.kind = 'no_show_followup'
     WHERE b.status = 'no_show' AND b.date >= $1 AND b.date <= $2`,
    [from, to]
  );
  return res.rows;
}

// Состояние разговора по одной неявке. Пять слов, которыми список объясняет владельцу,
// что с человеком уже произошло и что от него, владельца, требуется:
//   replied   - сказал «подберите время», это очередь на прозвон
//   declined  - сказал «пока не планирую», звонить не надо, но деньги всё равно потеряны
//   silent    - письмо ушло, ответа нет: молчащего звонят руками, а не забывают
//   queued    - письмо ещё в очереди, ждём отправки
//   no_channel- бота у человека нет, писать некому: только звонок
//   none      - неявка старше самого механизма, письма по ней не было и не будет
function followupState(row, todayDate) {
  if (row.noshow_reply === 'wants_time') {
    // Ответил и уже записался сам - строка остаётся в списке (деньги за пропущенный
    // приём никуда не делись), но звонить по ней не надо, и она уходит вниз
    if (row.rebooked_date) return { state: 'rebooked', silentDays: 0, rebookedDate: row.rebooked_date };
    return { state: 'replied', silentDays: 0 };
  }
  if (row.noshow_reply === 'not_now') return { state: 'declined', silentDays: 0, reason: row.noshow_reason ?? null };
  if (row.msg_status === 'sent') {
    const sent = row.msg_sent_date ?? null;
    return { state: 'silent', silentDays: sent ? Math.max(daysBetween(sent, todayDate), 0) : 0 };
  }
  if (row.msg_status === 'pending' || row.msg_status === 'sending') return { state: 'queued', silentDays: 0 };
  if (row.msg_status === 'skipped' || row.msg_status === 'failed') return { state: 'no_channel', silentDays: 0 };
  return { state: 'none', silentDays: 0 };
}

// Экспортируется с 02.09.2026: тем же способом собирает услуги броней карточка
// «Возвращено» (routes/returned.js). Копия запроса в двух файлах разошлась бы при
// первой же правке схемы booking_services
export async function loadServiceIds(db, bookingIds) {
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
    // Размах визитов ВНУТРИ периода - основа разрежённости (см. комментарий в
    // loadClientVisits): как человек ходил именно в это окно
    const spanDays = daysBetween(dstr(r.first_date), dstr(r.period_last_date));
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
      const missed = missedVisitsInWindow(lastVisitDate, r.renew_days, { from, to, today: todayDate });
      // Клиент просрочен, но ни один его пропущенный визит не пришёлся на это окно
      // (потерян раньше и уже показан в прошлом периоде) - в карточку периода он не
      // идёт. Иначе один и тот же человек считался бы потерей каждый месяц заново
      if (missed === 0) continue;
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
    ...followupState(r, todayDate),
    // Телефон нужен списку «Кому напомнить о себе» (04.09.2026): по неявкам владелец
    // теперь не только видит сумму, но и пишет человеку - ровно тем же набором кнопок,
    // что уже стоит у невернувшихся. Права те же: ручка закрыта MONEY_VIEWERS
    phone: r.phone ?? null,
    amount: priceOfBooking(r, r.id, r.service_id),
  }));

  // «Нет данных» - это отсутствие состоявшихся визитов И неявок за период. Ноль рублей
  // на пустом периоде читался бы как «вы ничего не упустили», а это другое сообщение
  // «Нет данных» - в окне не было ни одного состоявшегося визита, ни одной неявки и
  // ни одного пропущенного срока. Просто «строк не пришло» тут мало: последний визит
  // мог быть до периода, и клиент всё равно попадает в расчёт
  const hasData = rows.some((r) => Number(r.visits) > 0) || noShowRows.length > 0 || overdue.length > 0;
  const summary = summarizeMissedProfit({ overdue, sparse, noShowAmounts: noShows.map((n) => n.amount), hasData });

  return { from, to, ...summary, overdue, sparse, noShows };
}

// Списки сортируются так, как по ним работают: просроченных обзванивают начиная с тех,
// кто пропал давно; разрежённым объясняют срок начиная с тех, кто недодал больше денег.
// Экспортируется ради теста порядка неявок: очередь работы владельца - это поведение
// продукта, а не деталь реализации, и проверяться должна прямо, а не через HTTP
export function sortLists(result) {
  const overdue = [...result.overdue].sort((a, b) => (a.lastVisit ?? '').localeCompare(b.lastVisit ?? '') || b.amount - a.amount);
  const sparse = [...result.sparse].sort((a, b) => b.amount - a.amount || (a.name ?? '').localeCompare(b.name ?? ''));
  // Порядок в списке неявок - это порядок работы владельца, а не хронология.
  // Сначала те, кто ответил боту «подберите время», но ещё не записался: они уже
  // прогреты, звонок им самый дешёвый, и без звонка они потеряются. Дальше молчащие - вопрос Влада «а если клиент не ответит?»
  // закрывается тем, что молчащий не исчезает, а просто идёт вторым: его прозванивают
  // руками. Потом те, кому бот написать не смог, потом отказавшиеся. Внутри группы -
  // свежие сверху: разговор про пропущенный вчера приём человек ещё помнит.
  // Безымянные (бронь без клиента) в список не попадают: писать и звонить некому
  const NOSHOW_ORDER = { replied: 0, silent: 1, queued: 2, no_channel: 3, none: 3, rebooked: 4, declined: 5 };
  const noshow = [...result.noShows]
    .filter((r) => r.clientId && r.name)
    .sort(
      (a, b) =>
        (NOSHOW_ORDER[a.state] ?? 9) - (NOSHOW_ORDER[b.state] ?? 9) ||
        (b.date ?? '').localeCompare(a.date ?? '') ||
        b.amount - a.amount
    );
  return { overdue, sparse, noshow };
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
  if (kind !== 'overdue' && kind !== 'sparse' && kind !== 'noshow') return sendJson(res, 400, { error: 'invalid_kind' });

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
