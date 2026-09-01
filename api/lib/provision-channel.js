// Подключение бота арендатора при старте приложения (Волна 1, 01.09.2026).
//
// Тот же механизм и та же причина, что у provision-tenant.js: база Amvera живёт во
// внутренней сети, psql снаружи не дотянется, а роут «заведите бота с этим токеном»
// заводить нельзя - за такой дверью выдаётся право писать всем клиентам заведения
// от его имени. Остаётся переменная в панели плюс перезапуск.
//
// Арендатор задаётся ДОМЕНОМ, а не номером: номер надо где-то подсмотреть и легко
// перепутать, а домен заведения человек знает точно. Ошибка в домене - отказ с
// понятной строкой в логе, а не молча включённый бот у соседа.
//
// Функция не бросает никогда. Опечатка в переменной, относящейся к одному клиенту,
// не должна ронять сервер, обслуживающий остальных.
import { randomBytes } from 'node:crypto';
import { pool, runInTenant, registryQuery } from './db.js';
import { normalizeDomain, clearTenantCache } from './tenants.js';
import { setWebhook, getMe } from './channel-telegram.js';

const ALLOWED_KEYS = ['domain', 'channel', 'token', 'enabled', 'webhookBase'];

// Спецификаций может быть несколько: одна перестановка бота с заведения на
// заведение это две операции - выключить там, включить здесь. Разбивать их на два
// перезапуска боевого сервера ради формы записи неправильно.
function parseAll(raw) {
  let text = String(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) text = Buffer.from(text, 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(validate);
}

function parseSpec(raw) {
  let text = String(raw).trim();
  // Переменную удобнее вставлять в панель одной строкой без кавычек и переносов,
  // поэтому принимается и base64 - тот же приём, что у NEW_TENANT_B64
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
  return validate(JSON.parse(text));
}

function validate(spec) {
  for (const key of Object.keys(spec)) {
    if (!ALLOWED_KEYS.includes(key)) throw new Error(`незнакомый ключ «${key}». Ожидались: ${ALLOWED_KEYS.join(', ')}`);
  }
  if (!spec.domain) throw new Error('нужен domain заведения');
  if (spec.channel && spec.channel !== 'telegram') throw new Error('пока поддержан только channel: telegram');
  // Токен нужен, чтобы бота ВКЛЮЧИТЬ. Чтобы выключить - не нужен: отзыв доступа не
  // должен требовать самого доступа, иначе выключить чужого бота нечем
  if (spec.enabled !== false && !spec.token) throw new Error('нужен token бота');
  return spec;
}

export async function provisionChannelFromEnv(env = process.env) {
  const raw = env.BOT_CHANNEL ?? env.BOT_CHANNEL_B64;
  if (!raw) return null;
  let list;
  try {
    list = parseAll(raw);
  } catch (err) {
    console.error('BOT_CHANNEL: подключение бота не выполнено -', err.message);
    return null;
  }
  const done = [];
  for (const spec of list) {
    const result = await applyOne(spec, env);
    if (result) done.push(result);
  }
  return done.length ? done : null;
}

async function applyOne(spec, env) {
  try {
    const domain = normalizeDomain(spec.domain);
    const found = await registryQuery(
      `SELECT id, name FROM tenants WHERE $1 = ANY(domains) AND status = 'active'`,
      [domain],
    );
    const tenant = found.rows[0];
    if (!tenant) throw new Error(`заведение с доменом «${spec.domain}» не найдено`);

    // Выключение - самый короткий путь: ни Telegram, ни токен для него не нужны
    if (spec.enabled === false) {
      await runInTenant(tenant.id, () => pool.query(
        `UPDATE tenant_channels SET enabled = false WHERE tenant_id = $1 AND channel = 'telegram'`,
        [tenant.id],
      ));
      clearTenantCache();
      console.log(`BOT_CHANNEL: бот выключен у «${tenant.name}»`);
      return { tenantId: tenant.id, enabled: false };
    }

    // Имя бота спрашиваем у самого Telegram: ссылка-приглашение собирается из него,
    // и опечатка в руках человека превратилась бы в ссылку в никуда
    const me = await getMe(spec.token);
    if (!me.ok) throw new Error(`Telegram не признал токен: ${me.error}`);
    const username = me.result.username;

    // Секрет адреса webhook рождается здесь и живёт в базе. Повторный запуск с той
    // же переменной секрет НЕ меняет: иначе каждый перезапуск ронял бы уже
    // настроенный webhook и бот замолкал до следующей ручной настройки
    const existing = await registryQuery(
      `SELECT webhook_secret FROM tenant_channels WHERE tenant_id = $1 AND channel = 'telegram'`,
      [tenant.id],
    );
    const secret = existing.rows[0]?.webhook_secret ?? randomBytes(24).toString('base64url');
    const enabled = true;

    await runInTenant(tenant.id, () => pool.query(
      `INSERT INTO tenant_channels (tenant_id, channel, bot_token, bot_username, webhook_secret, enabled)
       VALUES ($1, 'telegram', $2, $3, $4, $5)
       ON CONFLICT (tenant_id, channel)
         DO UPDATE SET bot_token = EXCLUDED.bot_token, bot_username = EXCLUDED.bot_username,
                       webhook_secret = EXCLUDED.webhook_secret, enabled = EXCLUDED.enabled`,
      [tenant.id, spec.token, username, secret, enabled],
    ));
    clearTenantCache();

    // Адрес, на который Telegram будет присылать обновления. База берётся из
    // переменной или из адреса самого сервиса - подставлять домен кабинета нельзя,
    // это статика, обработчика там нет
    const base = (spec.webhookBase ?? env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
    if (!base) {
      console.log(`BOT_CHANNEL: бот @${username} привязан к «${tenant.name}», но webhookBase не задан - webhook не установлен`);
      return { tenantId: tenant.id, username, webhookSet: false };
    }
    const hook = await setWebhook(spec.token, `${base}/tg/${secret}`, secret);
    if (!hook.ok) throw new Error(`webhook не установлен: ${hook.error}`);
    // Секрет в лог не печатаем: по нему принимаются входящие обновления
    console.log(`BOT_CHANNEL: бот @${username} подключён к «${tenant.name}», webhook установлен`);
    return { tenantId: tenant.id, username, webhookSet: true };
  } catch (err) {
    console.error('BOT_CHANNEL: подключение бота не выполнено -', err.message);
    return null;
  }
}
