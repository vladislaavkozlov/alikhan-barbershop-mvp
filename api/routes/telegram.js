// Входящие обновления от бота Telegram (01.09.2026, Волна 1,
// plans/2026-09-01-bot-telegram-pesochnica.md).
//
// Почему этот роут особенный. Все остальные запросы приходят с домена кабинета или
// сайта, и арендатор определяется по домену (server.mjs). Telegram приходит на
// домен самого API и ни о каких заведениях не знает. Поэтому арендатор определяется
// по секрету в адресе: /tg/<секрет>. Строка справочника tenant_channels - это и есть
// ответ на вопрос «чей это бот», и читается она до открытия контекста арендатора.
//
// Второй рубеж - заголовок X-Telegram-Bot-Api-Secret-Token: его кладёт сам Telegram
// по договорённости, установленной в setWebhook. Знать адрес мало, надо знать и его.
//
// Отвечаем 200 всегда, когда обновление разобрано: код ответа для Telegram это не
// «понравилось ли нам содержимое», а «доставлять ли повторно». Повторная доставка
// того же нажатия кнопки - это второе уведомление администратору на один клик.
import { timingSafeEqual } from 'node:crypto';
import { sendJson, readBody } from '../lib/http.js';
import { pool, runInTenant, registryQuery, currentTenantId } from '../lib/db.js';
import { notifyStaff } from '../lib/notify-core.js';
import { answerCallback, buttons, dropKeyboard, sendMessage, tenantByWebhookSecret } from '../lib/channel-telegram.js';
import { deliverForClient, redeemInvite } from '../lib/client-messaging.js';
import { bookingWatcherIds } from './bookings.js';
import { term } from '../lib/vertical-terms.js';

// Сравнение секретов постоянного времени: обычное === на строках отвечает тем
// быстрее, чем раньше расходятся символы, и по этому времени секрет подбирается
function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Кто этот человек в нашей базе. Неизвестный chat_id - не ошибка и не повод для
// молчания: человек мог найти бота поиском, не проходя по ссылке.
async function clientByChat(chatId) {
  const res = await pool.query(
    `SELECT client_id FROM client_channels
      WHERE channel = 'telegram' AND external_id = $1 AND unsubscribed_at IS NULL`,
    [String(chatId)],
  );
  return res.rows[0]?.client_id ?? null;
}

// Бронь, о которой идёт речь, обязана принадлежать именно этому человеку. Данные
// кнопки приходят от клиента и подделываются тривиально: чужой id записи в
// callback_data - самый очевидный вектор, и он закрывается здесь, а не доверием.
// Адрес формы записи заведения (миграция 069). Лежит в реестре арендаторов, а не в
// данных заведения: замок 058 закрывает таблицу tenants от обычных запросов, читать
// её положено реестровым соединением - тем же, каким сервер узнаёт заведение по домену
async function tenantBookingUrl() {
  const res = await registryQuery('SELECT booking_url FROM tenants WHERE id = $1', [currentTenantId()]);
  return res.rows[0]?.booking_url ?? null;
}

async function bookingOfClient(bookingId, clientId) {
  const res = await pool.query(
    `SELECT b.id, b.date, b.start_time, b.location_id, b.master_id, b.status, c.name AS client_name
       FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
      WHERE b.id = $1 AND b.client_id = $2`,
    [bookingId, clientId],
  );
  return res.rows[0] ?? null;
}

async function onStart(bot, chatId, payload, vertical) {
  if (!payload) {
    // Пришёл сам, без приглашения. Врать «всё готово» нельзя: напоминания ему не
    // придут, потому что мы не знаем, кто он
    // Слово о самом событии - из словаря вертикали: у клиники «о приёме», у
    // барбершопа «о записи». Найдено на живом боте 01.09.2026: текст был зашит
    // руками и клиника здоровалась барбершопными словами
    await sendMessage(bot.token, chatId, `Здравствуйте. Чтобы получать напоминания о ${term(vertical, 'booking.pre')}, откройте бота по персональной ссылке - её выдаёт администратор при записи`);
    return { action: 'start_without_payload' };
  }
  const clientId = await redeemInvite(payload, chatId);
  if (!clientId) {
    await sendMessage(bot.token, chatId, 'Эта ссылка уже использована или устарела. Попросите, пожалуйста, новую у администратора');
    return { action: 'invite_invalid' };
  }
  const bookingWord = term(vertical, 'booking.pre'); // «записи» / «приёме»
  await sendMessage(bot.token, chatId, `Готово. Здесь будут напоминания о ${bookingWord} и кнопки для подтверждения\n\nОтписаться можно в любой момент командой /stop`);
  // Подтверждение уходит здесь же, а не следующим тиком планировщика: человек
  // только что нажал кнопку и ждёт ответа. Минута молчания читается как поломка
  await deliverForClient(clientId, vertical);
  return { action: 'linked', clientId };
}

