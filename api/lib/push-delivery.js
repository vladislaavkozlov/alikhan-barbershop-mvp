// Доставка уведомления на телефоны сотрудника (Окно 73, 28.08.2026).
//
// Прослойка между «в кабинете появилось уведомление» и «телефон зазвонил».
// Отдельным файлом, чтобы notify-core не знал ни про шифрование, ни про сеть, а
// эта логика могла молча ничего не делать, когда ключи не настроены.
//
// Главное правило: отправка НИКОГДА не роняет то, ради чего её позвали. Запись
// клиента должна создаться, даже если Google недоступен, поэтому здесь всё
// обёрнуто в try и уходит в фон - вызывающий не ждёт ответа сервисов доставки.
import { pool, runInTenant } from './db.js';
import { currentTenantId } from './tenant-context.js';
import { sendPush } from './webpush.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? '';
// Контакт отправителя - требование стандарта: сервис доставки должен знать, к кому
// обращаться при проблемах. В письмо сотруднику не попадает.
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';

export const pushConfigured = () => Boolean(PUBLIC_KEY && PRIVATE_KEY);
export const vapidPublicKey = () => PUBLIC_KEY || null;

// Уведомления пишутся внутри транзакции создания записи. Слать из транзакции
// нельзя: сеть может ответить через секунды, а транзакция всё это время держала
// бы строки. Поэтому отправка откладывается на следующий виток цикла событий,
// когда транзакция уже закрыта.
//
// Тонкость, из-за которой первая версия этой функции была сломана. Соединение с
// базой в этом проекте принадлежит запросу и отпускается вместе с ним (см.
// runInTenant в db.js). К моменту, когда сработает setImmediate, исходный запрос
// уже ответил браузеру и вернул соединение в пул - обращаться к `pool` оттуда
// нельзя: в лучшем случае это ошибка «нет контекста арендатора», в худшем -
// работа по чужому соединению. Поэтому арендатора запоминаем СЕЙЧАС, пока
// контекст ещё жив, а в фоне открываем свой собственный.
export function deliverPushLater(staffId, { title, body, url }) {
  if (!pushConfigured() || !staffId) return;
  let tenantId = null;
  try {
    tenantId = currentTenantId();
  } catch {
    // Контекста нет - значит зовут не из запроса (например из фонового сканера
    // напоминаний). Отправить в таком случае некуда: без арендатора мы не знаем,
    // в чьей базе искать подписки.
    return;
  }
  setImmediate(() => {
    runInTenant(tenantId, () => deliverPush(staffId, { title, body, url })).catch((error) => {
      console.error('push: не удалось доставить', error?.message ?? error);
    });
  });
}

export async function deliverPush(staffId, { title, body, url }) {
  const subs = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE staff_id = $1',
    [staffId],
  );
  if (subs.rows.length === 0) return { sent: 0, removed: 0 };

  const payload = JSON.stringify({ title, body: body ?? '', url: url ?? '' });
  let sent = 0;
  let removed = 0;

  for (const sub of subs.rows) {
    try {
      const res = await sendPush(sub, payload, {
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
        subject: SUBJECT,
      });
      if (res.gone) {
        // Устройство отписалось или браузер снесли - строка больше не нужна.
        // Не чистить их значило бы копить мусор и слать в пустоту вечно.
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
        removed += 1;
      } else if (res.status >= 200 && res.status < 300) {
        await pool.query('UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1', [sub.id]);
        sent += 1;
      } else {
        await pool.query('UPDATE push_subscriptions SET last_failure_at = now(), failure_count = failure_count + 1 WHERE id = $1', [sub.id]);
      }
    } catch (error) {
      await pool.query('UPDATE push_subscriptions SET last_failure_at = now(), failure_count = failure_count + 1 WHERE id = $1', [sub.id]);
    }
  }
  return { sent, removed };
}
