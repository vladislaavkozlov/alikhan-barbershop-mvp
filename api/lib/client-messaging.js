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
import { renewOutreachFor } from './renew.js';
import { notifyStaff } from './notify-core.js';

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

// Дата без времени: «8 августа». Письмам про возврат час прошлого визита не нужен -
// человек помнит, что был, а не во сколько
export function humanDate(value) {
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${d} ${months[m - 1]}`;
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
    // Письмо после неявки (04.09.2026). Ни упрёка, ни счёта за пропущенное время:
    // задача не пристыдить, а вернуть человека в расписание. Продукт обещает
    // «показывает потерю и называет, что делать» - вот здесь он это и делает
    case 'no_show_followup':
      return `${ctx.clientName}, вы не смогли прийти <b>${when}</b>\n\nБывает. Подобрать вам новое время?`;
    // Письма про возврат (05.09.2026, миграция 070). Повода-брони у них нет, есть
    // человек и его срок, поэтому и «когда» здесь - дата прошлого визита.
    //
    // Тон выбран по тому же правилу, что и после неявки: ни упрёка, ни счёта. «Пора»
    // - это забота, «вы давно не были» - приглашение, и ни то ни другое не должно
    // читаться как претензия к человеку за то, что он не пришёл
    case 'renew_due':
      return `${ctx.clientName}, вы были у нас <b>${ctx.lastVisitHuman}</b>\n\nПо срокам как раз пора. Подобрать вам время?`;
    case 'renew_overdue':
      return `${ctx.clientName}, вы давно у нас не были - с <b>${ctx.lastVisitHuman}</b>\n\nБудем рады видеть снова. Подобрать вам время?`;
    default:
      throw new Error(`unknown_kind_${kind}`);
  }
}

// id - бронь для писем по визиту и клиент для писем про возврат. Одно поле, потому
// что callback_data везде «два символа : id», и разбор на той стороне один
function keyboardFor(kind, id, links) {
  if (kind === 'booking_confirm' || kind === 'reminder_24h' || kind === 'reminder_2h') {
    return buttons([
      [{ text: '✅ Приду', data: `ok:${id}` }],
      [{ text: '🕗 Перенести', data: `mv:${id}` }, { text: '✖️ Отменить', data: `no:${id}` }],
    ]);
  }
  // Ответ на письмо после неявки - это и есть очередь на прозвон: нажал «да» -
  // попал в список владельца подсвеченным, и звонит ему уже живой человек. Бот сам
  // время не подбирает по той же причине, что не переносит и не отменяет: за
  // расписанием стоит администратор
  if (kind === 'no_show_followup') {
    return buttons([
      [{ text: '📅 Да, подберите время', data: `rb:${id}` }],
      [{ text: 'Пока не планирую', data: `rn:${id}` }],
    ]);
  }
  // Ответ на письмо про возврат - такая же очередь на прозвон, как после неявки, но
  // глаголы другие: в callback_data лежит id КЛИЕНТА, а не брони, и путать их нельзя
  // ни на йоту - по этому id бот решает, чью карточку трогать
  if (kind === 'renew_due' || kind === 'renew_overdue') {
    return buttons([
      // «Записаться», а не «подберите время» (поправка Влада 05.09.2026): человек
      // идёт на форму и выбирает время сам, администратор в этой цепочке не стоит
      [{ text: '📅 Записаться', data: `vb:${id}` }],
      [{ text: 'Пока не планирую', data: `vn:${id}` }],
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

// Письмо после неявки ставится отдельно от plannedMessages: те четыре сообщения
// живут по времени визита и ставятся при создании брони, а это - следствие события,
// которого могло и не случиться. Срок «сейчас»: администратор отмечает неявку в тот
// же день, и разговор про пропущенный сегодня приём человек ещё помнит.
//
// Идемпотентность даёт тот же уникальный индекс (одна бронь - одно письмо каждого
// вида): повторный клик по «Клиент не пришёл» вторым письмом не обернётся. Уже
// отправленное не воскресает - сказанное сказано.
export async function enqueueNoShowFollowup(booking, now = new Date(), db = pool) {
  if (!booking?.client_id) return null; // бронь без клиента - писать некому
  const res = await db.query(
    `INSERT INTO client_messages (id, client_id, booking_id, kind, due_at, status)
     VALUES ($1, $2, $3, 'no_show_followup', $4, 'pending')
     ON CONFLICT (tenant_id, booking_id, kind) WHERE booking_id IS NOT NULL
     DO UPDATE SET
       due_at = EXCLUDED.due_at,
       status = CASE WHEN client_messages.status = 'sent' THEN 'sent' ELSE 'pending' END,
       attempts = CASE WHEN client_messages.status = 'sent' THEN client_messages.attempts ELSE 0 END,
       claimed_at = NULL,
       last_error = NULL
     RETURNING id, kind, status`,
    [id('cm'), booking.client_id, booking.id, now.toISOString()],
  );
  return res.rows[0] ?? null;
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

// ── Сканер возврата ─────────────────────────────────────────────────────────
// 05.09.2026, решение Влада: «клиент получал сообщение в тг, а админ получал заявку
// на прозвон» - и то же самое по остальным причинам потери, не только по неявке.
//
// Почему сканер, а не постановка по событию. У неявки есть событие - администратор
// отметил «не пришёл». У невозврата события нет вовсе: ничего не происходит, в этом
// и беда. Единственный способ его заметить - каждый день смотреть, у кого сегодня
// наступил или пропущен срок.
//
// Кого пропускаем и почему - это половина всей осторожности механизма:
//   нет привязки к боту или отписался - писать нечем, и очередь не надо забивать;
//   есть будущая запись            - человек уже записан, «пора к нам» выглядело бы
//                                    так, будто система его не видит;
//   ответил «пока не планирую»     - его отказ уважаем до следующего визита, иначе
//                                    вежливый вопрос превращается в преследование;
//   больше двух циклов молчания    - это уже не возврат, а реактивация базы, и
//                                    решать её должен владелец, а не фоновый тик.
const OUTREACH_DAILY_LIMIT = 50;

export async function scanRenewOutreach(now = new Date(), db = pool) {
  const today = now.toISOString().slice(0, 10);

  // Предохранитель на первое включение механизма. На живой базе в окно поводов
  // разом попадёт столько людей, сколько накопилось, и без потолка система
  // разошлёт сотни писем за один тик - по всем правилам, но одномоментно.
  // Полсотни в сутки на заведение - это заметно больше, чем реальный поток
  // возвратов у кабинета, и заведомо меньше, чем выглядит рассылкой
  const sentToday = await db.query(
    `SELECT count(*)::int AS n FROM client_messages
      WHERE kind IN ('renew_due', 'renew_overdue') AND created_at::date = $1::date`,
    [today],
  );
  const room = OUTREACH_DAILY_LIMIT - (sentToday.rows[0]?.n ?? 0);
  if (room <= 0) return { queued: 0, skippedByLimit: true };

  // Кандидаты: у кого есть состоявшиеся визиты, канал и нет будущей записи.
  // Арифметику «пора или нет» здесь не считаем - её считает renewOutreachFor,
  // покрытая офлайн-тестами. SQL достаёт сырьё, решения принимаются в коде: тот
  // же порядок, что у всей недополученной выручки
  const candidates = await db.query(
    `SELECT c.id, c.renew_days, c.renew_reply, c.renew_reply_at,
            max(b.date) AS last_date
       FROM clients c
       JOIN client_channels ch
         ON ch.client_id = c.id AND ch.channel = 'telegram' AND ch.unsubscribed_at IS NULL
       JOIN bookings b ON b.client_id = c.id AND b.status = 'done'
      WHERE NOT EXISTS (
              SELECT 1 FROM bookings fb
               WHERE fb.client_id = c.id AND fb.status = 'planned' AND fb.date >= $1::date
            )
      GROUP BY c.id, c.renew_days, c.renew_reply, c.renew_reply_at
      LIMIT 2000`,
    [today],
  );

  let queued = 0;
  for (const row of candidates.rows) {
    if (queued >= room) break;
    const lastDate = row.last_date instanceof Date ? row.last_date.toISOString().slice(0, 10) : String(row.last_date);

    // Отказ живёт до следующего визита: человек сказал «пока не планирую» - значит
    // до тех пор, пока он снова не придёт, эта тема закрыта
    if (row.renew_reply === 'not_now' && row.renew_reply_at && new Date(row.renew_reply_at) > new Date(`${lastDate}T00:00:00Z`)) continue;

    const reason = renewOutreachFor({ lastVisitDate: lastDate, renewDays: row.renew_days, todayDate: today });
    if (!reason) continue;

    const res = await db.query(
      `INSERT INTO client_messages (id, client_id, booking_id, kind, cycle_key, due_at, status)
       VALUES ($1, $2, NULL, $3, $4, $5, 'pending')
       -- Ключ цикла и есть защита от повтора (миграция 070): один наступивший срок -
       -- одно письмо, сколько бы раз ни отработал сканер
       ON CONFLICT (tenant_id, client_id, kind, cycle_key) WHERE booking_id IS NULL AND cycle_key IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [id('cm'), row.id, reason.kind, reason.cycleKey, now.toISOString()],
    );
    if (res.rowCount) {
      queued += 1;
      // Дата разговора нужна списку владельца: он должен отличать того, кому ещё
      // никто ничего не сказал, от того, кому написали и кто молчит
      await db.query('UPDATE clients SET renew_outreach_at = now() WHERE id = $1', [row.id]);
    }
  }
  return { queued, skippedByLimit: false };
}


