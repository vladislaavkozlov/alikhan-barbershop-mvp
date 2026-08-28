// Живой прогон Окна 72 (28.08.2026): экран входа в реальном браузере.
//
// Проверяем то, что человек увидит глазами: поле называется «Логин», второе -
// «Пароль», подпись под формой не обещает почту, а поле логина не мешает набирать
// имя латиницей (у type="email" браузер ругался бы на значение без собачки).
//
// Запуск: node tools/verify-2026-08-28-okno72-vhod.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8793;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); };

await withBrowser(async (s) => {
  for (const page of ['crm-owner.html', 'crm-admin.html', 'crm-master.html']) {
    await s.navigate(`http://localhost:${PORT}/${page}`);
    await s.setViewport(390, 900, true);
    await new Promise((r) => setTimeout(r, 1200));

    const labels = await s.eval(`JSON.stringify({
      login: document.querySelector('label[for="loginEmail"]')?.textContent ?? null,
      secret: document.querySelector('label[for="loginPin"]')?.textContent ?? null,
      loginType: document.querySelector('#loginEmail')?.getAttribute('type') ?? null,
      hint: document.querySelector('.login-hint')?.textContent ?? null,
    })`);
    const seen = JSON.parse(labels);

    check(`${page}: поле логина подписано «Логин»`, seen.login === 'Логин', String(seen.login));
    check(`${page}: поле пароля подписано «Пароль»`, seen.secret === 'Пароль', String(seen.secret));
    check(`${page}: логин принимает имя без собачки (type не email)`, seen.loginType === 'text', String(seen.loginType));
    check(`${page}: подсказка не обещает почту`, !!seen.hint && !/почт|email/i.test(seen.hint), String(seen.hint));

    // Набираем имя латиницей и убеждаемся, что браузер не считает его ошибкой -
    // именно этим type="email" мешал бы человеку войти
    await s.type('#loginEmail', 'aliovsad');
    await s.type('#loginPin', 'barber-1234');
    const valid = await s.eval(`document.querySelector('#loginEmail').checkValidity()`);
    check(`${page}: имя латиницей проходит проверку браузера`, valid === true, String(valid));

    if (page === 'crm-owner.html') await s.screenshot(`${ROOT}tools/shots-2026-08-28-okno72-vhod.png`);
  }
});

server.close();

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` - получили: ${c.detail}`}`);
}
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
