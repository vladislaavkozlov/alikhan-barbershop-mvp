// GET /notifications, /unread-count, POST /:id/read, /read-all - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';
import { BOOKING_OPERATOR_ROLES } from '../lib/permissions.js';

// ── /notifications - Задача 5 (Окно 14, 02.08.2026). In-app поллинг, не push -
// список/бейдж на странице, обновляется по таймеру фронтенда.
// 20.08.2026 - лента отдаёт не только текст уведомления, но и саму запись: дату,
// время, мастера, услуги, клиента. Без этого раздел «Уведомления» не мог ни открыть
// запись в расписании (нужна дата - календарь листается по ней, не по id брони), ни
// предложить связаться с клиентом (нужен телефон). Один JOIN вместо запроса за бронью
// на каждую строку списка: их тут до 50.
//
// Телефон клиента отдаётся НЕ всем: разд.12 п.1 закрывает его от роли «мастер», и это
// же правило уже действует в карточке записи (BOOKING_OPERATOR_ROLES,
// api/routes/bookings.js). Мастер видит в ленте имя клиента и время, но не номер -
// поэтому и кнопок связи с клиентом у него нет.
export async function handleNotificationsList(req, res, url) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  const canSeeClientPhone = BOOKING_OPERATOR_ROLES.includes(auth.role);
  // COALESCE(c.name, b.walkin_name) - тот же приём, что в списке записей: клиент без
  // телефона (запись «с улицы») хранит имя прямо на брони, иначе оно молча терялось бы.
  // Услуги собираем подзапросом в одну строку - в ленте они показываются как подпись
  // («Стрижка, борода»), отдельный список фронту здесь не нужен.
  let query = `SELECT n.id, n.type, n.booking_id, n.title, n.body, n.read_at, n.created_at,
                      b.date AS booking_date, b.start_time, b.end_time, b.status AS booking_status,
                      b.master_id, m.name AS master_name,
                      COALESCE(c.name, b.walkin_name) AS client_name, c.phone AS client_phone,
                      (SELECT string_agg(s.name, ', ' ORDER BY s.name)
                         FROM booking_services bs JOIN services s ON s.id = bs.service_id
                        WHERE bs.booking_id = b.id) AS service_names
                 FROM notifications n
                 LEFT JOIN bookings b ON b.id = n.booking_id
                 LEFT JOIN clients c ON c.id = b.client_id
                 LEFT JOIN staff m ON m.id = b.master_id
                WHERE n.staff_id = $1`;
  const params = [auth.id];
  if (unreadOnly) query += ' AND n.read_at IS NULL';
  query += ' ORDER BY n.created_at DESC LIMIT 50';
  const result = await pool.query(query, params);
  return sendJson(
    res,
    200,
    result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      bookingId: r.booking_id,
      title: r.title,
      body: r.body,
      read: r.read_at !== null,
      createdAt: r.created_at,
      // Запись могла быть удалена (ON DELETE CASCADE уносит и уведомление, но между
      // двумя запросами страница может держать старый список) - тогда всё это null,
      // и фронт честно показывает только текст уведомления, без кнопок.
      booking: r.booking_id
        ? {
            id: r.booking_id,
            // pg отдаёт date-колонку как JS Date; TZ процесса зафиксирован в UTC
            // (api/lib/db.js), поэтому срез ISO-строки даёт ровно ту дату, что в базе
            date: r.booking_date instanceof Date ? r.booking_date.toISOString().slice(0, 10) : r.booking_date,
            startTime: r.start_time,
            endTime: r.end_time,
            status: r.booking_status,
            masterId: r.master_id,
            masterName: r.master_name,
            clientName: r.client_name,
            clientPhone: canSeeClientPhone ? r.client_phone : null,
            serviceNames: r.service_names,
          }
        : null,
    }))
  );
}

export async function handleNotificationsUnreadCount(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const result = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE staff_id = $1 AND read_at IS NULL', [auth.id]);
  return sendJson(res, 200, { count: result.rows[0].n });
}

export async function handleNotificationRead(req, res, parts) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  await pool.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND staff_id = $2 AND read_at IS NULL', [parts[1], auth.id]);
  return sendJson(res, 200, { ok: true });
}

export async function handleNotificationsReadAll(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  await pool.query('UPDATE notifications SET read_at = now() WHERE staff_id = $1 AND read_at IS NULL', [auth.id]);
  return sendJson(res, 200, { ok: true });
}
