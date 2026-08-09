// Живая проверка разворота 09.08.2026 (Влад: кнопка сворачивания sidebar
// "иногда работает, только если попасть в конкретную точку", хотя ВСЕ прошлые
// CDP-прогоны были зелёными). Причина найдена: старый s.click() в tools/cdp.mjs
// вызывал el.click() программно, в обход хит-теста браузера - он физически не
// мог поймать промах курсора по координатам. Этот прогон впервые использует
// s.clickAt(x, y) - настоящий Input.dispatchMouseEvent по координатам вьюпорта,
// вычисленным из getBoundingClientRect() кнопки, как реальный клик пользователя.
//
// Кнопка - снова position:fixed сосед body (НЕ потомок .app-sidebar - у панели
// overflow-y:auto, что по CSS2.1 форсит overflow-x:auto, и потомок обрезался бы
// этим scroll-overflow в момент, когда клик попадает на середину 180ms-анимации
// ширины панели, а его left-координата уже стоит на финальном, не анимированном
// значении). Left-координата кнопки МЕНЯЕТСЯ между состояниями (кнопка у правого
// края, Влад: "должна быть по правому краю") - но прыгает МГНОВЕННО по классу, без
// собственной CSS-анимации, так что промежуточного кадра для промаха нет.
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

        // ── Кнопка - сосед body (не потомок #appSidebar, не обрезается overflow панели) ──
        const parentId = await s.eval(`document.getElementById('appSidebarToggle').parentElement.tagName`);
        check('Кнопка - прямой потомок body (не .app-sidebar, не обрезается его overflow)', parentId === 'BODY', `parent=${parentId}`);

        const positioning = await s.eval(`getComputedStyle(document.getElementById('appSidebarToggle')).position`);
        check('Кнопка на position:fixed (от viewport, вне зоны overflow панели)', positioning === 'fixed', `position=${positioning}`);

        // ── Координата кнопки меняется между состояниями (у правого края - разная
        //    ширина панели), но БЕЗ CSS-анимации на left/top у самой кнопки ──
        const leftTransition = await s.eval(`getComputedStyle(document.getElementById('appSidebarToggle')).transitionProperty`);
        check('left/top кнопки не в списке CSS transition (мгновенный прыжок, не анимация)', !leftTransition.includes('left') && !leftTransition.includes('top'), `transitionProperty=${leftTransition}`);

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
