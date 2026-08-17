// Диагностика 17.08.2026 перед задачей «живое обновление»: что кабинет умеет СЕЙЧАС.
// Влад: «записал клиента - и сразу запись уже отображена без всяких обновлений» и
// «сделай так, чтобы без каких-либо действий работало» (про чужие изменения).
// Две разные ситуации, и чинятся они по-разному - сначала меряем каждую:
//   А. запись создал САМ сидящий в кабинете (форма walk-in) - нужен ли ему рефреш
//   Б. запись создал КТО-ТО ДРУГОЙ (здесь - прямой POST в API) - увидит ли её
//      открытый кабинет сам, без единого клика
// Ничего не чинит, только измеряет. Свою тестовую запись удаляет в конце.
import { withBrowser } from './cdp.mjs';

const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const API = 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const OWNER = { email: 'master1-test@alikhan.test', pin: '4495' };
const TARGET_MASTER = 'master-2'; // Мамедхан - единственный со свободными слотами сегодня
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function token() {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OWNER) });
  return (await res.json()).token;
}

const T = await token();
const DATE = todayStr();

async function waitFor(s, selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await s.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await s.sleep(250);
  }
  return false;
}

// Сколько карточек визитов сейчас нарисовано в дне
const APPT_COUNT = `document.querySelectorAll('.appt[data-id]').length`;
const APPT_IDS = `[...document.querySelectorAll('.appt[data-id]')].map((a) => a.dataset.id)`;

let createdId = null;
try {
  await withBrowser(async (s) => {
    await s.navigate(`${BASE}/crm-owner.html?v=${Date.now()}`);
    if (!await waitFor(s, '#loginEmail')) throw new Error('нет формы входа');
    await s.type('#loginEmail', OWNER.email);
    await s.type('#loginPin', OWNER.pin);
    await s.click('#loginBtn, button[type=submit], .login-submit');
    await sleep(5000);

    const before = await s.eval(APPT_COUNT);
    console.log(`\nБ. ЧУЖОЕ ИЗМЕНЕНИЕ (кабинет открыт, запись создаёт кто-то другой)`);
    console.log(`   визитов в дне до записи: ${before}`);

    // Кто-то другой создаёт запись прямо в API - кабинет об этом ничего не знает
    const startTime = '16:00'; // свободное окно, проверено через /schedule-availability
    const res = await fetch(`${API}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify({ masterId: TARGET_MASTER, serviceIds: ['strizhka'], date: DATE, startTime, clientName: 'Проверка живого обновления', clientPhone: null, channel: 'admin' }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      console.log(`   не удалось создать запись для проверки: ${JSON.stringify(data)}`);
      return;
    }
    createdId = data.booking.id;
    console.log(`   создана запись ${createdId} на ${startTime}`);

    // Ждём и смотрим, заметит ли открытый кабинет сам - без единого действия
    for (const wait of [2000, 3000, 5000, 5000]) {
      await sleep(wait);
      const now = await s.eval(APPT_COUNT);
      const seen = (await s.eval(APPT_IDS)).includes(createdId);
      console.log(`   через ${wait / 1000}с: визитов ${now}, новая запись видна: ${seen ? 'ДА' : 'нет'}`);
      if (seen) break;
    }

    // Теперь то же самое, но с нажатием кнопки «Обновить» - контрольный замер
    await s.eval(`document.getElementById('refreshBtn')?.click()`);
    await sleep(4000);
    const afterRefresh = (await s.eval(APPT_IDS)).includes(createdId);
    console.log(`   после нажатия «Обновить»: новая запись видна: ${afterRefresh ? 'ДА' : 'нет'}`);
  });
} finally {
  if (createdId) {
    const res = await fetch(`${API}/bookings/${encodeURIComponent(createdId)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}',
    });
    console.log(`\nтестовая запись удалена: ${res.status}`);
  }
}
