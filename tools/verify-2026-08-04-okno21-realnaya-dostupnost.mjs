// Проверка Окна 21 (04.08.2026) - календарь клиента красит недоступные даты серым
// ДО клика, используя GET /schedule-availability. В отличие от
// verify-2026-08-04-limit-zapisi-60-dney.mjs (офлайн-демо, ALIKHAN_API_URL вырезан),
// здесь window.ALIKHAN_API_URL специально ПЕРЕКЛЮЧЁН на локальный сервер
// (node api/server.mjs, порт 8091, DB=alikhan_test через локальный Postgres) - грейаут
// целиком зависит от реального сетевого ответа, офлайн-режим его не тестирует вообще.
// Локальный сервер и его QA-фикстуры (master-1, услуга tonirovka, диапазон
// 2026-08-20..2026-08-26) должны быть подняты ДО запуска этого скрипта.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8799;
const API_URL = 'http://localhost:8091';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    let data = await readFile(join(ROOT, p));
    if (p === '/index.html') {
      data = Buffer.from(
        data.toString('utf8').replace(
          /window\.ALIKHAN_API_URL = '[^']*';/,
          `window.ALIKHAN_API_URL = '${API_URL}';`,
        ),
      );
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
function check(label, cond) {
  if (cond) { pass++; console.log(`OK   ${label}`); }
  else { fail++; console.log(`FAIL ${label}`); }
}

async function readDayStates(s) {
  return s.eval(`Array.from(document.querySelectorAll('#cal-grid .cal-day')).map((b) => ({
    iso: b.dataset.iso,
    disabled: b.disabled,
  }))`);
}

await withBrowser(async (s) => {
  await s.navigate(`${BASE}/index.html`);
  await s.setViewport(390, 900, true);
  await new Promise((r) => setTimeout(r, 400));

  // master-1 = Алиовсад (первая карточка #master-grid, тот же приём, что уже
  // используется в verify-2026-08-04-limit-zapisi-60-dney.mjs).
  await s.click('#master-grid .option-card');
  await new Promise((r) => setTimeout(r, 300)); // ждём GET /master-services + renderServiceOptions

  // Выбрать "Тонировка седых волос" по тексту карточки - у master-1 это 60 минут
  // (master_services), ровно репро Влада из промпта.
  const clickedService = await s.eval(`(function(){
    const btns = Array.from(document.querySelectorAll('#service-grid .option-card'));
    const target = btns.find((b) => b.querySelector('.opt-name')?.textContent === 'Тонировка седых волос');
    if (!target) return false;
    target.click();
    return true;
  })()`);
  check('карточка услуги "Тонировка седых волос" найдена и кликнута', clickedService === true);

  // refreshCalendarAvailability асинхронный (fetch на локальный сервер) - ждём ответа.
  await new Promise((r) => setTimeout(r, 500));

  await s.click('#date-toggle');
  await new Promise((r) => setTimeout(r, 150));

  const dayStates = await readDayStates(s);
  const byIso = new Map(dayStates.map((d) => [d.iso, d]));

  // Фикстуры локального сервера (см. промпт-справку в комментарии выше файла):
  // 20 - день полностью забронирован; 21 - остаток окна короче услуги (30мин < 60);
  // 26 - разовая правка "выходной весь день". Все три ДОЛЖНЫ быть серыми ДО клика.
  for (const iso of ['2026-08-20', '2026-08-21', '2026-08-26']) {
    const state = byIso.get(iso);
    check(`${iso} серая ДО клика (реально недоступна под тонировку 60мин)`, state ? state.disabled === true : false);
  }

  // 22 (выходной у другого мастера, master-1 работает), 24 (остаток 2ч >= 60мин),
  // 25 (пустой день) - ДОЛЖНЫ остаться доступными.
  for (const iso of ['2026-08-22', '2026-08-24', '2026-08-25']) {
    const state = byIso.get(iso);
    check(`${iso} НЕ серая (реально доступна под тонировку 60мин)`, state ? state.disabled === false : false);
  }

  // Клик по серой дате не должен ничего выбирать (тот же принцип, что уже проверен
  // для границы 60 дней в verify-2026-08-04-limit-zapisi-60-dney.mjs).
  const beforeLabel = await s.eval(`document.getElementById('date-toggle-label').textContent`);
  await s.eval(`(function(){
    const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
    const target = btns.find((b) => b.dataset.iso === '2026-08-26');
    if (target) target.click();
  })()`);
  await new Promise((r) => setTimeout(r, 100));
  const afterLabel = await s.eval(`document.getElementById('date-toggle-label').textContent`);
  check('клик по серой (реально недоступной) дате не меняет выбор', beforeLabel === afterLabel);

  // ── Регрессия: обычная доступная дата бронируется штатно ──────────────────
  await s.eval(`(function(){
    const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
    const target = btns.find((b) => b.dataset.iso === '2026-08-25');
    if (target) target.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500)); // refreshSlots - реальный сетевой запрос

  const slotButtons = await s.eval(`Array.from(document.querySelectorAll('#slots-wrap .slot-btn')).map((b) => b.textContent)`);
  check('на доступную дату (2026-08-25) сервер вернул непустой список слотов', Array.isArray(slotButtons) && slotButtons.length > 0);

  if (Array.isArray(slotButtons) && slotButtons.length > 0) {
    await s.click('#slots-wrap .slot-btn');
    await new Promise((r) => setTimeout(r, 100));
    const submitDisabled = await s.eval(`document.getElementById('f-submit').disabled`);
    // Кнопка остаётся disabled без согласия на 152-ФЗ (чекбокс не отмечен) - это
    // ОЖИДАЕМОЕ поведение (см. комментарий updateSubmitState в app.js), не баг этого
    // окна. Проверяем именно то, что слот реально выбирается (класс .selected).
    const slotSelected = await s.eval(`document.querySelector('#slots-wrap .slot-btn.selected') !== null`);
    check('слот на доступную дату кликается и визуально выбирается (обычный сценарий не сломан)', slotSelected === true);
    check('кнопка подтверждения остаётся заблокированной без согласия на 152-ФЗ (не регрессия, штатное поведение)', submitDisabled === true);
  }
});

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
