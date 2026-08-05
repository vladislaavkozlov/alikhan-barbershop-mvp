// Живая проверка Окна 24 (05.08.2026) - производственный календарь как данные.
// Бьёт в РЕАЛЬНЫЙ локальный API (node api/server.mjs на alikhan_test), а не в моки:
// смысл окна ровно в том, что праздники приходят из базы и массовое закрытие реально
// пишет выходные в schedule_shifts.
//
// Ключевой ассерт Definition of done: после того как владелец закрыл дату всем, а
// одного мастера вернули в рабочий день вручную, бейдж праздника обязан остаться
// видимым на всех трёх вкладках - праздничность и рабочий статус независимы.
//
// Фикстурный праздник (создаётся и удаляется этим же прогоном, реальные строки
// таблицы holidays не трогаются): в окно клиентской записи (60 дней от августа 2026)
// ни один настоящий праздник РФ не попадает, а подсказку в виджете нужно проверить
// живым кликом, а не на словах.
//
// Запуск:
//   DB_HOST=localhost DB_NAME=alikhan_test DB_USER=$USER PORT=8092 node api/server.mjs &
//   W24_OWNER_PIN=... node tools/verify-2026-08-05-okno24-prazdniki.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import pg from 'pg';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8799;
const API_URL = process.env.API_URL || 'http://localhost:8092';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const SHOTS = '/tmp/okno24';

const OWNER_EMAIL = process.env.W24_OWNER_EMAIL || 'master1-test@alikhan.test';
const OWNER_PIN = process.env.W24_OWNER_PIN;
if (!OWNER_PIN) {
  console.error(
    'Нужен W24_OWNER_PIN в окружении (PIN владельца в локальной alikhan_test) - в файл,\n' +
      'лежащий в публичном репозитории, доступы не зашиваем:\n' +
      '  W24_OWNER_PIN=... node tools/verify-2026-08-05-okno24-prazdniki.mjs'
  );
  process.exit(2);
}

// Фикстурная праздничная дата: далеко от реальных праздников, внутри 60-дневного окна
// записи, чтобы её было видно и в CRM, и в клиентском календаре.
const FIX_DATE = '2026-09-15';
const FIX_NAME = 'Фикстура прогона Окна 24';
const MASTER_ID = 'master-1';

