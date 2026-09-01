// Транспорт Telegram: доставка сообщений клиенту (01.09.2026, Волна 1,
// plans/2026-09-01-bot-telegram-pesochnica.md).
//
// Здесь только «как доставить»: что и когда сказать решает движок очереди
// (client-messaging.js). Разделение не декоративное - Алихан ждёт МАКС, Карина
// работает в Telegram, и добавление третьего канала не должно трогать логику
// напоминаний.
//
// Зависимостей нет: у API их и не было, кроме pg. Bot API это обычный HTTPS с
// JSON, встроенного fetch хватает.
import { registryQuery } from './db.js';

const API = 'https://api.telegram.org';

// Telegram отвечает 200 и на логические ошибки, поэтому «доставлено» определяется
// полем ok, а не кодом ответа. Текст описания сохраняем целиком: по нему потом
// отличается заблокировавший бота клиент от нашей же ошибки в разметке.
// Сколько ждём ответа и сколько раз пробуем внутри одного вызова.
//
// Живой прогон 01.09.2026: первая отправка упала по таймауту, сообщение вернулось
// в очередь и ушло только следующим тиком - человек получил подтверждение через
// минуту после нажатия. Связь до Telegram из России рвётся регулярно, и ждать из-за
// одного обрыва целый тик неправильно.
//
// Повтор только на обрыв связи, когда ответа не было вовсе. Ответ с ошибкой не
// повторяем здесь: там уже решает движок очереди. Пятнадцать секунд ожидания
// заменены на восемь - за это время живой Telegram отвечает всегда, а мёртвая
// сеть не держит человека у экрана.
const CALL_TIMEOUT_MS = 8000;
const CALL_RETRIES = 2;

async function call(token, method, payload) {
  let res;
  let lastNetworkError = null;
  for (let attempt = 1; attempt <= CALL_RETRIES; attempt += 1) {
    try {
      res = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      lastNetworkError = null;
      break;
    } catch (e) {
      lastNetworkError = e;
      if (attempt < CALL_RETRIES) await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (lastNetworkError) {
    // Связи не было и со второй попытки. Это повод повторить позже, а не
    // пометить сообщение мёртвым
    return { ok: false, retriable: true, error: `network: ${lastNetworkError.message}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, retriable: true, error: `bad_response_${res.status}` };
  }
  if (body.ok) return { ok: true, result: body.result };

  // 403 - человек заблокировал бота или удалил чат. Повторять бессмысленно и
  // навязчиво: такую привязку движок гасит, а не долбит по расписанию.
  // 429 - слишком часто, ждём столько, сколько просят.
  const code = body.error_code;
  const retriable = code === 429 || code >= 500;
  return {
    ok: false,
    retriable,
    fatal: code === 403 || code === 400,
    retryAfter: body.parameters?.retry_after ?? null,
    error: `${code}: ${body.description}`,
  };
}

// Токен бота арендатора. Лежит в базе, а не в переменных окружения: подключение
// очередного клиента не должно требовать пересборки боевого сервера.
// Таблица без замка арендатора (миграция 062), поэтому registryQuery.
export async function telegramConfig(tenantId) {
  const res = await registryQuery(
    `SELECT bot_token, bot_username, webhook_secret, enabled
       FROM tenant_channels WHERE tenant_id = $1 AND channel = 'telegram'`,
    [tenantId],
  );
  const row = res.rows[0];
  if (!row || !row.enabled || !row.bot_token) return null;
  return { token: row.bot_token, username: row.bot_username, secret: row.webhook_secret };
}

// Обратный поиск: входящее обновление приходит на секретный адрес, и это
// единственный способ понять, чей это бот, ДО открытия контекста арендатора.
export async function tenantByWebhookSecret(secret) {
  if (!secret) return null;
  // Вертикаль берём здесь же: тексты бота говорят «врач» или «мастер» в
  // зависимости от заведения, а второй раз ходить в базу уже внутри контекста
  // арендатора незачем
  const res = await registryQuery(
    `SELECT tc.tenant_id, tc.bot_token, tc.bot_username, t.vertical
       FROM tenants t JOIN tenant_channels tc ON tc.tenant_id = t.id
      WHERE tc.channel = 'telegram' AND tc.webhook_secret = $1 AND tc.enabled = true
        AND t.status = 'active'`,
    [secret],
  );
  const row = res.rows[0];
  return row ? { tenantId: row.tenant_id, token: row.bot_token, username: row.bot_username, vertical: row.vertical } : null;
}

// Кнопки под сообщением. Telegram зовёт их inline и требует массив рядов, а не
// плоский список - оборачиваем здесь, чтобы движок не знал разметки платформы.
export function buttons(rows) {
  return { inline_keyboard: rows.map((row) => row.map(({ text, data, url }) => (url ? { text, url } : { text, callback_data: data }))) };
}

export async function sendMessage(token, chatId, text, keyboard = null) {
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    // Ссылки на карты в просьбе об отзыве не должны разворачиваться в простыню
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

// Нажатие кнопки надо подтвердить в течение нескольких секунд, иначе у клиента
// в интерфейсе висят часики и он жмёт второй раз
export async function answerCallback(token, callbackId, text = null) {
  return call(token, 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: false } : {}) });
}

// Убирает кнопки у уже отправленного сообщения: после ответа «Приду» кнопки
// теряют смысл, а оставленные - провоцируют повторные нажатия
export async function dropKeyboard(token, chatId, messageId) {
  return call(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

export async function setWebhook(token, url, secretHeader) {
  return call(token, 'setWebhook', {
    url,
    // Второй рубеж помимо секрета в адресе: Telegram кладёт это значение в
    // заголовок каждого запроса, подделать его посторонний не может
    secret_token: secretHeader,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: true,
  });
}

export async function getMe(token) {
  return call(token, 'getMe', {});
}

export async function deleteWebhook(token) {
  return call(token, 'deleteWebhook', { drop_pending_updates: true });
}
