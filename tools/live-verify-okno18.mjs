// Живая проверка Окна 18 на РЕАЛЬНОМ Amvera-бэкенде (не мок) - Definition of done
// требует именно это, не мок-прогон. Использует QA-логины Окна 18
// (migrations/028_qa_window18.sql, уже задеплоены и подтверждены curl'ом) и
// реальную тестовую бронь master-3/12.08.2026 11:00 (создана отдельно через API).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8799;
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

let failures = 0;
function checkTrue(label, actual) {
  console.log(`${actual ? '✔' : '✘'} ${label}`);
  if (!actual) failures++;
  return actual;
}

async function login(s, page, email, pin) {
  await s.navigate(`${BASE}/${page}`);
  await s.sleep(300);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = '${email}';
    document.getElementById('loginPin').value = '${pin}';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(1500); // реальная сеть, не мок - ждём дольше
}

console.log('=== crm-owner.html (реальный Amvera) ===');
await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await login(s, 'crm-owner.html', 'qa-window18-owner@alikhan.test', '583920');

  const revealed = await s.eval(`document.getElementById('loginGate').hidden`);
  checkTrue('Реальный логин прошёл (loginGate скрыт)', revealed);

  // --- Задача 1: навигация реально меняет отображаемые брони (DoD пункт 1) ---
  // 8 кликов "вперёд" от сегодня (04.08) до 12.08, где сидит тестовая бронь Елизаветы
  for (let i = 0; i < 8; i++) {
    await s.click('#dayNavNext');
    await s.sleep(350);
  }
  await s.sleep(500);
  const dayHasTestBooking = await s.eval(`Array.from(document.querySelectorAll('.appt')).some(el => el.dataset.client === 'QA Окно18 Конфликт-тест')`);
  checkTrue('Мой день (после 8 кликов "вперёд" на 12.08): видна реальная тестовая бронь Елизаветы', dayHasTestBooking);

  // --- Задача 2/3: клик по дню в Неделе/Месяце переключает "Мой день" ---
  await s.click('label[for="sp-month"]');
  await s.sleep(1200);
  const monthCellsCount = await s.eval(`document.querySelectorAll('#monthGrid .month-day--real').length`);
  checkTrue('Месяц (реальные данные): ячейки дней отрисованы', monthCellsCount > 25);

  // переключим master-switch на Елизавету (master-3), чтобы модалка/клик были про её день
  await s.eval(`(function(){
    const btn = Array.from(document.querySelectorAll('#monthMasterSwitch .master-pill')).find(b => b.textContent.includes('Елизавета'));
    if (btn) btn.click();
  })()`);
  await s.sleep(1200);

  const cellFor12 = await s.eval(`!!document.querySelector('#monthGrid .month-day--real[data-date="2026-08-12"]')`);
  checkTrue('Месяц: ячейка 12.08.2026 присутствует в сетке текущего месяца', cellFor12);

  await s.eval(`document.querySelector('#monthGrid .month-day--real[data-date="2026-08-12"]').click()`);
  await s.sleep(1000);
  const dayTabAfterMonthClick = await s.eval(`document.getElementById('sp-day').checked`);
  checkTrue('Месяц: клик по дню 12.08 переключил на "Мой день"', dayTabAfterMonthClick);
  const dateWidgetShows12 = await s.eval(`document.getElementById('dayNavDate').dataset.value`);
  checkTrue('Мой день: после клика дата виджета = 2026-08-12', dateWidgetShows12 === '2026-08-12');

  // --- Задача 3: модалка + 409 РЕАЛЬНЫЙ конфликт с реальной бронью ---
  await s.click('label[for="sp-month"]');
  await s.sleep(1200);
  await s.eval(`(function(){
    const btn = Array.from(document.querySelectorAll('#monthMasterSwitch .master-pill')).find(b => b.textContent.includes('Елизавета'));
    if (btn) btn.click();
  })()`);
  await s.sleep(1200);
  await s.eval(`document.querySelector('#monthGrid .month-day--real[data-date="2026-08-12"] .month-day-edit').click()`);
  await s.sleep(800);
  // ставим "выходной весь день" - должно конфликтовать с бронью 11:00-12:00
  await s.eval(`document.getElementById('dayEditWorking').checked = false; document.getElementById('dayEditWorking').dispatchEvent(new Event('change', {bubbles:true}))`);
  await s.click('#dayEditSave');
  await s.sleep(1200);
  const conflictRealShown = await s.eval(`!document.getElementById('dayEditConflicts').hidden`);
  checkTrue('РЕАЛЬНЫЙ конфликт: 409 от сервера показан в модалке (не оптимистично закрыто)', conflictRealShown);
  const conflictText = await s.eval(`document.getElementById('dayEditConflicts').textContent`);
  checkTrue('РЕАЛЬНЫЙ конфликт: в списке видно имя реального тестового клиента', conflictText.includes('QA Окно18 Конфликт-тест'));
  const modalStillOpen = await s.eval(`!document.getElementById('dayEditModal').hidden`);
  checkTrue('РЕАЛЬНЫЙ конфликт: модалка НЕ закрылась как успех', modalStillOpen);

  await s.eval(`document.getElementById('dayEditClose').click()`);
  await s.sleep(300);

  // --- Задача 3: сохранение НЕконфликтующего дня персистится после перезагрузки страницы ---
  await s.eval(`(function(){
    const btn = Array.from(document.querySelectorAll('#monthMasterSwitch .master-pill')).find(b => b.textContent.includes('Елизавета'));
    if (btn) btn.click();
  })()`);
  await s.sleep(1200);
  await s.eval(`document.querySelector('#monthGrid .month-day--real[data-date="2026-08-13"] .month-day-edit').click()`);
  await s.sleep(800);
  await s.eval(`document.getElementById('dayEditWorking').checked = false; document.getElementById('dayEditWorking').dispatchEvent(new Event('change', {bubbles:true}))`);
  await s.click('#dayEditSave');
  await s.sleep(1200);
  const modalClosedNoConflict = await s.eval(`document.getElementById('dayEditModal').hidden`);
  checkTrue('13.08 без конфликтов: сохранение реально прошло, модалка закрылась', modalClosedNoConflict);

  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(1500);
  const stillLoggedIn = await s.eval(`document.getElementById('loginGate').hidden`);
  checkTrue('После перезагрузки страницы сессия жива', stillLoggedIn);
  await s.click('label[for="sp-month"]');
  await s.sleep(1200);
  await s.eval(`(function(){
    const btn = Array.from(document.querySelectorAll('#monthMasterSwitch .master-pill')).find(b => b.textContent.includes('Елизавета'));
    if (btn) btn.click();
  })()`);
  await s.sleep(1200);
  const cell13StatusAfterReload = await s.eval(`document.querySelector('#monthGrid .month-day--real[data-date="2026-08-13"] .num').textContent`);
  checkTrue('После ПЕРЕЗАГРУЗКИ страницы 13.08 показывает 🔴 (правка реально сохранена на сервере, не в памяти вкладки)', cell13StatusAfterReload.includes('🔴'));

  // --- Задача 4: "Стандартный график" применяется без согласования ---
  await s.click('label[for="pt-b"]');
  await s.sleep(500);
  const weeklyRowsCount = await s.eval(`document.querySelectorAll('#weeklyEditor-master-3 .weekly-day-row').length`);
  checkTrue('Стандартный график (реальные данные, master-3): 7 строк отрисовано', weeklyRowsCount === 7);
});

await new Promise((r) => setTimeout(r, 1500));

console.log('\n=== crm-admin.html (реальный Amvera) ===');
await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await login(s, 'crm-admin.html', 'qa-window18-admin@alikhan.test', '714603');
  const revealedAdmin = await s.eval(`document.getElementById('loginGate').hidden`);
  checkTrue('Админ: реальный логин прошёл', revealedAdmin);

  await s.click('label[for="sp-week"]');
  await s.sleep(1200);
  const adminWeekPills = await s.eval(`document.querySelectorAll('#weekMasterSwitch .master-pill').length`);
  checkTrue(`Админ/Неделя: реально видит всех 3 мастеров точки (получено ${adminWeekPills})`, adminWeekPills === 3);
});

server.close();
console.log(failures === 0 ? '\n✔ ВСЕ ЖИВЫЕ ПРОВЕРКИ ЗЕЛЁНЫЕ' : `\n✘ ${failures} ПРОВАЛИВШИХСЯ ЖИВЫХ ПРОВЕРОК`);
process.exit(failures === 0 ? 0 : 1);
