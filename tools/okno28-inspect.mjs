// Шаг 0 Окна 28 (05.08.2026) - ЖИВАЯ СВЕРКА ДО ПРАВОК, без единой правки кода.
// Промпт Окна 28 требует сначала увидеть своими глазами каждый из 4 пунктов, а не
// чинить по словесному описанию. Скрипт ничего не утверждает - он снимает скриншоты
// и печатает фактические значения (текст якоря, координаты стрелок и вкладок, разметку
// точек статуса, состояние переключателя в модалке дня).
//
// Данные - фикстуры через подмену window.fetch (тот же паттерн, что в
// verify-2026-08-05-okno25-navigaciya.mjs): бэкенда Amvera в песочнице нет, а
// проверяем мы фронтенд.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8801;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const SHOTS = '/tmp/okno28-before';

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

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const CUR_MONTH = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
// Три дня-фикстуры внутри текущего месяца, каждый под свой статус в сетке Месяца.
const D_NORMAL = `${CUR_MONTH}-08`; // совпадает со стандартным графиком → 🟢
const D_OVERRIDE = `${CUR_MONTH}-10`; // разовая правка часов → 🟡
const D_OFF_STD = `${CUR_MONTH}-12`; // выходной у мастера со сменой 10:00-20:00 → 🔴
const D_OFF_EARLY = `${CUR_MONTH}-14`; // выходной у мастера со сменой 09:00-18:00 → 🔴

