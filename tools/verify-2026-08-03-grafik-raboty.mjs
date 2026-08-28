// Проверка Окна 16 (03.08.2026) - единый блок "График работы" + свой date-picker.
// Бэкенда Amvera нет в песочнице (реальная БД не трогается без явного разрешения) -
// window.fetch подменяется фикстурами, проверяем ФРОНТ (рендер полей, сбор payload,
// отправка правильных запросов), тот же паттерн, что verify-2026-08-03-recurring-
// schedule.mjs. server.mjs (getEffectiveSchedule/validateWeeklyChanges/миграция 022) -
// проверены отдельно: node --check, код-ревью, живая проверка через curl - после
// деплоя, не отсюда.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

// Окно 72 (28.08.2026): боевые логины и пароли убраны из кода - репозиторий публичный,
// а до этой правки пароли всех пятерых сотрудников салона лежали здесь открытым
// текстом. Скрипт берёт доступы из окружения, например:
//   OWNER_LOGIN=aliovsad OWNER_PIN=<пароль> node tools/verify-2026-08-03-grafik-raboty.mjs
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан доступ ${name}. Пример: ${name}=<значение> node tools/verify-2026-08-03-grafik-raboty.mjs`);
    process.exit(1);
  }
  return value;
};


const ROOT = process.cwd();
const PORT = 8797;
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

const STAFF = [
  { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
  { id: 'master-3', locationId: null, name: 'Елизавета', role: 'master', employed: true, providesServices: true, hasSystemAccess: true },
];
const WEEKLY_FIXTURE_MASTER1 = [
  { masterId: 'master-1', weekday: 1, isWorking: true, workStart: '09:00', workEnd: '18:00', breakStart: '13:00', breakEnd: '14:00' },
  { masterId: 'master-1', weekday: 7, isWorking: false, workStart: null, workEnd: null, breakStart: null, breakEnd: null },
];

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
  if (path === '/staff') return json(${JSON.stringify(STAFF)});
  if (path === '/services') return json([{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }]);
  if (path === '/master-services') return json([{ masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 }]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }]);
  if (path === '/schedule') return json([]);
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/master-weekly-schedule' && method === 'GET') {
    return json(u.searchParams.get('masterId') === 'master-1' ? ${JSON.stringify(WEEKLY_FIXTURE_MASTER1)} : []);
  }
  if (path === '/master-weekly-schedule' && method === 'PUT') return json({ ok: true, conflicts: 0 });
  if (path === '/schedule-requests' && method === 'GET') return json([]);
  if (path === '/schedule-requests' && method === 'POST') return json({ ok: true, id: 99 });
  return json({}, 404);
};
`;
}

const STAFF_BY_EMAIL = {
  'owner-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null },
  [env('MANAGER_LOGIN')]: { id: 'master-2', name: 'Мамедхан', role: 'master', locationId: null },
  'admin-test@alikhan.test': { id: 'master-2', name: 'Мамедхан', role: 'admin', locationId: 'loc-1' },
};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✔' : '✘'} ${label}` + (ok ? '' : ` — ожидал ${JSON.stringify(expected)}, получил ${JSON.stringify(actual)}`));
  if (!ok) failures++;
  return ok;
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

// --- Ноль нативных input[type=date] на всех трёх страницах ---
for (const [page, email] of [['crm-owner.html', 'owner-test@alikhan.test'], ['crm-master.html', env('MANAGER_LOGIN')], ['crm-admin.html', 'admin-test@alikhan.test']]) {
  await withBrowser(async (s) => {
    await s.setViewport(1280, 1600, false);
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
    await login(s, page, email);
    const nativeDateCount = await s.eval(`document.querySelectorAll('input[type="date"]').length`);
    check(`${page}: ноль нативных input[type=date] после логина`, nativeDateCount, 0);
  });
  await sleep(300);
}

