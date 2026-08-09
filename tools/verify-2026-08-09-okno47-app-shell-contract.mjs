// Живая проверка Окна 47 - параметризация assets/crm-app-shell.js (ROLE_CONFIG),
// см. plans/2026-08-09-admin-master-app-shell.md, Фаза 1.
//
// Честная поправка: старый tools/verify-2026-08-07-okno41-design-tokens-app-shell.mjs
// устарел ЕЩЁ ДО этой правки (проверено git stash - падает так же на неизменённом
// коде: "Sidebar содержит ровно 6 пунктов" - найдено 5, "активен пункт Сегодня" -
// такого пункта нет с Окна 42, плюс краш на #shellSectionTitle/#revenueWeekMonthLink,
// удалённых в Окнах 42/45). Тот скрипт писан под baseline Окна 41 (6 пунктов, "Сегодня"
// по умолчанию) и не обновлялся вслед за Окнами 42-46 - это не регрессия рефакторинга,
// это ранее известный (не задокументированный) архивный хвост. Этот файл - актуальный
// снимок реального сегодняшнего состояния Owner (5 пунктов: Расписание/Команда/
// Финансы/Аналитика/Уведомления, дефолт "Расписание"), становится источником истины
// для regression-проверок Окон 49/50, старый скрипт больше не гонять как gate.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o47-owner', NULL, 'QA Владелец 47', 'owner', true, false, true, 'o47-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);

        await s.type('#loginEmail', 'o47-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1000);

        const shellActive = await s.eval(`document.body.classList.contains('app-shell-active')`);
        check('body.app-shell-active выставлен после входа', shellActive === true, `active=${shellActive}`);

        const navCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Sidebar Owner содержит 5 пунктов (Расписание/Команда/Финансы/Аналитика/Уведомления)', navCount === 5, `найдено ${navCount}`);

        const labels = await s.eval(`Array.from(document.querySelectorAll('.app-nav-label')).map(e => e.textContent)`);
        const expectedLabels = ['Расписание', 'Команда', 'Финансы', 'Аналитика', 'Уведомления'];
        check('Подписи разделов Owner не изменились', JSON.stringify(labels) === JSON.stringify(expectedLabels), JSON.stringify(labels));

        const defaultActive = await s.eval(`document.querySelector('.app-nav-item[data-section="schedule"]')?.classList.contains('is-active')`);
        check('По умолчанию активен "Расписание" (defaultSection не сломан)', defaultActive === true, `active=${defaultActive}`);

        const profileLabel = await s.eval(`document.getElementById('appShellProfile')?.textContent`);
        check('Профиль-лейбл "Владелец" не изменился', profileLabel === 'Владелец', `"${profileLabel}"`);

        await s.screenshot('/tmp/okno47-owner-shell-regression.png');

        // ── все 5 пунктов кликабельны, переключают тот же radio/panel, что раньше ──
        const pairs = [
          ['schedule', 'pt-a', 'panel-a'],
          ['team', 'pt-b', 'panel-b'],
          ['finance', 'pt-c', 'panel-c'],
          ['analytics', 'pt-d', 'panel-d'],
          ['notifications', 'pt-e', 'panel-e'],
        ];
        for (const [sectionId, radioId, panelClass] of pairs) {
          await s.click(`.app-nav-item[data-section="${sectionId}"]`);
          await sleep(120);
          const state = await s.eval(
            `({ checked: document.getElementById('${radioId}')?.checked, visible: getComputedStyle(document.querySelector('.${panelClass}')).display !== 'none', active: document.querySelector('.app-nav-item[data-section="${sectionId}"]')?.classList.contains('is-active') })`
          );
          check(`Клик "${sectionId}" → ${radioId}.checked + .${panelClass} видна + пункт активен`, state.checked === true && state.visible === true && state.active === true, JSON.stringify(state));
        }

        // ── сворачивание sidebar (Окно 45/46 полировка) не сломано ──
        await s.click('#appSidebarToggle');
        await sleep(220);
        const collapsed = await s.eval(`document.body.classList.contains('app-shell-sidebar-collapsed')`);
        check('Кнопка сворачивания sidebar работает после рефакторинга', collapsed === true, `collapsed=${collapsed}`);
        await s.click('#appSidebarToggle');
        await sleep(220);
      });
    });
  });
  // ROLE_CONFIG.admin/master проверяются живьём в браузере в Окнах 49/50, когда
  // crm-admin.html/crm-master.html реально подключат initAppShell(role) - модуль
  // трогает window.* на верхнем уровне (window.crmGoToSection), плоский import()
  // в Node без DOM здесь небезопасен.
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

summary();
