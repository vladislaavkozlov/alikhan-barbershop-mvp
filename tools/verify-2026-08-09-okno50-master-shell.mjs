// Живая проверка Окна 50 - sidebar app-shell у Мастера (crm-master.html).
// План: plans/2026-08-09-admin-master-app-shell.md, Фаза 3. Зависит от Окна 47
// (ROLE_CONFIG.master в assets/crm-app-shell.js). Один Chrome-сеанс на весь
// прогон (см. комментарий в tools/verify-2026-08-09-okno49-admin-shell.mjs про
// гонку за фиксированным remote-debugging-port).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinMaster = randomPin();
    const pinOwner = randomPin();
    const pinAdmin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o50-master', NULL, 'QA Мастер 50', 'master', true, true, true, 'o50-master@test.local', $1),
       ('o50-owner', NULL, 'QA Владелец 50', 'owner', true, false, true, 'o50-owner@test.local', $2),
       ('o50-admin', NULL, 'QA Админ 50', 'admin', true, false, true, 'o50-admin@test.local', $3)`,
      [hashPin(pinMaster), hashPin(pinOwner), hashPin(pinAdmin)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        // ── Master, desktop (≥1024px) - sidebar виден, 3 пункта, переключение работает ──
        await s.navigate(`${base}/crm-master.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o50-master@test.local');
        await s.type('#loginPin', pinMaster);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1000);

        const shellActive = await s.eval(`document.body.classList.contains('app-shell-active')`);
        check('Master: body.app-shell-active выставлен после входа', shellActive === true, `active=${shellActive}`);

        const navCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Master: sidebar содержит 3 пункта (Мой день/Моя зарплата/Личные данные)', navCount === 3, `найдено ${navCount}`);

        const labels = await s.eval(`Array.from(document.querySelectorAll('.app-nav-label')).map(e => e.textContent)`);
        check('Master: подписи разделов верные', JSON.stringify(labels) === JSON.stringify(['Мой день', 'Моя зарплата', 'Личные данные']), JSON.stringify(labels));

        const defaultActive = await s.eval(`document.querySelector('.app-nav-item[data-section="today"]')?.classList.contains('is-active')`);
        check('Master: по умолчанию активен "Мой день"', defaultActive === true, `active=${defaultActive}`);

        const profileLabel = await s.eval(`document.getElementById('appShellProfile')?.textContent`);
        check('Master: профиль-лейбл "Мастер"', profileLabel === 'Мастер', `"${profileLabel}"`);

        const h1Gone = await s.eval(`!document.querySelector('#crmMain > h1')`);
        check('Master: дублирующий <h1>Мастер</h1> убран', h1Gone === true, `h1Gone=${h1Gone}`);

        await s.screenshot('/tmp/okno50-master-shell-desktop.png');

        const pairs = [
          ['today', 'pt-a', 'panel-a'],
          ['payroll', 'pt-b', 'panel-b'],
          ['profile', 'pt-c', 'panel-c'],
        ];
        for (const [sectionId, radioId, panelClass] of pairs) {
          await s.click(`.app-nav-item[data-section="${sectionId}"]`);
          await sleep(150);
          const state = await s.eval(
            `({ checked: document.getElementById('${radioId}')?.checked, visible: getComputedStyle(document.querySelector('.${panelClass}')).display !== 'none' })`
          );
          check(`Master: клик "${sectionId}" → ${radioId}.checked + .${panelClass} видна`, state.checked === true && state.visible === true, JSON.stringify(state));
        }

        const payrollPanelHasContent = await s.eval(`document.querySelector('.panel-b').textContent.length > 50`);
        check('Master: содержимое панели "Моя зарплата" на месте', payrollPanelHasContent === true, `hasContent=${payrollPanelHasContent}`);

        // ── Master, мобильный viewport (<1024px), та же сессия ──
        await s.setViewport(375, 800, true);
        await sleep(300);

        const sidebarHidden = await s.eval(`getComputedStyle(document.getElementById('appSidebar')).display === 'none'`);
        check('Master mobile (375px): sidebar скрыт', sidebarHidden === true, `hidden=${sidebarHidden}`);

        const tabBarVisible = await s.eval(`getComputedStyle(document.querySelector('.page-tabs .tab-bar')).display !== 'none'`);
        check('Master mobile (375px): старая .tab-bar видна и работает как раньше', tabBarVisible === true, `visible=${tabBarVisible}`);

        await s.click('label[for="pt-b"]');
        await sleep(150);
        const panelBVisibleMobile = await s.eval(`getComputedStyle(document.querySelector('.panel-b')).display !== 'none'`);
        check('Master mobile: клик по вкладке "Моя зарплата" переключает панель как раньше', panelBVisibleMobile === true, `visible=${panelBVisibleMobile}`);

        await s.screenshot('/tmp/okno50-master-shell-mobile.png');

        // ── Regression Owner ──
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o50-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1000);
        const ownerNavCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Regression Owner: sidebar по-прежнему 5 пунктов после подключения Master', ownerNavCount === 5, `найдено ${ownerNavCount}`);

        // ── Regression Admin ──
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o50-admin@test.local');
        await s.type('#loginPin', pinAdmin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1000);
        const adminNavCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Regression Admin: sidebar по-прежнему 2 пункта после подключения Master', adminNavCount === 2, `найдено ${adminNavCount}`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

summary();
