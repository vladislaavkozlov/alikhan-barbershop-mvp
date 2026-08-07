// GET /notifications, /unread-count, POST /:id/read, /read-all - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';

// ── /notifications - Задача 5 (Окно 14, 02.08.2026). In-app поллинг, не push -
// список/бейдж на странице, обновляется по таймеру фронтенда.
export async function handleNotificationsList(req, res, url) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  let query = 'SELECT id, type, booking_id, schedule_request_id, related_master_id, title, body, read_at, created_at FROM notifications WHERE staff_id = $1';
  const params = [auth.id];
  if (unreadOnly) query += ' AND read_at IS NULL';
  query += ' ORDER BY created_at DESC LIMIT 50';
  const result = await pool.query(query, params);
  return sendJson(
    res,
    200,
    result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      bookingId: r.booking_id,
      scheduleRequestId: r.schedule_request_id,
      relatedMasterId: r.related_master_id,
      title: r.title,
      body: r.body,
      read: r.read_at !== null,
      createdAt: r.created_at,
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
