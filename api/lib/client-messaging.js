// Движок сообщений клиенту: очередь, сроки, выбор канала (01.09.2026, Волна 1,
// plans/2026-09-01-bot-telegram-pesochnica.md).
//
// Что здесь. Решение «что и когда сказать клиенту»: подтверждение сразу после
// записи, напоминание за сутки и за два часа, просьба об отзыве через два часа
// после визита. Как именно доставить - дело транспорта (channel-telegram.js).
//
// Почему очередь, а не отправка на месте. Отправка на месте означает, что сбой
// сети клиента ломает создание записи, а напоминание за сутки вообще некому
// послать: в этот момент никакого запроса к серверу нет. Строка в таблице живёт
// сама, тик планировщика её подбирает, неудача не теряется и повторяется.
import { randomBytes } from 'node:crypto';
import { pool, registryQuery, runDetached, currentTenantId } from './db.js';
import { term } from './vertical-terms.js';
import { buttons, dropKeyboard, sendMessage, telegramConfig } from './channel-telegram.js';

// Сколько раз пробуем доставить, прежде чем признать сообщение непосланным.
// Больше пяти смысла не имеет: напоминание за два часа, опоздавшее на сутки,
// вредит сильнее, чем его отсутствие.
const MAX_ATTEMPTS = 5;
// Приглашение в бота живёт сутки. Ссылку пересылают и теряют, а подобравший
// чужую получает чужие напоминания - поэтому срок короткий, а токен одноразовый.
const INVITE_TTL_HOURS = 24;

const id = (prefix) => `${prefix}-${randomBytes(10).toString('hex')}`;

