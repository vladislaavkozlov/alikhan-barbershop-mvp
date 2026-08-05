// Проверка Окна 25 (05.08.2026) - единое состояние даты поперёк вкладок
// День/Неделя/Месяц/Год. Бэкенда Amvera в песочнице нет - window.fetch подменяется
// фикстурами (тот же паттерн, что verify-2026-08-04-okno18-nedelya-mesyats-god.mjs),
// проверяем ФРОНТ: не теряется ли выбранная дата при переключении плотности.
//
// Ключевой ассерт DoD сделан НЕ по тексту подписи (её формат покрыт юнитами
// tests/schedule-views.navigation.test.js), а по реальному содержимому сетки: среди
// ячеек Недели обязана быть ячейка ровно с той датой, которую выбрали в Месяце.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8799;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const SHOTS = '/tmp/okno25';

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

const STAFF = [
  { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-3', locationId: null, name: 'Елизавета', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
];
const SERVICES = [{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }];
const MASTER_SERVICES = [{ masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 }];
const STAFF_BY_EMAIL = {
  'owner-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null },
  'master-test@alikhan.test': { id: 'master-2', name: 'Мамедхан', role: 'master', locationId: null },
};

function mockFetchSource() {
  return `
window.__mockCalls = [];
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  window.__mockCalls.push({ method, path, search: u.search });
  const json = (body, status) => ({ ok: (status||200) < 400, status: status||200, json: async () => body });

  if (path === '/auth/login' && method === 'POST') {
    const body = JSON.parse(opts.body);
    const staffByEmail = ${JSON.stringify(STAFF_BY_EMAIL)};
    const staff = staffByEmail[body.email];
    if (!staff) return json({ error: 'invalid_credentials' }, 401);
    return json({ token: 'fake-token', staff });
  }
  if (path === '/staff') return json(${JSON.stringify(STAFF)});
  if (path === '/services') return json(${JSON.stringify(SERVICES)});
  if (path === '/master-services') return json(${JSON.stringify(MASTER_SERVICES)});
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }]);
  if (path === '/schedule' && method === 'GET') return json([]);
  if (path === '/schedule-range') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const days = [];
    for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0,10) <= to; d.setUTCDate(d.getUTCDate()+1)) {
      days.push({ date: d.toISOString().slice(0,10), startTime: '10:00', endTime: '20:00', breaks: [], isDayOff: false });
    }
    return json(days);
  }
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/master-weekly-schedule' && method === 'GET') return json([]);
  if (path === '/schedule-requests') return json([]);
  if (path === '/notifications') return json([]);
  return json({}, 404);
};
`;
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✔' : '✘'} ${label}` + (ok ? '' : ` — ожидал ${JSON.stringify(expected)}, получил ${JSON.stringify(actual)}`));
  if (!ok) failures++;
  return ok;
}
function checkTrue(label, actual) {
  console.log(`${actual ? '✔' : '✘'} ${label}`);
  if (!actual) failures++;
  return actual;
}

async function login(s, page, email) {
  await s.navigate(`${BASE}/${page}`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = '${email}';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(800);
}

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const CUR_MONTH = TODAY.slice(0, 7);
// 15-е число текущего месяца - "день из середины недели" сценария DoD: заведомо не
// сегодня для большинства прогонов и заведомо не на границе месяца.
const PICKED = `${CUR_MONTH}-15`;
const nextMonthDate = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
const NEXT_MONTH_FIRST = nextMonthDate.toISOString().slice(0, 10);

const anchor = (s) => s.eval(`document.getElementById('scheduleViewAnchor').textContent`);
const weekDates = (s) => s.eval(`Array.from(document.querySelectorAll('#weekGrid [data-open-day]')).map(e => e.dataset.openDay)`);
const monthDates = (s) => s.eval(`Array.from(document.querySelectorAll('#monthGrid .month-day--real')).map(e => e.dataset.date)`);

await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');
  await s.eval(`(function(){ const el = document.createElement('style'); el.textContent = '*{scroll-behavior:auto !important}'; document.head.appendChild(el); })()`);

  // ── Регрессия: обычный вход - "День", сегодня ───────────────────────────────
  const startAnchor = await anchor(s);
  checkTrue(`Старт: подпись-якорь про День (получено «${startAnchor}»)`, startAnchor.startsWith('День · '));
  checkTrue('Старт: активна вкладка "День"', await s.eval(`document.getElementById('sp-day').checked`));
  check('Старт: date-picker "Мой день" на сегодня', await s.eval(`document.getElementById('dayNavDate').dataset.value`), TODAY);
  await s.screenshot(`${SHOTS}-1-day.png`);

  // ── Месяц → клик по дню из середины ────────────────────────────────────────
  await s.click('label[for="sp-month"]');
  await s.sleep(600);
  const monthAnchor = await anchor(s);
  checkTrue(`Месяц: подпись-якорь про Месяц (получено «${monthAnchor}»)`, monthAnchor.startsWith('Месяц · '));
  checkTrue('Месяц: ячейки дней отрисованы (>25)', (await monthDates(s)).length > 25);
  checkTrue('Месяц: панель получила класс crossfade', await s.eval(`document.querySelector('.panel-sp-month').classList.contains('view-fade-in')`));
  await s.screenshot(`${SHOTS}-2-month.png`);

  await s.click(`.month-day--real[data-date="${PICKED}"]`);
  await s.sleep(600);
  checkTrue('Месяц → клик по дню: активна вкладка "День"', await s.eval(`document.getElementById('sp-day').checked`));
  check('Месяц → клик по дню: date-picker переехал на выбранную дату', await s.eval(`document.getElementById('dayNavDate').dataset.value`), PICKED);
  const dayAnchorAfterJump = await anchor(s);
  checkTrue(`Месяц → клик по дню: подпись-якорь про этот день (получено «${dayAnchorAfterJump}»)`, dayAnchorAfterJump.startsWith('День · ') && dayAnchorAfterJump.includes(' 15 '));

  // ── КЛЮЧЕВОЙ сценарий DoD: День → Неделя содержит эту дату ─────────────────
  await s.click('label[for="sp-week"]');
  await s.sleep(600);
  const weekAfterDay = await weekDates(s);
  check('День → Неделя: 7 ячеек', weekAfterDay.length, 7);
  checkTrue(`День → Неделя: открыта неделя, СОДЕРЖАЩАЯ ${PICKED} (получено ${weekAfterDay[0]}…${weekAfterDay[6]})`, weekAfterDay.includes(PICKED));
  const weekAnchor = await anchor(s);
  checkTrue(`День → Неделя: подпись-якорь про Неделю (получено «${weekAnchor}»)`, weekAnchor.startsWith('Неделя · '));
  await s.screenshot(`${SHOTS}-3-week.png`);

  // ── Неделя → Месяц: тот же месяц, дата не потеряна ────────────────────────
  await s.click('label[for="sp-month"]');
  await s.sleep(600);
  checkTrue(`Неделя → Месяц: открыт месяц, содержащий ${PICKED}`, (await monthDates(s)).includes(PICKED));

  // ── Листание месяца двигает общий якорь ───────────────────────────────────
  await s.click('#monthNavNext');
  await s.sleep(600);
  const monthCellsNext = await monthDates(s);
  checkTrue(`Месяц вперёд: показан следующий месяц (${NEXT_MONTH_FIRST.slice(0, 7)})`, monthCellsNext.every((d) => d.startsWith(NEXT_MONTH_FIRST.slice(0, 7))));
  await s.click('label[for="sp-week"]');
  await s.sleep(600);
  checkTrue(`Месяц вперёд → Неделя: открыта неделя, содержащая ${NEXT_MONTH_FIRST} (не текущая календарная)`, (await weekDates(s)).includes(NEXT_MONTH_FIRST));

  // ── Год не сбрасывает якорь ───────────────────────────────────────────────
  await s.click('label[for="sp-year"]');
  await s.sleep(400);
  check('Год: подпись-якорь называет реально нарисованный справочный календарь', await anchor(s), 'Год · 2026 (справочный)');
  await s.screenshot(`${SHOTS}-4-year.png`);
  await s.click('label[for="sp-month"]');
  await s.sleep(600);
  checkTrue('Год → Месяц: якорь пережил заход на "Год" (месяц остался тот же)', (await monthDates(s)).every((d) => d.startsWith(NEXT_MONTH_FIRST.slice(0, 7))));

  // ── Листание недели двигает общий якорь на понедельник новой недели ───────
  await s.click('label[for="sp-week"]');
  await s.sleep(600);
  const weekBeforeShift = await weekDates(s);
  await s.click('#weekNavNext');
  await s.sleep(600);
  const weekAfterShift = await weekDates(s);
  check('Неделя вперёд: сетка сдвинулась ровно на 7 дней', weekAfterShift[0], (() => {
    const d = new Date(`${weekBeforeShift[0]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })());
  await s.click('label[for="sp-day"]');
  await s.sleep(600);
  check('Неделя вперёд → День: открыт понедельник той недели, что смотрели', await s.eval(`document.getElementById('dayNavDate').dataset.value`), weekAfterShift[0]);

  // ── Регрессия Окна 18: клик по дню из Недели по-прежнему открывает День ───
  await s.click('label[for="sp-week"]');
  await s.sleep(600);
  const weekCellsForClick = await weekDates(s);
  await s.click('#weekGrid .week-day-cell');
  await s.sleep(600);
  checkTrue('Регрессия: клик по ячейке Недели переключает на "День"', await s.eval(`document.getElementById('sp-day').checked`));
  check('Регрессия: и открывает именно ту дату, по которой кликнули', await s.eval(`document.getElementById('dayNavDate').dataset.value`), weekCellsForClick[0]);

  // ── Регрессия Окна 18: выбор даты в самом виджете-календаре ──────────────
  // Отдельный риск Окна 25: loadDay теперь сам перерисовывает виджет даты, а
  // событие customdate:change прилетает изнутри этого же виджета - проверяем, что
  // перерисовка не съедает выбор и не ломает слушатель на слоте.
  await s.click('label[for="sp-day"]');
  await s.sleep(400);
  await s.click('#dayNavDate .custom-date-trigger');
  await s.sleep(300);
  // 20-е число ИМЕННО того месяца, который сейчас открыт в панели виджета (к этому
  // шагу якорь уже уехал вперёд по сценарию) - иначе клика по несуществующей ячейке.
  const widgetMonth = (await s.eval(`document.getElementById('dayNavDate').dataset.value`)).slice(0, 7);
  const pickedInWidget = `${widgetMonth}-20`;
  check('Регрессия: ячейка выбираемой даты есть в панели виджета', await s.click(`#dayNavDate .custom-date-cell[data-date="${pickedInWidget}"]`), 'OK');
  await s.sleep(700);
  check('Регрессия: выбор даты в виджете-календаре применён', await s.eval(`document.getElementById('dayNavDate').dataset.value`), pickedInWidget);
  checkTrue('Регрессия: подпись-якорь обновилась после выбора в виджете', (await anchor(s)).includes(' 20 '));
  await s.click('label[for="sp-week"]');
  await s.sleep(600);
  checkTrue(`Регрессия: и Неделя открылась на неделе с ${pickedInWidget}`, (await weekDates(s)).includes(pickedInWidget));

  // ── Регрессия: стрелки "Мой день" ────────────────────────────────────────
  await s.click('label[for="sp-day"]');
  await s.sleep(400);
  const dayBeforeArrow = await s.eval(`document.getElementById('dayNavDate').dataset.value`);
  await s.click('#dayNavNext');
  await s.sleep(600);
  const dayAfterArrow = await s.eval(`document.getElementById('dayNavDate').dataset.value`);
  check('Регрессия: стрелка "вперёд" в Дне двигает дату на +1', dayAfterArrow, (() => {
    const d = new Date(`${dayBeforeArrow}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })());
  checkTrue('Регрессия: календарь дня перерисован (колонки мастеров на месте)', (await s.eval(`document.querySelectorAll('.panel-sp-day .schedule-grid .schedule-col').length`)) === 3);
});

await new Promise((r) => setTimeout(r, 1500));

// ── Смоук crm-master.html (solo-режим, та же общая логика вкладок) ──────────
await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-master.html', 'master-test@alikhan.test');

  const masterStartAnchor = await anchor(s);
  checkTrue(`crm-master.html: подпись-якорь есть и про День (получено «${masterStartAnchor}»)`, masterStartAnchor.startsWith('День · '));
  await s.click('label[for="sp-month"]');
  await s.sleep(600);
  checkTrue('crm-master.html/Месяц: ячейки дней отрисованы', (await monthDates(s)).length > 25);
  const masterPicked = (await monthDates(s)).find((d) => d.endsWith('-15'));
  await s.click(`.month-day--real[data-date="${masterPicked}"]`);
  await s.sleep(600);
  await s.click('label[for="sp-week"]');
  await s.sleep(600);
  checkTrue(`crm-master.html: Месяц → День → Неделя сохраняет дату ${masterPicked}`, (await weekDates(s)).includes(masterPicked));
  // Окно 19: на crm-master.html контейнера #weekMasterSwitch нет в разметке вообще
  // (мастер видит только себя) - проверяем именно это, а не число пилюль в нём.
  const soloSwitchExists = await s.eval(`!!document.getElementById('weekMasterSwitch')`);
  check('crm-master.html: переключателя чужих мастеров по-прежнему нет (solo)', soloSwitchExists, false);
});

server.close();
console.log(failures === 0 ? '\n✔ ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ' : `\n✘ ${failures} ПРОВАЛИВШИХСЯ ПРОВЕРОК`);
process.exit(failures === 0 ? 0 : 1);
