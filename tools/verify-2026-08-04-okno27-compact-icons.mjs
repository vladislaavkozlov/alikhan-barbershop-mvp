// Проверка Окна 27 (04.08.2026) - компактные иконки дней недели в редакторе графика
// владельца + кнопка "Применить ко всем дням" для перерыва. Бэкенда Amvera нет в
// песочнице (реальная БД не трогается без явного разрешения) - window.fetch
// подменяется фикстурами, тот же паттерн, что verify-2026-08-03-grafik-raboty.mjs.
// Проверяем ФРОНТ (рендер иконок, раскрытие/сворачивание панели, копирование
// перерыва, итоговый PUT-payload) - api/server.mjs в этом окне не менялся вообще.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8798;
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
// Пн (1) - рабочий с перерывом 13-14, Вс (7) - выходной, Вт-Сб (2-6) - рабочие БЕЗ
// перерыва (byWeekday.get(wd) даёт null → дефолт isWorking=true, hasBreak=false в
// buildWeeklyDayRow) - ровно нужный набор, чтобы проверить "Применить ко всем дням".
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
  await s.setViewport(1280, 1800, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource(STAFF_BY_EMAIL) });
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');
  await s.eval(`document.getElementById('pt-b').click()`);
  await s.sleep(150);
  await s.eval(`document.getElementById('weeklyEditor-master-1').scrollIntoView({block:'center'})`);
  await s.sleep(300);

  // --- 7 компактных иконок вместо 7 всегда открытых карточек ---
  const iconCount = await s.eval(`document.querySelectorAll('#weeklyEditor-master-1 .weekday-icon').length`);
  check('7 иконок дней недели в редакторе master-1', iconCount, 7);
  const rowsStillExist = await s.eval(`document.querySelectorAll('#weeklyEditor-master-1 .weekly-day-row').length`);
  check('под капотом остались все 7 панелей (разметка не удалена, просто скрыта)', rowsStillExist, 7);
  const noneOpenInitially = await s.eval(`document.querySelectorAll('#weeklyEditor-master-1 .weekly-day-panel.is-open').length`);
  check('изначально ни одна панель дня не раскрыта', noneOpenInitially, 0);
  const mondayIconClass = await s.eval(`document.getElementById('weekly-master-1-1-icon').className`);
  check('иконка Пн визуально помечена рабочим днём (is-working)', mondayIconClass.includes('is-working'), true);
  const sundayIconClass = await s.eval(`document.getElementById('weekly-master-1-7-icon').className`);
  check('иконка Вс визуально помечена выходным (is-off, не is-working)', { off: sundayIconClass.includes('is-off'), working: sundayIconClass.includes('is-working') }, { off: true, working: false });

  // --- Клик по иконке Пн раскрывает панель с реальными данными фикстуры ---
  await s.eval(`document.getElementById('weekly-master-1-1-icon').click()`);
  await s.sleep(100);
  const mondayPanelOpen = await s.eval(`document.getElementById('weekly-master-1-1-panel').classList.contains('is-open')`);
  check('клик по иконке Пн раскрывает панель Пн', mondayPanelOpen, true);
  const mondayExpandedAttr = await s.eval(`document.getElementById('weekly-master-1-1-icon').getAttribute('aria-expanded')`);
  check('aria-expanded=true на открытой иконке', mondayExpandedAttr, 'true');
  const mondayData = await s.eval(`JSON.stringify({
    start: document.getElementById('weekly-master-1-1-start').dataset.value,
    end: document.getElementById('weekly-master-1-1-end').dataset.value,
    breakOn: document.getElementById('weekly-master-1-1-breakOn').checked,
  })`);
  check('панель Пн показывает реальные данные фикстуры (09:00-18:00, перерыв вкл)', JSON.parse(mondayData), { start: '09:00', end: '18:00', breakOn: true });

  // --- Аккордеон: клик по иконке Вт закрывает Пн, открывает Вт ---
  await s.eval(`document.getElementById('weekly-master-1-2-icon').click()`);
  await s.sleep(100);
  const accordionState = await s.eval(`JSON.stringify({
    mondayOpen: document.getElementById('weekly-master-1-1-panel').classList.contains('is-open'),
    tuesdayOpen: document.getElementById('weekly-master-1-2-panel').classList.contains('is-open'),
  })`);
  check('открытие Вт закрывает Пн (один день открыт за раз)', JSON.parse(accordionState), { mondayOpen: false, tuesdayOpen: true });

  // --- Повторный клик по той же иконке сворачивает панель ---
  await s.eval(`document.getElementById('weekly-master-1-2-icon').click()`);
  await s.sleep(100);
  const tuesdayClosedAgain = await s.eval(`document.getElementById('weekly-master-1-2-panel').classList.contains('is-open')`);
  check('повторный клик по той же иконке сворачивает панель', tuesdayClosedAgain, false);

  // --- "Применить ко всем дням" - копирует перерыв Пн на рабочие Вт-Сб, не трогает Вс ---
  await s.eval(`document.getElementById('weekly-master-1-1-icon').click()`);
  await s.sleep(100);
  const applyBtnVisibleBefore = await s.eval(`getComputedStyle(document.getElementById('weekly-master-1-1-applyAll')).display !== 'none'`);
  check('кнопка "Применить ко всем дням" видна у Пн (есть перерыв)', applyBtnVisibleBefore, true);
  await s.eval(`document.getElementById('weekly-master-1-1-applyAll').click()`);
  await s.sleep(100);
  const wednesdayAfterApply = await s.eval(`JSON.stringify({
    breakOn: document.getElementById('weekly-master-1-3-breakOn').checked,
    breakStart: document.getElementById('weekly-master-1-3-breakStart').dataset.value,
    breakEnd: document.getElementById('weekly-master-1-3-breakEnd').dataset.value,
  })`);
  check('Ср (рабочий день без перерыва) получила перерыв 13:00-14:00 с Пн', JSON.parse(wednesdayAfterApply), { breakOn: true, breakStart: '13:00', breakEnd: '14:00' });
  const sundayNotTouched = await s.eval(`document.getElementById('weekly-master-1-7-breakOn').checked`);
  check('Вс (выходной) перерыв не получила - копирование пропускает нерабочие дни', sundayNotTouched, false);

  // --- Ручное переопределение одного дня ПОСЛЕ массового применения всё ещё работает ---
  await s.eval(`document.getElementById('weekly-master-1-2-icon').click()`);
  await s.sleep(100);
  await s.eval(`(function(){
    const el = document.getElementById('weekly-master-1-2-breakOn');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.sleep(50);
  const tuesdayOverridden = await s.eval(`document.getElementById('weekly-master-1-2-breakOn').checked`);
  check('Вт можно вручную переопределить после массового применения (перерыв выключен)', tuesdayOverridden, false);

  // --- Сохранение по-прежнему работает через тот же PUT /master-weekly-schedule ---
  await s.eval(`document.getElementById('weekly-master-1-save').click()`);
  await s.sleep(200);
  const putCall = await s.eval(`JSON.stringify(window.__mockCalls.find(c => c.method === 'PUT' && c.path === '/master-weekly-schedule'))`);
  const put = JSON.parse(putCall);
  check('PUT /master-weekly-schedule реально отправлен', !!put, true);
  check('payload содержит masterId + 7 дней', { masterId: put?.body?.masterId, len: put?.body?.weeklyChanges?.length }, { masterId: 'master-1', len: 7 });
  const wedInPayload = put?.body?.weeklyChanges?.find((r) => r.weekday === 3);
  check('Ср в payload несёт скопированный перерыв 13:00-14:00', { breakStart: wedInPayload?.breakStart, breakEnd: wedInPayload?.breakEnd }, { breakStart: '13:00', breakEnd: '14:00' });
  const tueInPayload = put?.body?.weeklyChanges?.find((r) => r.weekday === 2);
  check('Вт в payload - перерыв выключен (ручное переопределение сохранилось)', { breakStart: tueInPayload?.breakStart, breakEnd: tueInPayload?.breakEnd }, { breakStart: null, breakEnd: null });

  await s.screenshot(`${outDir}/v-0804-okno27-icon-strip.png`);
});
await sleep(300);

server.close();
console.log(failures === 0 ? '\n✅ Все проверки Окна 27 зелёные' : `\n❌ Провалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
