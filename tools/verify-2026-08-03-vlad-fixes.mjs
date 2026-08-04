// Проверка 5 правок Влада 03.08.2026 (см. plans/2026-08-03-vlad-fixes.md):
// 1) длительность "Стрижка" 1 час (данные), 2) публичная запись показывает только
// реально назначенные мастеру услуги (master_services, не весь каталог),
// 3) комплекс "стрижка+борода" блокирует свои 4 компонента, 4) отдельный выбор
// стрижки+бороды сам сворачивается в комплекс, 5) "Клиент не пришёл" - реальная
// кнопка (PATCH /bookings/:id/status), "Фактическое время прихода" убрано.
// Бэкенда Amvera нет в песочнице - window.fetch подменяется фикстурами ДО загрузки
// страницы (тот же паттерн, что tools/verify-gotovnost-2026-08-01.mjs).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8795;
const outDir = process.argv[2] || '/tmp';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// master-1: комплекс+все 4 блокируемых компонента (проверка п.3/4).
// master-2: узкий набор без бритья/окантовки/тонировки/спа (проверка п.2 - фильтр по мастеру).
const MASTER_SERVICES_FIXTURE = [
  { masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 },
  { masterId: 'master-1', serviceId: 'boroda', price: 1600, durationMin: 30 },
  { masterId: 'master-1', serviceId: 'kompleks-strizhka-boroda', price: 3500, durationMin: 60 },
  { masterId: 'master-1', serviceId: 'britie', price: 1500, durationMin: 40 },
  { masterId: 'master-1', serviceId: 'firmennaya-okantovka', price: 1400, durationMin: 30 },
  { masterId: 'master-2', serviceId: 'strizhka', price: 1500, durationMin: 60 },
  { masterId: 'master-2', serviceId: 'vosk', price: 500, durationMin: 15 },
];

const BOOKING_FIXTURE = {
  id: 'booking-fixture-noshow-1',
  masterId: 'master-1',
  serviceId: 'strizhka',
  serviceIds: ['strizhka'],
  date: '2026-08-03',
  startTime: '10:00',
  endTime: '11:00',
  status: 'planned',
  clientConfirmed: true,
  clientName: 'Тест Клиент',
  clientPhone: '+79990001234',
  clientNoShowStreak: 2,
  requiresPrepayment: true,
};

function mockFetchSource(staffByEmail) {
  return `
window.__mockCalls = [];
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  window.__mockCalls.push({ method, path, body: opts && opts.body ? JSON.parse(opts.body) : null });
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
      { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'admin', employed: true, providesServices: true, hasSystemAccess: true },
    ]);
  }
  if (path === '/services') return json([
    { id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 },
    { id: 'boroda', name: 'Борода', category: 'base', durationMin: 30, price: 1600 },
    { id: 'kompleks-strizhka-boroda', name: 'Комплекс стрижка+борода', category: 'base', durationMin: 60, price: 3500 },
    { id: 'britie', name: 'Бритьё', category: 'base', durationMin: 40, price: 1500 },
    { id: 'firmennaya-okantovka', name: 'Фирменная окантовка', category: 'base', durationMin: 30, price: 1400 },
    { id: 'vosk', name: 'Воск', category: 'base', durationMin: 15, price: 500 },
  ]);
  if (path === '/master-services' && method === 'GET') return json(${JSON.stringify(MASTER_SERVICES_FIXTURE)});
  if (/\\/master-services\\/.+\\/.+/.test(path) && method === 'PUT') {
    return json({ ok: true, enabled: JSON.parse(opts.body).enabled !== false });
  }
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }, { masterId: 'master-2', pct: 100 }]);
  if (path === '/schedule') return json([]);
  if (path === '/bookings' && method === 'GET') return json({ bookings: [${JSON.stringify(BOOKING_FIXTURE)}] });
  if (path === '/bookings' && method === 'POST') {
    return json({ ok: true, booking: { id: 'booking-fixture-new', masterId: JSON.parse(opts.body).masterId, totalDurationMin: 60, totalPrice: 2000 } });
  }
  if (/\\/bookings\\/.+\\/status/.test(path) && method === 'PATCH') return json({ ok: true, status: JSON.parse(opts.body).status });
  return json({}, 404);
};
`;
}

const STAFF_BY_EMAIL = {
  'owner-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null },
};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✔' : '✘'} ${label}` + (ok ? '' : ` — ожидал ${JSON.stringify(expected)}, получил ${JSON.stringify(actual)}`));
  if (!ok) failures++;
  return ok;
}

