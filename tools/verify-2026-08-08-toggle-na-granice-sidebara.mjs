// Живая проверка правки 08.08.2026 (Влад: "ты её сломал, не по краю формы, а
// какого-то чёрта по середине" + "сделай удобно нажимать, посмотри как в других
// приложениях") - кнопка сворачивания sidebar вынесена ИЗ .app-sidebar отдельным
// элементом-соседом body (insertToggleButton, assets/crm-app-shell.js) и сидит
// ровно на границе сайдбар/контент (паттерн VS Code/Notion/Linear), а не
// по центру ширины панели, как в предыдущей версии того же дня.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('eg-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'eg-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        // ── До логина - кнопки не видно (не должна висеть на экране входа) ──
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        const beforeLoginDisplay = await s.eval(`(() => { const b = document.getElementById('appSidebarToggle'); return b ? getComputedStyle(b).display : null; })()`);
        check('До входа кнопка не видна (display:none, не сирота на экране логина)', beforeLoginDisplay === 'none', `display=${beforeLoginDisplay}`);

        await s.type('#loginEmail', 'eg-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        // ── Кнопка ровно на границе сайдбара, не в центре его ширины ──
        const expandedPos = await s.eval(`
          (() => {
            const sRect = document.getElementById('appSidebar').getBoundingClientRect();
            const bRect = document.getElementById('appSidebarToggle').getBoundingClientRect();
            return { sidebarRight: Math.round(sRect.right), buttonCenterX: Math.round(bRect.left + bRect.width / 2) };
          })()
        `);
        check(
          'Развёрнуто: центр кнопки совпадает с правой границей sidebar (240px), не с серединой его ширины (120px)',
          Math.abs(expandedPos.buttonCenterX - expandedPos.sidebarRight) <= 1,
          JSON.stringify(expandedPos)
        );

        await s.click('#appSidebarToggle');
        await sleep(250);
        const collapsedPos = await s.eval(`
          (() => {
            const sRect = document.getElementById('appSidebar').getBoundingClientRect();
            const bRect = document.getElementById('appSidebarToggle').getBoundingClientRect();
            return { sidebarRight: Math.round(sRect.right), buttonCenterX: Math.round(bRect.left + bRect.width / 2) };
          })()
        `);
        check(
          'Свёрнуто: кнопка едет вместе с границей sidebar (76px), не остаётся на месте',
          Math.abs(collapsedPos.buttonCenterX - collapsedPos.sidebarRight) <= 1 && collapsedPos.sidebarRight === 76,
          JSON.stringify(collapsedPos)
        );

        // ── Клик по-прежнему работает в обе стороны на новой позиции ──
        await s.click('#appSidebarToggle');
        await sleep(250);
        const expandedAgain = await s.eval(`!document.body.classList.contains('app-shell-sidebar-collapsed')`);
        check('Повторный клик разворачивает обратно', expandedAgain === true, `${expandedAgain}`);

        // ── Область клика достаточно большая (комфортно нажимать) ──
        const btnSize = await s.eval(`(() => { const r = document.getElementById('appSidebarToggle').getBoundingClientRect(); return Math.round(r.width); })()`);
        check('Область клика не мельче 28px (комфортный размер, как у кнопок topbar)', btnSize >= 28, `${btnSize}px`);

        await s.screenshot('/tmp/verify-toggle-edge.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
