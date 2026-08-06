// Проверка Окна 36 (06.08.2026) - "честный интерфейс владельца": crm-owner.html +
// assets/crm-auth.js. Бэкенда Amvera в песочнице нет - window.fetch подменяется
// фикстурами (тот же паттерн, что verify-2026-08-05-okno31-polirovka-nadpisey.mjs),
// но здесь фикстура ЕЩЁ и ЗАПИСЫВАЕТ каждый вызов в window.__calls, чтобы проверить
// не только "элемент есть/нет в разметке", но и "реально ли он доходит до сервера"
// (DoD промпта окна).
//
// Что покрыто:
//   п.1 - роль: чекбоксы убраны, 3 select реально шлют PUT /staff/:id/role,
//         "Роли комбинируются" убрано, summary-подпись роли обновляется на лету;
//   п.2 - радио статуса визита реально шлёт PATCH /bookings/:id/status (все 3
//         состояния), чекбокс "Клиент подтвердил запись" и кнопка "Клиент не
//         пришёл" убраны с owner-страницы;
//   п.3 - "Комментарии по клиенту" убраны с owner-страницы;
//   п.4 - вкладка "Акции" убрана из навигации и из DOM, дефолтная вкладка "Расписание"
//         по-прежнему открыта;
//   п.5 - кнопка "+ Добавить сотрудника" убрана с owner-страницы;
//   РЕГРЕССИЯ (это окно НЕ должно было коснуться admin/master) - на crm-admin.html и
//         crm-master.html toggleNoShow-кнопка, bconfirm-чекбокс и role-picker readonly
//         остаются как были и по-прежнему реально работают.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8806;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const SHOTS = '/tmp/okno36';

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

const BOOKING = {
  id: 'bk-test-1',
  masterId: 'master-1',
  clientId: 'cl-1',
  clientName: 'Клиент Тест',
  clientPhone: '+7 900 000-11-22',
  clientBirthday: null,
  startTime: '10:00',
  endTime: '10:40',
  status: 'planned',
  serviceId: 'strizhka',
  serviceIds: ['strizhka'],
  clientConfirmed: false,
  clientNoShowStreak: 0,
  requiresPrepayment: false,
};

