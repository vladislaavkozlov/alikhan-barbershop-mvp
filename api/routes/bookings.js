// GET/POST /bookings, /bookings/:id/cancel, /bookings/:id/status, GET/POST /sales -
// вынесено из server.mjs при декомпозиции (Этап 2 структурного рефакторинга,
// 07.08.2026), код перенесён без изменений.
import { randomBytes } from 'node:crypto';
import { sendJson, readBody } from '../lib/http.js';
import { currentTenantId, pool } from '../lib/db.js';
import { currentVertical } from '../lib/tenant-context.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { BOOKING_OPERATOR_ROLES, BOOKING_STAFF_ROLES } from '../lib/permissions.js';
import { addMinutes, dateColToStr, intervalsOverlap, shopNow, toMinutes } from '../lib/time.js';
import { mastersWithWorkingSchedule, masterAcceptsClients, getEffectiveSchedule, blockedIntervalsFor } from '../lib/schedule-core.js';
import { notifyStaff } from '../lib/notify-core.js';
import { cancelPendingForBooking, createInvite, deliverForClientSoon, enqueueForBooking, enqueueNoShowFollowup, inviteLink } from '../lib/client-messaging.js';
import { telegramConfig } from '../lib/channel-telegram.js';
import { findClientIdByPhone } from './clients.js';
// Живое обновление кабинетов (17.08.2026): каждое изменение брони уходит в открытые
// кабинеты сразу, чтобы запись появлялась в расписании без кнопки «Обновить»
import { publish } from '../lib/events.js';
import { hasComboConflict } from '../lib/service-combos.js';
import { normalizeRenewInput } from '../lib/renew-reason.js';
import { p } from '../lib/vertical-terms.js';

// Админы точки - адресаты уведомлений о её записях (Окно 14: Мамедхан управляет
// точкой день в день). Один запрос на два вызова - createBookingTx и перенос
// (Окно 54, Задача C) - чтобы условие отбора адресатов не разъехалось между
// созданием и переносом одной и той же брони.
// Кому, кроме мастера, уходит уведомление о записи. Администратор - только своей
// точки (он ведёт её день в день), владелец и управляющий - всегда: точки к ним не
// привязаны, они отвечают за весь барбершоп. Владелец до 20.08.2026 в этот список не
// попадал вовсе и о новых записях не узнавал ничего (решение Влада: должен узнавать,
// точка у Алихана одна). Уволенные и лишённые доступа отсеиваются - иначе строки
// копились бы в базе на людей, которые в CRM уже не войдут.
export async function bookingWatcherIds(client, locationId) {
  const res = await client.query(
    `SELECT id FROM staff
      WHERE employed = true AND has_system_access = true
        AND (role IN ('owner', 'manager') OR (role = 'admin' AND location_id = $1))`,
    [locationId]
  );
  return res.rows.map((r) => r.id);
}

// Имена мастеров для текста уведомления о переносе (Окно 54, Задача C) - «ушла к
// Мамедхану» вместо «ушла к staff-3».
async function masterNamesByIds(client, ids) {
  const unique = [...new Set(ids.filter((id) => id != null))];
  if (unique.length === 0) return {};
  const res = await client.query('SELECT id, name FROM staff WHERE id = ANY($1)', [unique]);
  return Object.fromEntries(res.rows.map((r) => [r.id, r.name]));
}

// Задача 2 промпта корректировки Окна 13 (01.08.2026, Блок 5 в.19, Алихан): "отмена не
// позже 2 часов" - до порога полный возврат/бесплатная отмена, после - без возврата.
const CANCEL_FULL_REFUND_HOURS = 2;

// ── Бронирование поверх нормализованной схемы (Шаг 1-2 Окна 8) ────────────
// Та же гарантия, что раньше давал casWrite по kv_store: pg_advisory_xact_lock
// сериализует все параллельные попытки одного мастера на одну дату, поэтому два
// устройства не могут обе "выиграть" один слот (см. storage.js/createBooking).
// Задача Окна 11 (найдено Владом 30.07.2026): клиент выбирает НЕСКОЛЬКО услуг за
// один визит, не одну - serviceIds теперь массив (минимум 1 элемент). Длительность
// слота = сумма duration_min всех выбранных услуг ПО ЭТОМУ МАСТЕРУ (master_services,
// Окно 10 - у Екатерины другая цена/длительность на части услуг), не общий прайс.
// isStaff (08.08.2026, жалоба Влада: "интернет отключили / администратор отвлёкся,
// клиента обслужили, а внести в систему нечем - должна быть возможность занести
// визит задним числом из CRM") - ИСКЛЮЧИТЕЛЬНО из authenticate(req) (см. handleBookings
// ниже), НЕ из тела запроса. Публичный виджет записи (index.html/app.js) шлёт этот же
// POST /bookings анонимно (auth===null) - past_time для него остаётся строгим, как и
// было: клиенту самому в прошлое не записаться. Разграничение по channel (строке из
// body) было бы небезопасным - анонимный запрос мог бы просто прислать
// channel:'admin' и обойти проверку, isStaff подделать нельзя, потому что это флаг с
// сервера, не эхо входных данных.
// ── Единая проверка доступности слота (Окно 54, 10.08.2026, Задача B) ─────────
// Вынесено из createBookingTx БЕЗ изменения поведения и порядка рубежей: те же
// четыре проверки, те же коды ответа, та же последовательность (мастер вообще
// принимает записи → прошлое время → пересечение с чужими бронями → рабочий
// график/перерыв/выходной). Причина выноса - требование ТЗ Окна 54: перенос записи
// обязан пропускать слот по ТЕМ ЖЕ правилам, что создание, иначе перенос стал бы
// дырой в правилах, которые соблюдает POST /bookings. Одна функция вместо двух
// копий - тот же принцип единого источника истины, что уже применён к
// mastersWithWorkingSchedule (Окно 29) и getEffectiveSchedule (Окно 16).
//
// excludeBookingId - ЕДИНСТВЕННОЕ отличие переноса от создания: переносимая запись
// не должна конфликтовать сама с собой (сохранение "без изменений" или смена только
// услуги). При создании передаётся null и условие самонейтрализуется в SQL, отдельной
// версии запроса нет.
//
// Возвращает null (препятствий нет) либо готовый { status, body } - вызывающая
// транзакция делает ROLLBACK и отдаёт это наружу как есть.
export async function checkSlotAvailability(client, { masterId, date, startTime, endTime, isStaff, excludeBookingId = null }) {
  // Задача C промпта Окна 29 (05.08.2026) - финальный рубеж: мастер без единого
  // рабочего дня в стандартном графике физически ещё не готов принимать записи
  // (только что нанят, график не выставлен). До этой правки getEffectiveSchedule
  // молча фолбэчился на GLOBAL_DEFAULT "10:00-20:00, без перерыва" - день выглядел
  // полностью свободным. Проверка тем же критерием, что уже видит владелец в CRM
  // (hasWorkingSchedule, Окно 22) - защищает и от прямого вызова API в обход
  // фронта, по тому же принципу, что и существующая защита от гонки (schedule_blocked).
  const workingSet = await mastersWithWorkingSchedule(client, [masterId]);
  if (!workingSet.has(masterId)) {
    return { status: 409, body: { ok: false, reason: 'master_not_bookable' } };
  }
  // Второй рубеж (13.08.2026): график заполнен, но сотрудник снят с приёма клиентов -
  // отдельная причина и отдельный текст, иначе владелец увидит "не настроен график"
  // там, где график как раз настроен, и пойдёт чинить не то.
  if (!await masterAcceptsClients(client, masterId)) {
    return { status: 409, body: { ok: false, reason: 'master_not_accepting' } };
  }

  const { date: today, time: nowTime } = shopNow();
  const isPast = date < today || (date === today && startTime < nowTime);
  if (isPast && !isStaff) {
    return { status: 409, body: { ok: false, reason: 'past_time' } };
  }

  const existingRes = await client.query(
    `SELECT start_time, end_time FROM bookings
     WHERE master_id = $1 AND date = $2 AND status != 'cancelled'
       AND ($3::text IS NULL OR id != $3)`,
    [masterId, date, excludeBookingId]
  );
  const hasOverlap = existingRes.rows.some((b) =>
    intervalsOverlap(startTime, endTime, b.start_time, b.end_time)
  );
  if (hasOverlap) {
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
    return { status: 409, body: { ok: false, reason: 'schedule_blocked' } };
  }

  return null;
}

// ── Тариф записи (20.08.2026, миграция 054) ────────────────────────────────
// Условия, на которых сделана запись. 'top' - если хотя бы одна услуга этого визита
// помечена у мастера топовой (master_services.is_top): одна топ-услуга в чеке уже
// означает, что клиент платит по топ-цене, значит и записан он на условиях топ-мастера.
// Пустой состав - null, а не 'standard': бронь без услуг тарифа не имеет, и врать про
// её условия в отчётности владельца нельзя. Чистая функция - проверяется юнитом без
// Postgres (тот же приём, что у buildPublicMasters и computeMasterPayroll).
export const MASTER_TIERS = ['standard', 'top'];