async function onStop(bot, chatId) {
  await pool.query(
    `UPDATE client_channels SET unsubscribed_at = now()
      WHERE channel = 'telegram' AND external_id = $1`,
    [String(chatId)],
  );
  await sendMessage(bot.token, chatId, 'Отписали. Напоминания приходить не будут. Чтобы вернуть их, откройте ссылку от администратора заново');
  return { action: 'unsubscribed' };
}

async function onCallback(bot, cb, vertical) {
  const chatId = cb.message?.chat?.id ?? cb.from?.id;
  const [verb, bookingId] = String(cb.data ?? '').split(':');
  const clientId = await clientByChat(chatId);
  if (!clientId || !bookingId) {
    await answerCallback(bot.token, cb.id, 'Не нашли вашу запись');
    return { action: 'callback_unknown_client' };
  }
  const booking = await bookingOfClient(bookingId, clientId);
  if (!booking) {
    await answerCallback(bot.token, cb.id, 'Не нашли вашу запись');
    return { action: 'callback_foreign_booking' };
  }
  const [y, m, d] = String(booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date).split('-');
  const when = `${d}.${m}.${y}, ${String(booking.start_time).slice(0, 5)}`;

  if (verb === 'ok') {
    // Отдельная ось от статуса записи (002_schema.sql): «подтвердил» это не
    // «состоялась». Колонка ждала своего часа с самого начала проекта
    await pool.query('UPDATE bookings SET client_confirmed = true WHERE id = $1', [bookingId]);
    await answerCallback(bot.token, cb.id, 'Спасибо, ждём вас');
    if (cb.message?.message_id) await dropKeyboard(bot.token, chatId, cb.message.message_id);
    // Планы меняются и после подтверждения. Оставлять человека без выхода - значит
    // вернуть его к телефонному звонку ради «буду на пятнадцать минут позже»
    await sendMessage(bot.token, chatId, `Подтверждено: ${when}. Ждём вас\n\nЕсли планы изменятся - скажите здесь`, buttons([
      [{ text: '🕐 Задержусь', data: `lt:${bookingId}` }],
      [{ text: '🕗 Перенести', data: `mv:${bookingId}` }, { text: '✖️ Отменить', data: `no:${bookingId}` }],
    ]));
    return { action: 'confirmed', bookingId };
  }

  // «Задержусь» без указания времени бесполезно администратору: подвинуть
  // следующего можно, только зная, на сколько. Поэтому сразу спрашиваем
  if (verb === 'lt') {
    await answerCallback(bot.token, cb.id);
    await sendMessage(bot.token, chatId, 'На сколько примерно задержитесь?', buttons([
      [
        { text: '10 минут', data: `l1:${bookingId}` },
        { text: '20 минут', data: `l2:${bookingId}` },
        { text: '30 минут', data: `l3:${bookingId}` },
      ],
    ]));
    return { action: 'late_ask', bookingId };
  }

  if (verb === 'l1' || verb === 'l2' || verb === 'l3') {
    const minutes = { l1: 10, l2: 20, l3: 30 }[verb];
    const client = await pool.connect();
    try {
      const recipients = [booking.master_id, ...(await bookingWatcherIds(client, booking.location_id))];
      for (const staffId of [...new Set(recipients.filter(Boolean))]) {
        await notifyStaff(client, staffId, 'client_will_be_late', {
          bookingId,
          title: `Клиент задержится на ${minutes} мин`,
          body: `${when}${booking.client_name ? ' · ' + booking.client_name : ''}`,
        });
      }
    } finally {
      client.release();
    }
    await answerCallback(bot.token, cb.id, 'Передали');
    if (cb.message?.message_id) await dropKeyboard(bot.token, chatId, cb.message.message_id);
    await sendMessage(bot.token, chatId, `Предупредили ${term(vertical, 'master.acc')}. Ждём вас на ${minutes} минут позже`);
    return { action: 'client_will_be_late', bookingId, minutes };
  }

  // Ответ «да» на письмо после неявки (04.09.2026, замечание Влада: «нахера
  // администратору с ним связываться, он сам может через форму новое время себе
  // выбрать»). Человек получает ссылку на форму записи и выбирает свободное время
  // сам - это не перенос чужой брони ботом, которого мы избегаем, а обычная новая
  // запись, ровно та же, что делает любой клиент с сайта.
  //
  // Администратора зовём только там, где ссылки нет: обещать самозапись заведению
  // без формы записи значит обещать неработающее. Ответ в любом случае ложится на
  // бронь - именно он поднимает строку в списке владельца наверх
  if (verb === 'rb') {
    await pool.query("UPDATE bookings SET noshow_reply = 'wants_time', noshow_reply_at = now() WHERE id = $1", [bookingId]);
    const bookingUrl = await tenantBookingUrl();
    if (!bookingUrl) {
      const client = await pool.connect();
      try {
        const recipients = [booking.master_id, ...(await bookingWatcherIds(client, booking.location_id))];
        for (const staffId of [...new Set(recipients.filter(Boolean))]) {
          await notifyStaff(client, staffId, 'client_wants_move', {
            bookingId,
            title: 'Не пришёл и просит новое время',
            body: `${when}${booking.client_name ? ' · ' + booking.client_name : ''}`,
          });
        }
      } finally {
        client.release();
      }
    }
    await answerCallback(bot.token, cb.id, bookingUrl ? 'Открывайте форму записи' : 'Передали администратору');
    if (cb.message?.message_id) await dropKeyboard(bot.token, chatId, cb.message.message_id);
    if (bookingUrl) {
      await sendMessage(bot.token, chatId, 'Выберите удобное время - свободные окна видны сразу', buttons([
        [{ text: '📅 Выбрать время', url: bookingUrl }],
      ]));
    } else {
      await sendMessage(bot.token, chatId, 'Передали администратору - он свяжется с вами и подберёт удобное время');
    }
    return { action: 'noshow_wants_time', bookingId, selfBooking: Boolean(bookingUrl) };
  }

  // Ответ «пока не планирую». Вопрос Влада: «а можно у него уточнить, почему не
  // планирует?». Можно - это единственная обратная связь от человека, который уже
  // проголосовал ногами, и она стоит одного вопроса. Один экран, четыре варианта,
  // ответ необязателен: не ответит - останется просто отказ, без причины
  if (verb === 'rn') {
    await pool.query("UPDATE bookings SET noshow_reply = 'not_now', noshow_reply_at = now() WHERE id = $1", [bookingId]);
    await answerCallback(bot.token, cb.id, 'Спасибо, поняли');
    if (cb.message?.message_id) await dropKeyboard(bot.token, chatId, cb.message.message_id);
    await sendMessage(bot.token, chatId, 'Понятно, не настаиваем\n\nПодскажете, почему? Это поможет нам стать удобнее', buttons([
      [{ text: 'Дорого', data: `rp:${bookingId}` }, { text: 'Неудобное время', data: `rt:${bookingId}` }],
      [{ text: 'Хожу в другое место', data: `ro:${bookingId}` }, { text: 'Просто передумал', data: `rm:${bookingId}` }],
    ]));
    return { action: 'noshow_not_now', bookingId };
  }

  // Названная причина отказа. Отдельные глаголы вместо одного с параметром - формат
  // callback_data здесь везде «два символа : id», и ломать его ради одного случая
  // значило бы переписывать разбор в начале функции
  const REASONS = { rp: 'price', rt: 'time', ro: 'other_place', rm: 'changed_mind' };
  if (REASONS[verb]) {
    await pool.query('UPDATE bookings SET noshow_reason = $2 WHERE id = $1', [bookingId, REASONS[verb]]);
    await answerCallback(bot.token, cb.id, 'Спасибо');
    if (cb.message?.message_id) await dropKeyboard(bot.token, chatId, cb.message.message_id);
    await sendMessage(bot.token, chatId, 'Спасибо, что сказали. Будем рады видеть вас, когда будет удобно');
    return { action: 'noshow_reason', bookingId, reason: REASONS[verb] };
  }

  if (verb === 'mv' || verb === 'no') {
    // Бот сам не переносит и не отменяет: за расписанием стоит живой человек, и
    // окно, освобождённое ботом по ошибке, стоит дороже, чем ручной звонок
    const type = verb === 'mv' ? 'client_wants_move' : 'client_wants_cancel';
    const title = verb === 'mv' ? 'Клиент просит перенести' : 'Клиент просит отменить';
    const client = await pool.connect();
    try {
      const recipients = [booking.master_id, ...(await bookingWatcherIds(client, booking.location_id))];
      for (const staffId of [...new Set(recipients.filter(Boolean))]) {
        await notifyStaff(client, staffId, type, {
          bookingId,
          title,
          body: `${when}${booking.client_name ? ' · ' + booking.client_name : ''}`,
        });
      }
    } finally {
      client.release();
    }
    await answerCallback(bot.token, cb.id, 'Передали администратору');
    if (cb.message?.message_id) await dropKeyboard(bot.token, chatId, cb.message.message_id);
    await sendMessage(bot.token, chatId, verb === 'mv'
      ? 'Передали администратору - он свяжется с вами и подберёт другое время'
      : 'Передали администратору. Если передумаете, просто напишите нам');
    return { action: type, bookingId };
  }
  await answerCallback(bot.token, cb.id);
  return { action: 'callback_unknown_verb' };
}

