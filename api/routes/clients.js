// GET /owner/alerts, GET /clients?risk=true, GET /clients?phone=, GET /clients/:id -
// вынесено из server.mjs при декомпозиции (Этап 2 структурного рефакторинга,
// 07.08.2026), код перенесён без изменений; ветка ?phone= добавлена Окном 54.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { mastersWithWorkingSchedule } from '../lib/schedule-core.js';
import { canManageStaff, BOOKING_STAFF_ROLES, BOOKING_OPERATOR_ROLES } from '../lib/permissions.js';
import { findMastersMissingSchedule } from '../lib/notify-core.js';
import { normalizeRenewInput } from '../lib/renew-reason.js';
import { publish } from '../lib/events.js';
import { p } from '../lib/vertical-terms.js';

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
  if (n === 1) return { level: 'watch', label: p('client.missedLast') };
  return { level: 'high', label: `Не пришёл ${n} ${pluralRaz(n)} подряд - стоит позвонить` };
}

// Карточка клиента: сам клиент + история визитов (мастер, услуги через
// booking_services - миграция 013 уже backfill-нула старые брони, отдельный
// фолбэк на bookings.service_id не нужен). Роль-агностичный резолвер (тот же
// принцип, что у computeRevenueToday/computeMasterPayroll) - видимость телефона и
// scoping по точке/мастеру решает вызывающий роут по auth.role, не эта функция.
export async function getClientCard(client, clientId) {
  // renew_* (Окно 59, миграция 056) - срок обновления стрижки и почему он такой.
  // Имя того, кто ставил срок последним, берём тут же джойном: в карточке нужна
  // строка «Алиовсад, 22.08», а не служебный id. Отдельной таблицы истории в v1 нет
  // осознанно - см. комментарий в миграции.
  const clientRes = await client.query(
    `SELECT c.id, c.name, c.phone, c.birthday, c.no_show_streak,
            c.renew_days, c.renew_days_recommended, c.renew_reason, c.renew_note,
            c.renew_set_by, c.renew_set_at, st.name AS renew_set_by_name
     FROM clients c LEFT JOIN staff st ON st.id = c.renew_set_by
     WHERE c.id = $1`,
    [clientId]
  );
  if (clientRes.rows.length === 0) return null;
  const row = clientRes.rows[0];

  const visitsRes = await client.query(
    `SELECT b.id, b.date, b.start_time, b.end_time, b.status, b.master_id, b.location_id,
            b.staff_comment, b.client_source, st.name AS master_name
     FROM bookings b LEFT JOIN staff st ON st.id = b.master_id
     WHERE b.client_id = $1
     ORDER BY b.date DESC, b.start_time DESC`,
    [clientId]
  );

  const bookingIds = visitsRes.rows.map((r) => r.id);
  // Цена услуги (21.08.2026, раздел «Клиенты») - та же формула, что в «Финансах»
  // (computeMasterPayroll, api/routes/payroll.js): своя цена мастера в приоритете,
  // общий прайс services - страховка на случай пары, которую не завели в
  // master_services. Считаем по СПИСОЧНОЙ цене, не по actual_price: решение Влада
  // 21.08.2026 - «сколько денег принёс клиент» и выручка в «Финансах» должны быть
  // одним числом, а не двумя расходящимися.
  const servicesRes = bookingIds.length
    ? await client.query(
        `SELECT bs.booking_id, bs.service_id, s.name AS service_name,
                COALESCE(ms.price, s.price, 0) AS price
         FROM booking_services bs
         JOIN services s ON s.id = bs.service_id
         JOIN bookings b ON b.id = bs.booking_id
         LEFT JOIN master_services ms ON ms.master_id = b.master_id AND ms.service_id = bs.service_id
         WHERE bs.booking_id = ANY($1)
         ORDER BY s.sort_order, s.name`,
        [bookingIds]
      )
    : { rows: [] };
  const servicesByBooking = new Map();
  const priceByBooking = new Map();
  for (const r of servicesRes.rows) {
    if (!servicesByBooking.has(r.booking_id)) servicesByBooking.set(r.booking_id, []);
    servicesByBooking.get(r.booking_id).push({ id: r.service_id, name: r.service_name });
    priceByBooking.set(r.booking_id, (priceByBooking.get(r.booking_id) ?? 0) + Number(r.price));
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
    // Сумма визита по прайсу и канал, по которому клиент пришёл именно на этот визит
    // (миграция 050). Оба поля - сырьё для раздела «Клиенты» (21.08.2026): в карточке
    // видно, сколько принёс каждый визит и откуда человек пришёл в первый раз.
    price: priceByBooking.get(r.id) ?? 0,
    clientSource: r.client_source ?? null,
    // Комментарий сотрудника к визиту (13.08.2026, миграция 048) - "почему сумма
    // отличалась". Именно история клиента - место, где его смотрят спустя время,
    // поэтому поле едет вместе с визитом. Мастеру срезается в
    // shapeClientCardForViewer, тем же уровнем видимости, что и actual_price.
    staffComment: r.staff_comment ?? null,
  }));

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    birthday: row.birthday instanceof Date ? row.birthday.toISOString().slice(0, 10) : row.birthday,
    noShowStreak: row.no_show_streak,
    risk: describeClientRisk(row.no_show_streak),
    // Срок в карточке - тот же объект, что принимает PATCH /clients/:id/renew: одно
    // и то же представление на чтение и на запись, чтобы форма не собирала его заново
    renew: {
      days: row.renew_days ?? null,
      recommendedDays: row.renew_days_recommended ?? null,
      reason: row.renew_reason ?? null,
      note: row.renew_note ?? null,
      setBy: row.renew_set_by ?? null,
      setByName: row.renew_set_by_name ?? null,
      setAt: row.renew_set_at instanceof Date ? row.renew_set_at.toISOString() : row.renew_set_at ?? null,
    },
    visits,
    // Итоги по клиенту (21.08.2026) - считаются из ТОЙ ЖЕ истории визитов, что уедет
    // на фронт, а не отдельным запросом: иначе у администратора, которому история
    // срезается по его точке, цифры не сошлись бы со списком под ними. По той же
    // причине их пересчитывает shapeClientCardForViewer после срезки.
    totals: summarizeClientVisits(visits),
    // Готовое сырьё для "Записать снова" (Задача 2, фронтенд) - мастер/услуги
    // последнего визита, дата и время выбираются заново на актуальной доступности.
    lastVisit: lastVisitOf(visits),
  };
}