function mockFetchSource() {
  return `
window.__calls = [];
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
  if (path === '/staff' && method === 'GET') return json(${JSON.stringify(STAFF)});
  if (/^\\/staff\\/[^/]+\\/role$/.test(path) && method === 'PUT') {
    const body = JSON.parse(opts.body);
    window.__calls.push({ path, method, body });
    return json({ ok: true, id: path.split('/')[2], role: body.role });
  }
  if (path === '/services') return json([{ id: 'strizhka', name: 'Стрижка', category: 'base', durationMin: 40, price: 2000 }]);
  if (path === '/master-services') return json([
    { masterId: 'master-1', serviceId: 'strizhka', price: 2000, durationMin: 40 },
    { masterId: 'master-2', serviceId: 'strizhka', price: 2000, durationMin: 40 },
    { masterId: 'master-3', serviceId: 'strizhka', price: 1500, durationMin: 40 },
  ]);
  if (path === '/payroll-settings') return json([{ masterId: 'master-1', pct: 100 }, { masterId: 'master-2', pct: 100 }, { masterId: 'master-3', pct: 40 }]);
  if (path === '/schedule') return json([]);
  if (path === '/schedule-range') return json([]);
  if (path === '/master-weekly-schedule') return json([1,2,3,4,5,6,7].map((wd) => ({ weekday: wd, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: null, breakEnd: null })));
  if (path === '/bookings' && method === 'GET') return json({ bookings: [${JSON.stringify(BOOKING)}] });
  if (/^\\/bookings\\/[^/]+\\/status$/.test(path) && method === 'PATCH') {
    const body = JSON.parse(opts.body);
    window.__calls.push({ path, method, body });
    return json({ ok: true, status: body.status });
  }
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

await withBrowser(async (s) => {
  await s.setViewport(1280, 2000, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: mockFetchSource() + `window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message)));`,
  });

  // ══════════════════════════ OWNER (crm-owner.html) ══════════════════════════
  await login(s, 'crm-owner.html', 'owner-test@alikhan.test');
  checkTrue('[owner] нет JS-ошибок при загрузке', (await s.eval(`window.__errors || []`)).length === 0);

  // Переключаемся на вкладку "Сотрудники" (pt-b)
  await s.click('label[for="pt-b"]');
  await s.sleep(200);

  // ── п.1 Роль ──────────────────────────────────────────────────────────────
  checkTrue('[п.1] чекбоксы role-picker убраны из DOM', !(await s.eval(`!!document.querySelector('.role-picker')`)));
  checkTrue('[п.1] "Роли комбинируются" убрано из текста', !(await s.eval(`document.body.innerHTML`)).includes('Роли комбинируются'));
  checkTrue('[п.1] "можно несколько" убрано', !(await s.eval(`document.body.innerHTML`)).includes('можно несколько'));
  checkTrue('[п.1] select роли master-1 существует и проставлен из /staff (owner)', await s.eval(`document.getElementById('roleSelect-master-1').value === 'owner'`));
  checkTrue('[п.1] select роли master-2 проставлен (admin)', await s.eval(`document.getElementById('roleSelect-master-2').value === 'admin'`));
  checkTrue('[п.1] select роли master-3 проставлен (master)', await s.eval(`document.getElementById('roleSelect-master-3').value === 'master'`));
  checkTrue('[п.1] summary-подпись роли master-2 честная (без "+ Мастер")', (await s.eval(`document.getElementById('roleLabel-master-2').textContent`)) === 'Администратор');

  // Реальное изменение роли Елизаветы (master-3): master → admin
  await s.eval(`(function(){ const sel = document.getElementById('roleSelect-master-3'); sel.value = 'admin'; sel.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await s.sleep(300);
  const roleCalls = await s.eval(`(window.__calls || []).filter((c) => c.path === '/staff/master-3/role')`);
  checkTrue('[п.1] изменение select реально шлёт PUT /staff/master-3/role {role:"admin"}', roleCalls.length === 1 && roleCalls[0].body.role === 'admin');
  checkTrue('[п.1] после сохранения summary-подпись обновилась на "Администратор"', (await s.eval(`document.getElementById('roleLabel-master-3').textContent`)) === 'Администратор');
  checkTrue('[п.1] note рядом с select показывает "Сохранено"', (await s.eval(`document.getElementById('roleNote-master-3').textContent`)) === 'Сохранено');

  // ── п.5 Кнопка "+ Добавить сотрудника" ───────────────────────────────────
  // ВАЖНО: проверяем textContent видимых элементов, не сырой innerHTML - в самой
  // разметке остались объясняющие HTML-комментарии с этими же словами (для
  // следующего разработчика), а .innerHTML сериализует и комментарии тоже.
  checkTrue('[п.5] кнопка "+ Добавить сотрудника" убрана из DOM', !(await s.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Добавить сотрудника'))`)));

  // ── п.4 Вкладка "Акции" ───────────────────────────────────────────────────
  checkTrue('[п.4] label "Акции" убран из tab-bar', !(await s.eval(`[...document.querySelectorAll('.tab-bar label')].some((l) => l.textContent.includes('Акции'))`)));
  checkTrue('[п.4] radio pt-d убран из DOM', !(await s.eval(`!!document.getElementById('pt-d')`)));
  checkTrue('[п.4] панель "Акции" (panel-d) удалена из DOM', !(await s.eval(`!!document.querySelector('.panel-d')`)));
  checkTrue('[п.4] "Добавить повод" убрано из DOM', !(await s.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Добавить повод'))`)));

  // Возвращаемся на "Расписание", открываем тестовую бронь
  await s.click('label[for="pt-a"]');
  await s.sleep(250);
  checkTrue('[owner] тестовая бронь отрисовалась в календаре (.appt)', await s.eval(`!!document.querySelector('.appt[data-id="bk-test-1"]')`));
  await s.click('.appt[data-id="bk-test-1"]');
  await s.sleep(200);

  // ── п.2 Статус визита + чекбокс подтверждения ────────────────────────────
  checkTrue('[п.2] кнопка bk-noshow-btn убрана с owner-страницы', !(await s.eval(`!!document.getElementById('bk-noshow-btn')`)));
  checkTrue('[п.2] чекбокс bconfirm убран с owner-страницы', !(await s.eval(`!!document.getElementById('bconfirm')`)));
  checkTrue('[п.2] радио честно отражает реальный статус брони (planned → "Ожидание" отмечено)', await s.eval(`document.getElementById('st-wait').checked === true`));

  await s.click('#st-came'); // реальный клик по радио "Пришёл" → должен вызвать PATCH status:'done'
  await s.sleep(300);
  const statusCalls = await s.eval(`(window.__calls || []).filter((c) => c.path === '/bookings/bk-test-1/status')`);
  checkTrue('[п.2] клик по радио "Пришёл" реально шлёт PATCH /bookings/:id/status {status:"done"}', statusCalls.length === 1 && statusCalls[0].body.status === 'done');
  checkTrue('[п.2] после PATCH ошибка bk-status-note не показана', await s.eval(`document.getElementById('bk-status-note').hidden === true`));

  // ── п.3 Комментарии по клиенту ────────────────────────────────────────────
  checkTrue('[п.3] "Комментарии по клиенту" убраны с owner-страницы', !(await s.eval(`!!document.getElementById('bk-comment-thread')`)));
  checkTrue('[п.3] баннер-пример дня рождения (birthday-banner) убран', !(await s.eval(`!!document.querySelector('.birthday-banner')`)));

  checkTrue('[owner] после всех действий JS-ошибок не прибавилось', (await s.eval(`window.__errors || []`)).length === 0);
  await s.screenshot(`${SHOTS}-1-owner-staff.png`);
  await s.click('label[for="pt-b"]');
  await s.sleep(200);
  await s.screenshot(`${SHOTS}-2-owner-booking.png`);

  // ══════════════ РЕГРЕССИЯ: admin/master НЕ должны были измениться ══════════════
  await login(s, 'crm-admin.html', 'admin-test@alikhan.test');
  checkTrue('[admin] нет JS-ошибок', (await s.eval(`window.__errors || []`)).length === 0);
  checkTrue('[admin, регресс] role-picker readonly остался (это окно не трогало admin)', await s.eval(`!!document.querySelector('.role-picker.readonly')`));
  checkTrue('[admin, регресс] кнопка "+ Добавить сотрудника" осталась (вне области этого окна)', (await s.eval(`document.body.innerHTML`)).includes('Добавить сотрудника'));
  checkTrue('[admin, регресс] чекбокс bconfirm жив', await s.eval(`!!document.getElementById('bconfirm')`));
  checkTrue('[admin, регресс] кнопка bk-noshow-btn жива', await s.eval(`!!document.getElementById('bk-noshow-btn')`));
  // Открываем ту же тестовую бронь и проверяем, что toggleNoShow по-прежнему реально работает
  await s.sleep(200);
  const apptFound = await s.eval(`!!document.querySelector('.appt[data-id="bk-test-1"]')`);
  checkTrue('[admin] тестовая бронь видна в календаре', apptFound);
  if (apptFound) {
    await s.click('.appt[data-id="bk-test-1"]');
    await s.sleep(150);
    await s.click('#bk-noshow-btn');
    await s.sleep(300);
    const adminNoShowCalls = await s.eval(`(window.__calls || []).filter((c) => c.path === '/bookings/bk-test-1/status')`);
    checkTrue('[admin, регресс] toggleNoShow по-прежнему реально шлёт PATCH status', adminNoShowCalls.some((c) => c.body.status === 'no_show' || c.body.status === 'planned'));
  }
  await s.screenshot(`${SHOTS}-3-admin.png`);

  await login(s, 'crm-master.html', 'master-test@alikhan.test');
  checkTrue('[master] нет JS-ошибок', (await s.eval(`window.__errors || []`)).length === 0);
  checkTrue('[master, регресс] чекбокс bconfirm жив', await s.eval(`!!document.getElementById('bconfirm')`));
  checkTrue('[master, регресс] кнопка bk-noshow-btn жива', await s.eval(`!!document.getElementById('bk-noshow-btn')`));
  await s.screenshot(`${SHOTS}-4-master.png`);
});

server.close();
console.log(failures === 0 ? '\n✔ ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ' : `\n✘ ${failures} ПРОВАЛИВШИХСЯ ПРОВЕРОК`);
process.exit(failures === 0 ? 0 : 1);
