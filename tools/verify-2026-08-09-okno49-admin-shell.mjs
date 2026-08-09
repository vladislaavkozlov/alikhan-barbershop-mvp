// Живая проверка Окна 49 - sidebar app-shell у Администратора (crm-admin.html).
// План: plans/2026-08-09-admin-master-app-shell.md, Фаза 2. Зависит от Окна 47
// (ROLE_CONFIG.admin в assets/crm-app-shell.js).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinAdmin = randomPin();
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o49-admin', NULL, 'QA Админ 49', 'admin', true, false, true, 'o49-admin@test.local', $1),
       ('o49-owner', NULL, 'QA Владелец 49', 'owner', true, false, true, 'o49-owner@test.local', $2)`,
      [hashPin(pinAdmin), hashPin(pinOwner)]
    );

    await withStaticServer(apiUrl, async (base) => {
      // Один Chrome-сеанс на весь прогон (withBrowser держит фиксированный
      // remote-debugging-port - несколько подряд идущих отдельных запусков гонятся
      // за портом, поймано на первой версии этого скрипта). Три сцены - три
      // navigate() в одной сессии, тот же паттерн, что уже использует
      // tools/verify-2026-08-07-regression-admin-master.mjs.
      await withBrowser(async (s) => {
        // ── Admin, desktop (≥1024px) - sidebar виден, 2 пункта, переключение работает ──
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o49-admin@test.local');
        await s.type('#loginPin', pinAdmin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1000);

        const shellActive = await s.eval(`document.body.classList.contains('app-shell-active')`);
        check('Admin: body.app-shell-active выставлен после входа', shellActive === true, `active=${shellActive}`);

        const navCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Admin: sidebar содержит 2 пункта (Расписание/Сотрудники)', navCount === 2, `найдено ${navCount}`);

        const labels = await s.eval(`Array.from(document.querySelectorAll('.app-nav-label')).map(e => e.textContent)`);
        check('Admin: подписи разделов верные', JSON.stringify(labels) === JSON.stringify(['Расписание', 'Сотрудники']), JSON.stringify(labels));

        const profileLabel = await s.eval(`document.getElementById('appShellProfile')?.textContent`);
        check('Admin: профиль-лейбл "Администратор"', profileLabel === 'Администратор', `"${profileLabel}"`);

        const h1Gone = await s.eval(`!document.querySelector('#crmMain > h1')`);
        check('Admin: дублирующий <h1>Администратор</h1> убран', h1Gone === true, `h1Gone=${h1Gone}`);

        const oldTabBarHidden = await s.eval(`getComputedStyle(document.querySelector('.page-tabs .tab-bar')).display === 'none'`);
        check('Admin: старая .tab-bar скрыта на desktop', oldTabBarHidden === true, `hidden=${oldTabBarHidden}`);

        await s.screenshot('/tmp/okno49-admin-shell-desktop.png');

        // Клик по обоим пунктам переключает те же panel/radio, что и раньше
        await s.click('.app-nav-item[data-section="schedule"]');
        await sleep(150);
        let state = await s.eval(`({ checked: document.getElementById('pt-a')?.checked, visible: getComputedStyle(document.querySelector('.panel-a')).display !== 'none' })`);
        check('Admin: клик "Расписание" → pt-a.checked + .panel-a видна', state.checked === true && state.visible === true, JSON.stringify(state));

        await s.click('.app-nav-item[data-section="team"]');
        await sleep(150);
        state = await s.eval(`({ checked: document.getElementById('pt-b')?.checked, visible: getComputedStyle(document.querySelector('.panel-b')).display !== 'none' })`);
        check('Admin: клик "Сотрудники" → pt-b.checked + .panel-b видна', state.checked === true && state.visible === true, JSON.stringify(state));

        // Содержимое панели "Сотрудники" не тронуто - маркер из существующей вёрстки
        const staffPanelHasContent = await s.eval(`document.querySelector('.panel-b').textContent.length > 50`);
        check('Admin: содержимое панели "Сотрудники" на месте (не пустая)', staffPanelHasContent === true, `hasContent=${staffPanelHasContent}`);

        // ── Admin, мобильный viewport (<1024px), та же сессия ──
        await s.setViewport(375, 800, true);
        await sleep(300);

        const sidebarHidden = await s.eval(`getComputedStyle(document.getElementById('appSidebar')).display === 'none'`);
        check('Admin mobile (375px): sidebar скрыт', sidebarHidden === true, `hidden=${sidebarHidden}`);

        const tabBarVisible = await s.eval(`getComputedStyle(document.querySelector('.page-tabs .tab-bar')).display !== 'none'`);
        check('Admin mobile (375px): старая .tab-bar видна и работает как раньше', tabBarVisible === true, `visible=${tabBarVisible}`);

        await s.click('label[for="pt-a"]');
        await sleep(150);
        const panelAVisibleMobile = await s.eval(`getComputedStyle(document.querySelector('.panel-a')).display !== 'none'`);
        check('Admin mobile: клик по вкладке "Расписание" переключает панель как раньше', panelAVisibleMobile === true, `visible=${panelAVisibleMobile}`);

        await s.screenshot('/tmp/okno49-admin-shell-mobile.png');

        // ── Regression Owner: тот же контракт, что проверил Окно 47, ещё раз, та же сессия ──
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o49-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1000);

        const ownerNavCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Regression Owner: sidebar по-прежнему 5 пунктов после подключения Admin', ownerNavCount === 5, `найдено ${ownerNavCount}`);

        const ownerProfileLabel = await s.eval(`document.getElementById('appShellProfile')?.textContent`);
        check('Regression Owner: профиль-лейбл всё ещё "Владелец"', ownerProfileLabel === 'Владелец', `"${ownerProfileLabel}"`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

summary();
