// Точечная проверка правки "бейдж Выходной" поверх Окна 16 (03.08.2026, вечер).
// Тот же mock-паттерн, что verify-2026-08-03-grafik-raboty.mjs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8798;
const outDir = process.argv[2] || '/tmp';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

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

const STAFF = [{ id: 'master-1', locationId: null, name: 'Алиовсад', role: 'owner', employed: true, providesServices: true, hasSystemAccess: true }];
const WEEKLY_FIXTURE = [{ masterId: 'master-1', weekday: 1, isWorking: true, workStart: '09:00', workEnd: '18:00', breakStart: '13:00', breakEnd: '14:00' }];

const mockFetchSource = `
window.fetch = async (url, opts) => {
  const u = new URL(url, location.href);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const json = (body, status) => ({ ok: (status||200) < 400, status: status||200, json: async () => body });
  if (path === '/auth/login' && method === 'POST') return json({ token: 'fake-token', staff: ${JSON.stringify(STAFF[0])} });
  if (path === '/staff') return json(${JSON.stringify(STAFF)});
  if (path === '/services') return json([]);
  if (path === '/master-services') return json([]);
  if (path === '/payroll-settings') return json([]);
  if (path === '/schedule') return json([]);
  if (path === '/bookings' && method === 'GET') return json({ bookings: [] });
  if (path === '/master-weekly-schedule' && method === 'GET') return json(${JSON.stringify(WEEKLY_FIXTURE)});
  if (path === '/schedule-requests' && method === 'GET') return json([]);
  return json({}, 404);
};
`;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✔' : '✘'} ${label}` + (ok ? '' : ` — ожидал ${JSON.stringify(expected)}, получил ${JSON.stringify(actual)}`));
  if (!ok) failures++;
}

await withBrowser(async (s) => {
  await s.setViewport(1280, 900, false);
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: mockFetchSource });
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'owner-test@alikhan.test';
    document.getElementById('loginPin').value = '1234';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(700);
  await s.eval(`document.getElementById('pt-b').click()`);
  await s.sleep(150);
  await s.eval(`document.getElementById('weekly-master-1-1-row').scrollIntoView({block:'center'})`);
  await s.sleep(300);

  const before = await s.eval(`JSON.stringify({
    badgeHidden: getComputedStyle(document.getElementById('weekly-master-1-1-offBadge')).display === 'none',
    rowIsOff: document.getElementById('weekly-master-1-1-row').classList.contains('is-off'),
  })`);
  check('Пн рабочий: бейдж скрыт, строка не приглушена', JSON.parse(before), { badgeHidden: true, rowIsOff: false });

  await s.screenshot(`${outDir}/dayoff-badge-before.png`);

  await s.eval(`(function(){
    const cb = document.getElementById('weekly-master-1-1-working');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.sleep(150);

  const after = await s.eval(`JSON.stringify({
    badgeVisible: getComputedStyle(document.getElementById('weekly-master-1-1-offBadge')).display !== 'none',
    badgeText: document.getElementById('weekly-master-1-1-offBadge').textContent,
    rowIsOff: document.getElementById('weekly-master-1-1-row').classList.contains('is-off'),
  })`);
  check('Пн выключен: бейдж "Выходной" виден, строка приглушена', JSON.parse(after), { badgeVisible: true, badgeText: 'Выходной', rowIsOff: true });

  await s.screenshot(`${outDir}/dayoff-badge-after.png`);
});

server.close();
console.log(failures === 0 ? `\nВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ` : `\n${failures} ПРОВЕРОК ПРОВАЛЕНО`);
process.exit(failures === 0 ? 0 : 1);