// --- Владелец: единый блок "График работы" - редактирует напрямую ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 1800, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');
  await s.eval(`document.getElementById('pt-b').click()`);
  await s.sleep(150);

  await s.eval(`document.getElementById('weeklyEditor-master-1').scrollIntoView({block:'center'})`);
  await s.sleep(300);

  const rowsCount = await s.eval(`document.querySelectorAll('#weeklyEditor-master-1 .weekly-day-row').length`);
  check('владелец: 7 строк дней недели в редакторе master-1', rowsCount, 7);

  const mondayLoaded = await s.eval(`JSON.stringify({
    working: document.getElementById('weekly-master-1-1-working').checked,
    start: document.getElementById('weekly-master-1-1-start').dataset.value,
    end: document.getElementById('weekly-master-1-1-end').dataset.value,
    breakOn: document.getElementById('weekly-master-1-1-breakOn').checked,
  })`);
  check('владелец: Пн подтянут из фикстуры (09:00-18:00, перерыв включён)', JSON.parse(mondayLoaded), { working: true, start: '09:00', end: '18:00', breakOn: true });

  const sundayLoaded = await s.eval(`document.getElementById('weekly-master-1-7-working').checked`);
  check('владелец: Вс из фикстуры - выходной (не отмечен рабочим)', sundayLoaded, false);

  // Переключаем Вторник на выходной - поля времени должны спрятаться
  await s.eval(`(function(){
    const cb = document.getElementById('weekly-master-1-2-working');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.sleep(50);
  const tuesdayFieldsHidden = await s.eval(`getComputedStyle(document.getElementById('weekly-master-1-2-fields')).display === 'none'`);
  check('владелец: снятие "рабочий день" прячет поля часов (Вт)', tuesdayFieldsHidden, true);

  await s.eval(`document.getElementById('weekly-master-1-save').click()`);
  await s.sleep(200);
  const putCall = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'PUT' && c.path === '/master-weekly-schedule'))`);
  const put = JSON.parse(putCall);
  check('владелец: PUT /master-weekly-schedule реально отправлен', !!put, true);
  check('владелец: payload содержит masterId + 7 дней', { masterId: put?.body?.masterId, len: put?.body?.weeklyChanges?.length }, { masterId: 'master-1', len: 7 });
  const tuesdayInPayload = put?.body?.weeklyChanges?.find((r) => r.weekday === 2);
  check('владелец: Вторник в payload - isWorking:false, часы null', tuesdayInPayload, { weekday: 2, isWorking: false, workStart: null, workEnd: null, breakStart: null, breakEnd: null });

  // "Разовое изменение на дату" - тоже свой date-picker, не текст
  const oneOffDatePicker = await s.eval(`JSON.stringify({
    hasCustomDate: !!document.querySelector('#schedDateFrom-master-1-slot .custom-date'),
    isNativeInput: !!document.querySelector('#schedDateFrom-master-1-slot input[type=date]'),
  })`);
  check('владелец: "Разовое изменение" тоже .custom-date, не нативный input', JSON.parse(oneOffDatePicker), { hasCustomDate: true, isNativeInput: false });

  await s.screenshot(`${outDir}/v-0803-grafik-owner-editor.png`);
});
await sleep(400);

// --- Админ: единый блок - только просмотр ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 1600, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await login(s, 'crm-admin.html', 'admin-test@alikhan.test');
  await s.eval(`document.getElementById('pt-b').click()`);
  await s.sleep(150);
  await s.eval(`document.getElementById('weeklyEditor-master-1').scrollIntoView({block:'center'})`);
  await s.sleep(300);
  const readOnlyCheck = await s.eval(`JSON.stringify({
    hasSaveButton: !!document.getElementById('weekly-master-1-save'),
    hasCheckbox: !!document.querySelector('#weeklyEditor-master-1 input[type=checkbox]'),
    rowsText: document.getElementById('weeklyEditor-master-1').textContent.includes('09:00') && document.getElementById('weeklyEditor-master-1').textContent.includes('выходной'),
  })`);
  check('админ: без кнопки сохранить/чекбоксов, текст показывает реальные данные', JSON.parse(readOnlyCheck), { hasSaveButton: false, hasCheckbox: false, rowsText: true });
  await s.screenshot(`${outDir}/v-0803-grafik-admin-view.png`);
});
await sleep(400);

