// GET /analytics/retention, GET /analytics/sources - раздел «Аналитика» владельца
// (22.08.2026, задача Влада: «возвращаемость клиентов по сотрудникам» и «в „Как
// приходят клиенты“ добавить откуда - яндекс, 2гис и т.д.»).
//
// До этого окна раздел не делал ни одного запроса к серверу: обе карточки были
// статичной вёрсткой «00% пример» прямо в crm-owner.html. Здесь появляются реальные
// цифры - обе считаются из уже существующих данных, новых полей и миграций задача не
// потребовала:
//   возвращаемость - по bookings (status='done', client_id);
//   каналы         - по bookings.client_source (миграция 050).
//
// Что именно считается «возвращаемостью», решено здесь один раз и записано явно,
// потому что у слова два разных смысла и цифры расходятся в разы:
//   по мастеру - клиент считается вернувшимся, если за период он был у ЭТОГО мастера
//                2+ раза (иначе показатель мастера мерил бы лояльность салона, а не
//                его личную работу);
//   по салону  - 2+ визита в салон, к любому мастеру. Эта цифра и стояла в разделе
//                раньше (company-wide), её сохраняем как ведущую.
// Из-за разной базы сумма по мастерам не обязана совпадать с цифрой салона - это не
// ошибка расчёта, и в интерфейсе подписано словами.
//
// Клиент без телефона (walk-in, walkin_name - миграция 041) в возвращаемость не
// входит: у него нет client_id, система намеренно не связывает такие визиты между
// собой (решение Алихана, Окно 53), значит и «вернулся ли он» ей неизвестно. Врать
// про это нельзя - роут отдаёт количество таких визитов отдельным числом
// (unlinkedVisits), интерфейс показывает его оговоркой под цифрой.
import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { MANAGEMENT_ROLES } from '../lib/permissions.js';
// Словарь каналов один на весь проект: сюда он приходит оттуда же, откуда его берёт
// запись брони (CLIENT_SOURCE_KEYS, api/routes/bookings.js - зеркало фронтового
// assets/client-source.js). Свой список каналов в аналитике завести нельзя: он
// разойдётся с записью при первой же новой площадке, и канал молча уедет в «не
// указан».
import { CLIENT_SOURCE_KEYS } from './bookings.js';
import { dateColToStr } from '../lib/time.js';

// Аналитика салона целиком - тот же круг, что и деньги (17.08.2026: владелец и
// управляющий). Администратору и мастеру раздела «Аналитика» в кабинете нет, но
// прятать данные только в вёрстке нельзя - до роута дотягивается любой токен.
const ANALYTICS_VIEWERS = MANAGEMENT_ROLES;

// Окна периодов - ровно те, что уже стоят переключателями в разделе. Список закрытый:
// произвольное число месяцев из адресной строки не принимаем, иначе запрос «за 999
// месяцев» пойдёт полным перебором таблицы.
// Сколько времени человеку даётся на возвращение, прежде чем считать, что он не
// вернулся (правка Влада 22.08.2026: «клиентов, которые не вернулись, нужно считать с
// месяца после визита. Там Гэндальф 19.08 пишет не вернулся - он каждый день что ли
// стричься должен?»). До этой правки невернувшимся числился каждый, кто за период был
// ровно раз - включая клиента, который приходил вчера и физически не успел бы прийти
// снова.
//
// Месяц - не абстрактная осторожность, а шаг самой услуги: стрижка живёт примерно
// столько, и раньше человека ждать незачем.
//
// Окно действует на ОБЕ цифры, не только на список: клиент, впервые пришедший на
// прошлой неделе, выпадает и из знаменателя возвращаемости. Иначе процент падал бы от
// каждого новичка - салон привёл новых людей, а показатель лояльности за это наказывал.
// Клиента с двумя визитами окно не касается: он уже вернулся, ждать нечего.
const RETURN_GRACE_MONTHS = 1;

export const RETENTION_MONTHS = [3, 6, 12, 24, 36];
export const SOURCE_MONTHS = [1, 3, 6, 12];

export function parseMonths(raw, allowed) {
  const n = Number(raw);
  if (!Number.isInteger(n) || !allowed.includes(n)) return null;
  return n;
}