// --- п.1/п.2: публичная запись показывает РЕАЛЬНЫЕ услуги мастера с реальной длительностью ---
await withBrowser(async (s) => {
  await s.setViewport(430, 1400, true);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/index.html`);
  await s.sleep(400);

  // master-1 (Алиовсад) - выбираем в #master-grid по имени
  await s.eval(`(function(){
    const btn = [...document.querySelectorAll('#master-grid .option-card')].find(b => b.textContent.includes('Алиовсад'));
    if (btn) btn.click();
  })()`);
  await s.sleep(300);

  const master1Names = await s.eval(`JSON.stringify([...document.querySelectorAll('#service-grid .option-card .opt-name')].map(n => n.textContent))`);
  check('master-1: список услуг = только 5 реально назначенных (не все 8 из каталога)', JSON.parse(master1Names).sort(),
    ['Бритьё', 'Борода', 'Комплекс стрижка+борода', 'Стрижка', 'Фирменная окантовка'].sort());

  const strizhkaMeta = await s.eval(`(function(){
    const btn = [...document.querySelectorAll('#service-grid .option-card')].find(b => b.querySelector('.opt-name').textContent === 'Стрижка');
    return btn ? btn.querySelector('.opt-meta').textContent : null;
  })()`);
  check('master-1: "Стрижка" показывает реальную длительность 60 мин (не 30-40)', strizhkaMeta, '2 000₽ · 60 мин');

  // п.4: отдельный выбор Стрижка + Борода должен сам слиться в Комплекс
  await s.eval(`(function(){
    const click = (name) => [...document.querySelectorAll('#service-grid .option-card')].find(b => b.querySelector('.opt-name').textContent === name)?.click();
    click('Стрижка');
    click('Борода');
  })()`);
  await s.sleep(150);
  const selectedAfterMerge = await s.eval(`JSON.stringify([...document.querySelectorAll('#service-grid .option-card.selected .opt-name')].map(n => n.textContent))`);
  check('п.4: "Стрижка"+"Борода" по отдельности сворачиваются в "Комплекс стрижка+борода"', JSON.parse(selectedAfterMerge), ['Комплекс стрижка+борода']);

  // п.3: пока комплекс выбран - Бритьё/Окантовка должны быть disabled (нельзя добавить)
  const blockedState = await s.eval(`JSON.stringify((function(){
    const byName = (name) => [...document.querySelectorAll('#service-grid .option-card')].find(b => b.querySelector('.opt-name').textContent === name);
    return { britie: byName('Бритьё').disabled, okantovka: byName('Фирменная окантовка').disabled, boroda: byName('Борода').disabled, vosk: byName('Стрижка') === undefined };
  })())`);
  check('п.3: при выбранном комплексе Бритьё/Окантовка/Борода заблокированы', JSON.parse(blockedState), { britie: true, okantovka: true, boroda: true, vosk: false });

  await s.screenshot(`${outDir}/v-0803-public-combo.png`);
});
await sleep(600);

// --- п.2 (продолжение): другой мастер - другой, УЖЕ узкий, набор услуг ---
await withBrowser(async (s) => {
  await s.setViewport(430, 1400, true);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/index.html`);
  await s.sleep(400);
  await s.eval(`(function(){
    const btn = [...document.querySelectorAll('#master-grid .option-card')].find(b => b.textContent.includes('Мамедхан'));
    if (btn) btn.click();
  })()`);
  await s.sleep(300);
  const master2Names = await s.eval(`JSON.stringify([...document.querySelectorAll('#service-grid .option-card .opt-name')].map(n => n.textContent))`);
  check('master-2: список услуг = только 2 реально назначенных (Стрижка, Воск)', JSON.parse(master2Names).sort(), ['Воск', 'Стрижка'].sort());
  await s.screenshot(`${outDir}/v-0803-public-master2.png`);
});
await sleep(600);

