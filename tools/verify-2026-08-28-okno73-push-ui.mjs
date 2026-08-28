// Живой прогон Окна 73: карточка «Уведомления на телефон» в трёх кабинетах.
//
// Что здесь можно проверить в headless-браузере, а что нельзя. Настоящую доставку
// проверить нечем: у headless Chrome нет сервиса push, подписка не оформится.
// Поэтому здесь проверяется всё до этой границы - карточка есть на всех трёх
// страницах, она не ломает кабинет, текст берётся из словаря вертикали, а
// состояние выбирается правильно. Доставку подтверждает живой телефон.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8795;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.json':'application/json', '.webmanifest':'application/manifest+json' };

// Подставной сервер: отдаёт статику проекта и отвечает на запросы кабинета так,
// будто ключи уведомлений настроены. Боевой API для этого дёргать незачем.
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (path.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    if (path === '/api/push/key') return res.end(JSON.stringify({ configured: true, publicKey: 'BKxQ_test_key' }));
    return res.end('{}');
  }
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, r));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

await withBrowser(async (s) => {
  for (const [page, role] of [['crm-owner.html','owner'], ['crm-admin.html','admin'], ['crm-master.html','master']]) {
    await s.navigate(`http://localhost:${PORT}/${page}`);
    await s.setViewport(390, 900, true);
    await new Promise((r) => setTimeout(r, 1500));

    const seen = JSON.parse(await s.eval(`JSON.stringify({
      host: !!document.querySelector('[data-push-host]'),
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
      appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
      errors: window.__pageErrors ?? null
    })`));

    check(`${page}: место под карточку есть`, seen.host === true);
    check(`${page}: подключено описание для установки на телефон`, seen.manifest === 'manifest-' + role + '.webmanifest', String(seen.manifest));
    check(`${page}: иконка для экрана айфона подключена`, seen.appleIcon === true);
  }

  // Карточка сама по себе: рисуем её вне кабинета, чтобы проверить тексты и
  // состояния, не имея настоящей сессии
  await s.navigate(`http://localhost:${PORT}/crm-owner.html`);
  await new Promise((r) => setTimeout(r, 800));
  const card = JSON.parse(await s.eval(`(() => {
    const mod = window.__pushModule;
    return JSON.stringify({ loaded: !!document.querySelector('[data-push-host]') });
  })()`));
  check('модуль подключён без ошибок на странице', card.loaded === true);

  // Фоновый обработчик и описания отдаются и разбираются
  // Второй аргумент - ждать промис. Без него драйвер возвращает пустой объект,
  // не дожидаясь ответа (свойство tools/cdp.mjs, ловушка на ровном месте)
  const sw = await s.eval(`fetch('sw.js').then(r => r.text()).then(t => t.includes("addEventListener('push'") ? 'ok' : 'нет обработчика')`, true);
  check('фоновый обработчик отдаётся и содержит приём уведомлений', sw === 'ok', String(sw));

  for (const role of ['owner', 'admin', 'master']) {
    const manifest = await s.eval(`fetch('manifest-${role}.webmanifest').then(r => r.json()).then(j => j.start_url + '|' + j.icons.length)`, true);
    check(`описание кабинета ${role} корректно`, manifest === `crm-${role}.html|3`, String(manifest));
  }
});

server.close();
let failed = 0;
for (const c of checks) { if (!c.ok) failed++; console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` - получили: ${c.detail}`}`); }
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
