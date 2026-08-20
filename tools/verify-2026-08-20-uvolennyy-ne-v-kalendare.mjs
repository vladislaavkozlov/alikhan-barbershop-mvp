// Живой прогон (20.08.2026, находка Влада): сотрудник с галкой «не работает в компании»
// не должен занимать колонку в календаре и не должен предлагаться в форме записи, даже
// если галка «принимает клиентов» у него осталась включённой.
//
// Фикстура повторяет боевую ситуацию один в один: employed = false, provides_services =
// true, услуги назначены, недельный график есть - то есть человек отличается от рабочего
// мастера ровно одним флагом.
//
// Что доказываем:
//   1. в колонках «Дня» уволенного нет, а работающий мастер на месте
//   2. в дропдауне мастера формы записи уволенного нет
//   3. сервер и раньше не давал записать к уволенному - запись отклоняется (регресс-щит)
//   4. уволенного нет и в публичном виджете записи для клиента
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  return (await res.json()).token;
}

const DATE = daysFromToday(1);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('uv-owner', 1, 'QA Владелец', 'owner', true, false, true, 'uv-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    // Работающий мастер - контроль: если фильтр перестарается, пропадёт и он
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email)
       VALUES ('uv-active', 1, 'Рабочий Мастер', 'master', true, true, false, 'uv-active@alikhan.test')`
    );
    // Ровно случай Влада: уволен, но галка услуг осталась
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email)
       VALUES ('uv-fired', 1, 'Тест Сценарии', 'master', false, true, false, 'uv-fired@alikhan.test')`
    );
    for (const id of ['uv-active', 'uv-fired']) {
      await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT $1, id, price, duration_min FROM services`, [id]);
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`,
        [id]
      );
    }
    const token = await login(apiUrl, 'uv-owner@alikhan.test', ownerPin);
    check('вход владельца', !!token);

    // ── 3. сервер отклоняет запись к уволенному ──────────────────────────────
    const serviceId = (await db.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0].id;
    const book = async (masterId, startTime) => {
      const res = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterId, serviceIds: [serviceId], date: DATE, startTime, clientName: 'Клиент', clientPhone: '+7 900 555-11-22' }),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const toFired = await book('uv-fired', '11:00');
    const toActive = await book('uv-active', '12:00');
    check('к уволенному записаться нельзя', toFired.status !== 200 || toFired.data?.ok === false, `${toFired.status} ${JSON.stringify(toFired.data)}`);
    check('к работающему записаться можно', toActive.status === 200 && toActive.data?.ok !== false, `${toActive.status} ${JSON.stringify(toActive.data)}`);

    // ── 4. публичный виджет уволенного не показывает ─────────────────────────
    const pub = await (await fetch(`${apiUrl}/public/masters`)).json();
    check('в публичной записи уволенного нет', !pub.some((m) => m.id === 'uv-fired'), JSON.stringify(pub.map((m) => m.id)));
    check('в публичной записи работающий есть', pub.some((m) => m.id === 'uv-active'));

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 950);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'uv-owner@alikhan.test';
          document.getElementById('loginPin').value = '${ownerPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(document.body.innerText.includes('Рабочий Мастер'))`)); i++) await sleep(200);

        // ── 1. колонки календаря ───────────────────────────────────────────
        const columns = JSON.parse(await s.eval(
          `JSON.stringify([...document.querySelectorAll('.schedule-col .col-head, .schedule-col .master-name, .schedule-head-name')].map(e => e.innerText.trim()).filter(Boolean))`
        ));
        const dayText = await s.eval(`document.querySelector('.panel-sp-day')?.innerText ?? ''`);
        check('работающий мастер в колонках дня есть', /Рабочий Мастер/.test(dayText), columns.join(' | ') || dayText.slice(0, 160));
        check('уволенного в колонках дня НЕТ', !/Тест Сценарии/.test(dayText), dayText.slice(0, 300));

        // ── 2. дропдаун формы записи ───────────────────────────────────────
        await s.eval(`window.openManualBooking && window.openManualBooking()`);
        await sleep(1200);
        const options = JSON.parse(await s.eval(
          `JSON.stringify([...document.querySelectorAll('#wfMaster-slot .custom-select-option')].map(o => o.innerText.trim()))`
        ));
        check('в форме записи работающий мастер есть', options.includes('Рабочий Мастер'), JSON.stringify(options));
        check('в форме записи уволенного НЕТ', !options.includes('Тест Сценарии'), JSON.stringify(options));

        await s.screenshot('/tmp/verify-uvolennyy.png');
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exitCode = 1;
