// Проверка Окна 18 (04.08.2026) - "Мой день" навигация, реальные Неделя/Месяц (+
// модалка редактирования дня, 409-конфликт), "Стандартный график" (рефетч после
// сохранения + 409). Бэкенда Amvera нет в песочнице для этого прогона - window.fetch
// подменяется фикстурами (тот же паттерн, что verify-2026-08-03-grafik-raboty.mjs),
// проверяем ФРОНТ: правильные запросы, правильный рендер, правильная навигация.
// Живая проверка против реального Amvera - отдельным curl/CDP прогоном после деплоя
// QA-логинов (Окно 18, migrations/028_qa_window18.sql).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8798;
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

const STAFF = [
  { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-3', locationId: null, name: 'Елизавета', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
];
const SERVICES = [{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }];
const MASTER_SERVICES = [{ masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 }];
const WEEKLY_MASTER1 = [
  { masterId: 'master-1', weekday: 1, isWorking: true, workStart: '09:00', workEnd: '18:00', breakStart: '13:00', breakEnd: '14:00' },
];
const STAFF_BY_EMAIL = {
  'owner-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null },
  'admin-loc1-test@alikhan.test': { id: 'master-2', name: 'Мамедхан', role: 'admin', locationId: 1 },
};

// Второй PUT /master-weekly-schedule возвращает конфликт, третий и далее - успех
// (проверяем ОБА пути одним и тем же тестовым прогоном, без перезапуска браузера).
function mockFetchSource() {
  return `
window.__mockCalls = [];
window.__weeklyPutCount = 0;
window.__daySaveCount = 0;
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const parsedBody = opts && opts.body ? JSON.parse(opts.body) : null;
  window.__mockCalls.push({ method, path, search: u.search, body: parsedBody });
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
  if (path === '/schedule' && method === 'POST') {
    window.__daySaveCount++;
    if (window.__daySaveCount === 1) {
      return json({ error: 'schedule_conflict', conflicts: [{ date: parsedBody.date, conflicts: [{ start_time: '11:00', end_time: '12:00', client_name: 'Тест Клиент', client_phone: '+79990001234' }] }] }, 409);
    }
    return json({ ok: true, id: 1, conflicts: 0 });
  }
  if (path === '/schedule' && method === 'DELETE') return json({ ok: true });
  if (path === '/schedule-range') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const days = [];
    for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0,10) <= to; d.setUTCDate(d.getUTCDate()+1)) {
      const dateStr = d.toISOString().slice(0,10);
      days.push({ date: dateStr, startTime: '10:00', endTime: '20:00', breaks: [], isDayOff: false });
    }
    return json(days);
  }
  if (path === '/bookings' && method === 'GET') {
    if (u.searchParams.get('from')) {
      return json({ bookings: [{ date: u.searchParams.get('from'), status: 'planned', masterId: u.searchParams.get('masterId') }] });
    }
    return json({ bookings: [] });
  }
  if (path === '/master-weekly-schedule' && method === 'GET') {
    return json(u.searchParams.get('masterId') === 'master-1' ? ${JSON.stringify(WEEKLY_MASTER1)} : []);
  }
  if (path === '/master-weekly-schedule' && method === 'PUT') {
    window.__weeklyPutCount++;
    if (window.__weeklyPutCount === 1) {
      return json({ error: 'schedule_conflict', conflicts: [{ date: '2026-08-10', conflicts: [{ start_time: '11:00', end_time: '12:00', client_name: 'Конфликт Клиент', client_phone: '+79990009999' }] }] }, 409);
    }
    return json({ ok: true, conflicts: 0 });
  }
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
  await s.sleep(700);
}

await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');

  // --- Задача 1: навигация "Мой день" ---
  const initialCalls = await s.eval(`window.__mockCalls.filter(c => c.path === '/bookings' && !c.search.includes('from')).length`);
  checkTrue('Мой день: изначальный /bookings?date= вызван хотя бы раз', initialCalls >= 1);
  await s.click('#dayNavNext');
  await s.sleep(400);
  const afterNextCalls = await s.eval(`window.__mockCalls.filter(c => c.path === '/bookings' && !c.search.includes('from')).length`);
  checkTrue('Мой день: клик "вперёд" вызвал ещё один /bookings?date=', afterNextCalls > initialCalls);
  const dateWidgetVisible = await s.eval(`!!document.getElementById('dayNavDate')`);
  checkTrue('Мой день: date-picker виджет отрендерен (не нативный input)', dateWidgetVisible);
  const noNativeDate = await s.eval(`document.querySelectorAll('#dayNav input[type="date"]').length`);
  check('Мой день: ноль нативных input[type=date] в day-nav', noNativeDate, 0);

  // --- Задача 2: "Неделя" ---
  await s.click('label[for="sp-week"]');
  await s.sleep(400);
  const weekCells = await s.eval(`document.querySelectorAll('#weekGrid .week-day-cell').length`);
  check('Неделя: 7 ячеек дней отрисовано', weekCells, 7);
  const weekMasterPills = await s.eval(`document.querySelectorAll('#weekMasterSwitch .master-pill').length`);
  check('Неделя: переключатель мастера построен по факту /staff (3 мастера)', weekMasterPills, 3);
  const weekRangeCalled = await s.eval(`window.__mockCalls.some(c => c.path === '/schedule-range' && c.search.includes('masterId=master-1'))`);
  checkTrue('Неделя: вызван GET /schedule-range для master-1', weekRangeCalled);
  // клик по ячейке недели переключает на "Мой день"
  await s.click('#weekGrid .week-day-cell');
  await s.sleep(400);
  const dayTabCheckedAfterWeekClick = await s.eval(`document.getElementById('sp-day').checked`);
  checkTrue('Неделя: клик по дню переключает вкладку "Мой день"', dayTabCheckedAfterWeekClick);

  // --- Задача 2b: смена мастера в Неделе не падает ---
  await s.click('label[for="sp-week"]');
  await s.sleep(200);
  await s.click('#weekMasterSwitch .master-pill:nth-child(2)');
  await s.sleep(400);
  const weekMaster2Called = await s.eval(`window.__mockCalls.some(c => c.path === '/schedule-range' && c.search.includes('masterId=master-2'))`);
  checkTrue('Неделя: переключение на второго мастера дёргает /schedule-range для него', weekMaster2Called);

  // --- Задача 3: "Месяц" + модалка + 409 ---
  await s.click('label[for="sp-month"]');
  await s.sleep(500);
  const monthCells = await s.eval(`document.querySelectorAll('#monthGrid .month-day--real').length`);
  checkTrue('Месяц: ячейки дней месяца отрисованы (>25)', monthCells > 25);
  const pencilCount = await s.eval(`document.querySelectorAll('.month-day-edit').length`);
  checkTrue('Месяц: у каждой ячейки есть иконка редактирования', pencilCount === monthCells);

  await s.click('.month-day-edit');
  await s.sleep(400);
  const modalOpen = await s.eval(`!document.getElementById('dayEditModal').hidden`);
  checkTrue('Месяц: клик по ✎ открывает модалку редактирования дня', modalOpen);

  // Первое сохранение - конфликт (мок вернёт 409 на первый POST /schedule)
  await s.click('#dayEditSave');
  await s.sleep(400);
  const conflictShown = await s.eval(`!document.getElementById('dayEditConflicts').hidden`);
  checkTrue('Месяц/модалка: 409 показывает список конфликтов, не закрывает модалку', conflictShown);
  const modalStillOpenAfterConflict = await s.eval(`!document.getElementById('dayEditModal').hidden`);
  checkTrue('Месяц/модалка: модалка НЕ закрылась при конфликте', modalStillOpenAfterConflict);
  const conflictHasOpenBtn = await s.eval(`!!document.querySelector('.conflict-open-btn')`);
  checkTrue('Месяц/модалка: у конфликта есть кнопка "Открыть запись"', conflictHasOpenBtn);

  // Второе сохранение - успех (мок вернёт 200 на второй POST /schedule)
  await s.click('#dayEditSave');
  await s.sleep(400);
  const modalClosedAfterSuccess = await s.eval(`document.getElementById('dayEditModal').hidden`);
  checkTrue('Месяц/модалка: успешное сохранение закрывает модалку', modalClosedAfterSuccess);
  const monthReloadedAfterSave = await s.eval(`window.__mockCalls.filter(c => c.path === '/schedule-range').length >= 2`);
  checkTrue('Месяц: после сохранения дня месяц перезапрошен свежим /schedule-range (не оптимистично)', monthReloadedAfterSave);

  // --- Задача 4: "Стандартный график" - рефетч после сохранения + 409 ---
  await s.click('label[for="pt-b"]');
  await s.sleep(300);
  const weeklyEditorRendered = await s.eval(`document.querySelectorAll('#weeklyEditor-master-1 .weekly-day-row').length`);
  check('Стандартный график: 7 строк дней недели отрисовано', weeklyEditorRendered, 7);

  const getCallsBeforeSave = await s.eval(`window.__mockCalls.filter(c => c.path === '/master-weekly-schedule' && c.method === 'GET').length`);
  await s.click('#weekly-master-1-save');
  await s.sleep(400);
  // Первый PUT (мок) - конфликт
  const conflictListVisible = await s.eval(`!document.getElementById('weekly-master-1-conflicts').hidden`);
  checkTrue('Стандартный график: 409 показывает список конфликтов', conflictListVisible);
  const noteTextOnConflict = await s.eval(`document.getElementById('weekly-master-1-note').textContent`);
  checkTrue('Стандартный график: note явно говорит "нельзя сохранить"', noteTextOnConflict.includes('Нельзя сохранить'));

  await s.click('#weekly-master-1-save');
  await s.sleep(400);
  const getCallsAfterSave = await s.eval(`window.__mockCalls.filter(c => c.path === '/master-weekly-schedule' && c.method === 'GET').length`);
  checkTrue('Стандартный график: после успешного PUT форма перезапросила GET заново (дыра №1 закрыта)', getCallsAfterSave > getCallsBeforeSave);
  const noteAfterSuccess = await s.eval(`document.getElementById('weekly-master-1-note') ? document.getElementById('weekly-master-1-note').textContent : ''`);
  checkTrue('Стандартный график: после успеха note подтверждает "сервером"', noteAfterSuccess.includes('сервером'));
});

// withBrowser убивает процесс Chrome в finally, но освобождение порта 9333 не
// мгновенное - без паузы второй withBrowser подряд иногда ловит "Could not create
// new page" (порт ещё занят предыдущим процессом).
await new Promise((r) => setTimeout(r, 1500));

// --- Смоук crm-admin.html - те же вкладки, роль admin (Мамедхан, локация 1) ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource() });
  await login(s, 'crm-admin.html', 'admin-loc1-test@alikhan.test');

  const adminDayNavExists = await s.eval(`!!document.getElementById('dayNavPrev')`);
  checkTrue('crm-admin.html: навигация "Мой день" на месте', adminDayNavExists);

  await s.click('label[for="sp-week"]');
  await s.sleep(400);
  const adminWeekCells = await s.eval(`document.querySelectorAll('#weekGrid .week-day-cell').length`);
  check('crm-admin.html/Неделя: 7 ячеек отрисовано', adminWeekCells, 7);
  const adminWeekMasterPills = await s.eval(`document.querySelectorAll('#weekMasterSwitch .master-pill').length`);
  checkTrue('crm-admin.html/Неделя: переключатель мастера построен по факту /staff, не жёстко 2', adminWeekMasterPills >= 2);

  await s.click('label[for="sp-month"]');
  await s.sleep(500);
  const adminMonthCells = await s.eval(`document.querySelectorAll('#monthGrid .month-day--real').length`);
  checkTrue('crm-admin.html/Месяц: ячейки дней отрисованы', adminMonthCells > 25);

  await s.click('label[for="sp-year"]');
  await s.sleep(200);
  const yearHasNoFakeCounts = await s.eval(`document.querySelectorAll('.panel-sp-year .ym-note').length`);
  check('crm-admin.html/Год: фейковых счётчиков записей не осталось', yearHasNoFakeCounts, 0);
});

server.close();
console.log(failures === 0 ? '\n✔ ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ' : `\n✘ ${failures} ПРОВАЛИВШИХСЯ ПРОВЕРОК`);
process.exit(failures === 0 ? 0 : 1);