// ── Заявка на прозвон: только тем, кто согласился и не записался ─────────────
// Поправка Влада 05.09.2026: «тот, кто согласен записаться - идёт и записывается на
// сайте по ссылке сам. А вот если уже он не записался, но хотел - тогда заявка на
// прозвон».
//
// Это меняет смысл заявки целиком. Она перестаёт быть уведомлением о согласии и
// становится тем, чем должна быть: списком людей, которые хотели прийти и не дошли.
// Звонить есть о чём только им - остальные уже в расписании.
//
// Сутки, а не час и не неделя: час - это ещё «пошёл выбирать время», неделя - уже
// «забыл, что собирался». Порог один на обе причины, потому что человеку всё равно,
// по какой из них его потеряли.
const CALL_AFTER_HOURS = 24;

export async function requestCallsForUnbooked(now = new Date(), db = pool) {
  const cutoff = new Date(now.getTime() - CALL_AFTER_HOURS * 3600e3).toISOString();

  // Кому звонить по возврату: сказал «да» больше суток назад, заявки по нему ещё не
  // было, и с момента ответа не появилось ни одной запланированной записи
  const renew = await db.query(
    `SELECT c.id, c.name, c.phone
       FROM clients c
      WHERE c.renew_reply = 'wants_time'
        AND c.renew_reply_at < $1
        AND c.renew_call_requested_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.client_id = c.id AND b.status = 'planned' AND b.created_at > c.renew_reply_at
        )`,
    [cutoff],
  );

  // То же по неявке. У неё та же дыра была с 04.09: если у заведения есть форма
  // записи, заявка не создавалась вовсе, и человек, ответивший «да» и не дошедший,
  // молча терялся - при том что именно он и есть самый горячий повод для звонка
  const noshow = await db.query(
    `SELECT b.id AS booking_id, b.client_id, c.name, c.phone
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE b.noshow_reply = 'wants_time'
        AND b.noshow_reply_at < $1
        AND b.noshow_call_requested_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM bookings nb
           WHERE nb.client_id = b.client_id AND nb.status = 'planned' AND nb.created_at > b.noshow_reply_at
        )`,
    [cutoff],
  );

  if (renew.rowCount === 0 && noshow.rowCount === 0) return { calls: 0 };

  const staff = await db.query(
    `SELECT id FROM staff
      WHERE employed = true AND has_system_access = true AND role IN ('owner', 'manager', 'admin')`,
  );
  const recipients = staff.rows.map((r) => r.id);
  let calls = 0;

  const client = await pool.connect();
  try {
    for (const row of renew.rows) {
      for (const staffId of recipients) {
        await notifyStaff(client, staffId, 'client_wants_return', {
          clientId: row.id,
          title: 'Хотел записаться и не записался',
          body: `${row.name || 'Клиент'}${row.phone ? ` · ${row.phone}` : ''} · сказал «да» вчера`,
        });
      }
      await db.query('UPDATE clients SET renew_call_requested_at = now() WHERE id = $1', [row.id]);
      calls += 1;
    }
    for (const row of noshow.rows) {
      for (const staffId of recipients) {
        await notifyStaff(client, staffId, 'client_wants_return', {
          clientId: row.client_id,
          title: 'Не пришёл, просил время и не записался',
          body: `${row.name || 'Клиент'}${row.phone ? ` · ${row.phone}` : ''} · сказал «да» вчера`,
        });
      }
      await db.query('UPDATE bookings SET noshow_call_requested_at = now() WHERE id = $1', [row.booking_id]);
      calls += 1;
    }
  } finally {
    client.release();
  }
  return { calls };
}