// Человек написал словами вместо нажатия кнопки. Найдено живым прогоном 01.09.2026:
// Влад, не увидев кнопок, написал «Приду» текстом и получил отписку «позвоните нам».
// Формально верно, по сути - тупик.
//
// Поэтому на любой текст показываем его ближайшую запись с теми же кнопками. Бот
// по-прежнему не изображает поддержку, которой за ним нет, но и не отправляет
// человека звонить туда, где он уже всё сказал.
async function onFreeText(bot, chatId, vertical) {
  const clientId = await clientByChat(chatId);
  if (clientId) {
    const res = await pool.query(
      `SELECT b.id, b.date, b.start_time, s.name AS master_name
         FROM bookings b LEFT JOIN staff s ON s.id = b.master_id
        WHERE b.client_id = $1 AND b.status = 'planned'
          -- Время визита без зоны означает московское, см. lib/client-messaging.js
          AND ((b.date + b.start_time::time) AT TIME ZONE 'Europe/Moscow') > now()
        ORDER BY b.date, b.start_time
        LIMIT 1`,
      [clientId],
    );
    const next = res.rows[0];
    if (next) {
      const dateIso = next.date instanceof Date ? next.date.toISOString().slice(0, 10) : String(next.date);
      const [y, m, d] = dateIso.split('-');
      const masterNom = term(vertical, 'master.nom');
      await sendMessage(
        bot.token,
        chatId,
        `Ваша ближайшая запись: <b>${d}.${m}.${y} в ${String(next.start_time).slice(0, 5)}</b>\n${masterNom}: ${next.master_name ?? '-'}`,
        buttons([
          [{ text: '✅ Приду', data: `ok:${next.id}` }],
          [{ text: '🕗 Перенести', data: `mv:${next.id}` }, { text: '✖️ Отменить', data: `no:${next.id}` }],
        ]),
      );
      return { action: 'free_text_with_booking' };
    }
  }
  await sendMessage(bot.token, chatId, `Этот бот присылает напоминания о ${term(vertical, 'booking.pre')}. Если нужно что-то уточнить, позвоните нам`);
  return { action: 'free_text' };
}