const STAFF = [
  { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
];
const SERVICES = [{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }];

function mockFetchSource() {
  return `
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const json = (body, status) => ({ ok: (status||200) < 400, status: status||200, json: async () => body });
  const D_NORMAL = ${JSON.stringify(D_NORMAL)}, D_OVERRIDE = ${JSON.stringify(D_OVERRIDE)};
  const D_OFF_STD = ${JSON.stringify(D_OFF_STD)}, D_OFF_EARLY = ${JSON.stringify(D_OFF_EARLY)};

  // График конкретной даты. D_OFF_EARLY - тот самый случай из памяти проекта:
  // мастер со сменой 09:00-18:00, отгул закрыт перерывом ровно по его смене.
  const dayOf = (date) => {
    if (date === D_OVERRIDE) return { startTime: '11:00', endTime: '19:00', breaks: [] };
    if (date === D_OFF_STD) return { startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] };
    if (date === D_OFF_EARLY) return { startTime: '09:00', endTime: '18:00', breaks: [{ startTime: '09:00', endTime: '18:00' }] };
    return { startTime: '10:00', endTime: '20:00', breaks: [] };
  };
  const isOff = (date) => date === D_OFF_STD || date === D_OFF_EARLY;

  if (path === '/auth/login' && method === 'POST') {
    return json({ token: 'fake-token', staff: { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null } });
  }
  if (path === '/staff') return json(${JSON.stringify(STAFF)});
  if (path === '/services') return json(${JSON.stringify(SERVICES)});
  if (path === '/master-services') return json([{ masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 }]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }]);
  if (path === '/schedule' && method === 'GET') {
    const date = u.searchParams.get('date');
    if (!date) return json([]);
    const d = dayOf(date);
    return json([{ id: 'sh-1', masterId: u.searchParams.get('masterId'), date, startTime: d.startTime, endTime: d.endTime, breaks: d.breaks }]);
  }
  if (path === '/schedule-range') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const days = [];
    for (let dt = new Date(from + 'T00:00:00Z'); dt.toISOString().slice(0,10) <= to; dt.setUTCDate(dt.getUTCDate()+1)) {
      const date = dt.toISOString().slice(0,10);
      const d = dayOf(date);
      days.push({ date, startTime: d.startTime, endTime: d.endTime, breaks: d.breaks, isDayOff: isOff(date) });
    }
    return json(days);
  }
  // Стандартный график: все семь дней 10:00-20:00 без перерыва - тогда D_OVERRIDE
  // (11:00-19:00) честно отличается от шаблона и обязан дать 🟡.
  if (path === '/master-weekly-schedule' && method === 'GET') {
    return json([1,2,3,4,5,6,7].map((wd) => ({ weekday: wd, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: null, breakEnd: null })));
  }
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/holidays') return json([{ date: ${JSON.stringify(`${CUR_MONTH}-01`)}, name: 'Тестовый праздник' }]);
  if (path === '/schedule-requests') return json([]);
  if (path === '/notifications') return json([]);
  return json({}, 404);
};
`;
}

async function login(s, page) {
  await s.navigate(`${BASE}/${page}`);
  for (let i = 0; i < 60; i++) {
    if (await s.eval(`!!document.getElementById('loginEmail')`)) break;
    await s.sleep(250);
  }
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'owner-test@alikhan.test';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(900);
}

const log = (label, value) => console.log(`· ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-owner.html');
  await s.eval(`(function(){ const el = document.createElement('style'); el.textContent = '*{scroll-behavior:auto !important}'; document.head.appendChild(el); })()`);

  console.log('\n── ПУНКТ 1: подпись дня недели рядом с числом (вкладка «День») ──');
  log('текст подписи-якоря', await s.eval(`document.getElementById('scheduleViewAnchor').textContent`));
  log('текст кнопки date-picker', await s.eval(`document.querySelector('#dayNavDate .custom-date-trigger').textContent`));
  await s.screenshot(`${SHOTS}-1-day-desktop.png`);

  console.log('\n── ПУНКТ 2: стрелки месяца vs блок вкладок (десктоп 1280) ──');
  await s.click('label[for="sp-month"]');
  await s.sleep(700);
  const geom = `(function(){
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    return { segBar: r('.seg-bar'), anchor: r('#scheduleViewAnchor'), prev: r('#monthNavPrev'), next: r('#monthNavNext'), monthNav: r('#monthNav') };
  })()`;
  const g = await s.eval(geom);
  log('geometry', g);
  const overlap = g.segBar && g.prev && g.prev.top < g.segBar.bottom && g.prev.left < g.segBar.right && g.prev.right > g.segBar.left;
  log('стрелки пересекают блок вкладок?', overlap ? 'ДА - воспроизводится' : 'нет');
  log('зазор между низом вкладок и верхом стрелок, px', g.prev && g.segBar ? g.prev.top - g.segBar.bottom : null);
  await s.screenshot(`${SHOTS}-2-month-desktop.png`);

  console.log('\n── ПУНКТ 3: точки статуса в сетке Месяца ──');
  log('разметка ячейки-нормы', await s.eval(`document.querySelector('.month-day--real[data-date="${D_NORMAL}"] .num').innerHTML`));
  log('разметка ячейки-правки', await s.eval(`document.querySelector('.month-day--real[data-date="${D_OVERRIDE}"] .num').innerHTML`));
  log('разметка ячейки-выходного', await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_STD}"] .num').innerHTML`));
  log('легенда под вкладкой', await s.eval(`document.querySelector('.panel-sp-month .section-hint').textContent.slice(0, 60)`));

  console.log('\n── ПУНКТ 4: модалка дня, состояние «Рабочий день» ──');
  // Открываем модалку выходного дня и СРАЗУ, до ответа сети, читаем переключатель.
  await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_STD}"] .month-day-edit').click()`);
  await s.sleep(30);
  log(`сразу после открытия (${D_OFF_STD}, выходной): переключатель «Рабочий день»`, await s.eval(`document.getElementById('dayEditWorking').checked`));
  log('подпись переключателя', await s.eval(`document.querySelector('#dayEditModal .tr-label').textContent`));
  log('note', await s.eval(`document.getElementById('dayEditNote').textContent`));
  await s.screenshot(`${SHOTS}-4a-modal-instant.png`);
  await s.sleep(900);
  log(`после ответа сети (${D_OFF_STD}, смена 10:00-20:00)`, await s.eval(`document.getElementById('dayEditWorking').checked`));
  await s.screenshot(`${SHOTS}-4b-modal-loaded-std.png`);
  await s.click('#dayEditClose');
  await s.sleep(300);

  await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_EARLY}"] .month-day-edit').click()`);
  await s.sleep(1200);
  log(`после ответа сети (${D_OFF_EARLY}, выходной у смены 09:00-18:00)`, await s.eval(`document.getElementById('dayEditWorking').checked`));
  log('статус этой же даты в сетке Месяца', await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_EARLY}"] .num').textContent.trim()`));
  await s.screenshot(`${SHOTS}-4c-modal-loaded-early.png`);
  await s.click('#dayEditClose');
  await s.sleep(200);

  console.log('\n── ПУНКТ 2 (мобильная ширина 390) ──');
  await s.setViewport(390, 900, true);
  await s.sleep(700);
  const gm = await s.eval(geom);
  log('geometry (mobile)', gm);
  const overlapM = gm.segBar && gm.prev && gm.prev.top < gm.segBar.bottom && gm.prev.left < gm.segBar.right && gm.prev.right > gm.segBar.left;
  log('стрелки пересекают блок вкладок?', overlapM ? 'ДА - воспроизводится' : 'нет');
  await s.screenshot(`${SHOTS}-2-month-mobile.png`);
});

server.close();
console.log(`\nСкриншоты: ${SHOTS}-*.png`);
