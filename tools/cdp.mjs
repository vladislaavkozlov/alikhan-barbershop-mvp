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
    // Работаем в ЕДИНСТВЕННОЙ вкладке браузера, а не заводим свою рядом с пустой,
    // открытой при запуске: двух вкладок достаточно, чтобы ввод начал уходить не туда
    const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
    const target = list.find((t) => t.type === 'page') ?? (await (await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: 'PUT' })).json());
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
        // Наша вкладка должна быть активной, иначе браузер не доставляет ей ввод
        await send('Page.bringToFront').catch(() => {});
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
      // Канонический жест: наведение, потом нажатие и отпускание с полем buttons.
      // Без наведения браузер не ставит цель клика, а без buttons нажатие считается
      // неполным - на третьей странице сессии клик переставал доходить до страницы
      // (24.08.2026, кабинет мастера)
      async clickAt(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
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
      // ⚠️ ОГРАНИЧЕНИЕ ЭТОЙ МАШИНЫ, разобрано 24.08.2026 подробно и не побеждено.
      // Клавиатурные события доходят до ПЕРВОЙ страницы сессии браузера и не доходят
      // до следующих: поле остаётся пустым, хотя document.activeElement - оно само,
      // document.hasFocus() истинно, страница complete, перезагрузки нет (проверено
      // маркером в window), чужой сессии в localStorage нет, вкладка одна и активна.
      // Проверено и отброшено: размер окна браузера, эмуляция вьюпорта, прогрев ввода
      // движением мыши, остаточные процессы Chrome, занятость главного потока,
      // порядок событий (канонический keyDown → char → keyUp даёт точный текст на
      // первой странице и ничего на второй; keyDown с текстом ПЛЮС char задваивает
      // символы - «1234» превращается в «11223344»).
      //
      // Поэтому typeReal ПРОВЕРЯЕТ результат и падает громко: молчаливый промах уже
      // стоил ложного вывода «кабинеты администратора и мастера пустые». Прогонам,
      // которым нужно пройти несколько кабинетов подряд, вход делается через type() -
      // он ставит значение через DOM и работает всегда.
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
          // Канонический порядок: нажатие БЕЗ текста, вставка символа отдельным
          // событием 'char', отпускание. Раньше текст ехал прямо в keyDown - Chrome
          // вставлял символ через раз, и поля входа на втором-третьем кабинете
          // оставались пустыми (найдено 24.08.2026). Оставить оба - keyDown с текстом
          // И char - нельзя: символ задваивается, «1234» превращается в «11223344»
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char });
          await send('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char, key: char });
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