// планировщик без наблюдаемости - это тихо не отправленные напоминания.
export async function tickTenant(tenantId, vertical, now = new Date(), deps = {}) {
  const onlyClient = deps.clientId ?? null;
  const send = deps.sendMessage ?? sendMessage;
  const config = (deps.telegramConfig ?? telegramConfig);
  const stats = { sent: 0, failed: 0, noChannel: 0 };
  const tg = await config(tenantId);

  // Сканер возврата идёт перед разбором очереди и только в общем тике: у адресной
  // доставки (открыл бота, администратор создал запись) свой узкий смысл, и
  // проходить ради неё по всей базе клиентов незачем
  if (!onlyClient && tg) {
    try {
      await scanRenewOutreach(now);
      // Заявки на прозвон тем, кто согласился и за сутки не записался. Здесь же,
      // потому что это часть того же разговора, а не отдельная фоновая работа
      await requestCallsForUnbooked(now);
    } catch (err) {
      // Сбой сканера не должен ронять доставку уже поставленных сообщений: человек,
      // ждущий подтверждение записи, не виноват в том, что не собрался список возврата
      console.error('сканер возврата не отработал:', err.message);
    }
  }

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
            sv.name AS service_name, l.name AS place_name, lv.last_date
       FROM claimed m
       LEFT JOIN client_channels ch
         ON ch.client_id = m.client_id AND ch.channel = 'telegram'
       LEFT JOIN bookings b ON b.id = m.booking_id
       LEFT JOIN clients c ON c.id = m.client_id
       -- Письма про возврат (миграция 070) живут без брони: «когда» в их тексте -
       -- это дата последнего состоявшегося визита, и взять её больше неоткуда.
       -- LATERAL считается только для таких строк, у писем по визиту условие ложно
       LEFT JOIN LATERAL (
         SELECT max(bb.date) AS last_date FROM bookings bb
          WHERE bb.client_id = m.client_id AND bb.status = 'done'
       ) lv ON m.booking_id IS NULL
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
    // Запись исчезла вместе с сообщением о ней - писать не о чем.
    // Проверка только для писем по визиту: у писем про возврат брони нет по
    // устройству, и общее условие отменяло бы их все (миграция 070)
    if (row.booking_id && !row.date) {
      await pool.query(`UPDATE client_messages SET status = 'cancelled', claimed_at = NULL, last_error = 'booking_gone' WHERE id = $1`, [row.id]);
      return;
    }
    // Зеркальный случай: письмо про возврат человеку, у которого не осталось ни
    // одного состоявшегося визита. Такое бывает после чистки истории - говорить
    // «вы были у нас» тому, кто у нас не был, нельзя
    if (!row.booking_id && !row.last_date) {
      await pool.query(`UPDATE client_messages SET status = 'cancelled', claimed_at = NULL, last_error = 'no_visits' WHERE id = $1`, [row.id]);
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
      lastVisitHuman: row.last_date ? humanDate(row.last_date) : null,
    });
    // id в кнопках: бронь для писем по визиту, клиент для писем про возврат
    const res = await send(tg.token, row.external_id, text, keyboardFor(row.kind, row.booking_id ?? row.client_id, deps.reviewLinks));

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