export function resolveMasterTier(masterServiceRows) {
  if (!Array.isArray(masterServiceRows) || masterServiceRows.length === 0) return null;
  return masterServiceRows.some((r) => r.is_top === true) ? 'top' : 'standard';
}

async function createBookingTx({ masterId, serviceIds, date, startTime, clientName, clientPhone, channel, isStaff, clientSource }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${masterId}:${date}`]);

    const msRes = await client.query(
      'SELECT service_id, duration_min, price, is_top FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
      [masterId, serviceIds]
    );
    if (msRes.rows.length !== serviceIds.length) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master_service' } };
    }
    const totalDuration = msRes.rows.reduce((sum, r) => sum + r.duration_min, 0);
    const totalPrice = msRes.rows.reduce((sum, r) => sum + r.price, 0);
    const masterTier = resolveMasterTier(msRes.rows);
    const endTime = addMinutes(startTime, totalDuration);

    const blocked = await checkSlotAvailability(client, { masterId, date, startTime, endTime, isStaff });
    if (blocked) {
      await client.query('ROLLBACK');
      return blocked;
    }

    const staffRes = await client.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
    if (staffRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master' } };
    }
    const locationId = staffRes.rows[0].location_id;

    // Решение Алихана 09.08.2026 (найдено живьём, Окно 53, Задача J): клиента с
    // телефоном - в общую базу clients как раньше, без изменений. Клиента БЕЗ
    // телефона (постоянный walk-in, который просто не называет номер) - НЕ
    // пытаться опознавать/связывать с прошлыми визитами по одному имени (не
    // масштабируется - "который из сотни Сергеев", память
    // feedback_ne-predlagat-matching-bez-unikalnogo-klyucha), но и не терять имя
    // молча, как было до этой правки. clientId остаётся null (эти визиты и есть
    // "неидентифицированные", см. countUnidentifiedToday в payroll.js), имя
    // сохраняется отдельно на самой брони - walkin_name (миграция 041).
    let clientId = null;
    let requiresPrepayment = false;
    if (clientPhone) {
      const clientRes = await client.query(
        `INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name)
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
    // walkin_name (миграция 041) - сырое имя прямо на брони, независимо от clientId.
    // Заполняется всегда, когда указано имя - раньше терялось молча, если
    // администратор не указал телефон (clientId оставался null).
    // master_tier (20.08.2026, миграция 054) - на каких условиях сделана запись.
    // Пишется в момент создания и дальше живёт вместе с бронью: галку «топ» у мастера
    // могут снять через месяц, а эта запись обязана помнить, почему в чеке была та цена.
    // client_source (17.08.2026, миграция 050) - откуда пришёл клиент. С публичного
    // сайта приезжает определённым автоматически (UTM-метка ссылки в карточке
    // организации, иначе referrer - assets/client-source.js), из CRM - выбором
    // администратора в форме записи. Не определился - остаётся NULL, это законное
    // состояние (клиент зашёл мимо или позвонил), а не пропуск данных.
    await client.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel, requires_prepayment, walkin_name, client_source, master_tier)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'planned', $8, $9, $10, $11, $12)`,
      [bookingId, locationId, masterId, clientId, date, startTime, endTime, channel ?? 'client', requiresPrepayment, clientName ?? null, clientSource ?? null, masterTier]
    );
    for (const serviceId of serviceIds) {
      await client.query('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [bookingId, serviceId]);
    }
    // Задача 5 (Окно 14) - мастер узнаёт о новой записи в личном кабинете сразу, в
    // момент её создания. С 20.08.2026 это ЕДИНСТВЕННЫЙ момент, когда уведомление о
    // записи появляется: напоминания «за 15 минут»/«время пришло» сняты вместе с
    // фоновым сканером (решение Влада), возвращать их нельзя без обратной миграции к 051.
    await notifyStaff(client, masterId, 'booking_new', {
      bookingId,
      title: p('booking.new'),
      body: `${startTime}–${endTime}${clientName ? ' · ' + clientName : ''}`,
    });
    // Владелец, управляющий и администратор точки. Мастеру, если он же владелец
    // (у Алихана так и есть - master-1), второе уведомление не задвоится: дедуп-индекс
    // notifications_booking_dedup стоит ровно на (staff_id, type, booking_id), и повтор
    // молча гаснет через ON CONFLICT DO NOTHING - у человека остаётся первая строка.
    for (const watcherId of await bookingWatcherIds(client, locationId)) {
      await notifyStaff(client, watcherId, 'booking_new', {
        bookingId,
        title: p('booking.new'),
        body: `${startTime}–${endTime}${clientName ? ' · ' + clientName : ''}`,
      });
    }
    // Сообщения самому клиенту (Волна 1, 01.09.2026): подтверждение, напоминания за
    // сутки и за два часа, просьба об отзыве. Здесь только постановка в очередь, в
    // той же транзакции, что и сама запись - отправка идёт своим чередом
    // (lib/client-messaging.js). Запись без клиента (walk-in с улицы) очереди не
    // порождает: писать некому.
    if (clientId) {
      await enqueueForBooking(
        { id: bookingId, client_id: clientId, date, start_time: startTime, end_time: endTime },
        new Date(),
        client,
      );
    }
    await client.query('COMMIT');
    // Клиент уже в боте - подтверждение уходит сразу после фиксации записи, а не
    // через минуту. Отдельно от транзакции: администратор не должен ждать сеть,
    // а неудачная отправка не должна откатывать саму запись
    if (clientId) deliverForClientSoon(currentTenantId(), currentVertical(), clientId);

    // Что сказать человеку про бота прямо на экране «вы записаны» (01.09.2026).
    // Уже подключён - подтверждение ему уже летит, предлагать нечего. Не подключён -
    // отдаём одноразовую ссылку, чтобы кнопка на сайте вела сразу в диалог.
    //
    // Осознанный компромисс первой версии: ссылку получает тот, кто оформил запись
    // на этот телефон. Знающий чужой номер может записать человека и привязаться
    // вместо него - тогда чужие напоминания пойдут ему. Полностью это закрывается
    // только подтверждением номера кодом, которого у нас пока нет; до тех пор
    // приглашение одноразовое, живёт сутки, а привязку видно в карточке клиента.
    const bot = clientId ? await botInviteFor(clientId) : null;
    return {
      status: 200,
      body: {
        ok: true,
        bot,
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

  // COALESCE(c.name, b.walkin_name) - клиент с телефоном берёт имя из общей базы
  // clients (как раньше), клиент без телефона (walkin_name, миграция 041) - имя
  // прямо с брони, вместо молчаливой потери (найдено 09.08.2026, Окно 53).
  let query = `SELECT b.id, b.master_id, b.service_id, b.date, b.start_time, b.end_time, b.status,
                      b.client_confirmed, b.location_id, b.requires_prepayment, b.review_request_pending,
                      b.actual_price, b.staff_comment, b.client_id, b.client_source, b.master_tier,
                      COALESCE(c.name, b.walkin_name) AS client_name, c.phone AS client_phone,
                      c.birthday AS client_birthday, c.no_show_streak AS client_no_show_streak
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
    ? await pool.query(
        `SELECT bs.booking_id, bs.service_id FROM booking_services bs
           JOIN services s ON s.id = bs.service_id
          WHERE bs.booking_id = ANY($1)
          ORDER BY s.sort_order, s.name`,
        [bookingIds]
      )
    : { rows: [] };
  const serviceIdsByBooking = new Map();
  for (const row of servicesRes.rows) {
    if (!serviceIdsByBooking.has(row.booking_id)) serviceIdsByBooking.set(row.booking_id, []);
    serviceIdsByBooking.get(row.booking_id).push(row.service_id);
  }

  // Метка "+1 новый клиент" (17.08.2026). Считать её по самой выборке нельзя: выборка
  // это ОДИН день, и постоянный клиент, чей прошлый визит был на прошлой неделе, в неё
  // не попадает - он бы каждый раз выглядел новым. Поэтому отдельный запрос по всей
  // истории именно тех клиентов, что есть в выборке (индекс bookings_client_history_idx,
  // миграция 050), а решение "какая бронь первая" принимает чистая функция - она же
  // покрыта офлайн-тестом, второй копии правила в SQL нет.
  const clientIds = [...new Set(result.rows.map((r) => r.client_id).filter(Boolean))];
  const historyRes = clientIds.length
    ? await pool.query(
        `SELECT id, client_id, date, start_time, status FROM bookings
          WHERE client_id = ANY($1) AND status <> 'cancelled'`,
        [clientIds]
      )
    : { rows: [] };
  const firstBookingId = firstBookingIdByClient(historyRes.rows);

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
      // masterTier (20.08.2026, миграция 054) - условия записи ('top' | 'standard' |
      // null у броней, созданных до фичи). Видно всему персоналу, включая мастера, в
      // отличие от канала привлечения: это не управленческая информация о клиенте, а
      // условия его собственной работы - по какому прайсу принят этот визит.
      masterTier: r.master_tier ?? null,
    };
    if (!auth) return base; // клиент без входа - карточек других клиентов вообще не видит
    // Блок В (ТЗ-готовность-к-продакшену, 01.08.2026): день рождения клиента - не
    // персональные данные уровня телефона (разд.12 п.1 ограничивает только phone),
    // и crm-master.html уже показывает поле "Дата рождения клиента" - мастеру нужно
    // знать дату, чтобы поздравить. Видна owner/admin/master, не анонимному запросу.
    const clientBirthday = r.client_birthday instanceof Date ? r.client_birthday.toISOString().slice(0, 10) : r.client_birthday;
    // clientIsNew виден ВСЕМУ персоналу, включая мастера: это не персональные данные
    // (в отличие от телефона), а рабочая пометка - новому человеку мастер и здоровается
    // иначе, и салон показывает. Про walk-in без телефона метки нет вовсе (см.
    // firstBookingIdByClient) - там это было бы догадкой, а не фактом.
    const clientIsNew = Boolean(r.client_id) && firstBookingId.get(r.client_id) === r.id;
    if (BOOKING_OPERATOR_ROLES.includes(auth.role)) {
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
        // actualPrice (08.08.2026, вечер) - видно только owner/admin, тем же
        // уровнем доступа, что и сама возможность её редактировать
        // (handleBookingActualPrice) - мастеру эта цифра не нужна для работы.
        actualPrice: r.actual_price,
        // staffComment (13.08.2026, миграция 048) - объяснение, почему фактическая
        // сумма отличается от прайса ("владелец дал скидку"). Тот же уровень
        // видимости, что и сама сумма: мастер её не видит, значит и объяснение
        // к ней ему не показываем.
        staffComment: r.staff_comment ?? null,
        clientIsNew,
        // clientSource (17.08.2026, миграция 050) - откуда клиент пришёл. Уровень
        // видимости тот же, что у телефона и комментария: канал привлечения это
        // управленческая информация владельца/администратора, а не рабочая мастера.
        clientSource: r.client_source ?? null,
      };
    }
    return { ...base, clientName: r.client_name, clientBirthday, clientIsNew }; // master: имя, ДР и "новый" видно, телефон и канал - нет
  });
}

