// Живая проверка Окна 23 (04.08.2026) - отмена уже одобренной многодневной заявки на
// отгул/отпуск целиком, из кабинета владельца. Тот же приём, что уже применён в
// verify-2026-08-04-okno21/26 - статика раздаётся своим мини-сервером, а
// window.ALIKHAN_API_URL подменяется на локальный API (node api/server.mjs, порт 8092,
// DB=alikhan_test), чтобы клики били в локальную базу, а не в боевую Amvera.
//
// Фикстуры (создаются и удаляются самим прогоном через API, реальных сотрудников не
// трогают): владелец qa-w23-owner + мастер qa-w23-master уже заведены в alikhan_test
// (см. сессию Окна 23), здесь создаются только сами заявки.
//
// Запуск:
//   DB_HOST=localhost DB_NAME=alikhan_test DB_USER=$USER PORT=8092 node api/server.mjs &
//   node tools/verify-2026-08-04-okno23-otmena-otgula.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8799;
const API_URL = 'http://localhost:8092';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    let data = await readFile(join(ROOT, p));
    if (p.endsWith('.html')) {
      data = Buffer.from(data.toString('utf8').replace(/window\.ALIKHAN_API_URL = '[^']*';/, `window.ALIKHAN_API_URL = '${API_URL}';`));
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`OK   ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── подготовка фикстур через API ───────────────────────────────────────────
async function login(email, pin) {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error(`логин ${email} → ${res.status}`);
  return (await res.json()).token;
}
async function api(path, method, token, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// PIN-ы фикстур берутся из окружения, а не зашиты в файл - скрипт лежит в публичном
// репозитории. Учётки одноразовые и живут только в локальной alikhan_test (на бою их
// никогда не было), но зашивать доступы в открытый код - плохая привычка вне
// зависимости от того, куда именно они ведут.
const OWNER_PIN = process.env.W23_OWNER_PIN;
const MASTER_PIN = process.env.W23_MASTER_PIN;
if (!OWNER_PIN || !MASTER_PIN) {
  console.error(
    'Нужны W23_OWNER_PIN и W23_MASTER_PIN в окружении.\n' +
      'Фикстуры qa-w23-owner / qa-w23-master создаются в локальной alikhan_test своим\n' +
      'hashPin() из api/server.mjs (тот же приём, что в tests/api.roles.test.js) - PIN\n' +
      'выбираешь сам при создании и передаёшь сюда:\n' +
      '  W23_OWNER_PIN=... W23_MASTER_PIN=... node tools/verify-2026-08-04-okno23-otmena-otgula.mjs'
  );
  process.exit(2);
}
const ownerToken = await login('qa-w23-owner@alikhan.test', OWNER_PIN);
const masterToken = await login('qa-w23-master@alikhan.test', MASTER_PIN);

// Диапазон под этот прогон - три подряд идущих дня далеко в будущем, чтобы не
// пересечься ни с реальными бронями, ни с фикстурами прошлых прогонов.
const D1 = '2026-12-14';
const D2 = '2026-12-15';
const D3 = '2026-12-16';

const created = await api('/schedule-requests', 'POST', masterToken, {
  requestType: 'day_off',
  category: 'otpusk',
  dateFrom: D1,
  dateTo: D3,
  masterComment: 'CDP-прогон Окна 23',
});
const approvedId = created.data.id;
await api(`/schedule-requests/${approvedId}/decision`, 'PATCH', ownerToken, { decision: 'approved' });

const pendingRes = await api('/schedule-requests', 'POST', masterToken, {
  requestType: 'day_off',
  category: 'otgul',
  dateFrom: '2026-12-20',
  dateTo: '2026-12-20',
  masterComment: 'CDP-прогон Окна 23 (остаётся pending)',
});
const pendingId = pendingRes.data.id;

console.log(`фикстуры: одобренная заявка id=${approvedId} (${D1}…${D3}), pending id=${pendingId}`);

// Контроль: до отмены все три даты реально заблокированы
const beforeRange = await api(`/schedule-range?masterId=qa-w23-master&from=${D1}&to=${D3}`, 'GET', ownerToken);
check(
  'до отмены: все 3 даты диапазона помечены выходными (isDayOff=true)',
  beforeRange.data.every((d) => d.isDayOff === true),
  JSON.stringify(beforeRange.data)
);

// ── клики в браузере ────────────────────────────────────────────────────────
await withBrowser(async (s) => {
  await s.setViewport(1280, 1000, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await sleep(700);

  await s.type('#loginEmail', 'qa-w23-owner@alikhan.test');
  await s.type('#loginPin', OWNER_PIN);
  await s.click('#loginForm button[type="submit"]');
  await sleep(2500);

  const blockExists = await s.eval(`!!document.getElementById('ownerReqList')`);
  check('блок «Заявки мастеров на изменение графика» есть на странице владельца', blockExists === true);

  const loaded = await s.eval(`document.querySelectorAll('#ownerReqList [data-req-row]').length > 0`);
  check('список заявок наполнился реальными строками из API', loaded === true);

  const approvedRow = `#ownerReqList [data-req-row="${approvedId}"]`;
  const rowText = await s.eval(`document.querySelector('${approvedRow}')?.innerText || ''`);
  check('строка одобренной заявки показывает период и статус «Одобрено»', /Одобрено/.test(rowText) && rowText.includes(D1), rowText);

  const hasCancelBtn = await s.eval(`!!document.querySelector('${approvedRow} [data-cancel-req]')`);
  check('у одобренной заявки есть кнопка «Отменить»', hasCancelBtn === true);

  const pendingHasBtn = await s.eval(`!!document.querySelector('#ownerReqList [data-req-row="${pendingId}"] [data-cancel-req]')`);
  check('у заявки в статусе «На рассмотрении» кнопки «Отменить» НЕТ (отменять нечего)', pendingHasBtn === false);

  // Шаг 1 подтверждения
  await s.eval(`document.querySelector('${approvedRow} [data-cancel-req]').click()`);
  await sleep(300);
  const confirmShown = await s.eval(`!!document.querySelector('${approvedRow} [data-confirm-yes]') && !!document.querySelector('${approvedRow} [data-confirm-no]')`);
  check('клик по «Отменить» показывает подтверждение (Да, отменить / Нет), а не отменяет сразу', confirmShown === true);

  // Отказ от подтверждения ничего не меняет
  await s.eval(`document.querySelector('${approvedRow} [data-confirm-no]').click()`);
  await sleep(300);
  const backToButton = await s.eval(`!!document.querySelector('${approvedRow} [data-cancel-req]') && !document.querySelector('${approvedRow} [data-confirm-yes]')`);
  check('«Нет» возвращает кнопку «Отменить», запрос не уходит', backToButton === true);
  const stillApproved = await api(`/schedule-requests?masterId=qa-w23-master`, 'GET', ownerToken);
  check(
    'после отказа заявка всё ещё approved на сервере',
    stillApproved.data.find((r) => r.id === approvedId)?.status === 'approved'
  );

  // Подтверждаем отмену
  await s.eval(`document.querySelector('${approvedRow} [data-cancel-req]').click()`);
  await sleep(300);
  await s.eval(`document.querySelector('${approvedRow} [data-confirm-yes]').click()`);
  await sleep(2000);

  const afterText = await s.eval(`document.querySelector('${approvedRow}')?.innerText || ''`);
  check('после подтверждения строка показывает «Одобрение отменено»', /Одобрение отменено/.test(afterText), afterText);
  const btnGone = await s.eval(`!!document.querySelector('${approvedRow} [data-cancel-req]')`);
  check('кнопка «Отменить» у отменённой заявки исчезла (повторно нажать нельзя)', btnGone === false);

  // behavior:'instant' обязателен - при плавном скролле скриншот снимается на полпути
  // (уже наступали на это в прошлых прогонах CDP в этом проекте)
  await s.eval(`document.getElementById('ownerReqList').scrollIntoView({block:'center',behavior:'instant'})`);
  await sleep(400);
  await s.screenshot('/tmp/okno23-owner-requests.png');
  console.log('скриншот: /tmp/okno23-owner-requests.png');
});

