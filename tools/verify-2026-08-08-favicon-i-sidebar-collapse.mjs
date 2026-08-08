// Живая проверка двух задумок Влада 08.08.2026:
// 1) favicon.svg (уже используется на index.html) подключён и к crm-owner.html/
//    crm-admin.html/crm-master.html - раньше вкладка CRM в браузере не имела иконки.
// 2) sidebar (assets/crm-app-shell.js) сворачивается до одних иконок кнопкой
//    вверху меню и разворачивается обратно тем же нажатием - токен
//    --sidebar-w-collapsed существовал с Окна 41, но не был задействован нигде.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('fs-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'fs-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fs-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      // ── 1) favicon на статике всех трёх CRM-страниц (без логина - тег в <head>) ──
      for (const page of ['crm-owner.html', 'crm-admin.html', 'crm-master.html']) {
        const html = await fetch(`${base}/${page}`).then((r) => r.text());
        check(`${page} подключает favicon.svg`, /<link rel="icon" href="favicon\.svg"/.test(html), 'тег <link rel="icon"> не найден в <head>');
      }
      const faviconRes = await fetch(`${base}/favicon.svg`);
      check('favicon.svg реально отдаётся сервером (200)', faviconRes.status === 200, `status=${faviconRes.status}`);

      // ── 2) сворачивание sidebar ──
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'fs-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        const beforeToggle = await s.eval(`({
          bodyCollapsed: document.body.classList.contains('app-shell-sidebar-collapsed'),
          sidebarWidth: Math.round(document.getElementById('appSidebar').getBoundingClientRect().width),
          labelVisible: getComputedStyle(document.querySelector('.app-nav-label')).display !== 'none',
        })`);
        check('По умолчанию sidebar развёрнут (240px, подписи видны)', beforeToggle.bodyCollapsed === false && beforeToggle.sidebarWidth === 240 && beforeToggle.labelVisible === true, JSON.stringify(beforeToggle));

        await s.click('#appSidebarToggle');
        await sleep(250); // transition 180ms
        const afterCollapse = await s.eval(`({
          bodyCollapsed: document.body.classList.contains('app-shell-sidebar-collapsed'),
          sidebarWidth: Math.round(document.getElementById('appSidebar').getBoundingClientRect().width),
          labelVisible: getComputedStyle(document.querySelector('.app-nav-label')).display !== 'none',
          iconStillVisible: getComputedStyle(document.querySelector('.app-nav-item .app-nav-icon svg')).display !== 'none',
          contentPaddingLeft: Math.round(parseFloat(getComputedStyle(document.body).paddingLeft)),
        })`);
        check(
          'После клика по кнопке sidebar сворачивается до 76px, подписи скрыты, иконки остаются',
          afterCollapse.bodyCollapsed === true && afterCollapse.sidebarWidth === 76 && afterCollapse.labelVisible === false && afterCollapse.iconStillVisible === true,
          JSON.stringify(afterCollapse)
        );
        check('Отступ контента (body padding-left) сузился вместе с sidebar (76px)', afterCollapse.contentPaddingLeft === 76, JSON.stringify(afterCollapse));

        await s.screenshot('/tmp/verify-sidebar-collapsed.png');

        // Разделы по-прежнему кликабельны в свёрнутом виде (только иконка, без подписи)
        await s.click('.app-nav-item[data-section="team"]');
        await sleep(300);
        const teamVisible = await s.eval(`document.querySelector('.panel-b')?.style.display !== 'none' && !document.getElementById('pt-a').checked`);
        check('Раздел "Команда" реально переключается кликом по свёрнутой иконке', teamVisible === true, `${teamVisible}`);

        await s.click('#appSidebarToggle');
        await sleep(250);
        const afterExpand = await s.eval(`({
          bodyCollapsed: document.body.classList.contains('app-shell-sidebar-collapsed'),
          sidebarWidth: Math.round(document.getElementById('appSidebar').getBoundingClientRect().width),
        })`);
        check('Повторный клик по той же кнопке разворачивает sidebar обратно (240px)', afterExpand.bodyCollapsed === false && afterExpand.sidebarWidth === 240, JSON.stringify(afterExpand));

        await s.screenshot('/tmp/verify-sidebar-expanded.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