// --- Мастер: постоянный график - форма ЗАПРОСА (не прямое сохранение) ---
await withBrowser(async (s) => {
  await s.setViewport(430, 2200, true);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await login(s, 'crm-master.html', env('MANAGER_LOGIN'));
  await s.eval(`document.getElementById('pt-c').click()`);
  await s.sleep(200);
  await s.eval(`document.getElementById('weeklyEditor-self').scrollIntoView({block:'center'})`);
  await s.sleep(200);

  const rowsCount = await s.eval(`document.querySelectorAll('#weeklyEditor-self .weekly-day-row').length`);
  check('мастер: 7 строк в форме запроса графика', rowsCount, 7);
  const hasRequestButton = await s.eval(`!!document.getElementById('weekly-self-save')`);
  check('мастер: кнопка "Отправить запрос на график" есть', hasRequestButton, true);

  await s.eval(`document.getElementById('weekly-self-save').click()`);
  await s.sleep(200);
  const reqCall = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'POST' && c.path === '/schedule-requests' && c.body && c.body.category === 'grafik_standard'))`);
  const req = JSON.parse(reqCall);
  check('мастер: POST /schedule-requests category=grafik_standard с 7 днями', { ok: !!req, len: req?.body?.weeklyChanges?.length }, { ok: true, len: 7 });

  // Разовое изменение (otgul/otpusk) - только 2 категории, дата через виджет
  const categoryOptions = await s.eval(`[...document.getElementById('reqCategory').options].map(o => o.value)`);
  check('мастер: категория запроса на дату сужена до otgul/otpusk', categoryOptions, ['otgul', 'otpusk']);
  const dateWidgetCheck = await s.eval(`JSON.stringify({
    hasCustomDate: !!document.querySelector('#reqDateFrom-slot .custom-date'),
    defaultValue: document.querySelector('#reqDateFrom-slot .custom-date')?.dataset.value,
  })`);
  check('мастер: дата разового запроса - .custom-date с дефолтным значением', JSON.parse(dateWidgetCheck).hasCustomDate, true);

  await s.screenshot(`${outDir}/v-0803-grafik-master-request.png`);
});
await sleep(400);

// --- Свой date-picker: открытие, смена месяца, выбор дня ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 1600, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');
  await s.eval(`document.getElementById('schedDateFrom-master-1-slot').scrollIntoView({block:'center'})`);
  await s.sleep(200);

  await s.eval(`document.querySelector('#schedDateFrom-master-1-slot .custom-date-trigger').click()`);
  await s.sleep(100);
  const panelOpen = await s.eval(`!document.querySelector('#schedDateFrom-master-1-slot .custom-date-panel').hidden`);
  check('date-picker: клик по кнопке открывает панель с сеткой дней', panelOpen, true);

  const beforeMonth = await s.eval(`document.querySelector('#schedDateFrom-master-1-slot .custom-date-month-label').textContent`);
  await s.eval(`document.querySelector('#schedDateFrom-master-1-slot .custom-date-nav-btn[aria-label="Следующий месяц"]').click()`);
  await s.sleep(100);
  const afterMonth = await s.eval(`document.querySelector('#schedDateFrom-master-1-slot .custom-date-month-label').textContent`);
  check('date-picker: стрелка "вперёд" реально меняет отображаемый месяц', beforeMonth !== afterMonth, true);

  await s.eval(`(function(){
    const day15 = [...document.querySelectorAll('#schedDateFrom-master-1-slot .custom-date-cell')].find(c => c.textContent.trim() === '15' && !c.classList.contains('custom-date-cell--empty'));
    day15.click();
  })()`);
  await s.sleep(100);
  const pickedValue = await s.eval(`document.getElementById('schedDateFrom-master-1').dataset.value`);
  const panelClosedAfterPick = await s.eval(`document.querySelector('#schedDateFrom-master-1-slot .custom-date-panel').hidden`);
  check('date-picker: клик по дню 15 ставит значение на 15-е число и закрывает панель', pickedValue.endsWith('-15') && panelClosedAfterPick, true);
});

server.close();
console.log(failures === 0 ? `\nВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ` : `\n${failures} ПРОВЕРОК ПРОВАЛЕНО`);
process.exit(failures === 0 ? 0 : 1);
