// Живая проверка Окна 41 - design tokens + app shell (sidebar/topbar/роутинг,
// crm-app-shell.js) на реальном Postgres и в реальном браузере. DoD промпта:
// sidebar рендерится, все 6 пунктов кликабельны и переключают раздел без reload,
// старые 4 раздела показывают ровно тот же контент, что до правки, три
// мигрированных cross-link'а из ШАГА 0 продолжают работать (кнопка "Выручка за
// неделю/месяц →", оба goToTab-перехода в crm-owner-today.js, клик по уведомлению
// в crm-notifications.js). Тот же приём withEphemeralServer/withStaticServer/
// withBrowser, что verify-2026-08-06-okno40-dashboard-segodnya.mjs - фикстуры
// алертов переиспользованы 1в1 оттуда (мастер без графика + необработанная заявка).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o41-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o41-owner@test.local', $1),
       ('o41-master1', NULL, 'QA Мастер С Графиком', 'master', true, true, true, 'o41-master1@test.local', $2),
       ('o41-master2', NULL, 'QA Мастер Без Графика', 'master', true, true, true, 'o41-master2@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    // master1 - рабочий график (не должен попасть в mastersWithoutSchedule);
    // master2 - намеренно без единой строки (тест кнопки "Настроить график").
    // Сидовые master-1/2/3 (миграция 002) тоже получают график, иначе они бы
    // попали в mastersWithoutSchedule и испортили точное сравнение ниже.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('o41-master1'), ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );

    // Необработанная заявка master1 (тест кнопки "Открыть" → раздел "Расписание").
    await db.query(
      `INSERT INTO schedule_change_requests (master_id, request_type, date_from, date_to, status)
       VALUES ('o41-master1', 'day_off', $1, $1, 'pending')`,
      [daysFromToday(5)]
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
    const authOwner = await login('o41-owner@test.local', pinOwner);
    void authOwner; // прогон целиком через живой браузер (не raw fetch) - shell не имеет собственного контракта данных

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true); // >=1024px - desktop breakpoint sidebar
        await sleep(400);

        await s.type('#loginEmail', 'o41-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300); // login + renderLiveProof + owner/alerts fetch + initAppShell

        // ── Sidebar рендерится и виден на desktop ────────────────────────────
        const shellActive = await s.eval(`document.body.classList.contains('app-shell-active')`);
        check('body.app-shell-active выставлен после успешного входа', shellActive === true, `active=${shellActive}`);

        const sidebarVisible = await s.eval(`getComputedStyle(document.getElementById('appSidebar')).display !== 'none'`);
        check('Sidebar виден на desktop-вьюпорте (1440px)', sidebarVisible === true, `visible=${sidebarVisible}`);

        const navCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Sidebar содержит ровно 6 пунктов навигации', navCount === 6, `найдено ${navCount}`);

        const oldTabBarHidden = await s.eval(`getComputedStyle(document.querySelector('.page-tabs .tab-bar')).display === 'none'`);
        check('Старая горизонтальная .tab-bar скрыта на desktop (заменена sidebar)', oldTabBarHidden === true, `hidden=${oldTabBarHidden}`);

        const defaultActive = await s.eval(`document.querySelector('.app-nav-item[data-section="today"]')?.classList.contains('is-active')`);
        check('По умолчанию активен пункт "Сегодня" (совпадает с pt-today checked)', defaultActive === true, `active=${defaultActive}`);

        await s.screenshot('/tmp/okno41-app-shell-sidebar.png');

        // ── 6 пунктов кликабельны и переключают раздел без reload ───────────
        const clickSection = async (sectionId) => {
          await s.click(`.app-nav-item[data-section="${sectionId}"]`);
          await sleep(150);
        };

        await clickSection('schedule');
        let panelAVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-a')).display !== 'none'`);
        let ptaChecked = await s.eval(`document.getElementById('pt-a')?.checked`);
        check('Клик "Расписание" → panel-a видна, pt-a.checked (старый контент не сломан)', panelAVisible === true && ptaChecked === true, `panelAVisible=${panelAVisible}, checked=${ptaChecked}`);

        await clickSection('team');
        let panelBVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-b')).display !== 'none'`);
        let ptbChecked = await s.eval(`document.getElementById('pt-b')?.checked`);
        check('Клик "Команда" → panel-b видна, pt-b.checked', panelBVisible === true && ptbChecked === true, `panelBVisible=${panelBVisible}, checked=${ptbChecked}`);

        await clickSection('finance');
        let panelCVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-c')).display !== 'none'`);
        let ptcChecked = await s.eval(`document.getElementById('pt-c')?.checked`);
        check('Клик "Финансы" → panel-c видна, pt-c.checked', panelCVisible === true && ptcChecked === true, `panelCVisible=${panelCVisible}, checked=${ptcChecked}`);

        await clickSection('clients');
        const clientsStubVisible = await s.eval(`getComputedStyle(document.querySelector('.shell-section-empty[data-stub="clients"]')).display !== 'none'`);
        const pageTabsHiddenOnStub = await s.eval(`getComputedStyle(document.querySelector('.page-tabs')).display === 'none'`);
        check('Клик "Клиенты" (заглушка) → текст-заглушка виден, старые панели скрыты целиком', clientsStubVisible === true && pageTabsHiddenOnStub === true, `stub=${clientsStubVisible}, tabsHidden=${pageTabsHiddenOnStub}`);
        const clientsStubText = await s.eval(`document.querySelector('.shell-section-empty[data-stub="clients"]')?.textContent`);
        check('Заглушка "Клиенты" называет своё окно (Окно 48), не голый пустой блок', (clientsStubText || '').includes('48'), `текст: "${clientsStubText}"`);

        await clickSection('settings');
        const settingsStubVisible = await s.eval(`getComputedStyle(document.querySelector('.shell-section-empty[data-stub="settings"]')).display !== 'none'`);
        check('Клик "Настройки" (заглушка) → текст-заглушка виден', settingsStubVisible === true, `stub=${settingsStubVisible}`);

        await clickSection('today');
        const backToTodayVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-today')).display !== 'none'`);
        const titleText = await s.eval(`document.getElementById('shellSectionTitle')?.textContent`);
        check('Возврат на "Сегодня" - panel-today снова видна, заголовок раздела синхронизирован', backToTodayVisible === true && titleText === 'Сегодня', `visible=${backToTodayVisible}, title="${titleText}"`);

        // ── Cross-link 1: кнопка "Выручка за неделю/месяц →" (ШАГ 0, п.1) ───
        await s.click('#revenueWeekMonthLink');
        await sleep(150);
        const afterRevenueLink = await s.eval(`({ checked: document.getElementById('pt-c')?.checked, active: document.querySelector('.app-nav-item[data-section="finance"]')?.classList.contains('is-active') })`);
        check('Cross-link 1: "Выручка за неделю/месяц →" переключает на раздел "Финансы" (goToSection, не прямой radio)', afterRevenueLink.checked === true && afterRevenueLink.active === true, JSON.stringify(afterRevenueLink));

        await clickSection('today');
        await sleep(200); // renderOwnerAlerts уже отработал при первой загрузке, алерты в DOM

        // ── Cross-link 2a: "Настроить график" (goToTab→goToSection('team'), ШАГ 0 п.2) ──
        const scheduleAlertBtn = await s.eval(`!!document.querySelector('#ownerAlertsSchedule [data-open-schedule-tab]')`);
        check('Фикстура: алерт "мастер без графика" отрисован (есть кнопка "Настроить график")', scheduleAlertBtn === true, `найдено=${scheduleAlertBtn}`);
        await s.click('#ownerAlertsSchedule [data-open-schedule-tab]');
        await sleep(150);
        const afterScheduleAlert = await s.eval(`({ checked: document.getElementById('pt-b')?.checked, active: document.querySelector('.app-nav-item[data-section="team"]')?.classList.contains('is-active') })`);
        check('Cross-link 2a: "Настроить график" переключает на раздел "Команда" через goToSection', afterScheduleAlert.checked === true && afterScheduleAlert.active === true, JSON.stringify(afterScheduleAlert));

        await clickSection('today');
        await sleep(150);

        // ── Cross-link 2b: "Открыть" на заявке (goToTab→goToSection('schedule')) ──
        const requestAlertBtn = await s.eval(`!!document.querySelector('#ownerAlertsRequests [data-open-requests-tab]')`);
        check('Фикстура: алерт "необработанная заявка" отрисован (есть кнопка "Открыть")', requestAlertBtn === true, `найдено=${requestAlertBtn}`);
        await s.click('#ownerAlertsRequests [data-open-requests-tab]');
        await sleep(150);
        const afterRequestAlert = await s.eval(`({ checked: document.getElementById('pt-a')?.checked, active: document.querySelector('.app-nav-item[data-section="schedule"]')?.classList.contains('is-active') })`);
        check('Cross-link 2b: "Открыть" на заявке переключает на раздел "Расписание" через goToSection', afterRequestAlert.checked === true && afterRequestAlert.active === true, JSON.stringify(afterRequestAlert));

        // ── Cross-link 3: клик по уведомлению "мастер потерял график" (openMasterCard, ШАГ 0 п.3) ──
        // Отдельная фикстура не нужна: сканер Окна 35 уже создал это уведомление САМ
        // при входе владельца (master2 намеренно без графика, см. фикстуры выше) -
        // подтверждено живьём: ручной дублирующий INSERT упал на
        // notifications_master_dedup (staff_id, type, related_master_id) - точное
        // доказательство, что уведомление уже реально лежит в базе.
        await s.click('#msgBell');
        await sleep(600); // renderList() по клику на колокольчик (см. crm-notifications.js)
        const notifItemFound = await s.eval(`!!document.querySelector('#msgList [data-related-master-id="o41-master2"]')`);
        check('Колокольчик уведомлений открылся, уведомление о мастере отрисовано', notifItemFound === true, `найдено=${notifItemFound}`);
        // Клик по пункту списка (openMasterCard теперь вызывает goToSection('team')
        // вместо document.getElementById('pt-b').checked=true).
        await s.click('#msgList [data-related-master-id="o41-master2"]');
        await sleep(200);
        const afterNotifClick = await s.eval(`({ checked: document.getElementById('pt-b')?.checked, active: document.querySelector('.app-nav-item[data-section="team"]')?.classList.contains('is-active') })`);
        check('Cross-link 3: клик по уведомлению переключает на раздел "Команда" через goToSection (openMasterCard мигрирован)', afterNotifClick.checked === true && afterNotifClick.active === true, JSON.stringify(afterNotifClick));
      });

      // withBrowser убивает Chrome в finally, но освобождение порта не мгновенное -
      // без паузы следующий withBrowser иногда ловит "Could not create new page"
      // (тот же приём, что verify-2026-08-06-okno40-dashboard-segodnya.mjs).
      await sleep(1500);

      // ── Impact Analysis: crm-notifications.js теперь импортирует crm-app-shell.js
      // и подключён также на crm-admin.html/crm-master.html (общая цепочка через
      // crm-auth.js) - эти страницы НЕ подключают crm-app-shell.css и не должны
      // получить sidebar/крэш при импорте. Проверяем, что модульный граф грузится
      // без исключений и app shell остаётся пассивным (no-op) на чужих страницах.
      for (const [page, role] of [['crm-admin.html', 'admin'], ['crm-master.html', 'master']]) {
        await withBrowser(async (s) => {
          await s.navigate(`${base}/${page}`);
          await s.setViewport(1440, 1000, true);
          await sleep(500);
          const bridgeFn = await s.eval(`typeof window.crmGoToSection`);
          check(`${page}: модульный граф (crm-auth→crm-notifications→crm-app-shell) загрузился без исключений`, bridgeFn === 'function', `typeof window.crmGoToSection = ${bridgeFn}`);
          const noSidebar = await s.eval(`document.getElementById('appSidebar') === null`);
          check(`${page}: sidebar НЕ создаётся на чужой роли (${role}) - app shell пассивен вне owner-страницы`, noSidebar === true, `appSidebar найден=${!noSidebar}`);
          const loginGateVisible = await s.eval(`document.getElementById('loginEmail') !== null`);
          check(`${page}: форма входа по-прежнему рендерится (crm-auth.js не сломан импортом)`, loginGateVisible === true, `loginEmail найден=${loginGateVisible}`);
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
