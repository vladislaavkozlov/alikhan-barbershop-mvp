// Живая проверка разворота 09.08.2026 (Влад: кнопка сворачивания sidebar
// "иногда работает, только если попасть в конкретную точку", хотя ВСЕ прошлые
// CDP-прогоны были зелёными). Причина найдена: старый s.click() в tools/cdp.mjs
// вызывал el.click() программно, в обход хит-теста браузера - он физически не
// мог поймать промах курсора по координатам. Этот прогон впервые использует
// s.clickAt(x, y) - настоящий Input.dispatchMouseEvent по координатам вьюпорта,
// вычисленным из getBoundingClientRect() кнопки, как реальный клик пользователя.
//
// Плюс структурная правка: кнопка перестала быть отдельным position:fixed
// элементом-соседом body (гонка координат с анимацией ширины панели, см.
// assets/crm-app-shell.css) и стала обычным дочерним элементом .app-sidebar -
// проверяем это явно (parentElement.id === 'appSidebar').
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buttonCircle(s) {
  return s.eval(`
    (() => {
      const b = document.getElementById('appSidebarToggle');
      const r = b.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
    })()
  `);
}

async function isCollapsed(s) {
  return s.eval(`document.body.classList.contains('app-shell-sidebar-collapsed')`);
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('rk-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'rk-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'rk-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        // ── Кнопка - настоящий ребёнок .app-sidebar, не сосед body ──
        const parentId = await s.eval(`document.getElementById('appSidebarToggle').parentElement.id`);
        check('Кнопка - дочерний элемент #appSidebar (не отдельный position:fixed сосед body)', parentId === 'appSidebar', `parent=${parentId}`);

        const positioning = await s.eval(`getComputedStyle(document.getElementById('appSidebarToggle')).position`);
        check('Кнопка не на position:fixed (закреплена от угла своей же панели, не от viewport)', positioning !== 'fixed', `position=${positioning}`);

        // ── Координата кнопки не меняется НИ на пиксель между развёрнутым и
        //    свёрнутым состоянием - корень прошлого промаха был именно в этом ──
        const rectBefore = await s.eval(`(() => { const r = document.getElementById('appSidebarToggle').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
        await s.click('#appSidebarToggle');
        await sleep(250);
        const rectAfterCollapse = await s.eval(`(() => { const r = document.getElementById('appSidebarToggle').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
        check('Координата кнопки идентична в развёрнутом и свёрнутом состоянии (не едет вообще)', rectBefore.x === rectAfterCollapse.x && rectBefore.y === rectAfterCollapse.y, `${JSON.stringify(rectBefore)} vs ${JSON.stringify(rectAfterCollapse)}`);
        await s.click('#appSidebarToggle');
        await sleep(250);

        // ── Реальный координатный клик (Input.dispatchMouseEvent) по 6 точкам круга,
        //    туда-обратно, 30 раз подряд - должен ни разу не промахнуться ──
        let ok = true;
        let fails = 0;
        for (let i = 0; i < 30; i++) {
          const before = await isCollapsed(s);
          const c = await buttonCircle(s);
          const angle = (i % 6) * (Math.PI / 3); // 6 разных точек на окружности круга
          const radius = Math.min(c.w, c.h) / 2 - 3; // чуть внутри края, не за пределами хитбокса
          const x = c.cx + radius * Math.cos(angle);
          const y = c.cy + radius * Math.sin(angle);
          await s.clickAt(x, y);
          await sleep(60);
          const after = await isCollapsed(s);
          if (after === before) { ok = false; fails++; }
        }
        check(`30 реальных координатных кликов по 6 разным точкам круга - каждый раз меняет состояние (промахов: ${fails})`, ok, `fails=${fails}/30`);

        // ── После 30 кликов (чётное число) - состояние должно вернуться в исходное ──
        const finalCollapsed = await isCollapsed(s);
        check('После 30 кликов (чётное число) sidebar в исходном развёрнутом состоянии', finalCollapsed === false, `collapsed=${finalCollapsed}`);

        // ── Клик ровно в геометрический центр (самая частая жалоба - "не туда попадаю") ──
        const c2 = await buttonCircle(s);
        const beforeCenter = await isCollapsed(s);
        await s.clickAt(c2.cx, c2.cy);
        await sleep(150);
        const afterCenter = await isCollapsed(s);
        check('Клик ровно в центр кнопки переключает состояние', afterCenter !== beforeCenter, `${beforeCenter} → ${afterCenter}`);

        // возвращаем обратно
        await s.clickAt(c2.cx, c2.cy);
        await sleep(150);
      });
    });
  });

  // ── Та же проверка для admin/master (общий crm-app-shell.js, другая роль) ──
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinAdmin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('rk-admin', NULL, 'QA Админ', 'admin', true, false, true, 'rk-admin@test.local', $1)`,
      [hashPin(pinAdmin)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'rk-admin@test.local');
        await s.type('#loginPin', pinAdmin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        const before = await isCollapsed(s);
        const c = await buttonCircle(s);
        await s.clickAt(c.cx, c.cy);
        await sleep(150);
        const after = await isCollapsed(s);
        check('crm-admin.html: реальный клик в центр кнопки переключает sidebar', after !== before, `${before} → ${after}`);
      });
    });
  });
} catch (err) {
  console.error('FATAL', err);
  process.exitCode = 1;
}

summary();
