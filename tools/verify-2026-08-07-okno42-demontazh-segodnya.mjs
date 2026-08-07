// Живая проверка Окна 42 - демонтаж вкладки "Сегодня" (ПРОМПТ-ОКНО-42-ДЕМОНТАЖ-
// СЕГОДНЯ.md) на реальном Postgres и в реальном браузере. DoD промпта: sidebar
// показывает 3 пункта (Расписание/Команда/Финансы), вход по умолчанию -
// Расписание. Алерт "мастер без графика" виден наверху Расписания с рабочей
// кнопкой перехода. Выручка сегодня нигде не дублируется вне Финансов. Риск-
// список клиентов не виден на UI, но счётчик колокольчика учитывает его (фикстура
// с ненулевым риск-списком - бейдж должен быть > 0). Тот же приём
// withEphemeralServer/withStaticServer/withBrowser, что verify-2026-08-07-
// okno41-design-tokens-app-shell.mjs.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o42-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o42-owner@test.local', $1),
       ('o42-master1', NULL, 'QA Мастер С Графиком', 'master', true, true, true, 'o42-master1@test.local', $2),
       ('o42-master2', NULL, 'QA Мастер Без Графика', 'master', true, true, true, 'o42-master2@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    // master1 + сидовые master-1/2/3 (миграция 002) получают график, иначе они бы
    // попали в mastersWithoutSchedule и испортили точную проверку баннера ниже.
    // master2 намеренно без единой строки (тест баннера "мастер без графика").
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('o42-master1'), ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );

    // Необработанная заявка master1 (тест кнопки "Открыть" → скролл к истории заявок).
    await db.query(
      `INSERT INTO schedule_change_requests (master_id, request_type, date_from, date_to, status)
       VALUES ('o42-master1', 'day_off', $1, $1, 'pending')`,
      [daysFromToday(5)]
    );

    // Риск-клиент (no_show_streak >= 1 + хотя бы одна бронь - см. listClientsAtRisk,
    // api/routes/clients.js) - для проверки, что счётчик колокольчика реален (> 0),
    // хотя сам список нигде на UI не рендерится (Окно 48 ещё заглушка).
    await db.query(
      `INSERT INTO clients (id, name, phone, no_show_streak) VALUES ('o42-c-risk', 'КЮ Тестовый Риск', '+79990042001', 2)`
    );
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o42-b-risk', 1, 'o42-master1', NULL, 'o42-c-risk', $1, '10:00', '10:40', 'no_show', 'admin')`,
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
    await login('o42-owner@test.local', pinOwner); // подтверждает, что фикстура логинится - сам прогон целиком через живой браузер ниже

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true); // >=1024px - desktop breakpoint sidebar
        await sleep(400);

        await s.type('#loginEmail', 'o42-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300); // login + renderLiveProof + owner/alerts + clients?risk=true + initAppShell

        // ── Sidebar: ровно 3 пункта, вход по умолчанию - Расписание ─────────
        const navItems = await s.eval(`[...document.querySelectorAll('.app-nav-item')].map((b) => b.dataset.section)`);
        check('Sidebar содержит ровно 3 пункта (Расписание/Команда/Финансы), "Сегодня" убрана', JSON.stringify(navItems) === JSON.stringify(['schedule', 'team', 'finance']), `пункты: ${JSON.stringify(navItems)}`);

        const defaultActive = await s.eval(`document.querySelector('.app-nav-item[data-section="schedule"]')?.classList.contains('is-active')`);
        const panelAVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-a')).display !== 'none'`);
        const ptaChecked = await s.eval(`document.getElementById('pt-a')?.checked`);
        check('Вход по умолчанию - раздел "Расписание" (не "Сегодня")', defaultActive === true && panelAVisible === true && ptaChecked === true, `active=${defaultActive}, panelVisible=${panelAVisible}, checked=${ptaChecked}`);

        const noTodayTab = await s.eval(`document.getElementById('pt-today') === null && document.querySelector('.panel-today') === null`);
        check('Разметка "Сегодня" (pt-today/panel-today) физически удалена из DOM', noTodayTab === true, `удалена=${noTodayTab}`);

        // ── Алерт "мастер без графика" виден наверху "Расписания" ───────────
        const scheduleAlertBtn = await s.eval(`!!document.querySelector('#ownerAlertsSchedule [data-open-schedule-tab]')`);
        check('Алерт "мастер без графика" отрисован наверху "Расписания" (фикстура: master2 без графика)', scheduleAlertBtn === true, `найдено=${scheduleAlertBtn}`);

        const alertAboveWalkin = await s.eval(`(() => {
          const alert = document.getElementById('ownerAlertsSchedule');
          const walkin = document.getElementById('walkinForm');
          if (!alert || !walkin) return false;
          return !!(alert.compareDocumentPosition(walkin) & Node.DOCUMENT_POSITION_FOLLOWING);
        })()`);
        check('Баннер алертов стоит НАД остальным содержимым "Расписания" (перед walkin-формой в DOM)', alertAboveWalkin === true, `above=${alertAboveWalkin}`);

        await s.screenshot('/tmp/okno42-schedule-with-banner.png');

        // ── Кнопка "Настроить график" по-прежнему ведёт в "Команду" ─────────
        await s.click('#ownerAlertsSchedule [data-open-schedule-tab]');
        await sleep(150);
        const afterScheduleAlert = await s.eval(`({ checked: document.getElementById('pt-b')?.checked, active: document.querySelector('.app-nav-item[data-section="team"]')?.classList.contains('is-active') })`);
        check('"Настроить график" переключает на раздел "Команда"', afterScheduleAlert.checked === true && afterScheduleAlert.active === true, JSON.stringify(afterScheduleAlert));

        await s.click('.app-nav-item[data-section="schedule"]');
        await sleep(150);

        // ── Кнопка "Открыть" на заявке скроллит к истории заявок (не переключает раздел) ──
        const requestAlertBtn = await s.eval(`!!document.querySelector('#ownerAlertsRequests [data-open-requests-tab]')`);
        check('Алерт "необработанная заявка" отрисован (фикстура: заявка master1)', requestAlertBtn === true, `найдено=${requestAlertBtn}`);
        const scrollBefore = await s.eval(`window.scrollY`);
        await s.click('#ownerAlertsRequests [data-open-requests-tab]');
        await sleep(500); // scrollIntoView({behavior:'smooth'})
        const scrollAfter = await s.eval(`window.scrollY`);
        const stillOnSchedule = await s.eval(`document.getElementById('pt-a')?.checked`);
        check('"Открыть" на заявке скроллит вниз к истории заявок, оставаясь в разделе "Расписание"', scrollAfter > scrollBefore && stillOnSchedule === true, `scrollBefore=${scrollBefore}, scrollAfter=${scrollAfter}, stillOnSchedule=${stillOnSchedule}`);
        const requestsHistoryInView = await s.eval(`(() => {
          const el = document.getElementById('scheduleRequestsHistory');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight;
        })()`);
        check('Секция "Заявки мастеров на изменение графика" реально в зоне видимости после скролла', requestsHistoryInView === true, `inView=${requestsHistoryInView}`);

        // ── Выручка сегодня нигде не дублируется вне "Финансов" ──────────────
        const revenueTodayCount = await s.eval(`document.querySelectorAll('#revenueTodayAmount').length`);
        check('#revenueTodayAmount отсутствует на crm-owner.html целиком (не дублирует "Финансы")', revenueTodayCount === 0, `найдено ${revenueTodayCount} элементов`);
        const financeRevenueExists = await s.eval(`!!document.getElementById('rvAllDayRevenue')`);
        check('Раздел "Финансы" по-прежнему считает выручку дня (#rvAllDayRevenue на месте)', financeRevenueExists === true, `найден=${financeRevenueExists}`);

        // ── Риск-список: не виден на UI, но счётчик колокольчика реален (> 0) ─
        const raListGone = await s.eval(`document.getElementById('raList') === null`);
        check('#raList (риск-список клиентов) отсутствует на UI (Окно 48 ещё заглушка)', raListGone === true, `удалён=${raListGone}`);
        const riskBadgeText = await s.eval(`document.getElementById('riskClientsBadge')?.textContent`);
        check('Счётчик колокольчика "Клиенты, которым стоит позвонить" реален (> 0) на фикстуре с риск-клиентом', Number(riskBadgeText) > 0, `бейдж="${riskBadgeText}"`);
      });

      // withBrowser убивает Chrome в finally, но освобождение порта не мгновенное -
      // без паузы следующий withBrowser иногда ловит "Could not create new page".
      await sleep(1500);

      // ── Impact Analysis: crm-admin.html/crm-master.html не задеты этим окном -
      // модульный граф грузится без исключений, форма входа рендерится как раньше.
      for (const [page, role] of [['crm-admin.html', 'admin'], ['crm-master.html', 'master']]) {
        await withBrowser(async (s) => {
          await s.navigate(`${base}/${page}`);
          await s.setViewport(1440, 1000, true);
          await sleep(500);
          const loginGateVisible = await s.eval(`document.getElementById('loginEmail') !== null`);
          check(`${page}: форма входа по-прежнему рендерится (${role}, регрессия нет)`, loginGateVisible === true, `loginEmail найден=${loginGateVisible}`);
          const bridgeFn = await s.eval(`typeof window.crmGoToSection`);
          check(`${page}: модульный граф загрузился без исключений`, bridgeFn === 'function', `typeof window.crmGoToSection = ${bridgeFn}`);
        });
        await sleep(1500);
      }
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