// Человек заблокировал бота. Telegram сообщает об этом сам, и лучше узнать так,
// чем на первой же неудачной отправке
async function onChatMember(update) {
  const status = update.my_chat_member?.new_chat_member?.status;
  const chatId = update.my_chat_member?.chat?.id;
  if (!chatId || !['kicked', 'left'].includes(status)) return { action: 'chat_member_ignored' };
  await pool.query(
    `UPDATE client_channels SET unsubscribed_at = now(), last_error = $2
      WHERE channel = 'telegram' AND external_id = $1`,
    [String(chatId), `my_chat_member: ${status}`],
  );
  return { action: 'unsubscribed_by_block' };
}

export async function processUpdate(update, bot, vertical) {
  if (update.message?.text) {
    const text = String(update.message.text).trim();
    const chatId = update.message.chat.id;
    if (text.startsWith('/start')) return onStart(bot, chatId, text.slice('/start'.length).trim(), vertical);
    if (text.startsWith('/stop')) return onStop(bot, chatId);
    return onFreeText(bot, chatId, vertical);
  }
  if (update.callback_query) return onCallback(bot, update.callback_query, vertical);
  if (update.my_chat_member) return onChatMember(update);
  return { action: 'ignored' };
}

// Точка входа из server.mjs. Разбор арендатора здесь, а не в общем месте: у этого
// запроса нет домена, по которому его можно узнать.
export async function handleTelegramWebhook(req, res, secretFromPath) {
  const bot = await tenantByWebhookSecret(secretFromPath);
  if (!bot) return sendJson(res, 404, { error: 'unknown_webhook' });
  if (!sameSecret(req.headers['x-telegram-bot-api-secret-token'], secretFromPath)) {
    return sendJson(res, 403, { error: 'bad_secret' });
  }
  let update;
  try {
    update = await readBody(req);
  } catch {
    return sendJson(res, 200, { ok: true }); // мусор не просим доставлять повторно
  }
  try {
    const result = await runInTenant(bot.tenantId, () => processUpdate(update, bot, bot.vertical));
    return sendJson(res, 200, { ok: true, action: result?.action ?? 'ignored' });
  } catch (err) {
    // В лог сервера, не клиенту: у Telegram нет глаз, а повторная доставка
    // нажатия кнопки хуже потерянного нажатия
    console.error('обновление от Telegram не обработано:', err.message);
    return sendJson(res, 200, { ok: false });
  }
}
