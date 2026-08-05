// Проверка Окна 28 (05.08.2026) - мелкая полировка CRM владельца.
// Бэкенда Amvera в песочнице нет - window.fetch подменяется фикстурами (тот же
// паттерн, что verify-2026-08-05-okno25-navigaciya.mjs), проверяется ФРОНТ.
//
// Что покрыто:
//   пункт 2 - ряд стрелок навигации не липнет к блоку вкладок и к подписи-якорю
//             (десктоп 1280 и мобильная ширина 390, DoD промпта требует обе);
//   пункт 3 - в сетке Месяца и в легенде вместо эмодзи кружок на переменных проекта,
//             у каждого статуса словесная подпись;
//   пункт 4 - модалка дня не показывает "Рабочий день" до ответа сервера, а после
//             ответа называет реальное состояние дня, в том числе у мастера с ранней
//             сменой 09:00-18:00 (прежняя проверка литералами 10:00-20:00 врала).
// Пункт 1 промпта (день недели рядом с датой) уже закрыт Окном 25 - здесь он идёт
// регрессией: подпись-якорь обязана называть день недели словом.
//
// Фикстура /schedule отвечает с задержкой SCHEDULE_DELAY_MS - без неё окно "модалка
// открыта, данные ещё не пришли" в песочнице не поймать, а на боевой сети оно как раз
// и видно (именно его Влад описал в пункте 4).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8802;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const SHOTS = '/tmp/okno28-after';
const SCHEDULE_DELAY_MS = 700;

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
// BASE_URL=https://... прогоняет те же сценарии против задеплоенного фронтенда.
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const CUR_MONTH = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
const D_NORMAL = `${CUR_MONTH}-08`; // совпадает со стандартным графиком → обычный день
const D_OVERRIDE = `${CUR_MONTH}-10`; // разовая правка часов → жёлтый статус
const D_OFF_STD = `${CUR_MONTH}-12`; // выходной у смены 10:00-20:00
const D_OFF_EARLY = `${CUR_MONTH}-14`; // выходной у смены 09:00-18:00 (ключевой случай)
const D_HOLIDAY = `${CUR_MONTH}-01`;