// Итоги по истории визитов. Чистая функция ради офлайн-теста и ради того, чтобы
// правило «что считается визитом» жило в одном месте:
//   visitsCount / revenue - только состоявшиеся визиты (status = 'done'), ровно тот
//     же фильтр, что в «Финансах» (computeMasterPayroll): «Ожидается» - это ещё не
//     деньги, клиент может и отменить, отменённая бронь и неявка - тем более.
//   firstVisitDate / source - первая НЕотменённая бронь: «когда и откуда пришёл»
//     это про первое касание с салоном, а неявка таким касанием была (человека
//     салон уже привлёк), отменённая запись - нет.
// visits приходят отсортированными по дате вниз (getClientCard), поэтому первый
// визит - последний подходящий элемент массива.
export function summarizeClientVisits(visits) {
  const done = visits.filter((v) => v.status === 'done');
  const real = visits.filter((v) => v.status !== 'cancelled');
  const first = real[real.length - 1] ?? null;
  return {
    visitsCount: done.length,
    revenue: done.reduce((sum, v) => sum + (Number(v.price) || 0), 0),
    firstVisitDate: first ? first.date : null,
    lastVisitDate: done[0] ? done[0].date : null,
    source: first ? first.clientSource ?? null : null,
  };
}

// Сырьё для "Записать снова" - мастер/услуги последнего визита. Отдельная функция,
// потому что Окно 54 пересобирает lastVisit после срезки истории по роли
// (shapeClientCardForViewer ниже): два места не должны знать форму по-своему.
function lastVisitOf(visits) {
  return visits[0]
    ? { masterId: visits[0].masterId, masterName: visits[0].masterName, services: visits[0].services }
    : null;
}

// ── Окно 54 (10.08.2026, Задача A): поиск клиента по телефону ────────────────
// Контракт под Окно 55: администратор вводит телефон в единой форме записи и сразу
// видит, есть такой клиент или это новый. До этого окна такого поиска не было -
// клиент только НЕЯВНО создавался/находился при сохранении брони через
// INSERT ... ON CONFLICT (phone) (api/routes/bookings.js).
//
// ЧЕСТНАЯ ПОПРАВКА К ТЗ (правило 3 из CLAUDE.md): промпт просил нормализовать
// телефон "тем же способом, что ON CONFLICT (phone)", но там нормализации НЕТ -
// телефон пишется сырой строкой, unique-индекс clients_phone_key (миграция 002)
// построен на сыром значении. Форматы при этом разные по факту: публичный виджет
// шлёт "+7 999 123 45 67" (formatPhone, app.js:382), CRM-форма - `value.trim()` как
// есть (crm-walkin.js:273). Поэтому нормализация живёт ЗДЕСЬ и применяется
// симметрично к обеим сторонам сравнения: последние 10 цифр (для РФ это номер без
// кода страны, что схлопывает +7/8/пробелы/скобки/дефисы в один ключ). Путь записи
// не тронут - менять его значит трогать POST /bookings и мигрировать уже
// накопленные строки, это отдельное решение, а не побочный эффект чтения.
const PHONE_KEY_DIGITS = 10;

