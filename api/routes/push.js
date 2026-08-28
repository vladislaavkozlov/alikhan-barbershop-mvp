// Подписка устройств на уведомления (Окно 73, 28.08.2026).
//
// Три операции: отдать фронту наш публичный ключ, запомнить устройство, забыть
// устройство. Само отправление живёт в lib/push-delivery.js - оно вызывается из
// notifyStaff, а не отдельным запросом снаружи.
import { randomBytes } from 'node:crypto';
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';
import { vapidPublicKey, pushConfigured } from '../lib/push-delivery.js';

// Публичный ключ отправителя. Без него браузер не может оформить подписку.
// Отдельным ответом сообщаем, настроены ли ключи вообще: интерфейс тогда честно
// скажет «уведомления не подключены», а не покажет тумблер, который не сработает.
export async function handlePushKey(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  return sendJson(res, 200, { configured: pushConfigured(), publicKey: vapidPublicKey() });
}

export async function handlePushSubscribe(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const endpoint = String(body.endpoint ?? '').trim();
  const p256dh = String(body.p256dh ?? body.keys?.p256dh ?? '').trim();
  const authSecret = String(body.auth ?? body.keys?.auth ?? '').trim();
  if (!endpoint || !p256dh || !authSecret) return sendJson(res, 400, { error: 'invalid_subscription' });
  // Адрес доставки выдаёт сервис Google или Apple - принимаем только http(s),
  // чтобы в таблицу не попало произвольное значение из подделанного запроса
  if (!/^https:\/\//.test(endpoint)) return sendJson(res, 400, { error: 'invalid_subscription' });

  const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 300);
  // Тот же браузер, переподписавшийся заново, обновляет свою строку. Заодно
  // перепривязываем её к текущему сотруднику: на общем планшете администратора
  // это ровно то, чего ждут - уведомления идут тому, кто сейчас вошёл.
  await pool.query(
    `INSERT INTO push_subscriptions (id, staff_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET staff_id = EXCLUDED.staff_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, failure_count = 0, last_failure_at = NULL`,
    [`push-${randomBytes(10).toString('hex')}`, auth.id, endpoint, p256dh, authSecret, userAgent || null],
  );
  return sendJson(res, 200, { ok: true });
}

export async function handlePushUnsubscribe(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const endpoint = String(body.endpoint ?? '').trim();
  if (!endpoint) return sendJson(res, 400, { error: 'invalid_subscription' });
  // Своё устройство отписывает кто угодно, чужое - никто: сверяем сотрудника
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND staff_id = $2', [endpoint, auth.id]);
  return sendJson(res, 200, { ok: true });
}

// Сколько устройств сейчас подписано у этого сотрудника - интерфейсу нужно, чтобы
// показать состояние тумблера правильно после перезахода
export async function handlePushStatus(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const result = await pool.query('SELECT count(*)::int AS devices FROM push_subscriptions WHERE staff_id = $1', [auth.id]);
  return sendJson(res, 200, { devices: result.rows[0]?.devices ?? 0, configured: pushConfigured() });
}
