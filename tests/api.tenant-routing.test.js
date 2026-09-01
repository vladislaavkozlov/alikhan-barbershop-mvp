// Фаза 4 мультиарендности (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
// Арендатор определяется по домену запроса: до маршрутизации, до любого обработчика.
// Неизвестный домен получает 404, а не данные Алихана (критерий 4 спеки).
//
// Здесь - чистые функции разбора домена и контракт обвязки сервера. Живой прогон
// (два арендатора на разных доменах, все роли, вход по одинаковой почте) -
// tools/verify-2026-08-24-tenant-routing.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { normalizeDomain, requestDomain, corsOriginFor } from '../api/lib/tenants.js';

test('домен вычищается до имени хоста - схема, путь и регистр не мешают совпадению', () => {
  assert.equal(normalizeDomain('https://vladislaavkozlov.github.io'), 'vladislaavkozlov.github.io');
  assert.equal(normalizeDomain('https://VladislaavKozlov.GitHub.io/alikhan/crm.html'), 'vladislaavkozlov.github.io');
  assert.equal(normalizeDomain('http://127.0.0.1:8791'), '127.0.0.1:8791', 'порт значим - на нём живут репетиции');
  assert.equal(normalizeDomain('klinika.karina.ru'), 'klinika.karina.ru');
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain(undefined), null);
  assert.equal(normalizeDomain('null'), null, 'браузер шлёт строку null для запросов без источника');
});

test('различает арендаторов источник запроса, а не адрес самого API', () => {
  // Кабинеты живут на разных доменах, а API у них пока один. Host одинаковый у всех,
  // поэтому первым спрашивается Origin - именно он говорит, чей это кабинет.
  const req = (headers) => ({ headers });
  assert.equal(
    requestDomain(req({ origin: 'https://klinika.karina.ru', host: 'alikhancrm1-vladislaavkozlov.amvera.io' })),
    'klinika.karina.ru'
  );
  assert.equal(
    requestDomain(req({ host: 'alikhancrm1-vladislaavkozlov.amvera.io' })),
    'alikhancrm1-vladislaavkozlov.amvera.io',
    'без источника остаётся адрес API - так ходят проверки и curl'
  );
  assert.equal(requestDomain(req({ origin: 'null', host: 'api.local' })), 'api.local');
  assert.equal(requestDomain(req({})), null);
});

test('CORS разрешает источник арендатора, а не один домен из переменной окружения', () => {
  const tenant = { id: 2, domains: ['klinika.karina.ru', 'www.karina.ru'] };
  assert.equal(corsOriginFor(tenant, 'https://klinika.karina.ru'), 'https://klinika.karina.ru');
  assert.equal(corsOriginFor(tenant, 'https://www.karina.ru'), 'https://www.karina.ru');
  assert.equal(
    corsOriginFor(tenant, 'https://vladislaavkozlov.github.io'),
    null,
    'чужой источник не получает разрешения - иначе кабинет Алихана смог бы читать API Карины'
  );
  assert.equal(corsOriginFor(tenant, undefined), null);
  assert.equal(corsOriginFor(null, 'https://klinika.karina.ru'), null);
});