export function normalizePhoneKey(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length >= PHONE_KEY_DIGITS ? digits.slice(-PHONE_KEY_DIGITS) : digits;
}

// Та же нормализация, но над колонкой. Seq scan по clients осознан: таблица - клиенты
// ОДНОГО барбершопа, функционального индекса под это не заводим (правило проекта:
// миграции только когда без них нельзя, см. CLAUDE.md).
const PHONE_DIGITS_SQL = `regexp_replace(phone, '[^0-9]', '', 'g')`;

// Дубли одного номера в разных форматах в базе ВОЗМОЖНЫ (unique-индекс на сырой
// строке их не запрещает: "+79991234567" и "+7 999 123 45 67" - две разные строки).
// Поэтому выбор детерминированный: сначала точное совпадение присланной строки,
// иначе первый по id - никогда "случайный из двух".
// Только id и счётчик неявок, без карточки с историей визитов: PATCH
// /bookings/:id/client (Влад, 16.08.2026) привязывает бронь к клиенту и ему нужны
// ровно эти два поля - тянуть ради них все визиты клиента незачем.
export async function findClientIdByPhone(client, rawPhone) {
  const key = normalizePhoneKey(rawPhone);
  if (!key) return null;
  const res = await client.query(
    `SELECT id, no_show_streak FROM clients
     WHERE CASE WHEN length(${PHONE_DIGITS_SQL}) >= ${PHONE_KEY_DIGITS}
                THEN right(${PHONE_DIGITS_SQL}, ${PHONE_KEY_DIGITS})
                ELSE ${PHONE_DIGITS_SQL} END = $1
     ORDER BY (phone = $2) DESC, id
     LIMIT 1`,
    [key, String(rawPhone ?? '')]
  );
  return res.rows.length === 0 ? null : { id: res.rows[0].id, noShowStreak: res.rows[0].no_show_streak };
}

export async function findClientByPhone(client, rawPhone) {
  const found = await findClientIdByPhone(client, rawPhone);
  if (!found) return null;
  return getClientCard(client, found.id);
}

// Какая ветка GET /clients запрошена. Вынесено в чистую функцию, чтобы разбор
// параметров был покрыт офлайн-тестом: ветка ?risk=true существует с Окна 39 и её
// поведение (включая 400 missing_fields, когда не передано ничего) обязано остаться
// ровно прежним. Пустой/пробельный phone - это НЕ поиск, а отсутствие фильтра:
// иначе Окно 55 приняло бы "клиент не найден" за ответ на пустой ввод.
export function resolveClientsQueryMode(searchParams) {
  const phone = searchParams.get('phone');
  if (phone !== null && phone.trim() !== '') return { mode: 'phone', phone };
  if (searchParams.get('risk') === 'true') return { mode: 'risk' };
  // ?all=true - вся база клиентов для раздела «Клиенты» (21.08.2026). Отдельным
  // параметром, а не «GET /clients без параметров»: пустой запрос уже означает
  // ошибку missing_fields с Окна 39, и менять этот ответ значило бы тихо отдать
  // всю базу телефонов тому, кто просто ошибся в адресе.
  if (searchParams.get('all') === 'true') return { mode: 'all' };
  return { mode: 'invalid' };
}

