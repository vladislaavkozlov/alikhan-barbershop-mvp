// Живая проверка второй партии правок 08.08.2026 (после первой партии - "Запись"/якорь):
// 1) карточки "Команда" использовали .avatar.lg (64px) вместо .avatar-icon/.avatar
//    (46px), которым единообразно оформлены Расписание/Финансы/Аналитика/Уведомления -
//    Влад прямо указал на это после первой партии правок ("блоки... все разного
//    размера"). Убран модификатор lg у трёх карточек мастеров crm-owner.html.
// 2) красная линия "сейчас" (Окно 43) считала top от верхнего края
//    .schedule-row-with-gutter, который включает шапку колонки (аватар+имя мастера) -
//    линия рисовалась ПОВЕРХ шапки и перечёркивала имена (жалоба Влада, скриншот).
//    Теперь top = высота шапки (измеряется живьём) + смещение по времени.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('tan-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'tan-owner@test.local', $1)`,
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
      body: JSON.stringify({ email: 'tan-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'tan-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        // ── 1) Размер карточек "Команда" == размер карточек остальных разделов ──
        await s.click('.app-nav-item[data-section="team"]');
        await sleep(300);
        const teamRows = await s.eval(`
          [...document.querySelectorAll('.panel-b details.staff-card > summary')].map((sum) => {
            const avatar = sum.querySelector('.avatar, .avatar-icon');
            return { height: Math.round(sum.getBoundingClientRect().height), avatarClass: avatar.className, avatarPx: Math.round(avatar.getBoundingClientRect().width) };
          })
        `);
        check(
          '3 карточки мастеров в "Команде" используют базовый .avatar (46px), не .avatar.lg (64px)',
          teamRows.every((r) => r.avatarClass === 'avatar' && r.avatarPx === 46),
          JSON.stringify(teamRows)
        );

        await s.click('.app-nav-item[data-section="schedule"]');
        await sleep(300);
        const scheduleRowHeight = await s.eval(`Math.round(document.querySelector('.panel-a details.staff-card > summary').getBoundingClientRect().height)`);
        check(
          'Высота свёрнутой карточки "Команда" совпадает с высотой карточки "Расписание" (74px)',
          teamRows.every((r) => r.height === scheduleRowHeight),
          `team: ${JSON.stringify(teamRows.map((r) => r.height))}, schedule: ${scheduleRowHeight}`
        );

        // ── 2) Линия "сейчас" ниже шапки колонки, не поверх неё ──
        await sleep(400); // renderDayCalendar + renderNowLine
        const lineCheck = await s.eval(`
          (() => {
            const row = document.querySelector('.panel-sp-day .schedule-row-with-gutter');
            const line = row?.querySelector('.now-line');
            const head = document.querySelector('.schedule-col .schedule-col-head');
            if (!row || !line || !head) return { error: 'элемент не найден на странице' };
            const rowRect = row.getBoundingClientRect();
            const lineRect = line.getBoundingClientRect();
            const headRect = head.getBoundingClientRect();
            return {
              lineHidden: line.hidden,
              lineTop: Math.round(lineRect.top - rowRect.top),
              headerBottom: Math.round(headRect.bottom - rowRect.top),
              lineCrossesHeader: !line.hidden && lineRect.top < headRect.bottom,
            };
          })()
        `);
        check(
          'Линия "сейчас" видна (текущее время в рабочем окне 10:00-20:00 тестового прогона)',
          lineCheck.lineHidden === false,
          JSON.stringify(lineCheck)
        );
        check(
          'Линия "сейчас" НЕ пересекает шапку колонки (не перечёркивает аватар/имя мастера)',
          lineCheck.lineCrossesHeader === false,
          JSON.stringify(lineCheck)
        );

        await s.screenshot('/tmp/verify-team-nowline.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