// ── Тексты ──────────────────────────────────────────────────────────────────
// Подписи зависят от вертикали: у Алихана «мастер» и «запись», у Карины «врач»
// и «приём». Словарь уже есть и уже отдаётся кабинету, второй раз его не пишем.
function human(dateIso, time) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${d} ${months[m - 1]} в ${String(time).slice(0, 5)}`;
}

export function messageText(kind, ctx) {
  const v = ctx.vertical;
  const masterNom = term(v, 'master.nom');
  const when = human(ctx.date, ctx.startTime);
  switch (kind) {
    case 'booking_confirm':
      return `Здравствуйте, ${ctx.clientName}\n\nВы записаны: <b>${when}</b>\n${masterNom[0].toUpperCase() + masterNom.slice(1)}: ${ctx.masterName}\n${ctx.serviceName ? `Услуга: ${ctx.serviceName}\n` : ''}\n${ctx.placeName}`;
    case 'reminder_24h':
      return `Напоминаем: завтра <b>${when}</b>\n${masterNom}: ${ctx.masterName}\n\nПодтвердите, пожалуйста, что придёте`;
    case 'reminder_2h':
      return `Ждём вас сегодня <b>${when}</b>\n${masterNom}: ${ctx.masterName}\n\n${ctx.placeName}`;
    case 'review_request':
      return `${ctx.clientName}, спасибо, что были у нас\n\nЕсли всё понравилось, оставьте, пожалуйста, отзыв - это две минуты, а нам помогает сильно`;
    default:
      throw new Error(`unknown_kind_${kind}`);
  }
}

function keyboardFor(kind, bookingId, links) {
  if (kind === 'booking_confirm' || kind === 'reminder_24h' || kind === 'reminder_2h') {
    return buttons([
      [{ text: '✅ Приду', data: `ok:${bookingId}` }],
      [{ text: '🕗 Перенести', data: `mv:${bookingId}` }, { text: '✖️ Отменить', data: `no:${bookingId}` }],
    ]);
  }
  if (kind === 'review_request') {
    const row = [];
    if (links?.gis) row.push({ text: '2ГИС', url: links.gis });
    if (links?.yandex) row.push({ text: 'Яндекс.Карты', url: links.yandex });
    return row.length ? buttons([row]) : null;
  }
  return null;
}

// ── Постановка в очередь ────────────────────────────────────────────────────
// Сроки считаются от времени визита, а не от «сейчас». Запись, созданная за час
// до приёма, не получает напоминания за сутки: его срок уже прошёл, и строка
// сразу помечается пропущенной, а не улетает вдогонку.
// Ставрополь = московское время, UTC+3 круглый год. Время визита лежит в базе
// строкой без зоны, и без явного смещения Date читает её в таймзоне процесса - на
// Amvera это UTC. Тот же приём и та же причина, что в handleBookingCancel
// (routes/bookings.js): иначе напоминание «за два часа» уходит за пять.
//
// Поймано живым прогоном 01.09.2026, а не рассуждением: подтверждение не пришло
// человеку, который открыл бота за полчаса до приёма - система считала визит
// давно прошедшим.
const VISIT_TZ_OFFSET = '+03:00';

export function plannedMessages(booking, now = new Date()) {
  const start = new Date(`${booking.date}T${String(booking.start_time).slice(0, 5)}:00${VISIT_TZ_OFFSET}`);
  const end = new Date(`${booking.date}T${String(booking.end_time).slice(0, 5)}:00${VISIT_TZ_OFFSET}`);
  return [
    { kind: 'booking_confirm', dueAt: now },
    { kind: 'reminder_24h', dueAt: new Date(start.getTime() - 24 * 3600e3) },
    { kind: 'reminder_2h', dueAt: new Date(start.getTime() - 2 * 3600e3) },
    { kind: 'review_request', dueAt: new Date(end.getTime() + 2 * 3600e3) },
  ];
}

// db - соединение текущей транзакции, если постановка идёт вместе с записью брони.
// По умолчанию обычный запрос: тогда постановка живёт своей жизнью.
//
// Функция идемпотентна и потому же годится для переноса: повторный вызов не плодит
// строки, а пересчитывает сроки. Уже отправленное при этом не воскресает - сказанное
// клиенту сказано, и «напоминание за сутки» из прошлого времени не должно уехать
// второй раз просто потому, что запись подвинули.
export async function enqueueForBooking(booking, now = new Date(), db = pool) {
  const rows = [];
  for (const { kind, dueAt } of plannedMessages(booking, now)) {
    // Просроченное на момент постановки не отправляем, но и не выбрасываем:
    // строка со статусом skipped объясняет владельцу, почему клиент молчал
    const status = dueAt.getTime() < now.getTime() - 60e3 && kind !== 'booking_confirm' ? 'skipped' : 'pending';
    const res = await db.query(
      `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       -- Индекс дедупа частичный (миграция 062), поэтому предикат обязателен:
       -- без него Postgres не понимает, о каком именно ограничении речь
       ON CONFLICT (tenant_id, booking_id, kind) WHERE booking_id IS NOT NULL
       DO UPDATE SET
         due_at = EXCLUDED.due_at,
         status = CASE WHEN client_messages.status = 'sent' THEN 'sent' ELSE EXCLUDED.status END,
         attempts = CASE WHEN client_messages.status = 'sent' THEN client_messages.attempts ELSE 0 END,
         claimed_at = NULL,
         last_error = NULL
       RETURNING id, kind, status`,
      [id('cm'), booking.client_id, booking.id, kind, dueAt.toISOString(), status],
    );
    if (res.rows[0]) rows.push(res.rows[0]);
  }
  return rows;
}

// Бронь перенесли или отменили - неотправленное по старым срокам больше не
// актуально. Отправленное не трогаем: сказанного клиенту не вернуть.
export async function cancelPendingForBooking(bookingId, kinds = null, db = pool) {
  const res = await db.query(
    `UPDATE client_messages SET status = 'cancelled'
      WHERE booking_id = $1 AND status = 'pending'
        ${kinds ? 'AND kind = ANY($2)' : ''}
      RETURNING id`,
    kinds ? [bookingId, kinds] : [bookingId],
  );
  return res.rowCount;
}

// ── Привязка клиента к боту ─────────────────────────────────────────────────
export async function createInvite(clientId, channel = 'telegram') {
  const token = randomBytes(16).toString('base64url'); // 22 символа, влезает в лимит 64 у Telegram
  await pool.query(
    `INSERT INTO client_channel_invites (token, client_id, channel, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)`,
    [token, clientId, channel, String(INVITE_TTL_HOURS)],
  );
  return token;
}

export function inviteLink(botUsername, token) {
  return `https://t.me/${botUsername}?start=${token}`;
}