// Видимость карточки по роли. Телефон мастеру не отдаём - тот же уровень, что уже
// принят в handleClientCard. История срезается по scope роли (admin - своя точка,
// master - свои визиты), но САМ факт существования клиента не скрывается: 403/404
// здесь сломали бы флоу Окна 55 (существующий клиент другой точки выглядел бы
// новым, администратор завёл бы дубль, а бэкенд при сохранении брони всё равно
// связал бы его с тем же ряд clients через ON CONFLICT (phone)). Это осознанное
// отличие от handleClientCard: там просмотр чужой карточки, здесь опознание
// клиента перед записью.
export function shapeClientCardForViewer(card, auth) {
  const scoped =
    auth.role === 'admin' ? card.visits.filter((v) => v.locationId === auth.locationId)
    : auth.role === 'master' ? card.visits.filter((v) => v.masterId === auth.id)
    : card.visits;
  // staffComment (13.08.2026) - тот же уровень видимости, что у actual_price в
  // /bookings: мастер не видит ни фактическую сумму, ни объяснение к ней (обычно
  // это "владелец дал скидку" - разговор владельца с администратором, не рабочая
  // информация мастера). Срезаем поле, а не весь визит: сам визит мастеру нужен.
  // Мастеру срезаем и цену визита (21.08.2026): деньги - тот же уровень видимости,
  // что фактическая сумма и комментарий к ней, и по итогам ниже он тоже не получает
  // строки «принёс N рублей» (summarizeClientVisits на визитах без price даст 0, но
  // мы не оставляем и этого - ключ revenue у мастера просто отсутствует).
  const visits = auth.role === 'master' ? scoped.map(({ staffComment, price, ...rest }) => rest) : scoped;
  const totals = summarizeClientVisits(visits);
  if (auth.role === 'master') delete totals.revenue;
  const shaped = { ...card, visits, totals, lastVisit: lastVisitOf(visits) };
  if (auth.role === 'master') {
    const { phone, ...withoutPhone } = shaped;
    return withoutPhone;
  }
  return shaped;
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

// ── Вся база клиентов (21.08.2026, раздел «Клиенты» - задача Влада: «база данных
// клиентов, их имена, номера телефонов, комментарии, откуда и когда пришли, история
// записей, сколько денег принесли»). Один агрегирующий запрос вместо N+1: карточку
// (getClientCard) фронт зовёт только для одного открытого клиента, список считается
// на стороне базы.
//
// ЧЕСТНАЯ ГРАНИЦА, которую видно в интерфейсе: клиент без телефона (walk-in, миграция
// 041) в этой базе не появляется вообще. Такие визиты намеренно не связываются между
// собой (решение Алихана, Окно 53 - «который из сотни Сергеев»), у них нет client_id,
// а значит нет ни истории, ни суммы «сколько принёс». Считать их отдельными клиентами
// значило бы выдумать людей, которых система не опознавала.
//
// Деньги - списочная цена услуг состоявшихся визитов (та же формула, что в
// «Финансах», решение Влада 21.08.2026), не actual_price и не sales.
export async function listAllClients(client) {
  const result = await client.query(
    `WITH visit AS (
       SELECT b.id, b.client_id, b.date, b.start_time, b.status, b.client_source, b.staff_comment,
              COALESCE(SUM(COALESCE(ms.price, s.price, 0)), 0) AS price
       FROM bookings b
       LEFT JOIN booking_services bs ON bs.booking_id = b.id
       LEFT JOIN services s ON s.id = bs.service_id
       LEFT JOIN master_services ms ON ms.master_id = b.master_id AND ms.service_id = bs.service_id
       WHERE b.client_id IS NOT NULL
       GROUP BY b.id
     ),
     first_visit AS (
       SELECT DISTINCT ON (client_id) client_id, date, client_source
       FROM visit WHERE status <> 'cancelled'
       ORDER BY client_id, date ASC, start_time ASC
     ),
     last_comment AS (
       -- ТОЛЬКО НАЧАЛО текста, не весь комментарий (21.08.2026, Влад: «клиенты очень
       -- долго грузятся»). Замер на 3000 клиентах: сам запрос 150-185 мс, а ответ
       -- весил 9,3 МБ - полный комментарий до 3000 знаков на КАЖДОГО клиента, при том
       -- что список его даже не показывает. Целиком комментарий приходит там, где он
       -- нужен - в карточке клиента (GET /clients/:id), по одному человеку за раз
       SELECT DISTINCT ON (client_id) client_id, left(staff_comment, 120) AS staff_comment, date
       FROM visit WHERE staff_comment IS NOT NULL
       ORDER BY client_id, date DESC, start_time DESC
     )
     SELECT c.id, c.name, c.phone, c.no_show_streak,
            COUNT(v.id) FILTER (WHERE v.status = 'done') AS visits_count,
            COALESCE(SUM(v.price) FILTER (WHERE v.status = 'done'), 0) AS revenue,
            MAX(v.date) FILTER (WHERE v.status = 'done') AS last_visit_date,
            COUNT(v.id) FILTER (WHERE v.staff_comment IS NOT NULL) AS comments_count,
            f.date AS first_visit_date, f.client_source AS source,
            lc.staff_comment AS last_comment
     FROM clients c
     LEFT JOIN visit v ON v.client_id = c.id
     LEFT JOIN first_visit f ON f.client_id = c.id
     LEFT JOIN last_comment lc ON lc.client_id = c.id
     GROUP BY c.id, c.name, c.phone, c.no_show_streak, f.date, f.client_source, lc.staff_comment
     ORDER BY f.date DESC NULLS LAST, c.name`,
    []
  );
  const asDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ?? null);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    visitsCount: Number(r.visits_count),
    revenue: Number(r.revenue),
    firstVisitDate: asDate(r.first_visit_date),
    lastVisitDate: asDate(r.last_visit_date),
    source: r.source ?? null,
    commentsCount: Number(r.comments_count),
    // Начало последнего комментария (до 120 знаков), не весь текст - см. CTE выше
    lastComment: r.last_comment ?? null,
    noShowStreak: r.no_show_streak,
    risk: describeClientRisk(r.no_show_streak),
  }));
}