// Доля в процентах. Нет базы (ни одного клиента за период) - возвращаем null, а не 0:
// «0% вернулись» и «считать не из чего» это разные сообщения владельцу, и первое из
// второго не выводится.
export function percentOf(part, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((Number(part) * 100) / total);
}

// Сборка строк «откуда приходят»: сначала каналы с людьми - по убыванию, потом
// каналы без единого визита за период (владельцу важно видеть, что площадка есть, а
// клиентов с неё нет), в самом конце - записи без источника. Подписи каналов сюда не
// попадают намеренно: словарь ключ→подпись один на весь проект и живёт на фронте
// (assets/client-source.js), сервер отдаёт ключи.
export function shapeSourceRows(counts, keys) {
  const known = keys.map((key) => ({ key, count: Number(counts[key] ?? 0) }));
  known.sort((a, b) => b.count - a.count || keys.indexOf(a.key) - keys.indexOf(b.key));
  const total = known.reduce((sum, row) => sum + row.count, 0) + Number(counts.unknown ?? 0);
  const rows = known.map((row) => ({ ...row, pct: percentOf(row.count, total) }));
  const unknown = Number(counts.unknown ?? 0);
  if (unknown > 0) rows.push({ key: null, count: unknown, pct: percentOf(unknown, total) });
  return { total, rows };
}

// ── Возвращаемость ──────────────────────────────────────────────────────────
// Один проход по броням периода, дальше две группировки в SQL. Состоявшиеся визиты
// (status='done') - тот же фильтр, что уже стоит в «Финансах» и в зарплате мастера
// (правка Влада 21.08.2026: «Ожидает» это только предположение, клиент и отменить
// может), иначе возвращаемость считалась бы по намерениям, а не по приходам.
export async function computeRetention(db, months) {
  const periodSql = `b.date > CURRENT_DATE - make_interval(months => $1) AND b.date <= CURRENT_DATE`;
  // «Успел ли клиент вернуться»: либо он уже приходил больше раза, либо с его
  // единственного визита прошло не меньше месяца. Всё остальное - слишком рано судить
  const matureSql = `n >= 2 OR last_date <= CURRENT_DATE - make_interval(months => ${RETURN_GRACE_MONTHS})`;

  const [salonRes, masterRes, unlinkedRes, staffRes] = await Promise.all([
    db.query(
      `WITH visits AS (
         SELECT b.client_id, count(*) AS n, max(b.date) AS last_date
         FROM bookings b
         WHERE b.status = 'done' AND b.client_id IS NOT NULL AND ${periodSql}
         GROUP BY b.client_id
       ), mature AS (
         SELECT * FROM visits WHERE ${matureSql}
       )
       SELECT count(*)::int AS clients,
              count(*) FILTER (WHERE n >= 2)::int AS returned,
              coalesce(sum(n), 0)::int AS visits,
              (SELECT count(*)::int FROM visits) - count(*)::int AS waiting
       FROM mature`,
      [months]
    ),
    db.query(
      `WITH visits AS (
         SELECT b.master_id, b.client_id, count(*) AS n, max(b.date) AS last_date
         FROM bookings b
         WHERE b.status = 'done' AND b.client_id IS NOT NULL AND b.master_id IS NOT NULL AND ${periodSql}
         GROUP BY b.master_id, b.client_id
       )
       SELECT master_id, count(*)::int AS clients,
              count(*) FILTER (WHERE n >= 2)::int AS returned,
              coalesce(sum(n), 0)::int AS visits
       FROM visits
       WHERE ${matureSql}
       GROUP BY master_id`,
      [months]
    ),
    db.query(
      `SELECT count(*)::int AS n FROM bookings b
       WHERE b.status = 'done' AND b.client_id IS NULL AND ${periodSql}`,
      [months]
    ),
    // Кто попадает в список мастеров: все, кто сейчас оказывает услуги (даже с нулём
    // визитов за период - пустая строка это тоже ответ владельцу), плюс те, у кого
    // визиты в периоде были, но кто уже не работает - их результат из истории не
    // исчезает. Порядок - как везде в CRM: по дате появления в салоне.
    db.query(
      `SELECT id, name, employed, employment_ended_at, provides_services FROM staff ORDER BY created_at, id`
    ),
  ]);

  const byMaster = new Map(masterRes.rows.map((r) => [r.master_id, r]));
  const masters = staffRes.rows
    .filter((s) => (s.provides_services && s.employed) || byMaster.has(s.id))
    .map((s) => {
      const agg = byMaster.get(s.id);
      const clients = agg ? agg.clients : 0;
      const returned = agg ? agg.returned : 0;
      return {
        masterId: s.id,
        name: s.name,
        employed: !!s.employed,
        // Дата увольнения (миграция 055) - чтобы в списке было не безликое
        // «не работает», а «не работает с 15.06»
        employmentEndedAt: dateColToStr(s.employment_ended_at) ?? null,
        clients,
        returned,
        visits: agg ? agg.visits : 0,
        pct: percentOf(returned, clients),
      };
    });

  const salon = salonRes.rows[0] ?? { clients: 0, returned: 0, visits: 0, waiting: 0 };
  return {
    months,
    graceMonths: RETURN_GRACE_MONTHS,
    salon: {
      clients: salon.clients,
      returned: salon.returned,
      visits: salon.visits,
      // waiting - клиенты, которые были один раз совсем недавно: судить о них рано,
      // поэтому в проценте их нет. Число отдаём, чтобы интерфейс мог сказать об этом
      // прямо, а не делал вид, что таких людей не существует
      waiting: salon.waiting ?? 0,
      pct: percentOf(salon.returned, salon.clients),
    },
    unlinkedVisits: unlinkedRes.rows[0]?.n ?? 0,
    masters,
  };
}

