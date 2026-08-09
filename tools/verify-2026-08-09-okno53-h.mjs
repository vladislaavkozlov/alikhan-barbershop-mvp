// Живая проверка Окна 53, задача H - дни календаря "вылезают из рамки" (СНАЧАЛА
// живая репродукция, причина НЕ была видна чтением статики - подтверждено промптом).
//
// Репродукция (tools/debug53h, не в репозитории - см. чат сессии): на узком вьюпорте
// (390px) панель .custom-date-panel (position:absolute; left:0; width:260px) якорится
// от ЛЕВОГО края триггера, а триггер в day-nav (‹ [дата] ›) сидит не у левого края
// карточки - на 390px правый край панели (362px от viewport) выходил ЗА правый край
// карточки "День" (352px), Сб/Вс визуально вылезали за бордер. Подтверждено замером
// getBoundingClientRect() ДО фикса.
//
// Фикс: openCustomDate (mockup-crm.js) меряет панель ПОСЛЕ показа - если правый край
// выходит за viewport, добавляет класс .align-right (left:auto; right:0 - якорь от
// правого края триггера вместо левого, обычный флип для popover/dropdown).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rectToObj = 'function rectToObj(r){return {left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),width:Math.round(r.width)};}';

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o53h-owner', NULL, 'QA Владелец H', 'owner', true, false, true, 'o53h-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o53h-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      // Один браузерный процесс на весь скрипт (не два withBrowser подряд) - cdp.mjs
      // держит порт отладки Chrome ХАРДКОДОМ (9333, не эфемерный) - второй параллельный
      // запуск гонится с ещё не освободившимся портом первого. Между сценариями просто
      // навигируем заново и логинимся снова (свежая сессия), один и тот же tab.
      await withBrowser(async (s) => {
      // ═══════════ Мобильный вьюпорт (390px) - тот же, где баг репродуцирован ═══════════
      {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(390, 844, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53h-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        // crm-auth.js после успешного логина делает НАСТОЯЩИЙ location.href (не SPA-
        // переход) - CDP device-metrics override сбрасывается на кросс-навигации,
        // переприменяем явно (тот же приём, что понадобился при изоляции причины
        // несоответствия window.innerWidth в этой сессии).
        await s.setViewport(390, 844, true);
        await sleep(200);
        await s.click('#scheduleCard-day summary');
        await sleep(500);
        await s.click('#dayNavDate-slot .custom-date-trigger');
        await sleep(400);

        const geomMobile = await s.eval(`(() => {
          ${rectToObj}
          const panel = document.querySelector('#dayNavDate-slot .custom-date-panel');
          const cells = [...document.querySelectorAll('#dayNavDate-slot .custom-date-cell:not(.custom-date-cell--empty)')];
          const rightmostCell = cells.reduce((max, c) => {
            const r = c.getBoundingClientRect();
            return r.right > (max?.right ?? -Infinity) ? r : max;
          }, null);
          return {
            viewportWidth: window.innerWidth,
            visualViewportWidth: window.visualViewport ? window.visualViewport.width : null,
            panelRect: rectToObj(panel.getBoundingClientRect()),
            alignRight: panel.classList.contains('align-right'),
            rightmostCellRect: rectToObj(rightmostCell),
          };
        })()`);
        check(
          'Задача H (мобильный вьюпорт): панель date-picker больше НЕ выходит за правый край viewport',
          geomMobile.panelRect.right <= geomMobile.viewportWidth,
          JSON.stringify(geomMobile)
        );
        check(
          'Задача H: реальная ширина экрана (visualViewport) не увеличилась из-за переполнения - было бы скрытым признаком того, что баг остался, просто замаскирован раздутым innerWidth',
          geomMobile.visualViewportWidth === 390,
          JSON.stringify(geomMobile)
        );
        check(
          'Задача H: флип-класс .align-right применился на узком экране (панель реально переключилась)',
          geomMobile.alignRight === true,
          JSON.stringify(geomMobile)
        );
        check(
          'Задача H: крайняя правая ячейка (Сб/Вс) целиком внутри viewport, не обрезана',
          geomMobile.rightmostCellRect.right <= geomMobile.viewportWidth,
          JSON.stringify(geomMobile)
        );
        await s.screenshot('/tmp/okno53-taskH-mobile-after-fix.png');

        // Регрессия: клик по дню всё ещё работает после флипа (виджет не сломан)
        const pickWorks = await s.eval(`(() => {
          const btn = document.querySelector('#dayNavDate-slot .custom-date-cell:not(.custom-date-cell--empty):not(.custom-date-cell--disabled)');
          if (!btn) return 'NOT_FOUND';
          btn.click();
          return 'OK';
        })()`);
        check('Регрессия: клик по дню в align-right режиме по-прежнему работает', pickWorks === 'OK', pickWorks);
        await sleep(200);
        const closedAfterPick = await s.eval(`document.getElementById('dayNavDate')?.classList.contains('open')`);
        check('Регрессия: попап закрывается после выбора дня даже в align-right режиме', closedAfterPick === false, `open=${closedAfterPick}`);
      }

      // ═══════════ Desktop вьюпорт (1440px) - align-right НЕ должен применяться зря ═══════════
      {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53h-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        await s.setViewport(1440, 1000, true);
        await sleep(200);
        await s.click('#scheduleCard-day summary');
        await sleep(500);
        await s.click('#dayNavDate-slot .custom-date-trigger');
        await sleep(400);
        const geomDesktop = await s.eval(`(() => {
          ${rectToObj}
          const panel = document.querySelector('#dayNavDate-slot .custom-date-panel');
          return { panelRect: rectToObj(panel.getBoundingClientRect()), alignRight: panel.classList.contains('align-right'), viewportWidth: window.innerWidth, visualViewportWidth: window.visualViewport ? window.visualViewport.width : null };
        })()`);
        check('Регрессия (desktop, 1440px): панель по-прежнему помещается без флипа (левый якорь не сломан)', geomDesktop.alignRight === false && geomDesktop.panelRect.right <= geomDesktop.viewportWidth, JSON.stringify(geomDesktop));
        await s.screenshot('/tmp/okno53-taskH-desktop-regression.png');
      }
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