// Окно 40 (06.08.2026) - агрегатор дашборда владельца "Сегодня"
// (PRODUCT_ARCHITECTURE_PLAN разд.1, UX_UI_REDESIGN_SPECIFICATION разд.5). Один
// роут вместо двух - избегает N+1 запросов с фронта. Мастера без графика -
// findMastersMissingSchedule/mastersWithWorkingSchedule (Окно 35): расчёт остался и
// после того, как одноимённое уведомление сняли 20.08.2026, потому что баннер «Нет
// рабочего графика» наверху «Расписания» кормится именно отсюда. Клиенты на грани
// ухода - listClientsAtRisk без фильтра (Окно 39), владелец видит всех.
export async function computeOwnerAlerts(client) {
  const staffRes = await client.query('SELECT id, name FROM staff WHERE employed = true AND provides_services = true');
  const serviceMasterIds = staffRes.rows.map((r) => r.id);
  const scheduledIds = await mastersWithWorkingSchedule(client, serviceMasterIds);
  const missingIds = findMastersMissingSchedule(serviceMasterIds, scheduledIds);
  const nameById = new Map(staffRes.rows.map((r) => [r.id, r.name]));
  const mastersWithoutSchedule = missingIds.map((id) => ({ id, name: nameById.get(id) ?? id }));

  // pendingRequests (необработанные заявки мастеров на отгул) убран 20.08.2026:
  // механизм заявок снят целиком - формы у мастера нет, роутов /schedule-requests нет,
  // показывать этот список больше негде. Ключ пропал и из ответа роута - потребителей
  // у него не осталось ни одного (проверено грепом по assets/).

  const clientsAtRisk = await listClientsAtRisk(client, {});

  return { mastersWithoutSchedule, clientsAtRisk };
}

// ── /owner/alerts - Окно 40 (06.08.2026). Один агрегирующий роут для дашборда
// "Сегодня" через computeOwnerAlerts - владелец получает три источника алертов
// (мастера без графика, необработанные заявки, клиенты в риске) одним запросом.
export async function handleOwnerAlerts(req, res) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const result = await computeOwnerAlerts(pool);
  return sendJson(res, 200, result);
}

// ── /clients - две ветки. ?risk=true - список "требует внимания" (Окно 39,
// 06.08.2026, Задача 1) через listClientsAtRisk. Тот же приём разграничения по
// роли, что у /payroll и /revenue/today: admin форсирован на свою точку, master -
// на своих клиентов (тех, у кого есть бронь с этим мастером), owner видит всех.
// Телефон - тот же уровень видимости, что в GET /bookings (разд.12 п.1 ТЗ):
// мастеру не отдаём. ?phone= - поиск клиента перед записью (Окно 54, Задача A),
// 404 client_not_found = "новый клиент" для Окна 55.
export async function handleClientsAtRisk(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_STAFF_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const query = resolveClientsQueryMode(url.searchParams);
  if (query.mode === 'invalid') return sendJson(res, 400, { error: 'missing_fields' });
  if (query.mode === 'all') {
    // Вся база с телефонами - только владелец и управляющий (решение Влада
    // 21.08.2026). Администратору и мастеру раздела «Клиенты» в интерфейсе нет, но
    // проверка стоит на сервере: спрятанный пункт меню не защищает от прямого
    // запроса к API, а здесь отдаётся телефон каждого клиента салона.
    if (!canManageStaff(auth)) return sendJson(res, 403, { error: 'forbidden' });
    return sendJson(res, 200, await listAllClients(pool));
  }
  if (query.mode === 'phone') {
    const card = await findClientByPhone(pool, query.phone);
    if (!card) return sendJson(res, 404, { error: 'client_not_found' });
    return sendJson(res, 200, shapeClientCardForViewer(card, auth));
  }
  const locationId = auth.role === 'admin' ? auth.locationId : undefined;
  const masterId = auth.role === 'master' ? auth.id : undefined;
  const list = await listClientsAtRisk(pool, { locationId, masterId });
  const shaped = auth.role === 'master' ? list.map(({ phone, ...rest }) => rest) : list;
  return sendJson(res, 200, shaped);
}

