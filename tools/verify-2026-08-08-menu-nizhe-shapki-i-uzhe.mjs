// Живая проверка правки 08.08.2026 (Влад отметил стрелкой на скриншоте линию
// границы шапки - пункты меню начинались ВЫШЕ неё, "наезжая" на topbar; плюс
// попросил сделать панель немного у́же) - .app-sidebar теперь начинается СРАЗУ
// под header.site (top: var(--topbar-h)), а не top:0 с internal padding, и
// --sidebar-w-expanded сужен 240px → 220px.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('mh-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'mh-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'mh-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        const m = await s.eval(`
          (() => {
            const header = document.querySelector('header.site');
            const firstNavItem = document.querySelector('.app-nav-item');
            const sidebar = document.getElementById('appSidebar');
            const hRect = header.getBoundingClientRect();
            const nRect = firstNavItem.getBoundingClientRect();
            const sRect = sidebar.getBoundingClientRect();
            return {
              headerBottom: Math.round(hRect.bottom),
              firstNavItemTop: Math.round(nRect.top),
              sidebarTop: Math.round(sRect.top),
              sidebarWidth: Math.round(sRect.width),
            };
          })()
        `);

        check('Первый пункт меню начинается НИЖЕ линии шапки, не над ней', m.firstNavItemTop > m.headerBottom, JSON.stringify(m));
        check('Сама панель (.app-sidebar) начинается сразу под шапкой (не перекрывает её)', Math.abs(m.sidebarTop - m.headerBottom) <= 1, JSON.stringify(m));
        check('Панель сужена до 220px (было 240px)', m.sidebarWidth === 220, JSON.stringify(m));

        // Кнопка сворачивания по-прежнему в вертикальном центре именно ПАНЕЛИ, а не всего экрана
        const centering = await s.eval(`
          (() => {
            const sRect = document.getElementById('appSidebar').getBoundingClientRect();
            const tRect = document.getElementById('appSidebarToggle').getBoundingClientRect();
            return { sidebarCenterY: Math.round(sRect.top + sRect.height / 2), toggleCenterY: Math.round(tRect.top + tRect.height / 2) };
          })()
        `);
        check('Кнопка сворачивания осталась в вертикальном центре именно панели (не экрана)', Math.abs(centering.sidebarCenterY - centering.toggleCenterY) <= 1, JSON.stringify(centering));

        await s.screenshot('/tmp/verify-menu-nizhe-shapki.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