// ── Как приходят клиенты ────────────────────────────────────────────────────
// Считаем визиты, а не людей: один и тот же человек может прийти по карте, а через
// полгода по рекомендации - именно поэтому источник и хранится на брони, а не на
// клиенте (миграция 050). Фильтр по статусу здесь НЕ ставится: канал привлечения
// сработал в момент записи, отменил клиент визит или нет - на работу площадки это
// не влияет. Исключены только удалённые брони (их в таблице уже нет).
export async function computeClientSources(db, months, sourceKeys) {
  const res = await db.query(
    `SELECT b.client_source AS key, count(*)::int AS n
     FROM bookings b
     WHERE b.date > CURRENT_DATE - make_interval(months => $1) AND b.date <= CURRENT_DATE
     GROUP BY b.client_source`,
    [months]
  );

  const counts = { unknown: 0 };
  for (const row of res.rows) {
    // Ключ не из словаря (осталась строка от старой версии словаря) - к «источник не
    // указан», а не в отдельную строку с сырым ключом: показывать владельцу «2gis_old»
    // как канал нельзя, он такого не выбирал.
    if (row.key && sourceKeys.includes(row.key)) counts[row.key] = row.n;
    else counts.unknown += row.n;
  }
  return { months, ...shapeSourceRows(counts, sourceKeys) };
}

// ── Кто не вернулся ─────────────────────────────────────────────────────────
// Список под цифрой возвращаемости (правка Влада 22.08.2026: «нужна возможность
// перехода на клиентов, которые не вернулись»). Процент без имён - справка, с именами
// - работа: владелец видит, кому именно можно позвонить.
//
// «Не вернулся» здесь ровно то же, что и в проценте выше, иначе список не сойдётся с
// цифрой, под которой он стоит: ОДИН состоявшийся визит за период И с него прошло не
// меньше RETURN_GRACE_MONTHS. С masterId - один визит к этому мастеру (клиент мог за
// это время сходить к другому, для мастера он всё равно не вернулся).
//
// Клиенты без телефона в список не попадают физически: у визита без client_id нет ни
// имени в базе, ни номера, звонить некому. Их количество отдаётся отдельным числом
// (см. unlinkedVisits у computeRetention) и показывается заглушкой.
const LAPSED_LIMIT = 200;

