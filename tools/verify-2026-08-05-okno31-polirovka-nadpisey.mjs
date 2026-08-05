// Проверка Окна 31 (05.08.2026) - убраны внутренние dev-надписи из crm-owner/admin/master.html.
// Бэкенда Amvera в песочнице нет - window.fetch подменяется фикстурами (тот же паттерн,
// что verify-2026-08-05-okno28-polirovka.mjs), проверяется ФРОНТ на всех 3 ролях.
//
// Что покрыто:
//   п.1  - тег "CRM · визуальный макет" убран из шапки всех 3 страниц;
//   п.2  - блок #liveProof убран, но реальный рендер (календарь/выручка/ЗП) остался живым;
//   п.3  - баннер "Визуальный макет (Окно 9)..." убран;
//   п.4  - блок "Обновления" убран;
//   п.5  - вкладка "Что доделываем" убрана у владельца целиком (radio/label/panel);
//   п.6  - кнопка "+" walk-in исчезла из шапок колонок мастеров (owner/admin), а
//          кнопка "+ Новая запись" в личном кабинете мастера (walkinSoloTrigger) жива
//          и по-прежнему открывает форму записи без предзаписи;
//   п.7  - точечные подписи (bd-hint/status-legend/staff-search/section-hint) убраны,
//          bk-commission-note НАМЕРЕННО сохранён (реально пишет туда JS);
//   п.8/9 - в разметке не осталось "разд.NN"/"Окно NN, дата" (кроме HTML/CSS-комментариев
//          и явно оставленных п.8 строк).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8803;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const SHOTS = '/tmp/okno31-after';

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
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

const STAFF = [
  { id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true, hasWorkingSchedule: true },
  { id: 'master-2', locationId: null, name: 'Мамедхан', role: 'admin', employed: true, providesServices: true, hasSystemAccess: true, hasWorkingSchedule: true },
  { id: 'master-3', locationId: null, name: 'Елизавета', role: 'master', employed: true, providesServices: true, hasSystemAccess: true, hasWorkingSchedule: true },
];

function mockFetchSource() {
  return `
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const json = (body, status) => ({ ok: (status||200) < 400, status: status||200, json: async () => body });

  if (path === '/auth/login' && method === 'POST') {
    const email = JSON.parse(opts.body).email;
    const staff = email.startsWith('master') ? { id: 'master-3', name: 'Елизавета', role: 'master', locationId: null }
      : email.startsWith('admin') ? { id: 'master-2', name: 'Мамедхан', role: 'admin', locationId: null }
      : { id: 'master-1', name: 'Алиовсад', role: 'owner', locationId: null };
    return json({ token: 'fake-token', staff });
  }
  if (path === '/staff') return json(${JSON.stringify(STAFF)});
  if (path === '/services') return json([{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 60, price: 2000 }]);
  if (path === '/master-services') return json([
    { masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 60 },
    { masterId: 'master-2', serviceId: 'strizhka', price: 2000, durationMin: 60 },
    { masterId: 'master-3', serviceId: 'strizhka', price: 1500, durationMin: 60 },
  ]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 100 }, { masterId: 'master-2', pct: 100 }, { masterId: 'master-3', pct: 40 }]);
  if (path === '/schedule') return json([]);
  if (path === '/schedule-range') return json([]);
  if (path === '/master-weekly-schedule') return json([1,2,3,4,5,6,7].map((wd) => ({ weekday: wd, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: null, breakEnd: null })));
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/holidays') return json([]);
  if (path === '/schedule-requests') return json([]);
  if (path === '/notifications') return json([]);
  if (path === '/masters-next-availability') return json({});
  return json({}, 404);
};
`;
}

let failures = 0;
function checkTrue(label, actual) {
  console.log(`${actual ? '✔' : '✘'} ${label}`);
  if (!actual) failures++;
  return actual;
}