// ── /bookings - GET публичный (без клиентских данных) + по роли, POST для записи ──
// Состояние бота для только что созданной записи: либо «подтверждение уже летит»,
// либо ссылка на подключение. Ошибки здесь глушим: запись создана, и рассказ про
// бота не должен превращать успех в ошибку на экране человека.
async function botInviteFor(clientId) {
  try {
    const config = await telegramConfig(currentTenantId());
    if (!config?.username) return null;
    const linked = await pool.query(
      `SELECT 1 FROM client_channels
        WHERE client_id = $1 AND channel = 'telegram' AND unsubscribed_at IS NULL`,
      [clientId],
    );
    if (linked.rowCount) return { linked: true };
    const token = await createInvite(clientId, 'telegram');
    return { linked: false, link: inviteLink(config.username, token) };
  } catch (err) {
    console.error('приглашение в бота не выдано (запись создана):', err.message);
    return null;
  }
}

export async function handleBookings(req, res, url) {
  if (req.method === 'GET') {
    const auth = await authenticate(req);
    const bookings = await listBookingsForRequest(url, auth);
    return sendJson(res, 200, { bookings });
  }
  if (req.method === 'POST') {
    const auth = await authenticate(req);
    // Правка 08.08.2026 (Влад: реальный процесс работы точки - мастер обслуживает
    // клиента и называет услуги/сумму администратору, ЗАПИСЬ и оплату проводит
    // администратор, не мастер сам себе: "нужно, чтобы только у администратора
    // была возможность записывать клиентов"). Анонимный запрос (auth===null, клиент
    // с публичного сайта) этой проверки не касается вообще - остаётся как был.
    if (auth && auth.role === 'master') {
      return sendJson(res, 403, { error: 'forbidden', reason: 'master_cannot_create_bookings' });
    }
    const body = await readBody(req);
    // Окно 11: контракт принимает serviceIds (массив, 1+) - serviceId (единичное
    // значение) остаётся принят для обратной совместимости со старыми клиентами,
    // оборачивается в массив из одного элемента.
    const serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds : body.serviceId ? [body.serviceId] : [];
    if (!body.masterId || !body.date || !body.startTime || serviceIds.length === 0) {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    // Комплекс и услуга, которая в него входит, разом - двойная оплата одного и того
    // же. Проверка нужна и здесь, на публичной записи с сайта: форма такой набор уже
    // не собирает, но запрос может прийти из старой открытой вкладки или мимо неё
    if (hasComboConflict(serviceIds)) {
      return sendJson(res, 400, { error: 'combo_conflict' });
    }
    // source (17.08.2026) - необязательное поле: старая открытая вкладка сайта и
    // прежние интеграции шлют запись без него и работают как раньше. Неизвестный
    // ключ отбиваем 400, а не пишем молча - иначе опечатка стала бы "каналом"
    const sourceOut = normalizeClientSource(body.source);
    if (sourceOut.error) return sendJson(res, 400, { error: sourceOut.error });
    const result = await createBookingTx({
      masterId: body.masterId,
      serviceIds,
      date: body.date,
      startTime: body.startTime,
      clientName: body.clientName ?? null,
      clientPhone: body.clientPhone ?? null,
      channel: body.channel ?? (auth ? 'admin' : 'client'),
      isStaff: !!auth,
      clientSource: sourceOut.value,
    });
    // Новая запись - главный случай, ради которого заводилось живое обновление
    // (Влад: «записал клиента - и сразу запись уже отображена»). Публикуем только
    // успех: отказ по занятому времени ничего в расписании не поменял
    if (result.status === 200 && result.body?.ok !== false) {
      publish('bookings', { date: body.date, masterId: body.masterId, bookingId: result.body?.booking?.id ?? null, reason: 'created' });
      // Та же запись создала уведомления мастеру и владельцу (notifyStaff в
      // createBookingTx) - без этой строки лента и колокольчик узнавали бы о ней
      // только со следующим тиком счётчика, до 45 секунд спустя, а раздел
      // «Уведомления» не обновлялся бы вовсе. Тип 'notifications' в потоке был
      // объявлен с самого начала (api/lib/events.js), но никто его не публиковал.
      publish('notifications', { reason: 'booking-created' });
    }
    return sendJson(res, result.status, result.body);
  }
}

// ── /bookings/:id - НАСТОЯЩЕЕ удаление (08.08.2026, Влад: "мастер зашёл случайно,
// сохранил не на ту дату - её же можно спокойно удалить?"). /cancel ниже только
// меняет статус на 'cancelled' - но computeMasterPayroll (api/routes/payroll.js) не
// фильтрует брони по статусу вообще, значит отменённая запись всё равно продолжила
// бы считаться в выручке/зарплате мастера. Для "случайно не туда нажал" это не
// годится - нужно, чтобы записи как будто не было. owner - любая запись, admin -
// только своя точка (та же матрица, что у /cancel), master сюда не допущен вовсе
// (см. отдельную правку в этом же окне - "только администратор записывает клиентов",
// тем же принципом и удаляет). booking_services/notifications подчищаются сами (ON
// DELETE CASCADE, миграции 013/015) - ручной DELETE по ним не нужен.
//
// force (08.08.2026, вторая правка того же вечера) - sales.booking_id БЕЗ каскада
// (002_schema.sql): к записи может быть привязана РЕАЛЬНАЯ продажа, которая уже
// участвует в расчёте зарплаты. Первый заход без force=true - явная 409 has_sale, не
// сырая FK-ошибка (тот же урок, что и инцидент с schedule_change_requests, см. память
// reference_barbershop-crm-tech.md). Если сотрудник ПОДТВЕРДИЛ (force=true из
// повторного запроса после предупреждения на фронте) - продажи по этой записи
// удаляются вместе с ней, одной транзакцией.
export async function handleBookingDelete(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query('SELECT id, location_id FROM bookings WHERE id = $1', [bookingId]);
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  const body = await readBody(req);
  const force = body?.force === true;
  const saleRes = await pool.query('SELECT id, amount FROM sales WHERE booking_id = $1', [bookingId]);
  if (saleRes.rows.length > 0 && !force) {
    return sendJson(res, 409, {
      ok: false,
      reason: 'has_sale',
      saleCount: saleRes.rows.length,
      saleTotal: saleRes.rows.reduce((sum, r) => sum + r.amount, 0),
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (saleRes.rows.length > 0) {
      await client.query('DELETE FROM sales WHERE booking_id = $1', [bookingId]);
    }
    await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  publish('bookings', { bookingId, reason: 'deleted' });
  return sendJson(res, 200, { ok: true });
}

// ── /bookings/:id/cancel - Задача 2 (Окно 13, 01.08.2026, Блок 5 в.19). Отмена
// сама по себе ничем не ограничена по времени - ограничено только право на полный
// возврат. Онлайн-оплаты в MVP нет (см. Ограничения промпта), поэтому "возврат"
// здесь не реальная транзакция, а флаг refundEligible в ответе, на который
// ориентируется сотрудник в разговоре с клиентом. Доступ сужен той же матрицей,
// что и видимость самой брони (listBookingsForRequest): owner - любая, admin -
// только своя точка, master - только свои записи.
// Отмена записи (20.08.2026, решение Влада): узнают все, кого она касается - мастер,
// у которого сорвался визит, плюс владелец, управляющий и администратор точки.
//
// В ленте остаётся ОДНА строка на запись: прежние уведомления по этой брони
// («Новая запись», «Запись перенесена») удаляются здесь же. Иначе у человека висело бы
// два взаимоисключающих сообщения об одном визите - тот же довод и тот же приём, что у
// переноса (applyRescheduleNotifications выше). Новая строка встаёт наверх списка,
// снова непрочитанной и снова видимой в колокольчике, даже если прежнюю оттуда убрали
// крестиком: отмена - новая информация, а не повтор разобранного (refresh, notify-core).
//
// Ошибку отправки глушим: запись уже отменена в базе, и падение на уведомлении не
// должно превращать успешную отмену в 500 для того, кто её нажал.
async function notifyAboutCancelledBooking(booking, bookingDate) {
  const client = await pool.connect();
  try {
    const clientRes = await client.query(
      `SELECT COALESCE(c.name, b.walkin_name) AS client_name
         FROM bookings b LEFT JOIN clients c ON c.id = b.client_id WHERE b.id = $1`,
      [booking.id]
    );
    const clientName = clientRes.rows[0]?.client_name ?? null;
    const [y, m, d] = String(bookingDate).split('-');
    const body = `${d}.${m}.${y}, ${booking.start_time}${clientName ? ' · ' + clientName : ''}`;

    const recipients = [booking.master_id, ...(await bookingWatcherIds(client, booking.location_id))];
    for (const staffId of [...new Set(recipients.filter(Boolean))]) {
      await client.query(
        `DELETE FROM notifications
          WHERE staff_id = $1 AND booking_id = $2 AND type <> 'booking_cancelled'`,
        [staffId, booking.id]
      );
      await notifyStaff(client, staffId, 'booking_cancelled', {
        bookingId: booking.id,
        title: p('booking.cancelledShort'),
        body,
        refresh: true,
      });
    }
  } catch (err) {
    console.error('уведомление об отмене записи не отправлено (сама отмена прошла):', err.message); // не интерфейс: строка в лог сервера, её читает разработчик
  } finally {
    client.release();
  }
}

export async function handleBookingCancel(req, res, parts) {
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
  // Напоминания и просьба об отзыве по отменённой записи отменяются вместе с ней:
  // «ждём вас завтра» по отменённому визиту - худшее, что может прислать бот.
  // Уже отправленное не трогаем, сказанного не вернуть (Волна 1, 01.09.2026)
  await cancelPendingForBooking(bookingId);
  await notifyAboutCancelledBooking(booking, bookingDate);
  publish('bookings', { bookingId, date: bookingDate, masterId: booking.master_id ?? null, reason: 'cancelled' });
  publish('notifications', { reason: 'booking-cancelled' });
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
//
// Правка Влада 22.08.2026 (Окно 59): статус визита ставит администратор, владелец или
// управляющий - у МАСТЕРА такой возможности нет вовсе. Отметка «Обслужен» - это
// фиксация сделки (визит попадает в выручку и в зарплату этого же мастера), и решать
// её должен не тот, кому она начисляется. В кабинете мастера контролов статуса и так
// не было ни одного (карточка записи только на просмотр, коммит d9efed5), но роут
// оставался открытым для его токена - интерфейс без контрола не защищает от прямого
// запроса к API.
//
// Окно 59 (22.08.2026) - вместе со статусом 'done' сюда приезжает срок, через
// который клиент должен вернуться (body.renew). Место выбрано принципиально: разговор
// про срок происходит в конце стрижки, и поле, спрятанное в карточке клиента, не
// заполнил бы никто. Правила:
//   - у клиента с телефоном закрыть визит без срока НЕЛЬЗЯ. Если срока нет ни в
//     запросе, ни у самого клиента с прошлого визита - 400 renew_required;
//   - если срок у клиента уже стоит, а в запросе его нет - визит закрывается молча,
//     старая договорённость остаётся в силе. Допрашивать постоянного клиента каждый
//     раз нельзя: мастер начнёт штамповать что попало, и метрика умрёт;
//   - визит без client_id (walk-in без телефона, миграция 041) срок не спрашивает
//     вовсе: система намеренно не связывает такие визиты между собой, напоминать
//     некому;
//   - откат статуса ('done' обратно в 'planned'/'no_show') срок НЕ стирает.
//     Договорённость состоялась в разговоре, ошибка в статусе её не отменяет.
// Статус и срок пишутся одной транзакцией - иначе остался бы закрытый визит без срока.
export async function handleBookingStatus(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 403, { error: 'forbidden' });
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
  // Ветки «мастер правит только свою запись» здесь больше нет: роль master до этого
  // места не доходит вовсе (см. комментарий у объявления функции)

  // Срок разбираем ДО открытия транзакции: отказ по нему - это отказ всего запроса,
  // и держать ради него открытое соединение незачем. Сам факт «срок обязателен»
  // проверяется по СОСТОЯНИЮ базы (есть ли уже срок у клиента), а не по тому, что
  // прислал фронт - спрятать поле в вёрстке и закрыть визит мимо него не выйдет.
  let renew = null;
  if (body.status === 'done' && booking.client_id) {
    const hasRenew = body.renew !== undefined && body.renew !== null;
    if (hasRenew) {
      const parsed = normalizeRenewInput(body.renew);
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
      renew = parsed.value;
    } else {
      const existing = await pool.query('SELECT renew_days FROM clients WHERE id = $1', [booking.client_id]);
      if (existing.rows[0]?.renew_days == null) return sendJson(res, 400, { error: 'renew_required' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE bookings SET status = $1 WHERE id = $2', [body.status, bookingId]);
    if (renew) {
      await client.query(
        `UPDATE clients SET renew_days = $1, renew_days_recommended = $2, renew_reason = $3,
                            renew_note = $4, renew_set_by = $5, renew_set_at = now()
          WHERE id = $6`,
        [renew.days, renew.recommendedDays, renew.reason, renew.note, auth.id ?? null, booking.client_id]
      );
    }
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
      // Флаг остаётся как след факта «визит закрыт»: на него смотрят отчёты.
      // Само письмо с просьбой об отзыве стоит в очереди с момента записи и уходит
      // через два часа после конца визита (lib/client-messaging.js, Волна 1)
      await client.query('UPDATE bookings SET review_request_pending = true WHERE id = $1', [bookingId]);
    }
    if (body.status === 'no_show' || body.status === 'cancelled') {
      // Человек не пришёл или визит отменён: напоминать и просить отзыв не за что
      await cancelPendingForBooking(bookingId, null, client);
    }
    // Не пришёл - пишем ему сами (04.09.2026, решение владельца по карточке
    // «Неявки»). Порядок важен: строку ставим ПОСЛЕ отмены остальных писем по этой
    // брони, иначе она гасится тем же запросом. Условие по прежнему статусу - то же,
    // что у счётчика неявок выше: повторный PATCH на уже не пришедшую бронь не должен
    // писать человеку второй раз
    if (body.status === 'no_show' && booking.status !== 'no_show') {
      await enqueueNoShowFollowup({ id: bookingId, client_id: booking.client_id }, new Date(), client);
    }
    // Отметку сняли (ошиблись, человек всё-таки пришёл) - неотправленное письмо
    // после неявки теряет смысл. Отправленное остаётся: сказанное клиенту сказано
    if (booking.status === 'no_show' && body.status !== 'no_show') {
      await cancelPendingForBooking(bookingId, ['no_show_followup'], client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  publish('bookings', { bookingId, reason: 'status', status: body.status });
  // Письмо после неявки уходит сразу, не дожидаясь тика планировщика: администратор
  // отмечает неявку, когда время визита уже прошло, и минута задержки тут ничего не
  // экономит, зато человек получает вопрос, пока помнит, что не пришёл
  if (body.status === 'no_show' && booking.status !== 'no_show' && booking.client_id) {
    deliverForClientSoon(currentTenantId(), currentVertical(), booking.client_id);
  }
  // renew в ответе - чтобы форма закрытия визита показала мастеру, что именно
  // записано, и не пересчитывала это у себя (при причине «не обсуждали» срок ставит
  // сервер, а не поле в интерфейсе)
  return sendJson(res, 200, { ok: true, status: body.status, renew });
}

// ── /bookings/:id/services - добавление услуги(й) К УЖЕ СУЩЕСТВУЮЩЕЙ записи
// (08.08.2026, жалоба Влада: мастер во время/после визита обнаруживает, что клиенту
// нужна ещё услуга - например, подстригли и уже потом попросили бритьё - а внести
// это было физически некуда, "Корректировка услуги" в карточке записи с 03.08.2026
// была статичным макетом без сохранения, см. assets/mockup-crm.js pickServiceForBooking).
// Намеренно ТОЛЬКО добавление, не полная замена списка - убрать уже оказанную услугу
// этой ручкой нельзя, только дописать новую, поэтому past_time-проверки из
// createBookingTx здесь нет вообще: это не бронирование нового времени, а честная
// фиксация уже случившегося визита, время может быть каким угодно в прошлом.
// revenue/payroll (computeMasterPayroll, api/routes/payroll.js) считают сумму по
// booking_services на лету при каждом запросе - простой INSERT сюда автоматически
// даёт верную статистику без отдельного пересчёта.
// Пересчёт тарифа после того, как состав услуг или мастер записи изменились
// (20.08.2026). Дописали к обычной стрижке топовую услугу - визит стал топовым; сняли
// её - вернулся обычный тариф; перенесли к другому мастеру - условия считаются по ЕГО
// прайсу. Без пересчёта строка условий в карточке показывала бы то, чего в записи
// больше нет. Работает внутри уже открытой транзакции вызывающего роута - тем же
// клиентом, а не отдельным соединением, иначе читал бы ещё не закоммиченный состав.
async function refreshMasterTier(client, bookingId, masterId) {
  const rows = await client.query(
    `SELECT ms.is_top FROM booking_services bs
       JOIN master_services ms ON ms.service_id = bs.service_id AND ms.master_id = $2
      WHERE bs.booking_id = $1`,
    [bookingId, masterId]
  );
  const tier = resolveMasterTier(rows.rows);
  await client.query('UPDATE bookings SET master_tier = $1 WHERE id = $2', [tier, bookingId]);
  return tier;
}

export async function handleBookingAddServices(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_STAFF_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const newServiceIds = Array.isArray(body.serviceIds) ? [...new Set(body.serviceIds)] : [];
  if (newServiceIds.length === 0) return sendJson(res, 400, { error: 'missing_fields' });

  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query(
    'SELECT id, master_id, location_id, date, start_time, end_time, status FROM bookings WHERE id = $1',
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
  if (booking.status === 'cancelled') return sendJson(res, 409, { error: 'booking_cancelled' });

  const msRes = await pool.query(
    'SELECT service_id, duration_min, price FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
    [booking.master_id, newServiceIds]
  );
  if (msRes.rows.length !== newServiceIds.length) {
    return sendJson(res, 400, { error: 'unknown_master_service' });
  }
  // Конфликт комплекса и его составляющей считаем по ИТОГОВОМУ составу записи, а не
  // по одним дописываемым услугам: он рождается именно из соседства с тем, что в
  // записи уже лежит (мастер дописывает "бороду" к записи, где уже есть комплекс)
  const existingRes = await pool.query('SELECT service_id FROM booking_services WHERE booking_id = $1', [bookingId]);
  if (hasComboConflict([...existingRes.rows.map((r) => r.service_id), ...newServiceIds])) {
    return sendJson(res, 400, { error: 'combo_conflict' });
  }
  const addedDuration = msRes.rows.reduce((sum, r) => sum + r.duration_min, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const serviceId of newServiceIds) {
      await client.query(
        'INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [bookingId, serviceId]
      );
    }
    // Длительность карточки в календаре растягиваем на реально добавленное время -
    // без этого визуальный слот молчаливо расходился бы с фактическим списком услуг
    // (см. bk-duration в карточке записи). Пересечения с чужими бронями НЕ проверяем -
    // сознательно (это правка уже случившегося визита, не новое бронирование).
    const newEndTime = addMinutes(booking.end_time, addedDuration);
    await client.query('UPDATE bookings SET end_time = $1 WHERE id = $2', [newEndTime, bookingId]);
    await refreshMasterTier(client, bookingId, booking.master_id);
    await client.query('COMMIT');
    const allServicesRes = await client.query('SELECT service_id FROM booking_services WHERE booking_id = $1', [bookingId]);
    publish('bookings', { bookingId, reason: 'services-added' });
    return sendJson(res, 200, {
      ok: true,
      booking: { id: bookingId, serviceIds: allServicesRes.rows.map((r) => r.service_id), endTime: newEndTime },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── PUT /bookings/:id/services - ПОЛНЫЙ состав услуг записи (13.08.2026, Влад:
// "клиент пришёл и они с мастером решили сделать другую услугу - её можно будет
// изменить?"). До этого дня состав можно было только дополнять (PATCH выше), а
// снять ошибочно отмеченную услугу - нечем: единственным выходом было удалить
// запись и создать заново, теряя её id вместе с actual_price, комментарием и
// привязанными продажами. Здесь тело запроса описывает состав ЦЕЛИКОМ: чего в нём
// нет - то удаляется, чего не было - добавляется.
//
// PATCH (только добавление) сознательно оставлен рядом и не тронут: им пользуется
// мастер со своей страницы (crm-master.html), где снятие услуги недоступно по
// решению Влада от 08.08.2026 ("только администратор проводит запись и оплату").
// Роли здесь - owner/admin, как у actual-price и удаления: снятие услуги меняет
// деньги визита и зарплату мастера.
//
// Длительность пересчитывается по прайсу мастера ЭТОЙ записи - тем же способом,
// что при переносе (resolveRescheduleDuration). Пересечения с соседними записями
// НЕ проверяются: это фиксация уже случившегося визита, тот же осознанный
// компромисс, что и у PATCH-версии (см. комментарий там).
export function resolveServicesReplacement({ serviceIds, masterServiceRows, currentServiceIds }) {
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) return { error: 'missing_fields' };
  const wanted = [...new Set(serviceIds)];
  if (masterServiceRows.length !== wanted.length) return { error: 'unknown_master_service' };
  const current = new Set(currentServiceIds);
  const next = new Set(wanted);
  return {
    serviceIds: wanted,
    added: wanted.filter((id) => !current.has(id)),
    removed: [...current].filter((id) => !next.has(id)),
    durationMin: masterServiceRows.reduce((sum, r) => sum + r.duration_min, 0),
  };
}

export async function handleBookingSetServices(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const bookingId = decodeURIComponent(parts[1]);

  const bookingRes = await pool.query(
    'SELECT id, master_id, location_id, start_time, status FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (booking.status === 'cancelled') return sendJson(res, 409, { error: 'booking_cancelled' });

  const wanted = Array.isArray(body.serviceIds) ? [...new Set(body.serviceIds)] : [];
  // Комплекс и услуга, которая в него входит, разом - клиент платит за неё дважды.
  // Форма такой набор больше не собирает (storage.js toggleServiceSelection), но
  // сервер обязан отказать и мимо формы: старая открытая вкладка, прямой вызов API,
  // запись, созданная до 16.08.2026.
  if (hasComboConflict(wanted)) return sendJson(res, 400, { error: 'combo_conflict' });
  const msRes = wanted.length
    ? await pool.query(
        'SELECT service_id, duration_min FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
        [booking.master_id, wanted]
      )
    : { rows: [] };
  const currentRes = await pool.query('SELECT service_id FROM booking_services WHERE booking_id = $1', [bookingId]);
  const plan = resolveServicesReplacement({
    serviceIds: wanted,
    masterServiceRows: msRes.rows,
    currentServiceIds: currentRes.rows.map((r) => r.service_id),
  });
  if (plan.error) return sendJson(res, 400, { error: plan.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (plan.removed.length > 0) {
      await client.query('DELETE FROM booking_services WHERE booking_id = $1 AND service_id = ANY($2)', [
        bookingId,
        plan.removed,
      ]);
    }
    for (const serviceId of plan.added) {
      await client.query(
        'INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [bookingId, serviceId]
      );
    }
    // Конец слота считается от НАЧАЛА записи и полного состава - не сдвигом от
    // прежнего конца (как в PATCH-версии, которая умеет только удлинять): при
    // снятии услуги слот обязан укоротиться, а не остаться прежним.
    const newEndTime = addMinutes(booking.start_time, plan.durationMin);
    await client.query('UPDATE bookings SET end_time = $1 WHERE id = $2', [newEndTime, bookingId]);
    await refreshMasterTier(client, bookingId, booking.master_id);
    await client.query('COMMIT');
    publish('bookings', { bookingId, reason: 'services-set' });
    return sendJson(res, 200, {
      ok: true,
      booking: { id: bookingId, serviceIds: plan.serviceIds, endTime: newEndTime },
      added: plan.added,
      removed: plan.removed,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── /bookings/:id/reschedule - ПЕРЕНОС записи: другой мастер и/или другая дата/
// время (Окно 54, 10.08.2026, Задача B). Честная находка, из-за которой окно
// существует: услугу у существующей записи менять уже было можно (PATCH
// /bookings/:id/services, Окно 51), а мастера и время - нельзя вообще, только
// удалить и создать заново. При этом удаление теряет id брони, а с ним actual_price
// (скидку, Окно 51) и привязанные продажи - для "перенеси Сергея на завтра к другому
// мастеру" это негодный путь. Здесь обновляется ТА ЖЕ строка, поэтому
// booking_services/actual_price/sales/статус остаются на своём id.
//
// Имя пути: /reschedule рядом с уже существующими /cancel, /status, /services,
// /actual-price - то же соглашение "существительное действия после :id", отдельного
// стиля не заводим.
//
// Длительность нового слота считается по прайсу НОВОГО мастера, не переносится
// старой длиной: у разных мастеров разные duration_min на одну услугу
// (master_services, Окно 10 - у Екатерины своя длительность и цена). Тот же расчёт,
// что у createBookingTx, вынесен в чистую функцию ради офлайн-теста.
export function resolveRescheduleDuration({ serviceIds, masterServiceRows, currentStartTime, currentEndTime }) {
  // Длительность считается по прайсу НОВОГО мастера, не по старой длине слота: у
  // разных мастеров разные duration_min на одну услугу (master_services, Окно 10 -
  // у Екатерины своя длительность и цена). Тот же расчёт, что у createBookingTx.
  if (serviceIds.length === 0) {
    // Брони без строк в booking_services штатно быть не должно (миграция 013
    // забэкфилила старые), но 0 минут дали бы вырожденный слот 12:00-12:00 -
    // сохраняем фактическую длину текущего слота.
    return { durationMin: toMinutes(currentEndTime) - toMinutes(currentStartTime) };
  }
  if (masterServiceRows.length !== serviceIds.length) {
    // Новый мастер не оказывает часть услуг этой брони - переносить некуда, тот же
    // код ошибки, что у создания брони с чужой услугой.
    return { error: 'unknown_master_service' };
  }
  return { durationMin: masterServiceRows.reduce((sum, r) => sum + r.duration_min, 0) };
}

// Окно 54, Задача C (10.08.2026) - решение Влада по открытому вопросу Задачи B:
// «да, сообщить». Создание брони уведомляет мастера и админов точки с Окна 14, у
// переноса аналога не было - мастер узнавал о пересадке клиента только заглянув в
// календарь.
//
// Дата показывается ВСЕГДА с обеих сторон, даже когда день не менялся: «11:00 →
// 15:00» в списке уведомлений через два дня не отвечает на вопрос «какого числа», а
// перенос как раз про время. Шесть лишних символов дешевле догадки. Формат
// «10.08 15:00» - без названий месяцев: русского форматтера дат на бэкенде нет и
// заводить его ради двух строк не стоит, локализация это дело фронта (Окно 55).
export function formatMoveSlot(date, time) {
  return `${date.slice(8, 10)}.${date.slice(5, 7)} ${time}`;
}

// Чистая функция - кому и что показать при переносе. Отдельно от SQL ровно потому,
// что решает продуктовый вопрос («старый мастер должен узнать, что запись ушла»), и
// проверяется офлайн-тестом без базы.
//
// Пустой массив на «переносе без изменений» (сценарий 4 промпта: сохранили карточку,
// ничего не подвинув) - это не забытая ветка, а требование: шум в колокольчике
// обесценивает настоящие уведомления.
export function planRescheduleNotifications({
  bookingId,
  clientName = null,
  previous,
  next,
  masterNames = {},
  previousLocationAdminIds = [],
  nextLocationAdminIds = [],
}) {
  const masterChanged = previous.masterId !== next.masterId;
  const slotChanged = previous.date !== next.date || previous.startTime !== next.startTime;
  if (!masterChanged && !slotChanged) return [];

  const from = formatMoveSlot(previous.date, previous.startTime);
  const to = formatMoveSlot(next.date, next.startTime);
  const who = clientName ? ` · ${clientName}` : '';
  // Фолбэк на id вместо имени - уведомление с id читается плохо, но молча уронить
  // перенос из-за отсутствующей строки staff было бы хуже.
  const nameOf = (id) => masterNames[id] ?? id;
  const outBody = `${from} → ${nameOf(next.masterId)}, ${to}${who}`;
  const inBody = masterChanged ? `${to}${who} · было: ${nameOf(previous.masterId)}, ${from}` : `${from} → ${to}${who}`;

  const planned = [];
  if (masterChanged) {
    planned.push({ staffId: previous.masterId, type: 'booking_moved_out', title: p('booking.movedOut'), body: outBody });
    planned.push({ staffId: next.masterId, type: 'booking_moved_in', title: p('booking.movedIn'), body: inBody });
  } else {
    planned.push({ staffId: next.masterId, type: 'booking_moved_in', title: p('booking.moved'), body: inBody });
  }
  // Точка едет за мастером, поэтому перенос на мастера другой точки уводит визит с
  // точки админа - он тоже должен узнать, симметрично мастеру. Если точка та же,
  // «ушла с точки» не отправляем: это было бы враньём.
  if (previous.locationId !== next.locationId) {
    for (const staffId of previousLocationAdminIds) {
      planned.push({ staffId, type: 'booking_moved_out', title: p('booking.movedOutPlace'), body: outBody });
    }
  }
  for (const staffId of nextLocationAdminIds) {
    planned.push({ staffId, type: 'booking_moved_in', title: p('booking.movedInPlace'), body: inBody });
  }

  // Схлопываем по (staff_id, type) - ровно ключ дедуп-индекса notifications_booking_dedup
  // при фиксированном booking_id. Один и тот же человек не должен получить две строки
  // об одном событии, даже если попал в план дважды.
  const seen = new Set();
  return planned
    .filter((n) => n.staffId != null)
    .filter((n) => {
      const key = `${n.staffId}|${n.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((n) => ({ ...n, bookingId }));
}

const OPPOSITE_MOVE_TYPE = { booking_moved_out: 'booking_moved_in', booking_moved_in: 'booking_moved_out' };

// Перенос туда-обратно (m1 → m2 → m1) оставил бы у m1 одновременно «запись ушла» и
// «запись у вас» - два взаимоисключающих утверждения об одной брони в одном списке.
// Противоположный тип удаляется, а свой обновляется (refresh, см. notify-core.js):
// повторный перенос это новая информация, а не дубль.
async function applyRescheduleNotifications(client, plan) {
  for (const n of plan) {
    await client.query('DELETE FROM notifications WHERE staff_id = $1 AND booking_id = $2 AND type = $3', [
      n.staffId, n.bookingId, OPPOSITE_MOVE_TYPE[n.type],
    ]);
    await notifyStaff(client, n.staffId, n.type, { bookingId: n.bookingId, title: n.title, body: n.body, refresh: true });
  }
}

async function rescheduleBookingTx({ bookingId, masterId, date, startTime, isStaff }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Тот же ключ блокировки, что у createBookingTx - поэтому перенос и создание на
    // один слот сериализуются между собой, а не только переносы между переносами
    // (сценарий 6 промпта: два одновременных переноса на один слот - проходит один).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${masterId}:${date}`]);

    // FOR UPDATE - два параллельных переноса ОДНОЙ брони (два устройства
    // администратора) не должны оба увидеть её исходное состояние.
    // client_name берётся тем же COALESCE(c.name, b.walkin_name), что и в
    // listBookingsForRequest - клиент без телефона (walkin_name, миграция 041) не
    // должен превращаться в безымянную строку в уведомлении.
    const bookingRes = await client.query(
      `SELECT b.id, b.master_id, b.location_id, b.date, b.start_time, b.end_time, b.status,
              COALESCE(c.name, b.walkin_name) AS client_name
       FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    if (bookingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'booking_not_found' } };
    }
    const booking = bookingRes.rows[0];
    // Отменённую запись переносить нельзя - тот же явный код, что уже отдаёт
    // handleBookingAddServices на отменённой брони.
    if (booking.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'booking_cancelled' } };
    }

    const bsRes = await client.query('SELECT service_id FROM booking_services WHERE booking_id = $1', [bookingId]);
    const serviceIds = bsRes.rows.map((r) => r.service_id);
    const msRes = serviceIds.length
      ? await client.query(
          'SELECT service_id, duration_min FROM master_services WHERE master_id = $1 AND service_id = ANY($2)',
          [masterId, serviceIds]
        )
      : { rows: [] };
    const duration = resolveRescheduleDuration({
      serviceIds,
      masterServiceRows: msRes.rows,
      currentStartTime: booking.start_time,
      currentEndTime: booking.end_time,
    });
    if (duration.error) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: duration.error } };
    }
    const endTime = addMinutes(startTime, duration.durationMin);

    // Ровно те же рубежи, что при создании (checkSlotAvailability), с одним
    // отличием - сама переносимая запись исключена из проверки пересечений, иначе
    // сохранение "без изменений" конфликтовало бы само с собой (сценарий 4 промпта).
    const blocked = await checkSlotAvailability(client, {
      masterId, date, startTime, endTime, isStaff, excludeBookingId: bookingId,
    });
    if (blocked) {
      await client.query('ROLLBACK');
      return blocked;
    }

    const staffRes = await client.query('SELECT location_id FROM staff WHERE id = $1', [masterId]);
    if (staffRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'unknown_master' } };
    }
    // location_id едет за мастером: две точки барбершопа, перенос на мастера другой
    // точки означает и смену точки визита - иначе бронь осталась бы висеть в
    // выручке/списках прежней точки (listBookingsForRequest фильтрует по location_id).
    const locationId = staffRes.rows[0].location_id;

    await client.query(
      `UPDATE bookings SET master_id = $1, location_id = $2, date = $3, start_time = $4, end_time = $5
       WHERE id = $6`,
      [masterId, locationId, date, startTime, endTime, bookingId]
    );
    // Тариф пересчитывается по НОВОМУ мастеру (20.08.2026): у прежнего стрижка могла
    // быть топовой, у нового та же стрижка - обычная. Оставить прежний тариф значило бы
    // показывать в карточке условия, по которым этот визит уже не проходит.
    await refreshMasterTier(client, bookingId, masterId);
    // Сроки сообщений клиенту считаются от времени визита, значит перенос обязан их
    // пересчитать. Постановка идемпотентна: строки не плодятся, отправленное не
    // воскресает (lib/client-messaging.js, Волна 1, 01.09.2026)
    if (booking.client_id) {
      await enqueueForBooking(
        { id: bookingId, client_id: booking.client_id, date, start_time: startTime, end_time: endTime },
        new Date(),
        client,
      );
    }

    const previousDate = dateColToStr(booking.date);
    const previousSlot = {
      masterId: booking.master_id,
      locationId: booking.location_id,
      date: previousDate,
      startTime: booking.start_time,
    };
    const nextSlot = { masterId, locationId, date, startTime };
    // Уведомления - Задача C. Внутри той же транзакции: перенос без уведомления
    // допустим не больше, чем уведомление о переносе, которого не было.
    const notifyPlan = planRescheduleNotifications({
      bookingId,
      clientName: booking.client_name,
      previous: previousSlot,
      next: nextSlot,
      masterNames: await masterNamesByIds(client, [booking.master_id, masterId]),
      previousLocationAdminIds: await bookingWatcherIds(client, booking.location_id),
      nextLocationAdminIds: await bookingWatcherIds(client, locationId),
    });
    await applyRescheduleNotifications(client, notifyPlan);
    await client.query('COMMIT');
    return {
      status: 200,
      body: {
        ok: true,
        booking: {
          id: bookingId,
          masterId,
          locationId,
          date,
          startTime,
          endTime,
          serviceIds,
          totalDurationMin: duration.durationMin,
          notified: notifyPlan.length,
          previous: {
            masterId: booking.master_id,
            date: previousDate,
            startTime: booking.start_time,
            endTime: booking.end_time,
          },
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

// Роли - owner+admin, master не допущен: та же матрица, что у handleBookingDelete и
// handleBookingActualPrice, и то же решение Влада от 08.08.2026 ("только у
// администратора должна быть возможность записывать клиентов" - перенос это
// пересадка клиента на другое время, то же самое действие по смыслу). Админ - только
// своя точка, причём с ДВУХ сторон: и текущая бронь, и новый мастер должны быть его
// (иначе админ одной точки перекинул бы клиента на чужую).
//
// Уведомления при переносе - Задача C того же окна (решение Влада «да, сообщить» по
// открытому вопросу Задачи B): старый мастер узнаёт, что запись ушла, новый - что
// пришла, админы точки - симметрично. Логика адресатов в planRescheduleNotifications.
export async function handleBookingReschedule(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  if (!body.masterId || !body.date || !body.startTime) {
    return sendJson(res, 400, { error: 'missing_fields' });
  }
  const bookingId = decodeURIComponent(parts[1]);
  // Scope-проверка админа до транзакции - тот же приём, что у handleBookingAddServices:
  // 403 не должен зависеть от исхода бизнес-проверок внутри. Авторитетные 404/409
  // (запись исчезла/отменена между этими двумя чтениями) всё равно перепроверяются
  // внутри транзакции под FOR UPDATE.
  const bookingRes = await pool.query('SELECT id, location_id FROM bookings WHERE id = $1', [bookingId]);
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  if (auth.role === 'admin') {
    if (bookingRes.rows[0].location_id !== auth.locationId) return sendJson(res, 403, { error: 'forbidden' });
    const targetRes = await pool.query('SELECT location_id FROM staff WHERE id = $1', [body.masterId]);
    if (targetRes.rows.length === 0) return sendJson(res, 400, { error: 'unknown_master' });
    if (targetRes.rows[0].location_id !== auth.locationId) return sendJson(res, 403, { error: 'forbidden' });
  }
  const result = await rescheduleBookingTx({
    bookingId,
    masterId: body.masterId,
    date: body.date,
    startTime: body.startTime,
    isStaff: true, // сюда допущены только owner/admin (requireRole выше) - визит задним числом разрешён, как и при создании из CRM
  });
  // Перенос двигает карточку в календаре у всех, кто сейчас смотрит расписание
  if (result.status === 200 && result.body?.ok !== false) {
    publish('bookings', { bookingId, reason: 'rescheduled' });
    // Перенос рассылает booking_moved_out/in - лента должна показать это сразу, тем
    // же приёмом, что и создание записи выше
    publish('notifications', { reason: 'booking-rescheduled' });
  }
  return sendJson(res, result.status, result.body);
}

// ── /bookings/:id/actual-price - фактически взятая с клиента сумма (08.08.2026,

// вечер, Влад: "Али иногда говорит администратору 'пробей по старой цене'" -
// скидка клиенту). owner/admin - та же матрица, что у handleBookingAddServices
// (master сюда не допущен - тем же принципом "только администратор" из этой же
// сессии). actualPrice: null - явный сброс "фактическая = списочная" (например,
// скидку отменили/ошиблись при вводе), не только положительное число. Влияет ли
// это на зарплату мастера - решает discount_settings (handleDiscountSettings),
// не эта ручка - здесь только фиксация факта, не расчёт.
// Комментарий сотрудника к записи (13.08.2026, миграция 048) едет тем же запросом,
// что и сумма: в карточке это одно действие ("сумма 1500 вместо 2000, потому что
// владелец дал скидку"), и разводить его по двум роутам значило бы уметь сохранить
// объяснение без цифры, которую оно объясняет. Чистая функция ради офлайн-теста:
// вся валидация тут, роут ниже только применяет результат.
// Лимит поднят 500 -> 3000 (21.08.2026, задача Влада «комментарий должен содержать
// до 3000 символов» - прямое требование заказчика). Колонка text, миграция не нужна:
// ограничение живёт только здесь и в maxlength поля на фронте (crm-owner.html,
// crm-admin.html), и эти два числа обязаны совпадать - иначе сотрудник допишет текст,
// который сервер отвергнет уже после нажатия «Сохранить».
export const BOOKING_COMMENT_MAX_LEN = 3000;
export function normalizeStaffComment(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: 'invalid_comment' };
  const trimmed = raw.trim();
  // Пустая строка = "комментария нет", не пустой текст в базе: иначе история визитов
  // показывала бы пустые строки-призраки там, где сотрудник просто стёр объяснение.
  if (trimmed === '') return { value: null };
  if (trimmed.length > BOOKING_COMMENT_MAX_LEN) return { error: 'comment_too_long' };
  return { value: trimmed };
}

// Источник клиента (17.08.2026, миграция 050). Ключи фиксированы: колонка заведена
// ради ответа на вопрос "сколько клиентов дал каждый канал", а свободный текст на
// этот вопрос не отвечает. Зеркало словаря для интерфейса - assets/client-source.js
// (там же подписи на русском), здесь только допустимые ключи: сервер не показывает
// подписи, а фронт не решает, что попадёт в базу.
export const CLIENT_SOURCE_KEYS = ['yandex_maps', '2gis', 'instagram', 'telegram', 'vk', 'referral', 'walkin', 'other'];

// Чистая функция ради офлайн-теста - тот же приём, что у normalizeStaffComment выше.
// null/пустая строка = "источник неизвестен", и это ЗАКОННОЕ значение, а не пропуск:
// человек, пришедший мимо по улице или по звонку, источника в технике не имеет, и
// система не должна за него ничего додумывать. Неизвестный ключ - ошибка, а не
// молчаливое "other": тихая подмена превратила бы опечатку в интеграции в цифру
// канала, которую владелец потом прочитает как факт.
export function normalizeClientSource(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: 'invalid_client_source' };
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null };
  if (!CLIENT_SOURCE_KEYS.includes(trimmed)) return { error: 'unknown_client_source' };
  return { value: trimmed };
}

// «Новый клиент» для метки в карточке дня (17.08.2026). Новая - самая ранняя не
// отменённая бронь клиента, а не "у клиента одна бронь": человек мог записаться на
// сегодня и тут же на следующий месяц, и меткой должен быть помечен первый визит,
// а не оба и не ни одного.
//
// Отменённая бронь визитом не считается - клиент не приходил. Неявка (no_show)
// считается: салон этого человека уже привлёк, второй раз он не новый.
//
// Брони БЕЗ client_id (walk-in без телефона, миграция 041) в расчёт не входят вовсе -
// такие визиты намеренно не связываются между собой по имени (решение Алихана), и
// утверждать про них "новый клиент" было бы выдумкой, а не фактом.
export function firstBookingIdByClient(rows) {
  const firstByClient = new Map();
  for (const r of rows) {
    if (!r.client_id || r.status === 'cancelled') continue;
    const prev = firstByClient.get(r.client_id);
    const key = `${dateColToStr(r.date)} ${r.start_time}`;
    if (!prev || key < prev.key) firstByClient.set(r.client_id, { key, id: r.id });
  }
  return new Map([...firstByClient].map(([clientId, v]) => [clientId, v.id]));
}

export async function handleBookingActualPrice(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const bookingId = decodeURIComponent(parts[1]);
  const bookingRes = await pool.query('SELECT id, location_id FROM bookings WHERE id = $1', [bookingId]);
  if (bookingRes.rows.length === 0) return sendJson(res, 404, { error: 'booking_not_found' });
  const booking = bookingRes.rows[0];
  if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  const body = await readBody(req);
  if (body.actualPrice !== null && (typeof body.actualPrice !== 'number' || body.actualPrice < 0)) {
    return sendJson(res, 400, { error: 'invalid_actual_price' });
  }
  // Поля comment в теле нет вообще - старый контракт (только сумма), комментарий не
  // трогаем. Это важно для обратной совместимости: прежние клиенты/скрипты, которые
  // шлют одну цифру, не должны молча стирать уже написанное объяснение.
  const hasComment = Object.prototype.hasOwnProperty.call(body, 'comment');
  let comment = null;
  if (hasComment) {
    const parsed = normalizeStaffComment(body.comment);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    comment = parsed.value;
  }
  if (hasComment) {
    await pool.query('UPDATE bookings SET actual_price = $1, staff_comment = $2 WHERE id = $3', [
      body.actualPrice,
      comment,
      bookingId,
    ]);
  } else {
    await pool.query('UPDATE bookings SET actual_price = $1 WHERE id = $2', [body.actualPrice, bookingId]);
  }
  publish('bookings', { bookingId, reason: 'actual-price' });
  return sendJson(res, 200, {
    ok: true,
    actualPrice: body.actualPrice,
    ...(hasComment ? { comment } : {}),
  });
}

// ── /bookings/:id/client - имя и телефон клиента у УЖЕ СОЗДАННОЙ записи ──────
// Влад, 16.08.2026: "не сохраняются изменения имени и номера в существующей
// карточке". Правка клиента и правда никуда не уезжала - роута под неё не было
// вовсе (были только services / reschedule / actual-price / status), а форма
// редактирования эти два поля просто показывала. Ошиблись при записи в имени или
// телефоне - исправить было нечем, только удалить запись и завести заново.
//
// Семантика повторяет создание записи (createBookingTx выше), чтобы правка и
// создание не расходились: телефон есть - клиент ищется/заводится в общей базе
// clients и бронь привязывается к нему; телефона нет - бронь остаётся
// неидентифицированной (client_id = NULL), а имя живёт на самой брони в
// walkin_name (решение Алихана 09.08.2026: без телефона по одному имени клиентов
// не связываем).
export const CLIENT_NAME_MAX_LEN = 120;
export function normalizeClientName(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: 'invalid_client_name' };
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null }; // стёрли имя - это "без имени", а не пустая строка в базе
  if (trimmed.length > CLIENT_NAME_MAX_LEN) return { error: 'client_name_too_long' };
  return { value: trimmed };
}

export function normalizeClientPhoneInput(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: 'invalid_client_phone' };
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null };
  // Тот же порог, что у поиска клиента (normalizePhoneKey, api/routes/clients.js) -
  // меньше 10 цифр не опознаёт никого, и привязка по такому вводу создала бы в базе
  // клиента-обрубок, к которому потом ничего не сойдётся
  if (trimmed.replace(/\D/g, '').length < 10) return { error: 'invalid_client_phone' };
  return { value: trimmed };
}

export async function handleBookingClient(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });
  const bookingId = decodeURIComponent(parts[1]);
  const body = await readBody(req);

  const nameOut = normalizeClientName(body.clientName);
  if (nameOut.error) return sendJson(res, 400, { error: nameOut.error });
  const phoneOut = normalizeClientPhoneInput(body.clientPhone);
  if (phoneOut.error) return sendJson(res, 400, { error: phoneOut.error });
  const clientName = nameOut.value;
  const clientPhone = phoneOut.value;
  // Источник правится тем же роутом, что имя и телефон (17.08.2026): в форме записи
  // это один блок "кто клиент", и разводить его по двум запросам значило бы уметь
  // сохранить канал отдельно от человека, которому он принадлежит.
  // Поля clientSource в теле НЕТ вообще - прежний контракт, канал не трогаем: старый
  // клиент, который шлёт только имя с телефоном, не должен молча стирать источник
  // (тот же приём, что у comment в handleBookingActualPrice).
  const hasSource = Object.prototype.hasOwnProperty.call(body, 'clientSource');
  const sourceOut = hasSource ? normalizeClientSource(body.clientSource) : { value: null };
  if (sourceOut.error) return sendJson(res, 400, { error: sourceOut.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bookingRes = await client.query('SELECT id, location_id, status FROM bookings WHERE id = $1', [bookingId]);
    if (bookingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { error: 'booking_not_found' });
    }
    const booking = bookingRes.rows[0];
    if (auth.role === 'admin' && booking.location_id !== auth.locationId) {
      await client.query('ROLLBACK');
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (booking.status === 'cancelled') {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { error: 'booking_cancelled' });
    }

    let clientId = null;
    let noShowStreak = 0;
    if (clientPhone) {
      // Сначала поиск по нормализованному номеру (последние 10 цифр) - иначе
      // "+7 903 444 44 44" и "+79034444444" завели бы ДВУХ клиентов с одной историей
      // на двоих: unique-индекс clients_phone_key построен на сырой строке.
      const found = await findClientIdByPhone(client, clientPhone);
      if (found) {
        clientId = found.id;
        noShowStreak = found.noShowStreak;
        // Имя обновляем только когда его реально ввели: пустое поле - это "не знаю
        // имени этого визита", а не команда стереть имя у клиента с историей
        if (clientName) {
          await client.query('UPDATE clients SET name = $1 WHERE id = $2', [clientName, clientId]);
        }
      } else {
        const created = await client.query(
          `INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name)
           RETURNING id, no_show_streak`,
          [`client-${randomBytes(6).toString('hex')}`, clientName ?? null, clientPhone]
        );
        clientId = created.rows[0].id;
        noShowStreak = created.rows[0].no_show_streak;
      }
    }

    // Тот же порог предоплаты, что при создании (>=2 неявки) - иначе после смены
    // телефона на номер проблемного клиента пометка осталась бы от прежнего
    const requiresPrepayment = clientId ? noShowStreak >= 2 : false;
    if (hasSource) {
      await client.query(
        'UPDATE bookings SET client_id = $1, walkin_name = $2, requires_prepayment = $3, client_source = $4 WHERE id = $5',
        [clientId, clientName, requiresPrepayment, sourceOut.value, bookingId]
      );
    } else {
      await client.query(
        'UPDATE bookings SET client_id = $1, walkin_name = $2, requires_prepayment = $3 WHERE id = $4',
        [clientId, clientName, requiresPrepayment, bookingId]
      );
    }
    await client.query('COMMIT');
    publish('bookings', { bookingId, reason: 'client' });
    return sendJson(res, 200, { ok: true, clientId, clientName, clientPhone, requiresPrepayment, clientSource: sourceOut.value });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── /sales - продажа (косметика и т.п.), привязана к визиту (разд.14.3 п.2) ──
export async function handleSales(req, res, url) {
  const auth = await authenticate(req);
  if (!requireRole(auth, BOOKING_OPERATOR_ROLES)) return sendJson(res, 401, { error: 'unauthorized' });

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
    publish('bookings', { bookingId: body.bookingId, reason: 'sale' });
    return sendJson(res, 200, { ok: true, id });
  }
}
