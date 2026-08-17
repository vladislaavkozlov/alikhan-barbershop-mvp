// Живая проверка правки 17.08.2026 (Влад на проде, кабинет управляющего):
//   1. галка «Показывать профиль на сайте» у Алиовсада будит кнопку «Сохранить изменения»
//   2. сохранение реально доезжает до базы
//   3. рядом с кнопкой НЕ остаётся подписи «Сохранено» - результат только окошком внизу
//
// Гоняем ЛОКАЛЬНЫЕ файлы против БОЕВОГО API: правка ещё не задеплоена, а на проде лежит
// прежний код. Боевой сервер пускает по CORS только домен GitHub Pages, поэтому Chrome
// поднимается с --disable-web-security и одноразовым профилем - тот же приём, что уже
// описан в памяти проекта (reference_barbershop-crm-tech). Свой withBrowser вместо
// tools/cdp.mjs ровно из-за этого флага, всё остальное - копия оттуда.
//
// Данные возвращаются в исходное состояние в finally: тумблер витрины виден клиентам
// на сайте, оставлять его переключённым нельзя.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const MANAGER = { email: 'master2-test@alikhan.test', pin: '5032' };
const TARGET = 'master-1'; // Алиовсад, защищённый владелец - именно его карточка была заперта
// Порт эфемерный, а не 8793 из COMMANDS: на машине уже висел чужой процесс на 8793,
// и прогон падал EADDRINUSE ещё до браузера. Реальный порт читаем из server.address()
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
      // awaitPromise=true по умолчанию: любой fetch/async внутри eval иначе вернёт
      // пустую оболочку промиса (память reference_cdp-mjs-eval-awaitpromise)
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

async function apiToken() {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MANAGER) });
  return (await res.json()).token;
}
async function readShowcase(token) {
  const rows = await (await fetch(`${API}/staff`, { headers: { Authorization: `Bearer ${token}` } })).json();
  return rows.find((r) => r.id === TARGET);
}

const server = await staticServer();
const token = await apiToken();
const before = await readShowcase(token);
console.log(`Витрина Алиовсада ДО прогона: publicProfileEnabled = ${before.publicProfileEnabled}`);

try {
  await withBrowser(async (s) => {
    await s.navigate(`http://localhost:${PORT}/crm-owner.html`);
    for (let i = 0; i < 40 && !(await s.eval(`!!document.querySelector('#loginEmail')`, false)); i++) await sleep(250);
    await s.type('#loginEmail', MANAGER.email);
    await s.type('#loginPin', MANAGER.pin);
    await s.eval(`document.querySelector('#loginBtn, button[type=submit], .login-submit')?.click()`, false);
    await sleep(4500);

    await s.eval(`document.querySelector('#pt-b')?.click()`, false);
    for (let i = 0; i < 40 && !(await s.eval(`!!document.querySelector('.team-editor-card[data-staff-id="${TARGET}"]')`, false)); i++) await sleep(250);

    const card = `document.querySelector('.team-editor-card[data-staff-id="${TARGET}"]')`;
    await s.eval(`${card}.setAttribute('open','')`, false);

    check(await s.eval(`!!${card}`, false), 'карточка Алиовсада отрисована у управляющего');
    check(await s.eval(`!${card}.querySelector('[name=publicProfileEnabled]').disabled`, false), 'галка «Показывать профиль на сайте» не заблокирована');
    check(await s.eval(`${card}.querySelector('[data-save]').disabled === true`, false), 'до правки кнопка «Сохранить изменения» серая');

    // Сам щелчок - как у человека: меняем состояние и шлём change, на который подписан dirty-tracking
    await s.eval(`(function(){const t=${card}.querySelector('[name=publicProfileEnabled]');t.checked=!t.checked;t.dispatchEvent(new Event('change',{bubbles:true}));return t.checked;})()`, false);
    const woke = await s.eval(`${card}.querySelector('[data-save]').disabled === false`, false);
    check(woke, 'ГЛАВНОЕ: после переключения галки кнопка стала активной');
    await s.screenshot('/tmp/verify-knopka-aktivna.png');

    if (woke) {
      await s.eval(`${card}.querySelector('[data-save]').click()`, false);
      await sleep(3500);
      const note = await s.eval(`${card}.querySelector('[data-card-note]')?.textContent.trim() ?? ''`, false);
      check(note === '', 'рядом с кнопкой НЕТ подписи «Сохранено»', `в строке осталось: "${note}"`);
      const toast = await s.eval(`[...document.querySelectorAll('.crm-toast, [class*=toast]')].map((t)=>t.textContent.trim()).join(' | ')`, false);
      check(/Сохранено|сохранен/i.test(toast), 'результат показан всплывающим окном внизу', `тосты: "${toast}"`);
      await s.screenshot('/tmp/verify-posle-sohraneniya.png');

      const after = await readShowcase(token);
      check(after.publicProfileEnabled !== before.publicProfileEnabled, 'правка реально доехала до базы', `было ${before.publicProfileEnabled}, стало ${after.publicProfileEnabled}`);
    }
  });
} finally {
  // Возвращаем витрину как была: она видна клиентам на сайте
  const now = await readShowcase(token);
  if (now.publicProfileEnabled !== before.publicProfileEnabled) {
    const res = await fetch(`${API}/staff/${TARGET}/portfolio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        experienceText: before.experienceText ?? null,
        strengthsText: before.strengthsText ?? null,
        certificatesText: before.certificatesText ?? null,
        beforeAfterUrls: before.beforeAfterUrls ?? null,
        publicProfileEnabled: before.publicProfileEnabled,
      }),
    });
    const restored = await readShowcase(token);
    console.log(`Витрина возвращена (${res.status}): publicProfileEnabled = ${restored.publicProfileEnabled}`);
    check(restored.publicProfileEnabled === before.publicProfileEnabled, 'боевые данные вернулись в исходное состояние');
  }
  server.close();
  console.log(`\nИТОГ: ${passed} прошло, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}