export async function computeLapsedClients(db, months, masterId = null) {
  const params = [months];
  let masterFilter = '';
  if (masterId) {
    params.push(masterId);
    masterFilter = ` AND b.master_id = $${params.length}`;
  }
  const period = `b.date > CURRENT_DATE - make_interval(months => $1) AND b.date <= CURRENT_DATE`;

  // Сортировка по дате последнего визита: чем раньше человек был, тем выше он в
  // списке - обзванивать логично начиная с тех, кто пропал давно
  const res = await db.query(
    `WITH visits AS (
       SELECT b.client_id, count(*) AS n, max(b.date) AS last_date
       FROM bookings b
       WHERE b.status = 'done' AND b.client_id IS NOT NULL${masterFilter} AND ${period}
       GROUP BY b.client_id
       -- Тот же порог, что и в проценте выше (RETURN_GRACE_MONTHS): человек, который
       -- был один раз на прошлой неделе, не «не вернулся» - ему просто рано снова
       HAVING count(*) = 1 AND max(b.date) <= CURRENT_DATE - make_interval(months => ${RETURN_GRACE_MONTHS})
     )
     SELECT c.id, c.name, c.phone, v.last_date
     FROM visits v JOIN clients c ON c.id = v.client_id
     ORDER BY v.last_date, c.name
     LIMIT ${LAPSED_LIMIT + 1}`,
    params
  );

  const rows = res.rows.slice(0, LAPSED_LIMIT).map((r) => ({
    clientId: r.id,
    name: r.name,
    phone: r.phone,
    lastVisit: r.last_date instanceof Date ? r.last_date.toISOString().slice(0, 10) : r.last_date,
  }));
  // truncated - честный признак, что показаны не все: молча обрезанный список владелец
  // принял бы за полный и решил, что обзвонил всех
  return { months, masterId: masterId ?? null, clients: rows, truncated: res.rows.length > LAPSED_LIMIT };
}

// Визиты без телефона за всё время - для раздела «Клиенты» (правка Влада 22.08.2026:
// «в записях клиентов их не учитывать, но считать, сколько таких»). В списке клиентов
// таких людей нет и не будет: без номера система намеренно не связывает их визиты
// между собой, и строка в базе на каждый приход означала бы десяток «разных» людей с
// одним именем. Но не показывать их вовсе - значит делать вид, что этих визитов не
// было, поэтому счётчик отдаётся отдельно.
export async function computeUnlinkedVisits(db) {
  const res = await db.query(
    `SELECT count(*)::int AS visits,
            count(*) FILTER (WHERE b.date > CURRENT_DATE - make_interval(months => 1))::int AS visits_month
     FROM bookings b
     WHERE b.status = 'done' AND b.client_id IS NULL`
  );
  const row = res.rows[0] ?? { visits: 0, visits_month: 0 };
  return { visits: row.visits, visitsMonth: row.visits_month };
}

export async function handleAnalyticsRetention(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ANALYTICS_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const months = parseMonths(url.searchParams.get('months'), RETENTION_MONTHS);
  if (months === null) return sendJson(res, 400, { error: 'invalid_months' });
  return sendJson(res, 200, await computeRetention(pool, months));
}

export async function handleAnalyticsSources(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ANALYTICS_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const months = parseMonths(url.searchParams.get('months'), SOURCE_MONTHS);
  if (months === null) return sendJson(res, 400, { error: 'invalid_months' });
  return sendJson(res, 200, await computeClientSources(pool, months, CLIENT_SOURCE_KEYS));
}

export async function handleAnalyticsLapsed(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ANALYTICS_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  const months = parseMonths(url.searchParams.get('months'), RETENTION_MONTHS);
  if (months === null) return sendJson(res, 400, { error: 'invalid_months' });
  // masterId приходит из ответа /analytics/retention, но проверяется всё равно: он
  // едет в SQL параметром, а не строкой, и несуществующий id даст пустой список, а
  // не ошибку - список «кто не вернулся к несуществующему мастеру» пуст по факту
  const masterId = url.searchParams.get('masterId');
  return sendJson(res, 200, await computeLapsedClients(pool, months, masterId || null));
}

export async function handleAnalyticsUnlinked(req, res) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ANALYTICS_VIEWERS)) return sendJson(res, 403, { error: 'forbidden' });
  return sendJson(res, 200, await computeUnlinkedVisits(pool));
}
