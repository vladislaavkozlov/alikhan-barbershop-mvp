// Проверка новой фичи "стандартный перерыв/выходной" (03.08.2026, второй запрос
// Влада в этой сессии): 4 категории в форме запроса мастера (отгул/отпуск/
// перерыв-стандартный/выходной-стандартный), кастомный time-picker вместо
// input type=text, прямой редактор владельца для recurring-правил. Бэкенда Amvera
// нет в песочнице (реальная БД не трогается без явного разрешения) - window.fetch
// подменяется фикстурами, проверяем ФРОНТ (рендер полей, сбор payload, отправка
// правильных запросов) тем же паттерном, что verify-2026-08-03-vlad-fixes.mjs.
// server.mjs (getEffectiveBreaks/isoWeekday/схема) проверены отдельно: isoWeekday -
// ручной прогон против реального календаря (см. отчёт сессии), SQL - код-ревью,
// живая проверка на реальной БД - после деплоя, не отсюда.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8796;
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
    return json([{ id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true }]);
  }
  if (path === '/services') return json([{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }]);
  if (path === '/master-services') return json([{ masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 }]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 0 }]);
  if (path === '/schedule') return json([]);
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/schedule-recurring' && method === 'GET') {
    return json([{ id: 7, masterId: 'master-1', ruleType: 'break', weekdays: [1,2,3,4,5], startTime: '13:00', endTime: '14:00', startsOn: '2026-08-01' }]);
  }
  if (path === '/schedule-recurring' && method === 'POST') return json({ ok: true, id: 42 });
  if (/\\/schedule-recurring\\/\\d+/.test(path) && method === 'DELETE') return json({ ok: true });
  if (path === '/schedule-requests' && method === 'GET') return json([]);
  if (path === '/schedule-requests' && method === 'POST') return json({ ok: true, id: 99 });
  return json({}, 404);
};
`;
}

const STAFF_BY_EMAIL = {
  'owner-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null },
  'master1-test@alikhan.test': { id: 'master-1', name: 'Алиовсад', role: 'master', locationId: null },
};

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✔' : '✘'} ${label}` + (ok ? '' : ` — ожидал ${JSON.stringify(expected)}, получил ${JSON.stringify(actual)}`));
  if (!ok) failures++;
  return ok;
}

// --- Мастер: форма "Запросить изменение графика" - 4 категории ---
await withBrowser(async (s) => {
  await s.setViewport(430, 1600, true);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/crm-master.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'master1-test@alikhan.test';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(600);

  // Дефолт (otgul): время видно, дни недели скрыты
  const defaultState = await s.eval(`JSON.stringify({
    timeFieldsVisible: getComputedStyle(document.getElementById('reqTimeFields')).display !== 'none',
    weekdaysVisible: getComputedStyle(document.getElementById('reqWeekdaysWrap')).display !== 'none',
    dateToVisible: getComputedStyle(document.getElementById('reqDateToWrap')).display !== 'none',
  })`);
  check('otgul (дефолт): время видно, дни недели скрыты, "по" видно', JSON.parse(defaultState), { timeFieldsVisible: true, weekdaysVisible: false, dateToVisible: true });

  // Переключаем на "Перерыв (стандартный)" - должны появиться дни недели, исчезнуть "дата по"
  await s.eval(`(function(){
    const sel = document.getElementById('reqCategory');
    sel.value = 'pereryv_standard';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.sleep(100);
  const recurringState = await s.eval(`JSON.stringify({
    timeFieldsVisible: getComputedStyle(document.getElementById('reqTimeFields')).display !== 'none',
    weekdaysVisible: getComputedStyle(document.getElementById('reqWeekdaysWrap')).display !== 'none',
    dateToVisible: getComputedStyle(document.getElementById('reqDateToWrap')).display !== 'none',
    dateFromLabel: document.getElementById('reqDateFromLabel').textContent,
  })`);
  check('pereryv_standard: время видно, дни недели видны, "по" скрыто, лейбл "Действует с"', JSON.parse(recurringState),
    { timeFieldsVisible: true, weekdaysVisible: true, dateToVisible: false, dateFromLabel: 'Действует с' });

  // time-picker реально работает (не текстовое поле)
  const timePickerCheck = await s.eval(`JSON.stringify({
    isTextInput: !!document.querySelector('#reqStartTime-slot input[type=text]'),
    hasCustomSelect: !!document.querySelector('#reqStartTime-slot .custom-select'),
    defaultValue: document.querySelector('#reqStartTime-slot .custom-select')?.dataset.value,
  })`);
  check('время выбирается кастомным дропдауном, не text input', JSON.parse(timePickerCheck), { isTextInput: false, hasCustomSelect: true, defaultValue: '13:00' });

  // Выбираем другое время кликом по опции в дропдауне
  await s.eval(`(function(){
    const trigger = document.querySelector('#reqStartTime-slot .custom-select-trigger');
    trigger.click();
    const opt = [...document.querySelectorAll('#reqStartTime-slot .custom-select-option')].find(o => o.textContent === '15:30');
    opt.click();
  })()`);
  await s.sleep(50);
  const pickedTime = await s.eval(`document.querySelector('#reqStartTime-slot .custom-select').dataset.value`);
  check('клик по опции 15:30 в дропдауне реально меняет значение', pickedTime, '15:30');

  // Отмечаем 3 дня недели и отправляем - проверяем реальный payload
  await s.eval(`(function(){
    ['1','3','5'].forEach(v => document.querySelector('#reqWeekdays input[value="' + v + '"]').click());
    document.getElementById('reqEndTime-slot').querySelector('.custom-select-trigger').click();
    [...document.querySelectorAll('#reqEndTime-slot .custom-select-option')].find(o => o.textContent === '16:00').click();
    document.getElementById('reqDateFrom').value = '2026-08-10';
  })()`);
  await s.eval(`document.getElementById('reqSubmitBtn').click()`);
  await s.sleep(200);
  const sentBody = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'POST' && c.path === '/schedule-requests').body)`);
  console.log('Отправленный payload (pereryv_standard, Пн/Ср/Пт, 15:30-16:00):', sentBody);
  check('payload: category=pereryv_standard, requestType=break, weekdays=[1,3,5], время 15:30-16:00, dateTo=null',
    JSON.parse(sentBody),
    { category: 'pereryv_standard', requestType: 'break', dateFrom: '2026-08-10', dateTo: null, startTime: '15:30', endTime: '16:00', weekdays: [1, 3, 5], masterComment: null });

  await s.eval(`document.getElementById('pt-c').click()`);
  await s.sleep(150);
  await s.eval(`document.getElementById('reqCategory').scrollIntoView({block:'center'})`);
  await s.sleep(150);
  await s.screenshot(`${outDir}/v-0803-recurring-master-form.png`);
});
await sleep(600);

