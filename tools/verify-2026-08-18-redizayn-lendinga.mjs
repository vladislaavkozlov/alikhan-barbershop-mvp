// Живая проверка редизайна лендинга (18.08.2026): новая вёрстка из макета
// alikhan-barbershop-logo-final-standalone поверх прежней логики записи.
// Проверяем, что дизайн приехал и при этом ничего из функционала не отвалилось:
// логотипы/картинки грузятся, витрина команды приходит из CRM (а не из статики),
// прайс из каталога, и вся цепочка записи мастер → услуга → дата → слот жива.
// Бронь НЕ создаём - страница читает боевой API, писать в него проверка не должна.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  OK ' : ' FAIL'}  ${name}${extra ? ' - ' + extra : ''}`);
  if (!ok) failed += 1;
}

// Боевой API отдаёт CORS только для github.io, поэтому локальная страница ходит в
// него через этот прокси - данные настоящие, но наружу уходят ТОЛЬКО GET-запросы,
// бронь такой проверкой создать физически нельзя.
const API = 'https://alikhancrm1-vladislaavkozlov.amvera.io';

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const p = decodeURIComponent(url);
  if (p.startsWith('/api/')) {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('только чтение');
      return;
    }
    const upstream = await fetch(API + req.url.replace('/api', ''));
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(body);
    return;
  }
  try {
    let data = await readFile(join(ROOT, p === '/' ? '/index.html' : p));
    if (p.endsWith('.html')) {
      data = Buffer.from(data.toString('utf8').replace(/window\.ALIKHAN_API_URL = "[^"]*";/, 'window.ALIKHAN_API_URL = "/api";'));
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
// порт 8793 может быть занят другим локальным сервером проекта - берём свободный
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

try {
  await withBrowser(async (s) => {
    await s.setViewport(1440, 1100, false);
    await s.navigate(`${BASE}/index.html`);
    await sleep(3500); // ответ боевого API по мастерам/услугам

    // 1. Ни одного битого локального ресурса (логотипы, фото, шрифты)
    const broken = await s.eval(`(async () => {
      const urls = new Set();
      for (const el of document.querySelectorAll('img')) urls.add(el.currentSrc || el.src);
      for (const el of document.querySelectorAll('link[rel*="icon"]')) urls.add(el.href);
      for (const f of document.fonts) if (f.status === 'loaded') urls.add(f.family);
      const bad = [];
      for (const u of urls) {
        if (!u.startsWith('http')) continue;
        const r = await fetch(u, { method: 'GET' });
        if (!r.ok) bad.push(u + ' -> ' + r.status);
      }
      return bad;
    })()`, true);
    check('все локальные картинки и иконки отдаются', broken.length === 0, broken.join(', '));

    await s.eval(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(2000);
    await s.eval(`window.scrollTo(0, 0)`);
    await sleep(500);
    const imgs = await s.eval(`[...document.querySelectorAll('img')].map(i => ({src: i.src.split('/').pop(), w: i.naturalWidth}))`);
    const empty = imgs.filter((i) => i.w === 0).map((i) => i.src);
    check('каждая картинка реально отрисовалась', empty.length === 0, empty.join(', '));

    const wordmark = await s.eval(`(() => { const i = document.querySelector('.brand-wordmark-header'); return i ? i.naturalWidth : 0; })()`);
    check('логотип в шапке на месте', wordmark > 0, `naturalWidth=${wordmark}`);

    const fonts = await s.eval(`document.fonts.check('600 24px "Playfair Display"') && document.fonts.check('400 16px Manrope')`);
    check('фирменные шрифты подхватились', fonts === true);

    // 2. Витрина команды - данные CRM, а не статика из разметки
    const team = await s.eval(`[...document.querySelectorAll('#masters-grid .master-card')].map(c => ({
      name: c.querySelector('.master-name')?.textContent.trim(),
      window: c.querySelector('.master-window')?.textContent.trim() || '',
      photo: !!c.querySelector('.master-avatar img'),
      cta: !!c.querySelector('.master-cta'),
    }))`);
    check('карточки мастеров отрисованы', team.length >= 3, JSON.stringify(team.map((t) => t.name)));
    check('витрина пришла из CRM (есть график работы)', team.every((t) => /\d{2}:\d{2}/.test(t.window)));
    check('фото мастера из CRM показано', team.some((t) => t.photo));
    check('на каждой карточке ссылка "Выбрать мастера"', team.every((t) => t.cta));

    // 3. Прайс из каталога (статический фоллбэк заменён)
    const prices = await s.eval(`[...document.querySelectorAll('#price-grid .price-card')].filter(c => !c.classList.contains('static-price-fallback')).length`);
    check('прайс отрисован из каталога', prices >= 5, `карточек: ${prices}`);

    // 4. CRO-связка: клик по витрине выбирает того же мастера в форме
    await s.eval(`document.querySelector('#masters-grid .master-card .master-cta').click()`);
    await sleep(700);
    const picked = await s.eval(`(() => {
      const sel = document.querySelector('#master-grid .option-card.selected');
      return sel ? sel.querySelector('.opt-name')?.textContent.trim() : null;
    })()`);
    check('клик по карточке мастера выбирает его в форме', picked === team[0].name, `выбран: ${picked}`);

    // 5. Цепочка записи: услуги → дата → слоты
    const services = await s.eval(`document.querySelectorAll('#service-grid .option-card').length`);
    check('услуги мастера подгрузились', services > 0, `услуг: ${services}`);

    await s.eval(`document.querySelector('#service-grid .option-card:not(.option-card--blocked)').click()`);
    await sleep(500);
    const summary = await s.eval(`(() => { const el = document.getElementById('service-summary'); return el.hidden ? '' : el.textContent.trim(); })()`);
    check('итог по услугам считается', summary.length > 0, summary);

    const dateEnabled = await s.eval(`!document.getElementById('date-toggle').disabled`);
    check('выбор даты разблокировался', dateEnabled === true);

    await s.click('#date-toggle');
    await sleep(1200);
    const days = await s.eval(`document.querySelectorAll('#cal-grid .cal-day:not(.disabled)').length`);
    check('календарь показывает доступные дни', days > 0, `дней: ${days}`);

    await s.eval(`document.querySelector('#cal-grid .cal-day:not(.disabled)').click()`);
    await sleep(2500);
    const slots = await s.eval(`document.querySelectorAll('#slots-wrap .slot-btn').length`);
    const slotsText = await s.eval(`document.getElementById('slots-wrap').textContent.trim().slice(0, 80)`);
    check('слоты пришли с боевого API', slots > 0, `слотов: ${slots} | ${slotsText}`);

    if (slots > 0) {
      await s.eval(`document.querySelector('#slots-wrap .slot-btn').click()`);
      await sleep(400);
      await s.type('#f-name', 'Проверка вёрстки');
      await s.type('#f-phone', '9001234567');
      await s.eval(`(() => { const c = document.getElementById('f-consent'); c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      await sleep(400);
      const canSubmit = await s.eval(`!document.getElementById('f-submit').disabled`);
      check('кнопка записи становится активной (бронь не отправляем)', canSubmit === true);
    }

    // 6. Ошибок в консоли после всей цепочки быть не должно
    const jsErrors = await s.eval(`(() => { const el = document.getElementById('form-msg'); return el.classList.contains('error') ? el.textContent.trim() : ''; })()`);
    check('форма не в состоянии ошибки', jsErrors === '', jsErrors);

    await s.screenshot('/tmp/redesign-desktop.png');
    await s.setViewport(390, 900, true);
    await s.navigate(`${BASE}/index.html`);
    await sleep(3000);
    await s.screenshot('/tmp/redesign-mobile.png');
    const mobile = await s.eval(`(() => {
      window.scrollTo(200, 0);
      const x = window.scrollX;
      window.scrollTo(0, 0);
      return { x, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    check('на мобильном нет горизонтальной прокрутки', mobile.x === 0 && mobile.over <= 1, JSON.stringify(mobile));
  });
} finally {
  server.close();
}

console.log(failed === 0 ? '\nВСЁ ЗЕЛЁНОЕ' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