// Человек открыл бота по ссылке. Токен одноразовый: гасим его в той же
// транзакции, что и привязку, иначе пересланная ссылка привяжет второго.
export async function redeemInvite(token, externalId, channel = 'telegram') {
  const found = await pool.query(
    `UPDATE client_channel_invites SET used_at = now()
      WHERE token = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING client_id`,
    [token, channel],
  );
  const clientId = found.rows[0]?.client_id;
  if (!clientId) return null;
  await pool.query(
    `INSERT INTO client_channels (id, client_id, channel, external_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, client_id, channel)
       DO UPDATE SET external_id = EXCLUDED.external_id, unsubscribed_at = NULL, last_error = NULL`,
    [id('cc'), clientId, channel, String(externalId)],
  );
  await revivePendingAfterLink(clientId);
  return clientId;
}

// Человек привязался ПОЗЖЕ, чем система захотела ему написать - и это не редкий
// случай, а обычный ход событий: администратор создаёт запись, пересылает ссылку,
// человек открывает бота через десять минут. К этому моменту подтверждение уже
// помечено «без канала» и молча похоронено.
//
// Найдено живым прогоном 01.09.2026: Влад нажал «Старт», получил приветствие и не
// получил ничего больше - подтверждение сгорело за пять секунд до его нажатия.
// Поэтому привязка воскрешает то, что ещё имеет смысл сказать.
//
// Условие смысла - визит впереди. Напоминание о вчерашнем приёме не нужно никому,
// а подтверждение будущей записи нужно немедленно, поэтому его срок сдвигается на
// сейчас: человек только что открыл бота и ждёт ответа, а не завтрашнего письма.
export async function revivePendingAfterLink(clientId) {
  const res = await pool.query(
    `UPDATE client_messages m
        SET status = 'pending',
            last_error = NULL,
            attempts = 0,
            claimed_at = NULL,
            due_at = CASE WHEN m.kind = 'booking_confirm' THEN now() ELSE m.due_at END
       FROM bookings b
      WHERE b.id = m.booking_id
        AND m.client_id = $1
        AND m.status = 'skipped'
        AND m.last_error = 'no_channel'
        AND b.status = 'planned'
        -- Время визита хранится без зоны и означает московское, а сессия базы
        -- может жить в любой. Явное AT TIME ZONE убирает разницу в три часа
        AND ((b.date + b.start_time::time) AT TIME ZONE 'Europe/Moscow') > now()
      RETURNING m.id, m.kind`,
    [clientId],
  );
  return res.rows;
}

// ── Отправка ────────────────────────────────────────────────────────────────
// Сколько сообщений одного заведения уходит одновременно и сколько заведений
// обрабатывается разом. Числа не с потолка: замер (tools/bench-2026-09-01-
// messaging-tick.mjs) показал, что тик упирается не в базу - 0.7 мс на сообщение -
// а в ответ Telegram, около 120 мс на каждое. Последовательная отправка съедала
// минуту тика уже на 400 сообщениях.
//
// Потолок сверху ставит сам Telegram: около 30 сообщений в секунду на бота. Восемь
// одновременных при ответе в 120 мс дают примерно 65 в секунду на бота, поэтому
// берём шесть - с запасом под быстрые ответы. Снизу упирается пул соединений к базе
// (DB_POOL_MAX, по умолчанию 10): три заведения по шесть задач это 18 задач, каждая
// со своим коротким запросом, очередь на пуле короткая и живым запросам не мешает.
const MSG_CONCURRENCY = Number(process.env.MESSAGING_CONCURRENCY) || 6;
const TENANT_CONCURRENCY = Number(process.env.MESSAGING_TENANT_CONCURRENCY) || 3;

