// Минимальный CDP-драйвер на встроенном Node WebSocket (Playwright/Puppeteer недоступны в песочнице,
// npm install не работает). Добавлено окном-тестировщиком 25.07.2026 для проверки booking-формы и
// admin.html кликами, без ручного браузера. Оставлено в проекте, чтобы следующее окно не пересобирало
// с нуля - см. plans/ или memory project_barbershop-crm-mvp.md за прецедентом использования.
//
// Использование:
//   import { withBrowser } from './tools/cdp.mjs';
//   await withBrowser(async (s) => {
//     await s.navigate('http://localhost:PORT/index.html');
//     await s.setViewport(390, 900, true); // true = mobile-эмуляция, обходит баг --window-size < 500px
//     await s.click('#some-button');
//     await s.type('#f-name', 'Текст');
//     const value = await s.eval(`document.querySelector('.x').textContent`);
//     await s.screenshot('/path/out.png');
//   });
// Каждый вызов withBrowser поднимает СВОЙ headless Chrome с одноразовым --user-data-dir
// (localStorage не сохраняется между вызовами - это фича для чистых тестов, не баг).
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForDebugger() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome debugger did not come up in time');
}

export async function withBrowser(fn) {
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + tmpdir() + '/alikhan-cdp-profile-' + Date.now(),
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitForDebugger();
    const targetRes = await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await targetRes.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });

    function send(method, params = {}) {
      const thisId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(thisId, { resolve, reject });
        ws.send(JSON.stringify({ id: thisId, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const session = {
      send,
      async navigate(url) {
        await send('Page.navigate', { url });
        await sleep(600);
      },
      async eval(expression, awaitPromise = false) {
        const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
        return res.result.value;
      },
      async setViewport(width, height, mobile = false) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      },
      async screenshot(path) {
        const res = await send('Page.captureScreenshot', { format: 'png' });
        const fs = await import('node:fs');
        fs.writeFileSync(path, Buffer.from(res.data, 'base64'));
      },
      async click(selector) {
        return this.eval(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`);
      },
      // Добавлено 09.08.2026 - вся история с "кнопка сворачивания не реагирует у
      // Влада, хотя все мои тесты зелёные" объясняется тем, что click() выше вызывает
      // el.click() программно, в обход хит-теста браузера - он не может поймать баг,
      // где реальный курсор в реальной точке экрана промахивается мимо элемента.
      // clickAt шлёт настоящее Input.dispatchMouseEvent по координатам вьюпорта -
      // ровно то, что делает браузер при живом клике пользователя.
      async clickAt(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      },
      async type(selector, text) {
        return this.eval(`(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if(!el) return 'NOT_FOUND';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(text)});
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return 'OK';
        })()`);
      },
      // Настоящий ввод с клавиатуры (21.08.2026): type() выше ставит value сеттером и
      // диспатчит события руками - так не поймать баги, которые живут в самом жесте
      // (фокус, выделение, активация <label> кликом по вложенному полю). Здесь -
      // честные события Input.*, ровно как от живого человека.
      // ⚠️ ОГРАНИЧЕНИЕ, найдено 24.08.2026 (существовало и до Этапа B). После
      // УСПЕШНОГО ВХОДА в один кабинет клавиатурные события перестают доходить до
      // следующих страниц этой же сессии браузера: поле остаётся пустым, хотя
      // document.activeElement - оно само и document.hasFocus() истинно. Переход,
      // clickAt и eval-клик сами по себе печать не ломают (проверено отдельным
      // стендом) - ломает именно вход. Причина не найдена, поэтому прогоны, которым
      // нужно войти в НЕСКОЛЬКО кабинетов подряд, вводят почту и PIN через type().
      async typeReal(selector, text, { clear = true } = {}) {
        const found = await this.eval(`(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'NOT_FOUND';
          el.focus();
          ${clear ? 'el.select();' : ''}
          return 'OK';
        })()`);
        if (found !== 'OK') return found;
        for (const char of String(text)) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, unmodifiedText: char, key: char });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
        }
        return 'OK';
      },
      sleep,
    };

    return await fn(session);
  } finally {
    proc.kill();
  }
}
