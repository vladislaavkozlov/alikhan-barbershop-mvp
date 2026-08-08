// Живая проверка третьей партии правок 08.08.2026:
// 1) кнопка сворачивания sidebar перенесена с верха панели на вертикальную
//    середину (просьба Влада по скриншоту со стрелкой).
// 2) контейнеры коротких вкладок (Команда/Финансы/Аналитика/Уведомления) были
//    разной высоты (298/210/210/207px) из-за разного числа карточек - выровнены
//    общим min-height. "Расписание" намеренно не трогали (живой календарь,
//    1650px+, см. комментарий в assets/mockup-crm.css) - см. отчёт в чате.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('th-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'th-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'th-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'th-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        // ── 1) кнопка сворачивания - в вертикальной середине sidebar ──
        const togglePos = await s.eval(`
          (() => {
            const sidebar = document.getElementById('appSidebar');
            const btn = document.getElementById('appSidebarToggle');
            const sRect = sidebar.getBoundingClientRect();
            const bRect = btn.getBoundingClientRect();
            const btnCenterY = bRect.top + bRect.height / 2;
            const sidebarCenterY = sRect.top + sRect.height / 2;
            return { offsetFromCenter: Math.round(btnCenterY - sidebarCenterY) };
          })()
        `);
        check(
          'Кнопка сворачивания расположена в вертикальной середине sidebar (не сверху)',
          Math.abs(togglePos.offsetFromCenter) <= 2,
          JSON.stringify(togglePos)
        );

        // Клик по кнопке в новом месте по-прежнему сворачивает/разворачивает.
        await s.click('#appSidebarToggle');
        await sleep(250);
        const collapsedNow = await s.eval(`document.body.classList.contains('app-shell-sidebar-collapsed')`);
        check('Клик по кнопке (в новой позиции) сворачивает sidebar', collapsedNow === true, `${collapsedNow}`);
        await s.click('#appSidebarToggle');
        await sleep(250);
        const expandedAgain = await s.eval(`!document.body.classList.contains('app-shell-sidebar-collapsed')`);
        check('Повторный клик разворачивает обратно', expandedAgain === true, `${expandedAgain}`);

        // ── 2) высота коротких вкладок одинакова, Расписание не тронуто ──
        const panels = { schedule: 'panel-a', team: 'panel-b', finance: 'panel-c', analytics: 'panel-d', notifications: 'panel-e' };
        const heights = {};
        for (const [sec, cls] of Object.entries(panels)) {
          await s.click(`.app-nav-item[data-section="${sec}"]`);
          await sleep(300);
          heights[sec] = await s.eval(`Math.round(document.querySelector('.${cls} > section').getBoundingClientRect().height)`);
        }
        check(
          'Команда/Финансы/Аналитика/Уведомления - одинаковая высота контейнера',
          heights.team === heights.finance && heights.finance === heights.analytics && heights.analytics === heights.notifications,
          JSON.stringify(heights)
        );
        check('Расписание осталось заметно выше остальных (живой календарь, не урезан)', heights.schedule > heights.team * 2, JSON.stringify(heights));

        await s.screenshot('/tmp/verify-toggle-minheight.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