// Простой пул воркеров: задачи разбираются из общего списка, одновременно работает
// не больше limit. Без внешних зависимостей - их у API нет и не появляется.
async function inParallel(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

// Один шаг очереди для одного арендатора. Возвращает счётчики, а не молчит:
// планировщик без наблюдаемости - это тихо не отправленные напоминания.
export async function tickTenant(tenantId, vertical, now = new Date(), deps = {}) {
  const onlyClient = deps.clientId ?? null;
  const send = deps.sendMessage ?? sendMessage;
  const config = (deps.telegramConfig ?? telegramConfig);
  const stats = { sent: 0, failed: 0, noChannel: 0 };
  const tg = await config(tenantId);

  // Строки, зависшие в «отправляется» после падения процесса, возвращаем в очередь.
  // Пять минут - заведомо больше любой честной отправки и заведомо меньше срока,
  // на котором напоминание теряет смысл
  await pool.query(
    `UPDATE client_messages SET status = 'pending', claimed_at = NULL
      WHERE status = 'sending' AND claimed_at < now() - interval '5 minutes'`,
  );

  // Занимаем строки в самой базе, а не договариваемся об этом в коде. FOR UPDATE
  // SKIP LOCKED означает: каждый тик забирает СВОИ строки и не ждёт чужих. Без
  // этого два тика (или два экземпляра приложения) разбирают одну очередь и
  // человек получает одно подтверждение несколько раз - ровно это и случилось
  // на живом прогоне 01.09.2026, attempts дошёл до 4 на одной строке.
  //
  // Тем же запросом приезжает всё нужное для текста письма: раньше контекст
  // добирался отдельным запросом на каждое сообщение.
  const due = await pool.query(
    `WITH claimed AS (
       UPDATE client_messages
          SET status = 'sending', claimed_at = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM client_messages
           WHERE status = 'pending' AND due_at <= $1
             AND ($2::text IS NULL OR client_id = $2)
           ORDER BY due_at
           LIMIT 500
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, client_id, booking_id, kind, attempts
     )
     SELECT m.id, m.client_id, m.booking_id, m.kind, m.attempts,
            ch.external_id, ch.unsubscribed_at,
            b.date, b.start_time,
            c.name AS client_name, s.name AS master_name,
            sv.name AS service_name, l.name AS place_name
       FROM claimed m
       LEFT JOIN client_channels ch
         ON ch.client_id = m.client_id AND ch.channel = 'telegram'
       LEFT JOIN bookings b ON b.id = m.booking_id
       LEFT JOIN clients c ON c.id = m.client_id
       LEFT JOIN staff s ON s.id = b.master_id
       LEFT JOIN services sv ON sv.id = b.service_id
       LEFT JOIN locations l ON l.id = b.location_id`,
    [now.toISOString(), onlyClient],
  );

  await inParallel(due.rows, MSG_CONCURRENCY, async (row) => {
    // Клиент не привязан или отписался - это не ошибка доставки, а отсутствие
    // канала. Помечаем отдельно: именно эта цифра показывает, работает ли
    // приглашение в бота, и именно она решает судьбу платного SMS-запасника.
    if (!tg || !row.external_id || row.unsubscribed_at) {
      await pool.query(`UPDATE client_messages SET status = 'skipped', claimed_at = NULL, last_error = 'no_channel' WHERE id = $1`, [row.id]);
      stats.noChannel += 1;
      return;
    }
    // Запись исчезла вместе с сообщением о ней - писать не о чем
    if (!row.date) {
      await pool.query(`UPDATE client_messages SET status = 'cancelled', claimed_at = NULL, last_error = 'booking_gone' WHERE id = $1`, [row.id]);
      return;
    }
    const text = messageText(row.kind, {
      vertical,
      clientName: row.client_name,
      masterName: row.master_name ?? '-',
      serviceName: row.service_name,
      placeName: row.place_name ?? '',
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
      startTime: row.start_time,
    });
    const res = await send(tg.token, row.external_id, text, keyboardFor(row.kind, row.booking_id, deps.reviewLinks));

    if (res.ok) {
      await pool.query(`UPDATE client_messages SET status = 'sent', channel = 'telegram', sent_at = now(), claimed_at = NULL WHERE id = $1`, [row.id]);
      stats.sent += 1;
      return;
    }
    // Попытка уже посчитана при захвате строки - здесь только исход
    const dead = res.fatal || !res.retriable || row.attempts >= MAX_ATTEMPTS;
    await pool.query(
      `UPDATE client_messages SET status = $2, claimed_at = NULL, last_error = $3 WHERE id = $1`,
      [row.id, dead ? 'failed' : 'pending', String(res.error).slice(0, 300)],
    );
    // Заблокировал бота - гасим привязку, иначе следующие сообщения будут
    // биться в ту же закрытую дверь и копить ошибки
    if (res.fatal && /403/.test(String(res.error))) {
      await pool.query(`UPDATE client_channels SET unsubscribed_at = now(), last_error = $2 WHERE client_id = $1 AND channel = 'telegram'`, [row.client_id, String(res.error).slice(0, 300)]);
    }
    stats.failed += 1;
  });
  return stats;
}

// Немедленная доставка тому, кто прямо сейчас чего-то ждёт (01.09.2026).
//
// Планировщик тикает раз в минуту, и это правильный интервал для напоминаний за
// сутки. Но человек, который только что открыл бота по ссылке или которому
// администратор только что создал запись, ждёт ответа СЕЙЧАС - минута молчания
// выглядит как поломка. Подсказка «подождите минуту» была бы извинением за
// неудобную архитектуру, а не решением.
//
// Поэтому оба этих события разбирают очередь сразу и только по своему клиенту.
// Ничего нового при этом не отправляется: те же строки очереди, тот же захват,
// та же защита от дублей - просто не ждём следующего тика.
export async function deliverForClient(clientId, vertical, deps = {}) {
  return tickTenant(currentTenantId(), vertical, new Date(), { ...deps, clientId });
}

// То же самое, но не заставляя человека у экрана ждать сеть: администратор,
// создавший запись, должен получить «готово» сразу, а не после разговора с
// Telegram. Ошибка доставки здесь не должна ронять создание записи - сообщение
// в любом случае остаётся в очереди и уйдёт следующим тиком.
export function deliverForClientSoon(tenantId, vertical, clientId) {
  setImmediate(() => {
    runDetached(tenantId, () => tickTenant(tenantId, vertical, new Date(), { clientId }), vertical)
      .catch((err) => console.error('немедленная отправка клиенту не прошла:', err.message));
  });
}

// Тик по всем арендаторам, у кого включён канал. Планировщик один на сервер,
// а контекст арендатора открывается на каждого отдельно - иначе замок базы
// (миграция 058) просто не отдаст строки.
export async function tickAll(now = new Date(), deps = {}) {
  const tenants = await registryQuery(
    `SELECT t.id, t.vertical FROM tenants t
       JOIN tenant_channels tc ON tc.tenant_id = t.id AND tc.channel = 'telegram' AND tc.enabled = true
      WHERE t.status = 'active'`,
  );
  const all = {};
  await inParallel(tenants.rows, TENANT_CONCURRENCY, async (t) => {
    all[t.id] = await runDetached(t.id, () => tickTenant(t.id, t.vertical, now, deps), t.vertical);
  });
  return all;
}

export { dropKeyboard, MAX_ATTEMPTS };