// --- Владелец: прямой редактор recurring-правил ---
await withBrowser(async (s) => {
  await s.setViewport(1280, 1600, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'owner-test@alikhan.test';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(700);

  // Текущее правило из фикстуры реально отрисовано
  const currentRule = await s.eval(`document.querySelector('#recurringEditor-master-1 .breaks-list')?.textContent`);
  check('текущее стандартное правило master-1 отрисовано из живых данных (фикстура: Пн-Пт 13:00-14:00)',
    currentRule?.includes('13:00') && currentRule?.includes('14:00') && currentRule?.includes('Пн'), true);

  // Разовый (не-стандартный) редактор тоже использует time-picker, не text input
  const oneOffTimePicker = await s.eval(`JSON.stringify({
    isTextInput: !!document.querySelector('#schedStart-master-1-slot input[type=text]'),
    hasCustomSelect: !!document.querySelector('#schedStart-master-1-slot .custom-select'),
  })`);
  check('разовый редактор даты (schedStart) тоже кастомный дропдаун, не text input', JSON.parse(oneOffTimePicker), { isTextInput: false, hasCustomSelect: true });

  // Ставим новое стандартное правило (Выходной по Вс) и проверяем реальный POST
  await s.eval(`(function(){
    document.getElementById('recurringType-master-1').value = 'day_off';
    document.getElementById('recurringType-master-1').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#recurringWeekdays-master-1 input[value="7"]').click();
    document.getElementById('recurringStartsOn-master-1').value = '2026-08-10';
  })()`);
  const timeFieldsHiddenForDayOff = await s.eval(`getComputedStyle(document.getElementById('recurringTimeFields-master-1')).display === 'none'`);
  check('тип "Выходной" скрывает поля времени', timeFieldsHiddenForDayOff, true);
  await s.eval(`document.getElementById('recurringSave-master-1').click()`);
  await s.sleep(200);
  const savedBody = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'POST' && c.path === '/schedule-recurring').body)`);
  console.log('Отправленный payload (владелец ставит "Выходной по Вс"):', savedBody);
  check('payload: masterId=master-1, ruleType=day_off, weekdays=[7], время=null',
    JSON.parse(savedBody),
    { masterId: 'master-1', ruleType: 'day_off', weekdays: [7], startTime: null, endTime: null, startsOn: '2026-08-10' });

  // Отключаем правило из фикстуры кнопкой ✕ - реальный DELETE
  await s.eval(`document.querySelector('#recurringCurrent-master-1 [data-rule-id]')?.click()`);
  await s.sleep(200);
  const deleteCall = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'DELETE'))`);
  console.log('DELETE после клика ✕:', deleteCall);
  check('клик ✕ отправляет реальный DELETE /schedule-recurring/7', JSON.parse(deleteCall)?.path, '/schedule-recurring/7');

  await s.eval(`document.getElementById('pt-b').click()`);
  await s.sleep(150);
  await s.eval(`document.getElementById('recurringEditor-master-1').scrollIntoView({block:'center'})`);
  await s.sleep(150);
  await s.screenshot(`${outDir}/v-0803-recurring-owner-editor.png`);
});

server.close();
console.log(failures === 0 ? `\nВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ` : `\n${failures} ПРОВЕРОК ПРОВАЛЕНО`);
process.exit(failures === 0 ? 0 : 1);