test('аварийная ручка выключена по умолчанию и включается без деплоя', async () => {
  const src = await readFile(new URL('../api/lib/tenants.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.TENANT_FALLBACK_ID \? Number\(process\.env\.TENANT_FALLBACK_ID\) : null/);
  // Без переменной окружения поведение строгое: неизвестный домен - это 404
  assert.match(src, /if \(found \|\| !FALLBACK_TENANT_ID\) return found;/);
  assert.equal(process.env.TENANT_FALLBACK_ID, undefined, 'в тестах ручка не должна быть включена');
});

const serverSource = await readFile(new URL('../api/server.mjs', import.meta.url), 'utf8');

test('арендатор определяется до маршрутизации, неизвестный домен получает 404', () => {
  // Ключ заведения (миграция 067) добавил второй путь резолва - для сайтов на общем
  // домене. Домен остаётся основным: ключ только предшествует ему и только на
  // публичных путях, поэтому проверяем оба выражения и их порядок
  assert.match(serverSource, /await resolveTenantForRequest\(req\)/);
  assert.match(serverSource, /findTenantByPublicKey\(publicKey, requestDomain\(req\)\)/);
  assert.match(serverSource, /PUBLIC_WIDGET_ROUTES\.has\(parts\[0\]\)/, 'ключ действует не на всех путях');
  assert.match(serverSource, /sendJson\(res, 404, \{ error: 'unknown_tenant' \}\)/);
  const resolveAt = serverSource.indexOf('resolveTenantForRequest(req)');
  const matchAt = serverSource.indexOf('matchRoute(req.method, parts)');
  assert.ok(resolveAt < matchAt, 'домен разбирается раньше, чем ищется роут');
  assert.match(serverSource, /runInTenant\(tenant\.id,/, 'запрос идёт от имени найденного арендатора');
  assert.match(serverSource, /runDetached\(tenant\.id,/, 'долгий ответ - тоже от его имени');
  assert.doesNotMatch(
    serverSource,
    /runRequest\(resolveTenantId\(req\)/,
    'заглушка Фазы 1 «всегда арендатор 1» должна быть снята'
  );
});

test('проверка живости отвечает и без арендатора - иначе Amvera сочтёт сервис мёртвым', () => {
  const healthAt = serverSource.indexOf("url.pathname === '/health'");
  const resolveAt = serverSource.indexOf('resolveTenantForRequest(req)');
  assert.ok(healthAt > 0 && healthAt < resolveAt, '/health обрабатывается до разбора домена');
});

test('CORS ставится по арендатору, а не по одной переменной окружения (ловушка 7)', () => {
  assert.match(serverSource, /corsOriginFor\(tenant, req\.headers\.origin\)/);
  const httpSource = readFileSync(new URL('../api/lib/http.js', import.meta.url), 'utf8');
  assert.match(httpSource, /export function setCors\(res, allowedOrigin\)/);
  assert.doesNotMatch(
    httpSource,
    /const ALLOWED_ORIGIN = process\.env\.ALLOWED_ORIGIN/,
    'один домен из окружения больше не источник истины - список берётся из справочника'
  );
});

test('ключ заведения открывает только публичные пути, и только со своего сайта', async () => {
  // Сито от расширения: ключ - это способ различить сайты на общем домене
  // GitHub Pages, а не универсальная отмычка. Список путей закрытый, и кабинетных
  // среди них быть не должно
  const list = serverSource.match(/const PUBLIC_WIDGET_ROUTES = new Set\(\[([^\]]*)\]/s)?.[1] ?? '';
  for (const forbidden of ['staff', 'payroll', 'clients', 'analytics', 'finance', 'backup', 'auth', 'notifications']) {
    assert.doesNotMatch(list, new RegExp(`'${forbidden}'`), `ключом открывается «${forbidden}» - это путь за логином`);
  }
  // Каждый путь, которым пользуется форма записи, обязан быть в списке. Забытый
  // путь не ломает сборку - он тихо уходит к соседнему заведению и отвечает
  // «нет такой услуги» (поймано живым прогоном 01.09.2026 на /free-slots)
  for (const needed of ['public', 'free-slots', 'bookings', 'tenant']) {
    assert.match(list, new RegExp(`'${needed}'`), `форма записи ходит в «${needed}», а ключ там не действует`);
  }
  const sql = await readFile(new URL('../api/migrations/067_tenant_public_key.sql', import.meta.url), 'utf8');
  assert.match(sql, /widget_origins/, 'ключ без списка разрешённых сайтов работал бы с любого адреса');
  const src = await readFile(new URL('../api/lib/tenants.js', import.meta.url), 'utf8');
  assert.match(src, /public_key = \$1 AND \$2 = ANY\(widget_origins\)/, 'ключ обязан проверяться вместе с источником');
});

test('домены Алихана прописаны миграцией - иначе прод получит 404 на первом же запросе', async () => {
  const sql = await readFile(new URL('../api/migrations/059_tenant_domains.sql', import.meta.url), 'utf8');
  assert.match(sql, /vladislaavkozlov\.github\.io/, 'домен кабинетов Алихана');
  assert.match(sql, /alikhancrm1-vladislaavkozlov\.amvera\.io/, 'домен самого API');
  assert.match(sql, /UPDATE tenants/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /INSERT INTO (?!tenants)/i);
});