const STAFF = [
  { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
];

function mockFetchSource() {
  return `
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const json = (body, status) => ({ ok: (status||200) < 400, status: status||200, json: async () => body });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const D_OVERRIDE = ${JSON.stringify(D_OVERRIDE)}, D_OFF_STD = ${JSON.stringify(D_OFF_STD)}, D_OFF_EARLY = ${JSON.stringify(D_OFF_EARLY)};

  const dayOf = (date) => {
    if (date === D_OVERRIDE) return { startTime: '11:00', endTime: '19:00', breaks: [] };
    if (date === D_OFF_STD) return { startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] };
    // Ранняя смена, закрытая целиком: перерыв 09:00-18:00 НЕ накрывает литералы
    // 10:00-20:00 - на этой фикстуре старая проверка и показывала "Рабочий день".
    if (date === D_OFF_EARLY) return { startTime: '09:00', endTime: '18:00', breaks: [{ startTime: '09:00', endTime: '18:00' }] };
    return { startTime: '10:00', endTime: '20:00', breaks: [] };
  };
  const isOff = (date) => date === D_OFF_STD || date === D_OFF_EARLY;

  // Роль отдаём по e-mail: crm-auth.js после входа уводит на страницу роли
  // (location.href = ROLE_PAGE[staff.role]), поэтому логин владельцем на crm-master.html
  // молча увёл бы прогон обратно на crm-owner.html и смоук проверял бы не ту страницу.
  if (path === '/auth/login' && method === 'POST') {
    const email = JSON.parse(opts.body).email;
    const staff = email.startsWith('master')
      ? { id: 'master-2', name: 'Мамедхан', role: 'master', locationId: null }
      : { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null };
    return json({ token: 'fake-token', staff });
  }
  if (path === '/staff') return json(${JSON.stringify(STAFF)});
  if (path === '/services') return json([{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }]);
  if (path === '/master-services') return json([{ masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 }]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }]);
  if (path === '/schedule' && method === 'GET') {
    const date = u.searchParams.get('date');
    if (!date) return json([]);
    await wait(${SCHEDULE_DELAY_MS});
    const d = dayOf(date);
    return json([{ id: 'sh-1', masterId: u.searchParams.get('masterId'), date, startTime: d.startTime, endTime: d.endTime, breaks: d.breaks }]);
  }
  if (path === '/schedule-range') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to'), days = [];
    for (let dt = new Date(from + 'T00:00:00Z'); dt.toISOString().slice(0,10) <= to; dt.setUTCDate(dt.getUTCDate()+1)) {
      const date = dt.toISOString().slice(0,10);
      const d = dayOf(date);
      days.push({ date, startTime: d.startTime, endTime: d.endTime, breaks: d.breaks, isDayOff: isOff(date) });
    }
    return json(days);
  }
  if (path === '/master-weekly-schedule' && method === 'GET') {
    return json([1,2,3,4,5,6,7].map((wd) => ({ weekday: wd, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: null, breakEnd: null })));
  }
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/holidays') return json([{ date: ${JSON.stringify(D_HOLIDAY)}, name: 'Тестовый праздник' }]);
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

async function login(s, page, email = 'owner-test@alikhan.test') {
  await s.navigate(`${BASE}/${page}`);
  for (let i = 0; i < 60; i++) {
    if (await s.eval(`!!document.getElementById('loginEmail')`)) break;
    await s.sleep(250);
  }
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = '${email}';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(900);
}

// Прямоугольники ключевых блоков вкладки "Месяц" - на них держится пункт 2.
const GEOM = `(function(){
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
  return { segBar: r('.seg-bar'), anchor: r('#scheduleViewAnchor'), prev: r('#monthNavPrev'), next: r('#monthNavNext') };
})()`;
const rectsOverlap = (a, b) => !!a && !!b && a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;

const MIN_GAP = 6; // ниже этого ряд стрелок читается как приклеенный к блоку сверху

async function checkMonthNavGeometry(s, width) {
  const g = await s.eval(GEOM);
  checkTrue(`[${width}px] стрелки месяца НЕ пересекают блок вкладок`, !rectsOverlap(g.prev, g.segBar) && !rectsOverlap(g.next, g.segBar));
  checkTrue(`[${width}px] стрелки месяца НЕ пересекают подпись-якорь`, !rectsOverlap(g.prev, g.anchor) && !rectsOverlap(g.next, g.anchor));
  const gapToAnchor = g.prev.top - g.anchor.bottom;
  const gapToTabs = g.prev.top - g.segBar.bottom;
  checkTrue(`[${width}px] зазор до подписи-якоря ≥ ${MIN_GAP}px (получено ${gapToAnchor})`, gapToAnchor >= MIN_GAP);
  checkTrue(`[${width}px] зазор до блока вкладок ≥ ${MIN_GAP}px (получено ${gapToTabs})`, gapToTabs >= MIN_GAP);
  return g;
}

await withBrowser(async (s) => {
  await s.setViewport(1280, 1800, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-owner.html');
  await s.eval(`(function(){ const el = document.createElement('style'); el.textContent = '*{scroll-behavior:auto !important}'; document.head.appendChild(el); })()`);

  // ── Пункт 1 (регрессия Окна 25): день недели виден словом ──────────────────
  const anchorDay = await s.eval(`document.getElementById('scheduleViewAnchor').textContent`);
  checkTrue(`Вкладка "День": подпись называет день недели словом (получено «${anchorDay}»)`, /День · (понедельник|вторник|среда|четверг|пятница|суббота|воскресенье), \d+ /.test(anchorDay));
  await s.screenshot(`${SHOTS}-1-day-desktop.png`);

  // ── Пункт 2: геометрия ряда стрелок на десктопе ───────────────────────────
  await s.click('label[for="sp-month"]');
  await s.sleep(900);
  await checkMonthNavGeometry(s, 1280);
  await s.screenshot(`${SHOTS}-2-month-desktop.png`);

  // ── Пункт 3: точки статуса ────────────────────────────────────────────────
  const numHtml = (date) => s.eval(`document.querySelector('.month-day--real[data-date="${date}"] .num').innerHTML`);
  checkTrue('Месяц: в ячейках больше нет эмодзи-статусов', !(await s.eval(`document.getElementById('monthGrid').innerHTML`)).match(/🟢|🟡|🔴/));
  checkTrue('Месяц: обычный день - кружок day-dot--work', (await numHtml(D_NORMAL)).includes('day-dot--work'));
  checkTrue('Месяц: день с разовой правкой - кружок day-dot--edit', (await numHtml(D_OVERRIDE)).includes('day-dot--edit'));
  checkTrue('Месяц: выходной - кружок day-dot--off', (await numHtml(D_OFF_STD)).includes('day-dot--off'));
  checkTrue('Месяц: у кружка есть подпись словами (не только цвет)', (await numHtml(D_OFF_STD)).includes('aria-label="Выходной"'));
  const legendHtml = await s.eval(`document.querySelector('.panel-sp-month .section-hint').innerHTML`);
  checkTrue('Легенда под вкладкой перерисована теми же кружками', legendHtml.includes('day-dot--work') && legendHtml.includes('day-dot--edit') && legendHtml.includes('day-dot--off'));
  checkTrue('Легенда: эмодзи убраны', !legendHtml.match(/🟢|🟡|🔴/));
  // Цвета берутся из палитры проекта, а не заданы произвольно
  const dotColor = (cls) => s.eval(`getComputedStyle(document.querySelector('.month-grid .${cls}')).backgroundColor`);
  const varColor = (name) => s.eval(`(function(){ const p = document.createElement('span'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue('${name}').trim(); document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
  check('Цвет обычного дня = переменная --success', await dotColor('day-dot--work'), await varColor('--success'));
  check('Цвет разовой правки = переменная --accent', await dotColor('day-dot--edit'), await varColor('--accent'));
  check('Цвет выходного = переменная --danger', await dotColor('day-dot--off'), await varColor('--danger'));
  // Регрессия Окна 24: бейдж праздника - отдельный признак, статус его не заменяет
  checkTrue('Регрессия Окна 24: праздничная ячейка сохранила и метку праздника, и кружок статуса', (await numHtml(D_HOLIDAY)).includes('day-dot--') && (await s.eval(`!!document.querySelector('[data-holiday-for="${D_HOLIDAY}"]')`)));
  await s.screenshot(`${SHOTS}-3-month-dots.png`);

  // ── Пункт 4: модалка дня ──────────────────────────────────────────────────
  const modalState = `(function(){
    const card = document.querySelector('#dayEditModal .day-edit-card');
    const row = document.querySelector('#dayEditModal .toggle-row');
    return {
      loading: card.classList.contains('is-loading'),
      toggleVisible: !!row.offsetParent,
      checked: document.getElementById('dayEditWorking').checked,
      state: document.getElementById('dayEditState').textContent,
      note: document.getElementById('dayEditNote').textContent,
    };
  })()`;

  await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_STD}"] .month-day-edit').click()`);
  await s.sleep(120); // ответ /schedule ещё в пути (фикстура держит ${SCHEDULE_DELAY_MS}ms)
  const during = await s.eval(modalState);
  checkTrue('Модалка во время загрузки: переключатель "Рабочий день" не показан вовсе', during.loading && !during.toggleVisible);
  check('Модалка во время загрузки: видно, что данные едут', during.note, 'Загружаю текущий график…');
  await s.screenshot(`${SHOTS}-4a-modal-loading.png`);

  await s.sleep(SCHEDULE_DELAY_MS + 500);
  const offStd = await s.eval(modalState);
  checkTrue('Выходной (смена 10:00-20:00): переключатель выключен', offStd.toggleVisible && offStd.checked === false);
  check('Выходной (смена 10:00-20:00): состояние названо словом', offStd.state, 'Сейчас: выходной');
  await s.screenshot(`${SHOTS}-4b-modal-dayoff-std.png`);
  await s.click('#dayEditClose');
  await s.sleep(300);

  // Ключевой случай пункта 4: ранняя смена, закрытая целиком.
  await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_EARLY}"] .month-day-edit').click()`);
  await s.sleep(SCHEDULE_DELAY_MS + 800);
  const offEarly = await s.eval(modalState);
  checkTrue('Выходной у РАННЕЙ смены 09:00-18:00: переключатель выключен (был включён до Окна 28)', offEarly.checked === false);
  check('Выходной у ранней смены: состояние названо словом', offEarly.state, 'Сейчас: выходной');
  check('Сетка Месяца на ту же дату согласна с модалкой', await s.eval(`document.querySelector('.month-day--real[data-date="${D_OFF_EARLY}"]').dataset.status`), 'off');
  await s.screenshot(`${SHOTS}-4c-modal-dayoff-early.png`);
  await s.click('#dayEditClose');
  await s.sleep(300);

  // Рабочий день - обратная сторона той же проверки
  await s.eval(`document.querySelector('.month-day--real[data-date="${D_NORMAL}"] .month-day-edit').click()`);
  await s.sleep(SCHEDULE_DELAY_MS + 800);
  const working = await s.eval(modalState);
  checkTrue('Рабочий день: переключатель включён', working.checked === true);
  check('Рабочий день: состояние названо словом и с часами', working.state, 'Сейчас: рабочий, 10:00–20:00');
  checkTrue('Рабочий день: поля времени показаны', await s.eval(`!!document.getElementById('dayEditFields').offsetParent`));
  await s.screenshot(`${SHOTS}-4d-modal-working.png`);
  // Переключение вручную обновляет ту же строку состояния
  await s.eval(`(function(){ const c = document.getElementById('dayEditWorking'); c.checked = false; c.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await s.sleep(200);
  check('Ручное выключение переключателя сразу меняет строку состояния', await s.eval(`document.getElementById('dayEditState').textContent`), 'Сейчас: выходной');
  await s.click('#dayEditClose');
  await s.sleep(300);

  // ── Регрессия Окна 18/25: клик по ячейке по-прежнему открывает "Мой день" ──
  await s.click(`.month-day--real[data-date="${D_NORMAL}"]`);
  await s.sleep(700);
  checkTrue('Регрессия: клик по числу открывает вкладку "День"', await s.eval(`document.getElementById('sp-day').checked`));
  check('Регрессия: и именно на этой дате', await s.eval(`document.getElementById('dayNavDate').dataset.value`), D_NORMAL);

  // ── Пункт 2 на мобильной ширине (DoD промпта) ─────────────────────────────
  await s.click('label[for="sp-month"]');
  await s.sleep(700);
  await s.setViewport(390, 900, true);
  await s.sleep(700);
  await checkMonthNavGeometry(s, 390);
  // Без прокрутки в кадр 390x900 попадает только шапка страницы - блок вкладок со
  // стрелками лежит ниже сгиба, а DoD промпта требует именно ЕГО на мобильном.
  // Скроллим с поправкой на липкую шапку - иначе она накрывает как раз тот ряд,
  // ради которого кадр и делается (тот же класс промаха, что уже ловили в проекте).
  await s.eval(`(function(){
    const header = document.querySelector('header');
    const offset = (header ? header.getBoundingClientRect().height : 0) + 24;
    const top = document.querySelector('.seg-bar').getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo(0, top);
  })()`);
  await s.sleep(400);
  await s.screenshot(`${SHOTS}-5-month-mobile.png`);
});

await new Promise((r) => setTimeout(r, 1500));

// ── Смоук crm-master.html: сетка Месяца там из того же модуля ───────────────
await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-master.html', 'master-test@alikhan.test');
  checkTrue('crm-master.html: прогон остался на странице мастера (не увело редиректом роли)', (await s.eval(`location.pathname`)).endsWith('crm-master.html'));
  await s.click('label[for="sp-month"]');
  await s.sleep(900);
  checkTrue('crm-master.html: кружки статуса в сетке', await s.eval(`!!document.querySelector('#monthGrid .day-dot')`));
  checkTrue('crm-master.html: эмодзи-статусов не осталось ни в сетке, ни в легенде', !(await s.eval(`document.querySelector('.panel-sp-month').innerHTML`)).match(/🟢|🟡|🔴/));
  checkTrue('crm-master.html: модалки редактирования дня у мастера по-прежнему нет', !(await s.eval(`!!document.querySelector('#monthGrid .month-day-edit')`)));
  await checkMonthNavGeometry(s, 1280);
  await s.screenshot(`${SHOTS}-6-master-month.png`);
});

server.close();
console.log(failures === 0 ? '\n✔ ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ' : `\n✘ ${failures} ПРОВАЛИВШИХСЯ ПРОВЕРОК`);
process.exit(failures === 0 ? 0 : 1);