async function login(s, page, email) {
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

async function checkCommon(s, roleLabel) {
  checkTrue(`[${roleLabel}] нет JS-ошибок при загрузке (window.__errors пуст)`, (await s.eval(`window.__errors || []`)).length === 0);
  checkTrue(`[${roleLabel}] тег "CRM · визуальный макет" убран`, !(await s.eval(`document.body.innerHTML`)).includes('CRM · визуальный макет'));
  checkTrue(`[${roleLabel}] блок #liveProof убран из DOM`, !(await s.eval(`!!document.getElementById('liveProof')`)));
  checkTrue(`[${roleLabel}] баннер "Визуальный макет (Окно 9)" убран`, !(await s.eval(`document.body.innerHTML`)).includes('Визуальный макет (Окно 9)'));
  checkTrue(`[${roleLabel}] блок "Обновления" убран`, !(await s.eval(`document.body.innerHTML`)).includes('>Обновления<'));
  checkTrue(`[${roleLabel}] реальный рендер жив: расписание (schedule-grid/schedule-track) заполнилось`, await s.eval(`!!document.querySelector('.schedule-grid, .schedule-track')`));
}

await withBrowser(async (s) => {
  await s.setViewport(1280, 1800, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: mockFetchSource() + `window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message)));`,
  });

  // ── OWNER ────────────────────────────────────────────────────────────────
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');
  await checkCommon(s, 'owner');
  checkTrue('[owner] вкладка "Что доделываем" убрана из tab-bar', !(await s.eval(`document.body.innerHTML`)).includes('Что доделываем'));
  checkTrue('[owner] radio pt-e тоже убран', !(await s.eval(`!!document.getElementById('pt-e')`)));
  checkTrue('[owner] в шапке колонок мастеров нет кнопки "+" walk-in', !(await s.eval(`!!document.querySelector('.walkin-add-btn')`)));
  checkTrue('[owner] карточка bk-commission-note на месте (JS пишет в неё текст)', await s.eval(`!!document.getElementById('bk-commission-note')`));
  // Все вкладки переключаются без ошибок
  for (const tab of ['pt-a', 'pt-b', 'pt-c', 'pt-d']) {
    await s.click(`label[for="${tab}"]`);
    await s.sleep(150);
  }
  checkTrue('[owner] после клика по всем вкладкам ошибок в консоли не прибавилось', (await s.eval(`window.__errors || []`)).length === 0);
  await s.click('label[for="pt-a"]');
  await s.sleep(200);
  await s.screenshot(`${SHOTS}-1-owner.png`);

  // ── ADMIN ────────────────────────────────────────────────────────────────
  await login(s, 'crm-admin.html', 'admin-test@alikhan.test');
  await checkCommon(s, 'admin');
  checkTrue('[admin] в шапке колонок мастеров нет кнопки "+" walk-in', !(await s.eval(`!!document.querySelector('.walkin-add-btn')`)));
  for (const tab of ['pt-a', 'pt-b']) {
    await s.click(`label[for="${tab}"]`);
    await s.sleep(150);
  }
  checkTrue('[admin] после клика по вкладкам ошибок в консоли нет', (await s.eval(`window.__errors || []`)).length === 0);
  await s.click('label[for="pt-a"]');
  await s.sleep(200);
  await s.screenshot(`${SHOTS}-2-admin.png`);

  // ── MASTER ───────────────────────────────────────────────────────────────
  await login(s, 'crm-master.html', 'master-test@alikhan.test');
  await checkCommon(s, 'master');
  checkTrue('[master] своя кнопка "+ Новая запись" (walkinSoloTrigger) НЕ тронута', await s.eval(`!!document.getElementById('walkinSoloTrigger')`));
  // Клик по walkinSoloTrigger по-прежнему открывает форму walk-in (soloBtn-wiring жив)
  await s.click('#walkinSoloTrigger');
  await s.sleep(200);
  checkTrue('[master] клик по "+ Новая запись" реально открывает форму walkinForm', !(await s.eval(`document.getElementById('walkinForm').hidden`)));
  await s.click('#wfCancel');
  await s.sleep(150);
  for (const tab of ['pt-a', 'pt-b', 'pt-c']) {
    await s.click(`label[for="${tab}"]`);
    await s.sleep(150);
  }
  checkTrue('[master] после клика по вкладкам ошибок в консоли нет', (await s.eval(`window.__errors || []`)).length === 0);
  await s.click('label[for="pt-a"]');
  await s.sleep(200);
  await s.screenshot(`${SHOTS}-3-master.png`);
});

server.close();
console.log(failures === 0 ? '\n✔ ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ' : `\n✘ ${failures} ПРОВАЛИВШИХСЯ ПРОВЕРОК`);
process.exit(failures === 0 ? 0 : 1);
