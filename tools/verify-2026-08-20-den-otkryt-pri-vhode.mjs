// Живая проверка правки 20.08.2026 (Влад): «переходишь с "Команды" или другого пункта
// меню на "Расписание" - "День" должен быть сразу открыт».
//
// Что проверяем:
//   1. первый вход в кабинет - карточка "День" уже раскрыта (атрибут open в crm-owner.html)
//   2. свернул "День" руками, ушёл в "Команду", вернулся в "Расписание" - "День" снова раскрыт
//      (событие crm:section, assets/crm-app-shell.js -> raiseDayOnEnter, crm-schedule-views.js)
//   3. открытая "Неделя" при этом НЕ закрывается - чужой осознанный выбор не отменяем
//   4. в раскрытом "Дне" есть реальные колонки мастеров, а не пустая карточка
//
// Локальные файлы против БОЕВОГО API (правка не задеплоена, на проде прежний код).
// Боевой CORS пускает только GitHub Pages, поэтому Chrome с --disable-web-security и
// одноразовым профилем - тот же приём, что в tools/verify-2026-08-17-vitrina-*.mjs.
// Скрипт только ЧИТАЕТ: ни одной записи в боевые данные не делает.
//
// Запуск: node tools/verify-2026-08-20-den-otkryt-pri-vhode.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

// Логин передаётся окружением, в файле его нет: каталог tools/ уезжает в публичный
// репозиторий (та же конвенция, что в tools/verify-daylight-theme.mjs). Годится любой
// аккаунт с owner-набором разделов - владелец или управляющий:
//   CRM_EMAIL=... CRM_PIN=... node tools/verify-2026-08-20-den-otkryt-pri-vhode.mjs
const LOGIN = { email: process.env.CRM_EMAIL, pin: process.env.CRM_PIN };
if (!LOGIN.email || !LOGIN.pin) {
  console.error('Нужны CRM_EMAIL и CRM_PIN в окружении - в файле логинов нет намеренно.');
  process.exit(2);
}
let PORT = 0;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;
const ROOT = new URL('../', import.meta.url).pathname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(ok, title, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${title}`); }
  else { failed++; console.log(`  FAIL ${title}${detail ? ` -> ${detail}` : ''}`); }
}

function staticServer() {
  const server = createServer(async (req, res) => {
    const path = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((resolve) => server.listen(0, () => { PORT = server.address().port; resolve(server); }));
}

async function withBrowser(fn) {
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--disable-web-security', // боевой CORS пускает только GitHub Pages, а мы с localhost
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${tmpdir()}/alikhan-verify-${Date.now()}`,
    'about:blank',
  ], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).ok) break; } catch {}
      await sleep(250);
    }
    const target = await (await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable'); await send('Runtime.enable');
    const s = {
      async navigate(url) { await send('Page.navigate', { url }); await sleep(800); },
      async eval(expression, awaitPromise = true) {
        const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
        return res.result.value;
      },
      async type(selector, text) {
        return this.eval(`(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'NOT_FOUND';const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'OK';})()`, false);
      },
      async screenshot(path) {
        const res = await send('Page.captureScreenshot', { format: 'png' });
        (await import('node:fs')).writeFileSync(path, Buffer.from(res.data, 'base64'));
      },
      sleep,
    };
    return await fn(s);
  } finally { proc.kill(); }
}

// Ждать готовности, а не спать фиксированно: боевой сервер иногда отвечает за секунду,
// иногда тянет полминуты (прогон 20.08.2026 поймал такое окно - те же запросы висли и на
// проде БЕЗ правки, то есть это состояние сервера, не регресс). Фиксированный sleep давал
// ложный FAIL "колонок: 0" на ровном месте.
async function waitFor(s, expr, label, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await s.eval(expr, false)) return true;
    await sleep(500);
  }
  console.log(`  (не дождались: ${label}, ${Math.round((Date.now() - started) / 1000)}s)`);
  return false;
}

const dayOpen = `!!document.querySelector('#scheduleCard-day')?.open`;
const weekOpen = `!!document.querySelector('#scheduleCard-week')?.open`;
const goSection = (id) => `document.querySelector('.app-nav-item[data-section="${id}"]').click()`;

const server = await staticServer();
try {
  await withBrowser(async (s) => {
    await s.navigate(`http://localhost:${PORT}/crm-owner.html`);
    for (let i = 0; i < 40 && !(await s.eval(`!!document.querySelector('#loginEmail')`, false)); i++) await sleep(250);
    await s.type('#loginEmail', LOGIN.email);
    await s.type('#loginPin', LOGIN.pin);
    await s.eval(`document.querySelector('#loginBtn, button[type=submit], .login-submit')?.click()`, false);
    // Кабинет считается загруженным, когда расписание отрисовало колонки мастеров:
    // именно к этому моменту отработал wireScheduleViews и навесил слушателя crm:section
    await waitFor(s, `document.querySelectorAll('.schedule-grid .schedule-col').length > 0`, 'колонки "Дня" после входа');

    check(await s.eval(`!document.querySelector('#crmMain').hidden`, false), 'вход в кабинет прошёл');
    check(await s.eval(dayOpen, false), '1. первый вход: карточка "День" сразу раскрыта');
    const cols = await s.eval(`document.querySelectorAll('.schedule-grid .schedule-col').length`, false);
    check(cols > 0, '4. в раскрытом "Дне" есть колонки мастеров', `колонок: ${cols}`);
    await s.screenshot('/tmp/verify-den-1-vhod.png');

    // Человек сворачивает "День" и открывает "Неделю"
    await s.eval(`document.querySelector('#scheduleCard-day').open = false`, false);
    await s.eval(`document.querySelector('#scheduleCard-week').open = true`, false);
    await sleep(2500);
    check(!(await s.eval(dayOpen, false)), 'подготовка: "День" свёрнут руками');
    check(await s.eval(weekOpen, false), 'подготовка: "Неделя" раскрыта руками');

    // Уходит в "Команду" и возвращается в "Расписание"
    await s.eval(goSection('team'), false);
    await sleep(1200);
    check(await s.eval(`document.body.dataset.shellSection === 'team'`, false), 'переход в раздел "Команда"');
    await s.eval(goSection('schedule'), false);
    await waitFor(s, `${dayOpen} && document.querySelectorAll('.schedule-grid .schedule-col').length > 0`, '"День" раскрыт и отрисован после возврата');

    check(await s.eval(`document.body.dataset.shellSection === 'schedule'`, false), 'возврат в раздел "Расписание"');
    check(await s.eval(dayOpen, false), 'ГЛАВНОЕ (2): после возврата из "Команды" "День" снова раскрыт');
    check(await s.eval(weekOpen, false), '3. открытая "Неделя" не закрылась');
    const colsBack = await s.eval(`document.querySelectorAll('.schedule-grid .schedule-col').length`, false);
    check(colsBack > 0, 'после возврата "День" показывает колонки мастеров', `колонок: ${colsBack}`);
    await s.screenshot('/tmp/verify-den-2-vozvrat.png');

    // Тот же путь из другого пункта меню - "Финансы"
    await s.eval(`document.querySelector('#scheduleCard-day').open = false`, false);
    await sleep(500);
    await s.eval(goSection('finance'), false);
    await sleep(1200);
    await s.eval(goSection('schedule'), false);
    await waitFor(s, dayOpen, '"День" раскрыт после возврата из "Финансов"');
    check(await s.eval(dayOpen, false), '2b. тот же эффект при возврате из "Финансов"');
  });
} finally {
  server.close();
  console.log(`\nИТОГ: ${passed} прошло, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}