const db = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'alikhan_test',
  user: process.env.DB_USER || process.env.USER,
});

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    let data = await readFile(join(ROOT, p));
    if (p.endsWith('.html')) {
      data = Buffer.from(
        data.toString('utf8').replace(/window\.ALIKHAN_API_URL = '[^']*';/, `window.ALIKHAN_API_URL = '${API_URL}';`)
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

try {
  // ── подготовка ───────────────────────────────────────────────────────────
  await db.query('INSERT INTO holidays (date, name) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET name = EXCLUDED.name', [
    FIX_DATE,
    FIX_NAME,
  ]);
  // Чистое состояние даты: прошлый прогон мог оставить её закрытой.
  await db.query('DELETE FROM schedule_shifts WHERE date = $1', [FIX_DATE]);
  const ownerToken = await login(OWNER_EMAIL, OWNER_PIN);

  const listRes = await api('/holidays?year=2026', 'GET', ownerToken);
  check(
    'GET /holidays отдаёт производственный календарь из базы (15 реальных дат + фикстура)',
    Array.isArray(listRes.data) && listRes.data.some((h) => h.date === '2026-01-07' && h.name === 'Рождество Христово'),
    JSON.stringify(listRes.data?.slice(0, 3))
  );

  // ── клики в браузере ─────────────────────────────────────────────────────
  await withBrowser(async (s) => {
    await s.setViewport(1440, 1100, false);
    await s.navigate(`${BASE}/crm-owner.html`);
    await sleep(700);
    await s.type('#loginEmail', OWNER_EMAIL);
    await s.type('#loginPin', OWNER_PIN);
    await s.click('#loginForm button[type="submit"]');
    await sleep(2500);

    // ── вкладка "Год" ──────────────────────────────────────────────────────
    await s.click('label[for="sp-year"]');
    await sleep(1200);

    const yearCards = await s.eval(`document.querySelectorAll('#yearGrid .year-month').length`);
    check('вкладка "Год" рисуется из данных: 12 карточек-месяцев', yearCards === 12, `получено ${yearCards}`);

    const janText = await s.eval(`document.querySelectorAll('#yearGrid .year-month')[0].textContent.replace(/\\s+/g,' ')`);
    check(
      'январь показывает реальные даты из базы (Рождество 7-го)',
      typeof janText === 'string' && janText.includes('Рождество Христово') && janText.includes('7 -'),
      janText
    );

    const aprilText = await s.eval(`document.querySelectorAll('#yearGrid .year-month')[3].textContent.replace(/\\s+/g,' ')`);
    check('месяц без праздников остаётся в сетке и честно говорит «без праздников»', aprilText.includes('без праздников'), aprilText);

    const fixVisible = await s.eval(`!!document.querySelector('#yearGrid input[data-holiday-date="${FIX_DATE}"]')`);
    check('фикстурная дата появилась в сетке года с чекбоксом', fixVisible === true);

    const btnDisabledBefore = await s.eval(`document.getElementById('yearCloseSelected').disabled`);
    check('кнопка массового закрытия заблокирована, пока ничего не отмечено', btnDisabledBefore === true);

    await s.click(`#yearGrid input[data-holiday-date="${FIX_DATE}"]`);
    await sleep(300);
    const btnAfter = await s.eval(
      `JSON.stringify({d: document.getElementById('yearCloseSelected').disabled, t: document.getElementById('yearCloseSelected').textContent.trim()})`
    );
    const btnState = JSON.parse(btnAfter);
    check('отметил дату - кнопка разблокировалась и посчитала выбор', btnState.d === false && /1/.test(btnState.t), btnAfter);
    // behavior:'instant' обязателен: плавный скролл не успевает доехать до кадра.
    await s.eval(`document.getElementById('yearActions').scrollIntoView({behavior:'instant', block:'center'})`);
    await sleep(400);
    await s.screenshot(`${SHOTS}-god.png`);

    await s.click('#yearCloseSelected');
    await sleep(2000);
    const noteText = await s.eval(`document.getElementById('yearCloseNote').textContent`);
    check('после закрытия владелец видит сводку по закрытым дням', /Закрыто дней у мастеров: [1-9]/.test(noteText), noteText);

    // Реальная запись в базу, а не только текст на экране.
    const closedRange = await api(`/schedule-range?masterId=${MASTER_ID}&from=${FIX_DATE}&to=${FIX_DATE}`, 'GET', ownerToken);
    check('дата реально стала выходной в графике мастера', closedRange.data?.[0]?.isDayOff === true, JSON.stringify(closedRange.data));

    // ── ключевой сценарий DoD: мастер вернулся в рабочий день, праздник остался ─
    await api(`/schedule?masterId=${MASTER_ID}&date=${FIX_DATE}`, 'DELETE', ownerToken);
    const backRange = await api(`/schedule-range?masterId=${MASTER_ID}&from=${FIX_DATE}&to=${FIX_DATE}`, 'GET', ownerToken);
    check('мастера вернули в рабочий день вручную', backRange.data?.[0]?.isDayOff === false, JSON.stringify(backRange.data));

    // ── Месяц ──────────────────────────────────────────────────────────────
    await s.click('label[for="sp-month"]');
    await sleep(1500);
    // Листаем к сентябрю от текущего августа - навигация Окна 25 двигает общий якорь.
    await s.click('#monthNavNext');
    await sleep(1800);

    const monthCell = await s.eval(`(() => {
      const cell = document.querySelector('.month-day--real[data-date="${FIX_DATE}"]');
      if (!cell) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        isHoliday: cell.classList.contains('is-holiday'),
        badge: (cell.querySelector('.holiday-label')?.textContent || '').trim(),
        status: (cell.querySelector('.num')?.textContent || '').trim(),
      });
    })()`);
    const month = JSON.parse(monthCell);
    check('Месяц: у праздничной ячейки есть бейдж праздника', month.found && month.isHoliday && month.badge.includes(FIX_NAME), monthCell);
    check(
      'Месяц: бейдж НЕ подменил рабочий статус - день снова рабочий (не 🔴), но праздничный',
      month.found && !month.status.includes('🔴'),
      monthCell
    );
    await s.screenshot(`${SHOTS}-mesyac.png`);

    // Клик по ячейке переводит ОБЩИЙ якорь даты на неё (Окно 25) - без этого шага
    // Неделя показала бы неделю с 1 сентября (листание месяца ставит якорь на первое
    // число), а не ту, в которой лежит проверяемая дата.
    await s.click(`.month-day--real[data-date="${FIX_DATE}"]`);
    await sleep(1800);

    // ── Неделя ─────────────────────────────────────────────────────────────
    await s.click('label[for="sp-week"]');
    await sleep(1800);
    const weekCell = await s.eval(`(() => {
      const cell = document.querySelector('.week-day-cell[data-open-day="${FIX_DATE}"]');
      if (!cell) return JSON.stringify({ found: false, cells: [...document.querySelectorAll('.week-day-cell')].map(c => c.dataset.openDay) });
      return JSON.stringify({
        found: true,
        isHoliday: cell.classList.contains('is-holiday'),
        badge: (cell.querySelector('.holiday-label')?.textContent || '').trim(),
        hours: (cell.querySelector('.week-hours')?.textContent || '').trim(),
      });
    })()`);
    const week = JSON.parse(weekCell);
    check('Неделя: бейдж праздника есть в ячейке', week.found && week.isHoliday && week.badge.includes(FIX_NAME), weekCell);
    check('Неделя: часы смены остались на месте рядом с бейджем (признаки независимы)', week.found && /\d\d:\d\d/.test(week.hours), weekCell);
    await s.screenshot(`${SHOTS}-nedelya.png`);

    // ── День ───────────────────────────────────────────────────────────────
    await s.click('label[for="sp-day"]');
    await sleep(1800);
    const dayNote = await s.eval(`(() => {
      const n = document.getElementById('dayHolidayNote');
      return JSON.stringify({ hidden: n.hidden, text: n.textContent.trim() });
    })()`);
    const day = JSON.parse(dayNote);
    check('День: бейдж праздника виден на выбранной дате', day.hidden === false && day.text.includes(FIX_NAME), dayNote);
    await s.screenshot(`${SHOTS}-den.png`);

    // Контроль: на обычной дате бейдж пропадает, а не висит всегда.
    await s.click('#dayNavNext');
    await sleep(1500);
    const dayNoteAfter = await s.eval(`document.getElementById('dayHolidayNote').hidden`);
    check('День: на соседней обычной дате бейджа нет', dayNoteAfter === true);

    // ── клиентский виджет ──────────────────────────────────────────────────
    await s.navigate(`${BASE}/index.html`);
    await sleep(1500);
    await s.eval(`document.getElementById('booking').scrollIntoView({behavior:'instant'})`);
    await sleep(400);
    await s.click('#master-grid .option-card');
    await sleep(900);
    await s.click('#service-grid .option-card');
    await sleep(1200);
    await s.click('#date-toggle');
    await sleep(600);
    // Листаем календарь к сентябрю (сегодня август) и жмём фикстурную дату.
    await s.click('#cal-next');
    await sleep(800);
    await s.click(`#cal-grid .cal-day[data-iso="${FIX_DATE}"]`);
    await sleep(1500);

    const hint = await s.eval(`(() => {
      const h = document.getElementById('holiday-hint');
      return JSON.stringify({ hidden: h.hidden, text: h.textContent.trim() });
    })()`);
    const hintState = JSON.parse(hint);
    check(
      'Клиент: под выбранной праздничной датой видна подсказка с названием',
      hintState.hidden === false && hintState.text.includes(FIX_NAME),
      hint
    );
    await s.eval(`document.getElementById('holiday-hint').scrollIntoView({behavior:'instant', block:'center'})`);
    await sleep(400);
    await s.screenshot(`${SHOTS}-klient.png`);

    // Контроль: обычная дата подсказку убирает.
    await s.click('#date-toggle');
    await sleep(500);
    await s.click(`#cal-grid .cal-day[data-iso="2026-09-16"]`);
    await sleep(1200);
    const hintAfter = await s.eval(`document.getElementById('holiday-hint').hidden`);
    check('Клиент: на обычной дате подсказки нет', hintAfter === true);

    // Календарь выбора даты бейджами НЕ засеян - ТЗ запрещает метить каждую ячейку.
    const calBadges = await s.eval(`document.querySelectorAll('#cal-grid .holiday-label, #cal-grid .cal-day.is-holiday').length`);
    check('Клиент: ячейки календаря остались чистыми (подсказка только на выбранной дате)', calBadges === 0, `найдено ${calBadges}`);
  });
} finally {
  // Фикстуру убираем всегда - и на упавшем прогоне тоже.
  await db.query('DELETE FROM schedule_shifts WHERE date = $1', [FIX_DATE]).catch(() => {});
  await db.query('DELETE FROM holidays WHERE date = $1', [FIX_DATE]).catch(() => {});
  await db.end().catch(() => {});
  server.close();
}

console.log(`\nИТОГ: ${pass} OK, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
