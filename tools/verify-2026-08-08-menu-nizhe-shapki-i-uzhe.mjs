// Живая проверка правки 08.08.2026 (Влад отметил стрелкой на скриншоте линию
// границы шапки - пункты меню начинались ВЫШЕ неё, "наезжая" на topbar; плюс
// попросил сделать панель немного у́же).
//
// Разворот той же правки (следующее сообщение Влада: "ты как будто всю меню
// просто ниже опустил - надо было не блок меню опускать, а только кнопки, а
// саму панель не трогать") - первая версия сдвигала весь .app-sidebar под шапку
// (top: var(--topbar-h)), меняя саму панель (позицию/высоту фона и рамки), а не
// только кнопки внутри. Итоговая версия - .app-sidebar снова top:0/bottom:0 (во
// всю высоту экрана, как было исходно с Окна 41), опущен только padding-top её
// содержимого. --sidebar-w-expanded остаётся суженным 240px → 220px (эта часть
// не оспаривалась).
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
              sidebarHeight: Math.round(sRect.height),
              viewportHeight: window.innerHeight,
              sidebarWidth: Math.round(sRect.width),
            };
          })()
        `);

        check('Первый пункт меню начинается НИЖЕ линии шапки, не над ней', m.firstNavItemTop > m.headerBottom, JSON.stringify(m));
        check('Сама панель (.app-sidebar) НЕ сдвинута - как и раньше, top:0 и во всю высоту экрана', m.sidebarTop === 0 && m.sidebarHeight === m.viewportHeight, JSON.stringify(m));
        check('Панель сужена до 220px (было 240px)', m.sidebarWidth === 220, JSON.stringify(m));

        // Кнопка сворачивания - в вертикальном центре ЦЕЛОГО экрана (панель снова во весь экран)
        const centering = await s.eval(`
          (() => {
            const tRect = document.getElementById('appSidebarToggle').getBoundingClientRect();
            return { toggleCenterY: Math.round(tRect.top + tRect.height / 2), viewportCenterY: Math.round(window.innerHeight / 2) };
          })()
        `);
        check('Кнопка сворачивания в вертикальном центре экрана (панель снова во весь экран)', Math.abs(centering.toggleCenterY - centering.viewportCenterY) <= 1, JSON.stringify(centering));

        await s.screenshot('/tmp/verify-menu-nizhe-shapki.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
