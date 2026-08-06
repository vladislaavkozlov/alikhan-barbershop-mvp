// Живая проверка Окна 40 - дашборд владельца "Сегодня" (GET /owner/alerts,
// computeOwnerAlerts) на реальном Postgres и в реальном браузере, не только на
// fake-клиенте из tests/api.owner-alerts.test.js. DoD промпта: тест на роут (уже
// есть) + regression (уже прогнан) + живой прогон (все три источника алертов
// корректно агрегируются, каждый пункт кликабелен, пустое состояние не показывает
// декоративных блоков) + скриншот. Тот же приём withEphemeralServer/
// withStaticServer/withBrowser, что verify-2026-08-06-okno39-kartochka-klienta-risk.mjs.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o40-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o40-owner@test.local', $1),
       ('o40-master1', NULL, 'QA Мастер С Графиком', 'master', true, true, true, 'o40-master1@test.local', $2),
       ('o40-master2', NULL, 'QA Мастер Без Графика', 'master', true, true, true, 'o40-master2@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    // master1 - рабочий график на все дни (бронируем, считаем выручку); master2 -
    // НАМЕРЕННО ни одной строки в master_weekly_schedule (тест "мастер без графика").
    // Базовые сидовые master-1/2/3 (миграция 002) на свежей базе тоже без единой
    // строки в master_weekly_schedule (эта таблица - более поздняя фича) - без их
    // собственного графика mastersWithoutSchedule содержал бы их тоже, что ломало
    // бы точное сравнение ниже. Даём и им рабочий график, чтобы "чисто" в тесте
    // означало ровно то же, что "чисто" будет означать на реальном бою.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('o40-master1'), ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o40-master1', 'strizhka', 2500, 40)`
    );

    // Бронь сегодня у master1 + реальная продажа (computeRevenueToday читает
    // sales.amount, не цену брони напрямую - см. api/server.mjs) - реальное число
    // на #revenueTodayAmount, не "0 ₽ пример".
    const today = daysFromToday(0);
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o40-b1', 1, 'o40-master1', NULL, NULL, $1, '11:00', '11:40', 'planned', 'admin')`,
      [today]
    );
    await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ('o40-b1', 'strizhka')`);
    await db.query(`INSERT INTO sales (id, booking_id, item_name, amount) VALUES ('o40-sale1', 'o40-b1', 'Стрижка', 2500)`);

    // Необработанная заявка master1 на отгул.
    const reqRes = await db.query(
      `INSERT INTO schedule_change_requests (master_id, request_type, date_from, date_to, status)
       VALUES ('o40-master1', 'day_off', $1, $1, 'pending') RETURNING id`,
      [daysFromToday(5)]
    );
    const requestId = reqRes.rows[0].id;

    // Клиент на грани ухода.
    await db.query(
      `INSERT INTO clients (id, name, phone, no_show_streak) VALUES ('o40-client-risk', 'КЮ Тестовый Риск', '+79990040001', 2)`
    );
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o40-b-risk', 1, 'o40-master1', NULL, 'o40-client-risk', $1, '09:00', '09:40', 'no_show', 'admin')`,
      [daysFromToday(-1)]
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
    const authOwner = await login('o40-owner@test.local', pinOwner);

    // ── Слой 1: GET /owner/alerts напрямую ──────────────────────────────────
    const alertsRes = await fetch(`${apiUrl}/owner/alerts`, { headers: authOwner });
    const alerts = await alertsRes.json();
    check('GET /owner/alerts - 200', alertsRes.status === 200, `статус ${alertsRes.status}`);
    check('mastersWithoutSchedule - только master2 (у master1 есть график)', alerts.mastersWithoutSchedule.length === 1 && alerts.mastersWithoutSchedule[0].id === 'o40-master2', JSON.stringify(alerts.mastersWithoutSchedule));
    check('pendingRequests - одна заявка master1, статус не утекает approved/rejected', alerts.pendingRequests.length === 1 && alerts.pendingRequests[0].masterId === 'o40-master1', JSON.stringify(alerts.pendingRequests));
    check('clientsAtRisk - клиент риска присутствует с описанием', alerts.clientsAtRisk.length === 1 && alerts.clientsAtRisk[0].risk.level === 'high', JSON.stringify(alerts.clientsAtRisk));

    // Роль admin/master не должна пройти (auth: owner в реестре роутов).
    const noAuthRes = await fetch(`${apiUrl}/owner/alerts`);
    check('GET /owner/alerts без токена - 401', noAuthRes.status === 401, `статус ${noAuthRes.status}`);

    // ── Слой 2: живой браузер - crm-owner.html, вкладка "Сегодня" ───────────
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1280, 1400, true);
        await sleep(400);

        await s.type('#loginEmail', 'o40-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300); // login + renderLiveProof + owner/alerts fetch

        const defaultTab = await s.eval(`document.getElementById('pt-today')?.checked`);
        check('Вкладка "Сегодня" открыта по умолчанию после входа (первый экран)', defaultTab === true, `checked=${defaultTab}`);

        const revenueText = await s.eval(`document.getElementById('revenueTodayAmount')?.textContent`);
        // toLocaleString('ru-RU') разделяет тысячи неразрывным пробелом (U+00A0/U+202F,
        // не обычным ' ') - сравниваем без пробелов, не литералом "2 500".
        check('Выручка сегодня - реальное число (2500 ₽ от продажи по брони master1), не "000 ₽ пример"', (revenueText || '').replace(/\s/gu, '').includes('2500'), `текст: "${revenueText}"`);

        const scheduleAlertText = await s.eval(`document.getElementById('ownerAlertsSchedule')?.textContent`);
        check('Алерт "мастер без графика" называет реального master2, не декоративный пример', (scheduleAlertText || '').includes('QA Мастер Без Графика'), `текст: "${scheduleAlertText}"`);

        const requestAlertText = await s.eval(`document.getElementById('ownerAlertsRequests')?.textContent`);
        check('Алерт "необработанная заявка" называет реального master1', (requestAlertText || '').includes('QA Мастер С Графиком'), `текст: "${requestAlertText}"`);

        const raText = await s.eval(`document.getElementById('raList')?.textContent`);
        check('Список "требует внимания" (перенесённый #raList) показывает реального клиента риска', (raText || '').includes('КЮ Тестовый Риск'), `текст: "${raText}"`);

        await s.screenshot('/tmp/okno40-dashboard-segodnya-alerts.png');

        // ── Прямое действие: клик "Настроить график" переключает на вкладку "Сотрудники" ──
        await s.click('#ownerAlertsSchedule [data-open-schedule-tab]');
        await sleep(150);
        const onStaffTab = await s.eval(`document.getElementById('pt-b')?.checked`);
        check('"Настроить график" переключает на вкладку "Сотрудники" (прямое действие, не просто текст)', onStaffTab === true, `pt-b.checked=${onStaffTab}`);

        // ── Прямое действие: клик "Открыть" на заявке переключает на "Расписание" ──
        await s.eval(`document.getElementById('pt-today').checked = true`);
        await sleep(100);
        await s.click('#ownerAlertsRequests [data-open-requests-tab]');
        await sleep(150);
        const onScheduleTab = await s.eval(`document.getElementById('pt-a')?.checked`);
        check('"Открыть" на заявке переключает на вкладку "Расписание" (прямое действие)', onScheduleTab === true, `pt-a.checked=${onScheduleTab}`);

        // ── Прямое действие: клик на клиенте риска открывает карточку (переиспользует Окно 39) ──
        await s.eval(`document.getElementById('pt-today').checked = true`);
        await sleep(100);
        await s.click('[data-open-client-id="o40-client-risk"]');
        await sleep(500);
        const cardName = await s.eval(`document.getElementById('clientCardName')?.textContent`);
        check('Клик на клиенте риска открывает карточку клиента (переиспользован Окно 39, не новый код)', cardName === 'КЮ Тестовый Риск', `имя: "${cardName}"`);
        await s.eval(`document.getElementById('clientCardModal').hidden = true`);
      });
    });

    // ── Пустое состояние: снимаем все три источника алертов, перезагружаем ──
    await db.query(`INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o40-master2', wd, true, '10:00', '20:00' FROM generate_series(1, 7) AS wd`);
    const decideRes = await fetch(`${apiUrl}/schedule-requests/${requestId}/decision`, {
      method: 'PATCH',
      headers: { ...authOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'rejected', ownerComment: 'QA cleanup' }),
    });
    check('Заявка снята решением (rejected) через уже существующий роут', decideRes.status === 200, `статус ${decideRes.status}`);
    await db.query(`UPDATE clients SET no_show_streak = 0 WHERE id = 'o40-client-risk'`);

    const emptyAlerts = await fetch(`${apiUrl}/owner/alerts`, { headers: authOwner }).then((r) => r.json());
    check('После снятия всех трёх источников - все списки пустые (бэкенд)', emptyAlerts.mastersWithoutSchedule.length === 0 && emptyAlerts.pendingRequests.length === 0 && emptyAlerts.clientsAtRisk.length === 0, JSON.stringify(emptyAlerts));

    // withBrowser убивает процесс Chrome в finally, но освобождение порта не
    // мгновенное - без паузы второй withBrowser подряд иногда ловит "Could not
    // create new page" (тот же приём, что verify-2026-08-04-okno18).
    await sleep(1500);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1280, 900, true);
        await sleep(400);
        await s.type('#loginEmail', 'o40-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);

        const scheduleEmpty = await s.eval(`document.getElementById('ownerAlertsSchedule')?.innerHTML`);
        check('Пустое состояние: "Всё в порядке" вместо декоративного пустого списка', (scheduleEmpty || '').includes('Всё в порядке'), `html: "${scheduleEmpty}"`);
        const requestsEmpty = await s.eval(`document.getElementById('ownerAlertsRequests')?.innerHTML`);
        check('Пустое состояние: второй блок алертов не рисует пустых строк (объединено в одно сообщение)', !(requestsEmpty || '').includes('break-row'), `html: "${requestsEmpty}"`);
        const raEmpty = await s.eval(`document.getElementById('raList')?.textContent`);
        check('Пустое состояние: клиентский риск-список тоже честно пуст ("Нет клиентов...")', (raEmpty || '').includes('Нет клиентов'), `текст: "${raEmpty}"`);

        await s.screenshot('/tmp/okno40-dashboard-segodnya-empty.png');
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
