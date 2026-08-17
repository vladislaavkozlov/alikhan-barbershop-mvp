// Приёмка живого обновления на БОЕВОМ сайте и боевом API (17.08.2026).
// Именно то, что просил Влад: кабинет открыт, никто в нём ничего не нажимает, запись
// создаёт другой человек - она обязана появиться в расписании сама и сразу.
// Тот же прогон, что 15 минут назад показывал «через 15 секунд не видна».
//
// Тестовая запись создаётся на свободное окно и удаляется в finally при любом исходе.
import { withBrowser } from './cdp.mjs';

const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const API = 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const OWNER = { email: 'master1-test@alikhan.test', pin: '4495' };
const MASTER = 'master-2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(ok, title, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${title}`); }
  else { failed++; console.log(`  FAIL ${title}${detail ? ` -> ${detail}` : ''}`); }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const token = await (await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OWNER),
})).json().then((r) => r.token);

const DATE = todayStr();
let createdId = null;

// Свободное окно ищем перебором: занятые часы меняются в течение дня
async function freeSlot() {
  const res = await fetch(`${API}/bookings?date=${DATE}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  const busy = (body.bookings ?? body).filter((b) => b.masterId === MASTER).map((b) => [b.startTime, b.endTime]);
  for (const hour of [17, 18, 19, 20]) {
    const start = `${String(hour).padStart(2, '0')}:00`;
    const clash = busy.some(([from, to]) => start >= from && start < to);
    if (!clash) return start;
  }
  return null;
}

try {
  await withBrowser(async (s) => {
    await s.navigate(`${BASE}/crm-owner.html?v=${Date.now()}`);
    for (let i = 0; i < 40 && !(await s.eval(`!!document.querySelector('#loginEmail')`)); i++) await sleep(250);
    await s.type('#loginEmail', OWNER.email);
    await s.type('#loginPin', OWNER.pin);
    await s.click('#loginBtn, button[type=submit], .login-submit');
    await sleep(6000);

    const subscribers = (await (await fetch(`${API}/health`)).json()).liveSubscribers;
    check(subscribers >= 1, 'открытый кабинет подключился к потоку событий', `подписчиков: ${subscribers}`);

    const before = await s.eval(`document.querySelectorAll('.appt[data-id]').length`);
    const startTime = await freeSlot();
    if (!startTime) { check(false, 'нашлось свободное окно для проверки'); return; }
    console.log(`\n  кабинет открыт, визитов в дне: ${before}. Записываю клиента на ${startTime} со стороны`);

    const res = await fetch(`${API}/bookings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ masterId: MASTER, serviceIds: ['strizhka'], date: DATE, startTime, clientName: 'Проверка живого обновления', channel: 'admin' }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) { check(false, 'запись создана', JSON.stringify(data)); return; }
    createdId = data.booking.id;

    // Замеряем, за сколько кабинет заметит запись САМ - ни одного клика не делаем
    const started = Date.now();
    let seenAfter = null;
    while (Date.now() - started < 15000) {
      if ((await s.eval(`[...document.querySelectorAll('.appt[data-id]')].map((a) => a.dataset.id)`)).includes(createdId)) {
        seenAfter = Date.now() - started;
        break;
      }
      await sleep(250);
    }
    check(seenAfter !== null, 'ГЛАВНОЕ: запись появилась в расписании сама, без единого действия', seenAfter === null ? 'не появилась за 15 секунд' : '');
    if (seenAfter !== null) {
      console.log(`  появилась через ${(seenAfter / 1000).toFixed(1)}с`);
      check(seenAfter < 5000, 'появилась быстрее пяти секунд', `${(seenAfter / 1000).toFixed(1)}с`);
    }
    const after = await s.eval(`document.querySelectorAll('.appt[data-id]').length`);
    check(after === before + 1, 'в дне стало ровно на один визит больше', `было ${before}, стало ${after}`);
    await s.screenshot('/tmp/prod-zhivoe-obnovlenie.png');

    // Удаление тоже должно долетать: карточка обязана исчезнуть сама
    await fetch(`${API}/bookings/${encodeURIComponent(createdId)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
    });
    const deletedAt = Date.now();
    let goneAfter = null;
    while (Date.now() - deletedAt < 10000) {
      if (!(await s.eval(`[...document.querySelectorAll('.appt[data-id]')].map((a) => a.dataset.id)`)).includes(createdId)) {
        goneAfter = Date.now() - deletedAt;
        break;
      }
      await sleep(250);
    }
    check(goneAfter !== null, 'удалённая запись исчезла из расписания сама', goneAfter === null ? 'осталась висеть' : `за ${(goneAfter / 1000).toFixed(1)}с`);
    if (goneAfter !== null) createdId = null;
  });
} finally {
  if (createdId) {
    const res = await fetch(`${API}/bookings/${encodeURIComponent(createdId)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
    });
    console.log(`\n  тестовая запись убрана: ${res.status}`);
  }
  console.log(`\nИТОГ: ${passed} прошло, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}