// --- CRM владелец: реальный редактор услуг мастера + реальная кнопка "Клиент не пришёл" ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 2400, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'owner-test@alikhan.test';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(700);

  // Редактор услуг master-1: чекбоксы должны отражать РЕАЛЬНЫЕ данные фикстуры
  // (5 checked, 3 unchecked - тонировка/воск/спа не назначены Алиовсаду в фикстуре).
  const editorState = await s.eval(`JSON.stringify((function(){
    const box = document.querySelector('.service-picker[data-master-id="master-1"]');
    if (!box) return 'NOT_FOUND';
    return [...box.querySelectorAll('.service-check')].map(l => ({
      name: l.querySelector('.sc-name').textContent,
      checked: l.querySelector('input[type=checkbox]').checked,
    }));
  })())`);
  console.log('Редактор услуг master-1 (владелец):', editorState);
  const editorRows = JSON.parse(editorState);
  check('редактор услуг: 8 строк (весь каталог), 5 отмечены как реально назначенные',
    Array.isArray(editorRows) ? editorRows.filter((r) => r.checked).length : null, 5);

  // Клик по чекбоксу "Воск" (сейчас не назначен master-1) должен включить услугу и
  // отправить РЕАЛЬНЫЙ PUT /master-services/master-1/vosk с enabled:true.
  await s.eval(`(function(){
    const box = document.querySelector('.service-picker[data-master-id="master-1"]');
    const row = [...box.querySelectorAll('.service-check')].find(l => l.querySelector('.sc-name').textContent === 'Воск');
    row.querySelector('input[type=checkbox]').click();
  })()`);
  await s.sleep(200);
  const putCall = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'PUT' && c.path.includes('/master-services/')))`);
  console.log('PUT master-services после клика "Воск":', putCall);
  const parsedPut = JSON.parse(putCall);
  check('клик по чекбоксу услуги реально отправляет PUT /master-services/master-1/vosk', parsedPut?.path, '/master-services/master-1/vosk');
  check('PUT body содержит enabled:true', parsedPut?.body?.enabled, true);

  // Карточка записи: клик по реальной брони из фикстуры (booking-fixture-noshow-1).
  await s.eval(`document.querySelector('.appt')?.click()`);
  await s.sleep(150);
  const bookingCard = await s.eval(`JSON.stringify({
    hasArrivalField: !!document.getElementById('bk-actual'),
    hasNoShowBtn: !!document.getElementById('bk-noshow-btn'),
    btnLabel: document.getElementById('bk-noshow-btn')?.textContent,
    bannerHidden: document.getElementById('bk-noshow-banner')?.hidden,
    bannerText: document.getElementById('bk-noshow-banner')?.querySelector('span:last-child')?.textContent,
    bookingId: document.getElementById('bd-1')?.dataset.bookingId,
  })`);
  console.log('Карточка записи после клика по реальной брони:', bookingCard);
  const cardState = JSON.parse(bookingCard);
  check('п.5: поле "Фактическое время прихода" (bk-actual) отсутствует', cardState.hasArrivalField, false);
  check('п.5: кнопка "Клиент не пришёл" присутствует', cardState.hasNoShowBtn, true);
  check('п.5: label кнопки - "Клиент не пришёл" (статус брони planned)', cardState.btnLabel, 'Клиент не пришёл');
  check('п.5: баннер истории показан (streak=2 из фикстуры)', cardState.bannerHidden, false);
  check('п.5: баннер содержит реальное число неявок и правило предоплаты', cardState.bannerText, 'У этого клиента 2 неявки без предупреждения. Действует правило предоплаты для следующей записи.');
  check('п.5: id открытой брони - реальный из фикстуры, не пустой', cardState.bookingId, 'booking-fixture-noshow-1');

  // Клик "Клиент не пришёл" - должен отправить РЕАЛЬНЫЙ PATCH /bookings/<id>/status
  await s.eval(`document.getElementById('bk-noshow-btn').click()`);
  await s.sleep(250);
  const patchCall = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'PATCH' && c.path.includes('/status')))`);
  console.log('PATCH status после клика "Клиент не пришёл":', patchCall);
  const parsedPatch = JSON.parse(patchCall);
  check('клик "Клиент не пришёл" отправляет PATCH на реальный id брони', parsedPatch?.path, '/bookings/booking-fixture-noshow-1/status');
  check('PATCH body - status:no_show', parsedPatch?.body?.status, 'no_show');
  const btnLabelAfter = await s.eval(`document.getElementById('bk-noshow-btn').textContent`);
  check('после клика label меняется на "Отменить отметку неявки" (toggle работает)', btnLabelAfter, 'Отменить отметку неявки');

  await s.screenshot(`${outDir}/v-0803-owner-services-and-noshow.png`);
});

server.close();
console.log(failures === 0 ? `\nВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ` : `\n${failures} ПРОВЕРОК ПРОВАЛЕНО`);
process.exit(failures === 0 ? 0 : 1);
