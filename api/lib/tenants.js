// Справочник арендаторов и определение «чей это запрос» (Фаза 4 мультиарендности,
// 24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
//
// Почему источник (Origin), а не адрес самого API (Host). Кабинеты арендаторов живут
// на разных доменах, а API у них пока один: у Алихана фронт на GitHub Pages, у
// Карины - поддомен её собственного домена, и оба ходят на alikhancrm1-...amvera.io.
// Host в этих запросах одинаковый, различает арендаторов именно Origin - домен той
// страницы, из которой браузер шлёт запрос.
//
// Запрос без источника (curl, проверки, живые прогоны) опознаётся по Host, и адрес
// API числится за Алиханом - ровно то поведение, что на проде сегодня. Ограничение
// этого решения записано в план: когда таких арендаторов станет больше одного,
// обращаться к API без Origin придётся с явным заголовком.
import { registryQuery } from './db.js';

// Справочник читается на каждый запрос, поэтому найденный арендатор держится в
// памяти минуту. Подключение нового арендатора (строка в справочнике) становится
// видно самое позднее через минуту, перезапуск сервера не нужен. Значение
// настраивается - живым прогонам нужна секунда, а не минута ожидания.
const CACHE_TTL_MS = Number(process.env.TENANT_CACHE_TTL_MS) || 60_000;
const cache = new Map();
// Ключ кэша приходит из заголовка запроса, то есть его выбирает кто угодно снаружи.
// Без потолка поток запросов с разными вымышленными доменами раздул бы эту карту в
// памяти сервера - дешёвый способ его уронить. Потолок мягкий: переполнилась -
// очистили целиком, следующий запрос просто сходит в справочник заново.
const CACHE_MAX_ENTRIES = 500;

// 'https://Klinika.Karina.RU/page.html' → 'klinika.karina.ru'. Порт сохраняется:
// на нём живут локальные репетиции, и без него они склеились бы в один домен.
export function normalizeDomain(value) {
  if (!value || typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw || raw === 'null' || raw === 'undefined') return null;
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  raw = raw.split('/')[0].split('?')[0];
  raw = raw.replace(/\.$/, '').toLowerCase();
  return raw || null;
}

export function requestDomain(req) {
  return normalizeDomain(req?.headers?.origin) ?? normalizeDomain(req?.headers?.host);
}

// Ловушка 7 спеки: список разрешённых источников больше не одна переменная
// окружения, а домены самого арендатора. Чужой источник разрешения не получает.
export function corsOriginFor(tenant, originHeader) {
  const origin = normalizeDomain(originHeader);
  if (!tenant || !origin) return null;
  if (!tenant.domains?.includes(origin)) return null;
  return String(originHeader).replace(/\/+$/, '');
}

// Справочник - единственная таблица без замка (см. миграцию 058): его читают ДО
// того, как арендатор известен, иначе определить его было бы нечем. Клиентских
// данных в нём нет.
export async function findTenantByDomain(domain) {
  if (!domain) return null;
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tenant;
  const res = await registryQuery(
    `SELECT id, name, vertical, status, domains FROM tenants
      WHERE status = 'active' AND $1 = ANY(domains) LIMIT 1`,
    [domain]
  );
  const tenant = res.rows[0] ?? null;
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(domain, { tenant, at: Date.now() });
  return tenant;
}

export async function resolveTenantForRequest(req) {
  return findTenantByDomain(requestDomain(req));
}

// Новый арендатор подключается строкой в справочнике - ждать минуту до конца жизни
// кэша незачем, поэтому сброс вынесен наружу (им же пользуются живые прогоны).
export function clearTenantCache() {
  cache.clear();
}