// ── проверка эффекта в базе, не только на экране ────────────────────────────
// "Вернулись к стандартному графику" проверяем по ОТСУТСТВИЮ разовой правки на дату
// (GET /schedule отдаёт id: null, когда строки schedule_shifts нет и день посчитан
// резолвером), а не по isDayOff=false. Первый прогон ловил здесь ложный FAIL: одна
// из дат диапазона - понедельник, а у фикстурного мастера понедельник выходной по
// НЕДЕЛЬНОМУ ШАБЛОНУ, так что isDayOff=true там - правильный ответ после отмены, а
// не остаток отпуска. Отличать надо именно исключение от шаблона.
for (const date of [D1, D2, D3]) {
  const day = await api(`/schedule?masterId=qa-w23-master&date=${date}`, 'GET', ownerToken);
  check(
    `после отмены на ${date} не осталось разовой правки - день считает стандартный график`,
    Array.isArray(day.data) && day.data.length === 1 && day.data[0].id === null,
    JSON.stringify(day.data)
  );
}

const afterList = await api('/schedule-requests?masterId=qa-w23-master', 'GET', ownerToken);
check('статус заявки в базе = cancelled', afterList.data.find((r) => r.id === approvedId)?.status === 'cancelled');
check('pending-заявка отменой не задета', afterList.data.find((r) => r.id === pendingId)?.status === 'pending');

const repeat = await api(`/schedule-requests/${approvedId}/cancel`, 'PATCH', ownerToken);
check('повторная отмена той же заявки отбита 409', repeat.status === 409, `HTTP ${repeat.status}`);

console.log(`\nИТОГО: ${pass} OK, ${fail} FAIL`);
server.close();
process.exit(fail ? 1 : 0);
