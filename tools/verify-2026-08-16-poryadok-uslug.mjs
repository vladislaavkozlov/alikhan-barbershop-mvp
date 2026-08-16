// Живая проверка единого порядка показа услуг (Влад, 16.08.2026):
// стрижка → борода → комплекс → бритьё → фирменная окантовка → тонировка → воск → СПА уход.
//
// До правки порядок задавался алфавитом и был РАЗНЫМ в разных формах: GET /services
// сортировал по имени (Борода, Бритьё, Воск, Комплекс…), GET /master-services - по
// service_id (boroda, britie, firmennaya-okantovka, kompleks…), публичный сайт до
// загрузки сети показывал третий (порядок SERVICES в storage.js). Теперь порядок
// один: колонка services.sort_order (миграция 049) на бэкенде + sortByServiceOrder
// (storage.js) на фронте - вторая нужна потому, что GitHub Pages и Amvera
// деплоятся раздельно, между деплоями API какое-то время отдаёт старый порядок.
//
// Стенд весь свой (tools/verify-lib.mjs): одноразовая база + свой сервер + свой
// QA-владелец и QA-мастер со случайным PIN. Внешних фикстур не требует.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_IDS = [
  'strizhka',
  'boroda',
  'kompleks-strizhka-boroda',
  'britie',
  'firmennaya-okantovka',
  'tonirovka',
  'vosk',
  'spa-uhod',
];
const EXPECTED_NAMES = [
  'Стрижка',
  'Борода',
  'Комплекс стрижка+борода',
  'Бритьё',
  'Фирменная окантовка',
  'Тонировка седых волос',
  'Воск',
  'СПА уход',
];

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error(`логин ${email} → ${res.status}`);
  return (await res.json()).token;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    // ── QA-аккаунты этого прогона. PIN случайный, в репозиторий не попадает.
    const ownerPin = randomPin();
    const adminPin = randomPin();
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vu-owner', 1, 'QA Владелец', 'owner', true, false, true, 'vu-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vu-admin', 1, 'QA Админ', 'admin', true, false, true, 'vu-admin@alikhan.test', $1)`,
      [hashPin(adminPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vu-master', 1, 'QA Мастер', 'master', true, true, true, 'vu-master@alikhan.test', $1)`,
      [hashPin(masterPin)]
    );
    // Мастеру назначены ВСЕ 8 услуг - иначе проверять порядок не на чем
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min)
       SELECT 'vu-master', id, price, duration_min FROM services`
    );
    // График - чтобы мастер был бронируемым на публичном сайте (filterBookableMasters)
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'vu-master', g, true, '10:00', '20:00' FROM generate_series(1, 7) g
       ON CONFLICT DO NOTHING`
    );

    // ── 1. Миграция 049 реально применилась и проставила порядок
    const sortRes = await db.query('SELECT id, sort_order FROM services ORDER BY sort_order, name, id');
    check(
      'миграция 049: services.sort_order задаёт порядок в самой базе',
      eq(sortRes.rows.map((r) => r.id), EXPECTED_IDS),
      sortRes.rows.map((r) => `${r.id}:${r.sort_order}`).join(', ')
    );

    // ── 2. Роуты API отдают тот же порядок
    const token = await login(apiUrl, 'vu-owner@alikhan.test', ownerPin);
    const catalog = await (await fetch(`${apiUrl}/services`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check('GET /services - каталог в порядке продажи, не по алфавиту', eq(catalog.map((s) => s.id), EXPECTED_IDS),
      catalog.map((s) => s.name).join(' · '));
    check('GET /services - имена совпадают с ожидаемыми', eq(catalog.map((s) => s.name), EXPECTED_NAMES));

    const ms = await (await fetch(`${apiUrl}/master-services`)).json();
    const mine = ms.filter((r) => r.masterId === 'vu-master').map((r) => r.serviceId);
    check('GET /master-services - услуги мастера в том же порядке', eq(mine, EXPECTED_IDS), mine.join(', '));

    const pub = await (await fetch(`${apiUrl}/public/masters`)).json();
    const pubMaster = (pub.masters || pub).find?.((m) => m.id === 'vu-master');
    if (pubMaster?.services) {
      check(
        'GET /public/masters - услуги мастера на сайте в том же порядке',
        eq(pubMaster.services.map((s) => s.id), EXPECTED_IDS),
        pubMaster.services.map((s) => s.name).join(' · ')
      );
    } else {
      check('GET /public/masters - услуги мастера на сайте в том же порядке', false, 'мастер не попал в публичную выдачу');
    }

    // ── 3. Живые формы в браузере: сайт клиента + кабинет владельца + кабинет мастера.
    // Один withBrowser на весь прогон - cdp.mjs хардкодит порт отладки, два подряд гонятся.
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        // 3.1 Публичный сайт: прайс-лист и чекбоксы услуг в форме записи
        await s.navigate(`${siteUrl}/index.html`);
        await sleep(1500);
        const priceNames = await s.eval(
          `[...document.querySelectorAll('#price-grid .price-card-head h3')].map((n) => n.textContent.trim())`
        );
        check('сайт: прайс-лист в порядке продажи', eq(priceNames, EXPECTED_NAMES), (priceNames || []).join(' · '));

        // Выбор мастера открывает список его услуг. Ждём ВТОРОГО рендера карточек
        // мастера (бейдж .opt-availability появляется только после ответа сети) -
        // иначе кликнем по списку, который ещё не знает реальных master_services,
        // и проверим фолбэк из storage.js вместо живых данных.
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.querySelector('#master-grid .opt-availability'))`)); i++) {
          await sleep(150);
        }
        const clicked = await s.eval(
          `(() => {
             const btn = [...document.querySelectorAll('#master-grid .option-card')]
               .find((n) => n.querySelector('.opt-name')?.textContent.trim() === 'QA Мастер');
             btn?.click();
             return Boolean(btn);
           })()`
        );
        await sleep(800);
        const siteServices = await s.eval(
          `[...document.querySelectorAll('#service-grid .option-card .opt-name')].map((n) => n.textContent.trim())`
        );
        check(
          'сайт: чекбоксы услуг в форме записи в порядке продажи',
          clicked && eq(siteServices, EXPECTED_NAMES),
          clicked ? (siteServices || []).join(' · ') : 'карточка QA Мастера не найдена в списке выбора'
        );

        // 3.2 Кабинет владельца: редактор услуг в карточке сотрудника
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
        await s.eval(
          `document.getElementById('loginEmail').value = 'vu-owner@alikhan.test';
           document.getElementById('loginPin').value = '${ownerPin}';
           document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
        );
        await sleep(2500);
        const ownerNames = await s.eval(
          `[...document.querySelectorAll('.service-picker .service-check .sc-name')].map((n) => n.textContent.trim()).slice(0, 8)`
        );
        check('владелец: услуги в карточке сотрудника в порядке продажи', eq(ownerNames, EXPECTED_NAMES),
          (ownerNames || []).join(' · '));

        // Форма "Новая запись" - тот же список, но из master-services
        await s.eval(`window.openManualBooking?.()`);
        await sleep(900);
        const walkinNames = await s.eval(
          `[...document.querySelectorAll('#wfServicePicker .service-check .sc-name')].map((n) => n.textContent.trim())`
        );
        check(
          'владелец: услуги в форме "Новая запись" в порядке продажи',
          walkinNames?.length ? eq(walkinNames, EXPECTED_NAMES) : false,
          (walkinNames || []).join(' · ')
        );

        // 3.3 Кабинет админа: та же форма записи, другая страница и роль
        await s.navigate(`${siteUrl}/crm-admin.html`);
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
        await s.eval(
          `document.getElementById('loginEmail').value = 'vu-admin@alikhan.test';
           document.getElementById('loginPin').value = '${adminPin}';
           document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
        );
        await sleep(2500);
        await s.eval(`window.openManualBooking?.()`);
        await sleep(900);
        const adminNames = await s.eval(
          `[...document.querySelectorAll('#wfServicePicker .service-check .sc-name')].map((n) => n.textContent.trim())`
        );
        check(
          'админ: услуги в форме "Новая запись" в порядке продажи',
          adminNames?.length ? eq(adminNames, EXPECTED_NAMES) : false,
          (adminNames || []).join(' · ')
        );

        // 3.4 Кабинет мастера: свои услуги во вкладке "Личные данные"
        await s.navigate(`${siteUrl}/crm-master.html`);
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
        await s.eval(
          `document.getElementById('loginEmail').value = 'vu-master@alikhan.test';
           document.getElementById('loginPin').value = '${masterPin}';
           document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
        );
        await sleep(2500);
        const masterNames = await s.eval(
          `[...document.querySelectorAll('#selfServicePicker .service-check .sc-name')].map((n) => n.textContent.trim())`
        );
        check('мастер: свои услуги в "Личных данных" в порядке продажи', eq(masterNames, EXPECTED_NAMES),
          (masterNames || []).join(' · '));
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exit(1);