// ── PATCH /clients/:id/renew - срок обновления стрижки из карточки клиента (Окно 59,
// 22.08.2026). Основное место ввода - закрытие визита (PATCH /bookings/:id/status),
// здесь же поправка задним числом: «договорились на месяц, а он в отпуске до октября».
//
// Права - ровно те же, что на простановку статуса визита: администратор, владелец,
// управляющий (правка Влада 22.08.2026 - «у мастера такой возможности не должно быть
// вообще»). Мастер срок ВИДИТ в карточке клиента, но не ставит и не правит: договор о
// сроке фиксирует тот же человек, что закрывает визит. Scope администратора - как у
// GET /clients/:id: только клиент, у которого есть визит на его точке.
export async function handleClientRenew(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 403, { error: 'forbidden' });
  const clientId = decodeURIComponent(parts[1]);
  const body = await readBody(req);
  const parsed = normalizeRenewInput(body?.renew ?? body);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

  // Существование клиента проверяется ДО scope-проверки - 404 одинаков для всех ролей
  // и не палит, есть такой клиент или просто чужой (тот же приём, что в handleClientCard)
  const card = await getClientCard(pool, clientId);
  if (!card) return sendJson(res, 404, { error: 'client_not_found' });
  if (auth.role === 'admin' && !card.visits.some((v) => v.locationId === auth.locationId)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  const renew = parsed.value;
  const saved = await pool.query(
    `UPDATE clients SET renew_days = $1, renew_days_recommended = $2, renew_reason = $3,
                        renew_note = $4, renew_set_by = $5, renew_set_at = now()
      WHERE id = $6
      RETURNING renew_days, renew_days_recommended, renew_reason, renew_note, renew_set_by, renew_set_at`,
    [renew.days, renew.recommendedDays, renew.reason, renew.note, auth.id ?? null, clientId]
  );
  const row = saved.rows[0];
  // Живое обновление открытых вкладок - тот же канал, что у статуса брони: срок влияет
  // на «Недополученную прибыль», и она не должна показывать вчерашнюю картину
  publish('bookings', { clientId, reason: 'renew' });
  return sendJson(res, 200, {
    ok: true,
    renew: {
      days: row.renew_days,
      recommendedDays: row.renew_days_recommended ?? null,
      reason: row.renew_reason,
      note: row.renew_note ?? null,
      setBy: row.renew_set_by ?? null,
      setByName: auth.name ?? null,
      setAt: row.renew_set_at instanceof Date ? row.renew_set_at.toISOString() : row.renew_set_at ?? null,
    },
  });
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
  if (!requireRole(auth, BOOKING_STAFF_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
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
    // Найдено живым прогоном 13.08.2026: этот роут (в отличие от опознания клиента
    // по телефону, shapeClientCardForViewer) срезает мастеру только телефон, список
    // визитов отдаёт целиком - осознанное старое решение (мастеру полезна вся история
    // клиента, см. комментарий у shapeClientCardForViewer). Но комментарий сотрудника
    // к визиту (миграция 048) - тот же уровень видимости, что фактическая сумма, к
    // которой он написан: owner/admin. Срезаем именно поле, историю не трогаем.
    const { phone, ...cardWithoutPhone } = card;
    // 21.08.2026 - вместе с комментарием срезается и цена визита (тот же уровень
    // видимости, что фактическая сумма), а итоги пересчитываются уже без денег:
    // иначе мастер получил бы «принёс N рублей» суммой, которую по строкам не видит.
    const visits = cardWithoutPhone.visits.map(({ staffComment, price, ...visit }) => visit);
    const totals = summarizeClientVisits(visits);
    delete totals.revenue;
    return sendJson(res, 200, { ...cardWithoutPhone, visits, totals });
  }
  return sendJson(res, 200, card);
}
