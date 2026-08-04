// Проверка правок ТЗ-готовность-к-продакшену-2026-08-01.md: Блок Б (баги) + Блок В
// (продажа/ЗП по периодам/birthday). Бэкенда Amvera нет в песочнице - window.fetch
// подменяется фейковым ответом ДО загрузки страницы (Page.addScriptToEvaluateOnNewDocument),
// чтобы реальные ES-модули (crm-auth.js) отработали как в проде, просто на фикстурах.
// Каждая страница - отдельный withBrowser (свежий Chrome): повторный Page.navigate в
// одной CDP-сессии ПОСЛЕ логина (async fetch + module) стабильно зависает на старом
// document (воспроизведено изолированно, не баг проекта) - обходим новым browser'ом.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8794;
const outDir = process.argv[2] || '/tmp';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const data = await readFile(join(ROOT, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;
// cdp.mjs держит фиксированный remote-debugging-port (9333) - между последовательными
// withBrowser() нужна пауза, иначе новый Chrome стартует раньше, чем предыдущий
// процесс реально освободил порт (поймано живым прогоном - "Could not create new page").
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockFetchSource(staffByEmail) {
  return `
window.__mockCalls = [];
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  window.__mockCalls.push(method + ' ' + path + u.search);
  const json = (body, status) => ({ ok: (status||200) < 400, status: status||200, json: async () => body });

  if (path === '/auth/login' && method === 'POST') {
    const body = JSON.parse(opts.body);
    const staffByEmail = ${JSON.stringify(staffByEmail)};
    const staff = staffByEmail[body.email];
    if (!staff) return json({ error: 'invalid_credentials' }, 401);
    return json({ token: 'fake-token', staff });
  }
  if (path === '/staff') {
    return json([
      { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true },
      { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
      { id: 'master-3', locationId: null, name: 'Екатерина', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
    ]);
  }
  if (path === '/services') return json([{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 40, price: 2000 }]);
  if (path === '/master-services') return json([
    { masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 40 },
    { masterId: 'master-2', serviceId: 'strizhka', price: 2000, durationMin: 40 },
  ]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }, { masterId: 'master-2', pct: 100 }, { masterId: 'master-3', pct: 40 }]);
  if (path === '/bookings' && method === 'POST') {
    return json({ ok: true, booking: { id: 'booking-fixture-1', masterId: JSON.parse(opts.body).masterId, totalDurationMin: 40, totalPrice: 2000 } });
  }
  if (/\\/bookings\\/.+\\/status/.test(path) && method === 'PATCH') return json({ ok: true, status: 'done' });
  if (path === '/sales' && method === 'POST') return json({ ok: true, id: 'sale-fixture-1' });
  if (path === '/bookings') return json({ bookings: [] });
  return json({}, 404);
};
`;
}

const STAFF_BY_EMAIL = {
  'owner-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null },
  'master2-test@alikhan.test': { id: 'master-2', name: 'Мамедхан', role: 'master', locationId: null },
};

// --- Б.2: index-showcase.html должна физически уметь отправить форму ---
await withBrowser(async (s) => {
  await s.setViewport(430, 1200, true);
  await s.navigate(`${BASE}/index-showcase.html`);
  await s.sleep(300);
  const showcaseCheck = await s.eval(`JSON.stringify({
    apiUrl: window.ALIKHAN_API_URL || null,
    hasConsent: !!document.getElementById('f-consent'),
    serviceLabel: document.getElementById('f-service-label').textContent,
    consoleWarnOnMissingUrl: typeof window.ALIKHAN_API_URL,
  })`);
  console.log('index-showcase.html (Б.2):', showcaseCheck);
  await s.screenshot(`${outDir}/v-showcase-booking.png`);
});
await sleep(800);

// --- Б.4: страница БЕЗ ALIKHAN_API_URL должна показать офлайн-баннер + console.warn ---
// index-no-api.html - временная копия index.html БЕЗ строки window.ALIKHAN_API_URL,
// чтобы честно проверить сценарий "переменную забыли задать" (ровно баг Б.2 ДО починки).
{
  const original = await readFile(join(ROOT, 'index.html'), 'utf8');
  const withoutApiUrl = original.replace(/<script>window\.ALIKHAN_API_URL[^<]*<\/script>\s*/, '');
  await (await import('node:fs/promises')).writeFile(join(ROOT, 'index-no-api.tmp.html'), withoutApiUrl);
}
await withBrowser(async (s) => {
  await s.setViewport(430, 900, true);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__warnings = []; const origWarn = console.warn; console.warn = (...a) => { window.__warnings.push(a.join(' ')); origWarn(...a); };`,
  });
  await s.navigate(`${BASE}/index-no-api.tmp.html`);
  await s.sleep(300);
  const offlineCheck = await s.eval(`JSON.stringify({
    apiUrl: window.ALIKHAN_API_URL || null,
    warnings: window.__warnings,
    bannerText: document.body.lastElementChild ? document.body.lastElementChild.textContent : null,
  })`);
  console.log('index-no-api (Б.4, офлайн-баннер):', offlineCheck);
  await s.screenshot(`${outDir}/v-offline-banner.png`);
});
await (await import('node:fs/promises')).unlink(join(ROOT, 'index-no-api.tmp.html'));
await sleep(800);

// --- Б.1: crm-master.html под Мамедханом не должен показывать "Алиовсад" ---
await withBrowser(async (s) => {
  await s.setViewport(430, 1200, true);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/crm-master.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'master2-test@alikhan.test';
    document.getElementById('loginPin').value = '1111';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(500);
  const masterSelf = await s.eval(`JSON.stringify({
    badge: document.getElementById('selfNameBadge').textContent,
    avatar: document.getElementById('selfAvatar').textContent,
    nameHead: document.getElementById('selfNameHead').textContent,
    bkMaster: document.getElementById('bk-master').value,
    commissionNote: document.getElementById('bk-commission-note').textContent,
    mainHidden: document.getElementById('crmMain').hidden,
  })`);
  console.log('crm-master.html как Мамедхан (Б.1):', masterSelf);
  await s.screenshot(`${outDir}/v-master-self.png`);
});
await sleep(800);

// --- Блок В: ЗП по периодам + продажа у владельца ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 2200, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'owner-test@alikhan.test';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(600);
  const ownerCheck = await s.eval(`JSON.stringify({
    mainHidden: document.getElementById('crmMain').hidden,
    m1Week: document.getElementById('payrollMaster1Week') ? document.getElementById('payrollMaster1Week').textContent : 'MISSING',
    m2Week: document.getElementById('payrollMaster2Week') ? document.getElementById('payrollMaster2Week').textContent : 'MISSING',
    m2Month: document.getElementById('payrollMaster2Month') ? document.getElementById('payrollMaster2Month').textContent : 'MISSING',
    m3Week: document.getElementById('payrollMaster3Week') ? document.getElementById('payrollMaster3Week').textContent : 'MISSING',
    saleFormExists: !!document.getElementById('wfSaleForm'),
    mockCalls: window.__mockCalls,
  })`);
  console.log('crm-owner.html ЗП по периодам + форма продажи (Блок В):', ownerCheck);
  await s.click('label[for="pt-b"]');
  await s.sleep(200);
  await s.screenshot(`${outDir}/v-owner-payroll.png`);

  // Переключим период на "Неделя" во второй карточке (Мамедхан) и сфотографируем реальный текст
  await s.click('label[for="zp2p-week"]');
  await s.sleep(150);
  await s.screenshot(`${outDir}/v-owner-payroll-week.png`);

  // --- Сквозной сценарий: walk-in запись → форма продажи получает РЕАЛЬНЫЙ bookingId ---
  await s.click('label[for="pt-a"]');
  await s.sleep(150);
  await s.click('.walkin-add-btn[data-master-id="master-1"]');
  await s.sleep(150);
  await s.type('#wfClientName', 'Тестовый клиент');
  await s.type('#wfClientPhone', '+7 900 111-22-33');
  await s.click('#wfServicePicker input[type="checkbox"]');
  await s.sleep(100);
  await s.click('#wfSubmit');
  await s.sleep(400);
  const walkinResult = await s.eval(`JSON.stringify({
    wfResultText: document.getElementById('wfResult').textContent,
    saleFormHidden: document.getElementById('wfSaleForm').hidden,
    saleFormBookingId: document.getElementById('wfSaleForm').dataset.bookingId,
  })`);
  console.log('walk-in → форма продажи (сквозной сценарий):', walkinResult);

  await s.type('#wfSaleItem', 'Воск для укладки');
  await s.type('#wfSaleAmount', '450');
  await s.click('#wfSaleSubmit');
  await s.sleep(400);
  const saleResult = await s.eval(`JSON.stringify({
    saleResultText: document.getElementById('wfSaleResult').textContent,
    mockCallsAfterSale: window.__mockCalls.filter(c => c.includes('/sales') || c.includes('/bookings') && c.startsWith('POST')),
  })`);
  console.log('добавление продажи (сквозной сценарий):', saleResult);
  await s.screenshot(`${outDir}/v-owner-walkin-sale.png`);
});
await sleep(800);

// --- crm-admin.html: та же ЗП-по-периодам структура (Мамедхан), не тестировалась выше ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 1400, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: mockFetchSource({ 'admin1-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'admin', locationId: 1 } }),
  });
  await s.navigate(`${BASE}/crm-admin.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'admin1-test@alikhan.test';
    document.getElementById('loginPin').value = '1111';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(600);
  const adminCheck = await s.eval(`JSON.stringify({
    mainHidden: document.getElementById('crmMain').hidden,
    m1Week: document.getElementById('payrollMaster1Week') ? document.getElementById('payrollMaster1Week').textContent : 'MISSING',
    m2Week: document.getElementById('payrollMaster2Week') ? document.getElementById('payrollMaster2Week').textContent : 'MISSING',
    m2Month: document.getElementById('payrollMaster2Month') ? document.getElementById('payrollMaster2Month').textContent : 'MISSING',
    saleFormExists: !!document.getElementById('wfSaleForm'),
  })`);
  console.log('crm-admin.html ЗП по периодам (Блок В):', adminCheck);
  await s.click('label[for="pt-b"]');
  await s.sleep(200);
  await s.screenshot(`${outDir}/v-admin-payroll.png`);
});

server.close();
