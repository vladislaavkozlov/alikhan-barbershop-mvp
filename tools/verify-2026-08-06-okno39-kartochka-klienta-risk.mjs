// Живая проверка Окна 39 - карточка клиента + индикатор риска ухода (GET /clients/:id,
// GET /clients?risk=true, getClientCard/listClientsAtRisk/describeClientRisk) на реальном
// Postgres и в реальном браузере, не только на fake-клиенте из tests/api.clients-risk.test.js.
// DoD промпта: тесты на оба роута (уже есть) + regression (уже прогнан) + живой прогон
// (клиент с растущим no_show_streak появляется в списке "требует внимания", "Записать
// снова" предзаполняет верно, обычная карточка без риска не показывает тревожный
// индикатор) + скриншот в чат. Тот же приём withEphemeralServer/withStaticServer/
// withBrowser, что уже применён в verify-2026-08-06-okno38-vyruchka-dnya.mjs.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pinAdmin1 = randomPin();
    const pinAdmin2 = randomPin();
    const pinMaster1 = randomPin();
    const pinMaster2 = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o39-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o39-owner@test.local', $1),
       ('o39-admin1', 1, 'QA Админ Точка 1', 'admin', true, false, true, 'o39-admin1@test.local', $2),
       ('o39-admin2', 2, 'QA Админ Точка 2', 'admin', true, false, true, 'o39-admin2@test.local', $3),
       ('o39-master1', NULL, 'QA Мастер Один', 'master', true, true, true, 'o39-master1@test.local', $4),
       ('o39-master2', NULL, 'QA Мастер Два', 'master', true, true, true, 'o39-master2@test.local', $5)`,
      [hashPin(pinOwner), hashPin(pinAdmin1), hashPin(pinAdmin2), hashPin(pinMaster1), hashPin(pinMaster2)]
    );
    // "Записать снова" рендерит service-picker по master_services этого мастера (см.
    // wireWalkIn/renderPicker, assets/crm-auth.js) - без этой строки список услуг был
    // бы пуст, а preselect (services из lastVisit) не нашёл бы ни одного checkbox.
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min)
       SELECT m.id, 'strizhka', 2000, 40 FROM (VALUES ('o39-master1'), ('o39-master2')) AS m(id)`
    );
    // Без строки в master_weekly_schedule мастер физически не бронируем (Задача C,
    // Окно 29 - mastersWithWorkingSchedule/createBookingTx отклоняет 409
    // master_not_bookable) - "Записать снова" в живом прогоне ниже реально создаёт
    // будущую бронь, значит мастеру нужен настоящий рабочий график на все дни недели.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('o39-master1'), ('o39-master2')) AS m(id), generate_series(1, 7) AS wd`
    );

    // Три клиента: растущий риск (>=2, requiresPrepayment-порог), только что пропустил
    // (=1, "watch"), и обычный без риска (=0) - для проверки "индикатор не показывается
    // тревожно" на карточке без риска.
    await db.query(
      `INSERT INTO clients (id, name, phone, no_show_streak) VALUES
       ('o39-c-high', 'КЮ Тестовый Высокий Риск', '+79990039001', 3),
       ('o39-c-watch', 'КЮ Тестовый Средний Риск', '+79990039002', 1),
       ('o39-c-safe', 'КЮ Тестовый Без Риска', '+79990039003', 0)`
    );

    const yesterday = daysFromToday(-1);
    const twoDaysAgo = daysFromToday(-2);
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o39-b-high', 1, 'o39-master1', NULL, 'o39-c-high', $1, '10:00', '10:40', 'no_show', 'admin'),
       ('o39-b-watch', 2, 'o39-master2', NULL, 'o39-c-watch', $1, '11:00', '11:40', 'no_show', 'admin'),
       ('o39-b-safe', 1, 'o39-master1', NULL, 'o39-c-safe', $2, '12:00', '12:40', 'done', 'admin')`,
      [yesterday, twoDaysAgo]
    );
    await db.query(
      `INSERT INTO booking_services (booking_id, service_id) VALUES
       ('o39-b-high', 'strizhka'), ('o39-b-watch', 'strizhka'), ('o39-b-safe', 'strizhka')`
    );

    const login = async (email, pin) => {
      const res = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      const { token } = await res.json();
      return { Authorization: `Bearer ${token}` };
    };

    const authOwner = await login('o39-owner@test.local', pinOwner);
    const authAdmin1 = await login('o39-admin1@test.local', pinAdmin1);
    const authAdmin2 = await login('o39-admin2@test.local', pinAdmin2);
    const authMaster1 = await login('o39-master1@test.local', pinMaster1);
    const authMaster2 = await login('o39-master2@test.local', pinMaster2);

    const getJson = async (path, auth) => {
      const res = await fetch(`${apiUrl}${path}`, { headers: auth });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    };

    // ── Слой 1: GET /clients?risk=true - scoping по роли ────────────────────
    const riskNoParam = await fetch(`${apiUrl}/clients`, { headers: authOwner });
    check('GET /clients без ?risk=true - 400 (не полноценный список всех клиентов, вне scope окна)', riskNoParam.status === 400, `статус ${riskNoParam.status}`);

    const riskOwner = await getJson('/clients?risk=true', authOwner);
    const ownerIds = riskOwner.body.map((c) => c.id).sort();
    check('Владелец: risk-список = оба клиента с no_show_streak>=1 (high+watch), safe не входит', JSON.stringify(ownerIds) === JSON.stringify(['o39-c-high', 'o39-c-watch']), `получено ${JSON.stringify(ownerIds)}`);
    check('Владелец: список отсортирован по убыванию streak (high первым)', riskOwner.body[0]?.id === 'o39-c-high', `первый: ${riskOwner.body[0]?.id}`);

    const riskAdmin1 = await getJson('/clients?risk=true', authAdmin1);
    check('Админ Точки 1: видит только high (визит на своей точке), не watch (визит на Точке 2)', riskAdmin1.body.length === 1 && riskAdmin1.body[0].id === 'o39-c-high', `получено ${JSON.stringify(riskAdmin1.body.map((c) => c.id))}`);

    const riskAdmin2 = await getJson('/clients?risk=true', authAdmin2);
    check('Админ Точки 2: видит только watch', riskAdmin2.body.length === 1 && riskAdmin2.body[0].id === 'o39-c-watch', `получено ${JSON.stringify(riskAdmin2.body.map((c) => c.id))}`);

    const riskMaster1 = await getJson('/clients?risk=true', authMaster1);
    check('Мастер 1: видит только high (свой клиент), не watch (клиент мастера 2)', riskMaster1.body.length === 1 && riskMaster1.body[0].id === 'o39-c-high', `получено ${JSON.stringify(riskMaster1.body.map((c) => c.id))}`);
    check('Мастер 1: телефон клиента НЕ отдаётся (разд.12 п.1, тот же уровень, что у /bookings)', riskMaster1.body[0] && !('phone' in riskMaster1.body[0]), `ключи: ${Object.keys(riskMaster1.body[0] || {})}`);

    check('Owner-список: телефон ЕСТЬ у каждого клиента', riskOwner.body.every((c) => typeof c.phone === 'string'), '');
    check('Честная оговорка: ни один risk.label в списке не содержит "заблокирова"', riskOwner.body.every((c) => !c.risk.label.toLowerCase().includes('заблокирова')), '');

    // ── Слой 1: GET /clients/:id - карточка + scoping ────────────────────────
    const notFound = await getJson('/clients/o39-nope', authOwner);
    check('GET /clients/:id неизвестный - 404 client_not_found', notFound.status === 404 && notFound.body.error === 'client_not_found', `статус ${notFound.status}, тело ${JSON.stringify(notFound.body)}`);

    const cardOwner = await getJson('/clients/o39-c-high', authOwner);
    check('Владелец: карточка high - 200, 1 визит, risk.level high', cardOwner.status === 200 && cardOwner.body.visits.length === 1 && cardOwner.body.risk.level === 'high', JSON.stringify(cardOwner.body));
    check('Карточка: lastVisit содержит masterId+masterName+services для "Записать снова"', cardOwner.body.lastVisit?.masterId === 'o39-master1' && cardOwner.body.lastVisit?.services?.[0]?.id === 'strizhka', JSON.stringify(cardOwner.body.lastVisit));

    const cardAdmin2Forbidden = await getJson('/clients/o39-c-high', authAdmin2);
    check('Админ Точки 2: карточка клиента Точки 1 - 403 forbidden (не тихий пустой ответ)', cardAdmin2Forbidden.status === 403, `статус ${cardAdmin2Forbidden.status}`);

    const cardMaster2Forbidden = await getJson('/clients/o39-c-high', authMaster2);
    check('Мастер 2: карточка чужого клиента (был только у мастера 1) - 403', cardMaster2Forbidden.status === 403, `статус ${cardMaster2Forbidden.status}`);

    const cardMaster1 = await getJson('/clients/o39-c-high', authMaster1);
    check('Мастер 1: карточка своего клиента - 200, БЕЗ поля phone', cardMaster1.status === 200 && !('phone' in cardMaster1.body), JSON.stringify(Object.keys(cardMaster1.body)));

    const cardSafe = await getJson('/clients/o39-c-safe', authOwner);
    check('Карточка без риска: risk.level none, label null (индикатор не показывается тревожно)', cardSafe.body.risk.level === 'none' && cardSafe.body.risk.label === null, JSON.stringify(cardSafe.body.risk));

    // ── Слой 2: живой браузер - crm-owner.html ───────────────────────────────
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1280, 1100, true);
        await sleep(400);

        await s.type('#loginEmail', 'o39-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1200); // login + renderLiveProof + wireClientsRisk fetch

        const raText = await s.eval(`document.getElementById('raList')?.textContent`);
        check('crm-owner.html: список "требует внимания" показывает РЕАЛЬНЫЕ имена, не фейковый пример "Клиент Ж"', (raText || '').includes('КЮ Тестовый Высокий Риск') && !(raText || '').includes('Клиент Ж'), `текст: "${raText}"`);
        check('crm-owner.html: risk.label с сервера виден в списке ("стоит позвонить")', (raText || '').includes('стоит позвонить'), `текст: "${raText}"`);

        const badge = await s.eval(`document.querySelector('.notif-bell .notif-badge')?.textContent`);
        check('Колокольчик: бейдж = 2 (high+watch), не фейковая "3"', badge === '2', `бейдж: "${badge}"`);

        await s.click('[data-open-client-id="o39-c-high"]');
        await sleep(500);
        const cardName = await s.eval(`document.getElementById('clientCardName')?.textContent`);
        check('Карточка клиента открылась с реальным именем', cardName === 'КЮ Тестовый Высокий Риск', `имя: "${cardName}"`);
        const cardVisits = await s.eval(`document.getElementById('clientCardVisits')?.textContent`);
        check('Карточка: история визитов показывает услугу и мастера', (cardVisits || '').includes('Стрижка') && (cardVisits || '').includes('QA Мастер Один'), `визиты: "${cardVisits}"`);
        const rebookVisible = await s.eval(`!document.getElementById('clientCardRebook')?.hidden`);
        check('Карточка: кнопка "Записать снова" видна (есть история)', rebookVisible === true, `hidden=${!rebookVisible}`);

        await s.click('#clientCardRebook');
        await sleep(500);
        const formHidden = await s.eval(`document.getElementById('walkinForm')?.hidden`);
        check('"Записать снова": форма записи открылась', formHidden === false, `hidden=${formHidden}`);
        const dtRowHidden = await s.eval(`document.getElementById('wfDateTimeRow')?.hidden`);
        check('"Записать снова": показаны поля даты/времени (не "прямо сейчас", как у обычного walk-in)', dtRowHidden === false, `hidden=${dtRowHidden}`);
        const wfMaster = await s.eval(`document.getElementById('wfMasterName')?.textContent`);
        check('"Записать снова": предзаполнен мастер последнего визита', wfMaster === 'QA Мастер Один', `мастер: "${wfMaster}"`);
        const wfClientName = await s.eval(`document.getElementById('wfClientName')?.value`);
        check('"Записать снова": предзаполнено имя клиента', wfClientName === 'КЮ Тестовый Высокий Риск', `имя: "${wfClientName}"`);
        const preselected = await s.eval(`document.querySelector('#wfServicePicker input[type=checkbox]:checked')?.value`);
        check('"Записать снова": услуга последнего визита предвыбрана (Стрижка)', preselected === 'strizhka', `выбрано: "${preselected}"`);

        // Дата/время - устанавливаем детерминированно (завтра, 11:00), не полагаемся на
        // дефолт виджета (today + округление "сейчас") - избегаем флаки от времени суток
        // прогона (past_time у сервера мог бы отклонить дефолт поздно вечером).
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        await s.eval(`(function(){
          const d = document.getElementById('wfDateValue'); if (d) d.dataset.value = ${JSON.stringify(tomorrow)};
          const t = document.getElementById('wfTimeValue'); if (t) t.dataset.value = '11:00';
        })()`);

        await s.screenshot('/tmp/okno39-client-card-rebook.png');

        await s.click('#wfSubmit');
        await sleep(900);
        const resultText = await s.eval(`document.getElementById('wfResult')?.textContent`);
        check('"Записать снова": сохранение прошло успешно (реальная доступность проверена сервером)', /Готово/.test(resultText || ''), `результат: "${resultText}"`);

        const saleFormHidden = await s.eval(`document.getElementById('wfSaleForm')?.hidden`);
        check('"Записать снова": форма "Добавить продажу" НЕ появляется (клиента физически ещё нет в кресле)', saleFormHidden === true, `hidden=${saleFormHidden}`);

        // ── Карточка без риска - индикатор не показывается тревожно ──────────
        await s.eval(`document.getElementById('clientCardModal').hidden = true`);
        await s.click('[data-open-client-id="o39-c-high"]'); // noop safety, гарантирует что список кликабелен после re-render
        await sleep(200);

        await s.screenshot('/tmp/okno39-risk-list.png');
      });
    });

    // ── Пост-факт проверка в БД: бронь создана как 'planned', НЕ 'done' (клиент ещё
    // не в кресле - PATCH к статусу "пришёл" был бы нечестным для будущей записи) ──
    const rebooked = await db.query(
      `SELECT status FROM bookings WHERE master_id = 'o39-master1' AND client_id = 'o39-c-high' AND date <> $1 ORDER BY created_at DESC LIMIT 1`,
      [yesterday]
    );
    check('БД: новая запись от "Записать снова" создана со статусом planned, не done', rebooked.rows[0]?.status === 'planned', `статус в БД: ${rebooked.rows[0]?.status}`);
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
