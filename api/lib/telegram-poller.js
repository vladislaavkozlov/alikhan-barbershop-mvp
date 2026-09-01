// Опрос обновлений от ботов (01.09.2026, вынужденная замена webhook).
//
// Почему опрос, а не webhook. Проверено на боевом сервере: Telegram не может
// дозвониться до Amvera, «Connection timed out» в getWebhookInfo, при том что
// тот же адрес с нашей машины отвечает мгновенно, а исходящие запросы к
// api.telegram.org с сервера проходят. Значит доставку тянем на себя.
//
// Один процесс - один опрос на бота. Два одновременных опроса одного бота
// Telegram не разрешает и отвечает 409 Conflict; если контейнеров станет
// несколько, опрос придётся отдать выделенному процессу.
import { pool, runDetached, registryQuery } from './db.js';
import { deleteWebhook, getUpdates } from './channel-telegram.js';
import { processUpdate } from '../routes/telegram.js';

// Пауза после ошибки. Не ноль: если Telegram недоступен, крутиться в холостом
// цикле и жечь запросы незачем
const ERROR_PAUSE_MS = 5000;

const running = new Map();

async function loadPollingChannels() {
  const res = await registryQuery(
    `SELECT tc.tenant_id, tc.bot_token, tc.bot_username, tc.poll_offset, t.vertical, t.name
       FROM tenants t JOIN tenant_channels tc ON tc.tenant_id = t.id
      WHERE tc.channel = 'telegram' AND tc.enabled = true AND tc.delivery = 'polling'
        AND t.status = 'active'`,
  );
  return res.rows;
}

// Смещение сохраняем ПОСЛЕ обработки: упавший на середине процесс перечитает то,
// что не успел доделать, а не потеряет ответ клиента. Повторная обработка
// безопаснее потери: «Приду» дважды - это то же самое «Приду».
async function saveOffset(tenantId, offset) {
  await pool.query(
    `UPDATE tenant_channels SET poll_offset = $2 WHERE tenant_id = $1 AND channel = 'telegram'`,
    [tenantId, offset],
  );
}

async function pollLoop(channel, isStopped) {
  const bot = {
    tenantId: channel.tenant_id,
    token: channel.bot_token,
    username: channel.bot_username,
    vertical: channel.vertical,
  };
  let offset = Number(channel.poll_offset) || 0;
  // Webhook и опрос одновременно Telegram не разрешает: если адрес остался с
  // прошлой попытки, getUpdates будет отвечать отказом, пока его не снимут
  await deleteWebhook(bot.token).catch(() => {});

  while (!isStopped()) {
    const res = await getUpdates(bot.token, offset);
    if (!res.ok) {
      console.error(`опрос бота @${bot.username}: ${res.error}`);
      await new Promise((r) => setTimeout(r, ERROR_PAUSE_MS));
      continue;
    }
    for (const update of res.result ?? []) {
      offset = update.update_id + 1;
      try {
        await runDetached(bot.tenantId, () => processUpdate(update, bot, bot.vertical), bot.vertical);
      } catch (err) {
        // Одно плохое обновление не должно останавливать разбор остальных
        console.error(`обновление от Telegram не обработано (@${bot.username}):`, err.message);
      }
      await runDetached(bot.tenantId, () => saveOffset(bot.tenantId, offset), bot.vertical);
    }
  }
}

// Запуск опроса для всех заведений, у которых он выбран способом доставки.
// Ошибка одного бота не должна мешать другим, поэтому каждый цикл живёт сам по
// себе и перезапускается после паузы.
export async function startTelegramPolling() {
  let channels;
  try {
    channels = await loadPollingChannels();
  } catch (err) {
    console.error('опрос ботов не запущен:', err.message);
    return [];
  }
  for (const channel of channels) {
    if (running.has(channel.tenant_id)) continue;
    running.set(channel.tenant_id, true);
    const isStopped = () => !running.has(channel.tenant_id);
    (async function keepAlive() {
      while (!isStopped()) {
        try {
          await pollLoop(channel, isStopped);
        } catch (err) {
          console.error(`цикл опроса @${channel.bot_username} упал:`, err.message);
          await new Promise((r) => setTimeout(r, ERROR_PAUSE_MS));
        }
      }
    })();
    console.log(`опрос обновлений запущен: @${channel.bot_username} для «${channel.name}»`);
  }
  return channels.map((c) => c.bot_username);
}

export function stopTelegramPolling() {
  running.clear();
}
