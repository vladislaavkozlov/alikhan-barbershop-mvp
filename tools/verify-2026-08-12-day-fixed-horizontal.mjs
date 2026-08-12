// Регрессия 12.08.2026 - "Расписание -> День" не меняет высоту при нескольких
// мастерах, прокручивается только горизонтально и сохраняет аккуратную шкалу
// времени слева. Проверяем живой DOM на временной Postgres-базе, включая длинные
// имена, полную видимость 10:00/20:00, прокрутку до Елизаветы и mobile viewport.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function geometrySource() {
  return `(() => {
    const scroll = document.querySelector('.panel-sp-day .schedule-scroll');
    const gutter = document.querySelector('.panel-sp-day .hour-gutter');
    const marks = gutter.querySelector('.hour-marks');
    const firstMark = marks.querySelector('span:first-child');
    const lastMark = marks.querySelector('span:last-child');
    const cols = [...document.querySelectorAll('.panel-sp-day .schedule-grid > .schedule-col')];
    const css = getComputedStyle(scroll);
    const marksRect = marks.getBoundingClientRect();
    const firstMarkRect = firstMark.getBoundingClientRect();
    const lastMarkRect = lastMark.getBoundingClientRect();
    const firstTrackRect = cols[0].querySelector('.schedule-track').getBoundingClientRect();
    return {
      overflowX: css.overflowX,
      overflowY: css.overflowY,
      clientHeight: Math.round(scroll.clientHeight),
      scrollHeight: Math.round(scroll.scrollHeight),
      clientWidth: Math.round(scroll.clientWidth),
      scrollWidth: Math.round(scroll.scrollWidth),
      gutterDisplay: getComputedStyle(gutter).display,
      gutterBackground: getComputedStyle(gutter).backgroundColor,
      marksBackground: getComputedStyle(marks).backgroundColor,
      marksBackdropFilter: getComputedStyle(marks).backdropFilter,
      marksHeight: Math.round(marksRect.height),
      marksTopOffsetToTrack: Math.round(marksRect.top - firstTrackRect.top),
      marksBottomOffsetToTrack: Math.round(marksRect.bottom - firstTrackRect.bottom),
      firstMarkInside: firstMarkRect.top >= marksRect.top - 1 && firstMarkRect.bottom <= marksRect.bottom + 1,
      lastMarkInside: lastMarkRect.top >= marksRect.top - 1 && lastMarkRect.bottom <= marksRect.bottom + 1,
      firstMarkText: firstMark.textContent.trim(),
      lastMarkText: lastMark.textContent.trim(),
      colHeights: [...new Set(cols.map((el) => Math.round(el.getBoundingClientRect().height)))],
      headHeights: [...new Set(cols.map((el) => Math.round(el.querySelector('.schedule-col-head').getBoundingClientRect().height)))],
      trackHeights: [...new Set(cols.map((el) => Math.round(el.querySelector('.schedule-track').getBoundingClientRect().height)))],
      trackOffsets: [...new Set(cols.map((el) => Math.round(el.querySelector('.schedule-track').getBoundingClientRect().top - el.getBoundingClientRect().top)))],
      columnCount: cols.length,
    };
  })()`;
}

function stickyTimeScaleSource() {
  return `(() => {
    const scroll = document.querySelector('.panel-sp-day .schedule-scroll');
    const gutter = document.querySelector('.panel-sp-day .hour-gutter');
    const scrollRect = scroll.getBoundingClientRect();
    const gutterRect = gutter.getBoundingClientRect();
    const elizabeth = [...document.querySelectorAll('.panel-sp-day .schedule-col')]
      .find((col) => col.querySelector('.name')?.textContent.trim() === 'Елизавета');
    const elizabethRect = elizabeth?.getBoundingClientRect();
    return {
      scrollLeft: Math.round(scroll.scrollLeft),
      gutterLeft: Math.round(gutterRect.left),
      scrollLeftEdge: Math.round(scrollRect.left),
      gutterPosition: getComputedStyle(gutter).position,
      elizabethVisible: !!elizabethRect && elizabethRect.left < scrollRect.right && elizabethRect.right > scrollRect.left,
    };
  })()`;
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('hf-owner', 1, 'QA Владелец HF', 'owner', true, false, true, 'hf-owner@test.local', $1),
       ('hf-master-1', 1, 'Александр Очень-Длинная-Фамилия', 'master', true, true, false, NULL, NULL),
       ('hf-master-2', 1, 'Екатерина Северцова', 'master', true, true, false, NULL, NULL),
       ('hf-master-3', 1, 'Мамедхан Алиханов', 'master', true, true, false, NULL, NULL),
       ('hf-master-4', 1, 'Рустам Гаджиев', 'master', true, true, false, NULL, NULL),
       ('hf-master-5', 1, 'Алиовсад Алиханов', 'master', true, true, false, NULL, NULL),
       ('hf-master-6', 1, 'Константин Длинное-Имя-Мастера', 'master', true, true, false, NULL, NULL)`,
      [hashPin(pinOwner)],
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT master_id, weekday, true, '10:00', '20:00'
       FROM unnest(ARRAY['hf-master-1','hf-master-2','hf-master-3','hf-master-4','hf-master-5','hf-master-6']) AS master_id,
            generate_series(1, 7) AS weekday`,
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await session.navigate(`${base}/crm-owner.html`);
        await session.setViewport(1100, 1250, false);
        await sleep(400);
        await session.type('#loginEmail', 'hf-owner@test.local');
        await session.type('#loginPin', pinOwner);
        await session.click('#loginForm button[type="submit"]');
        await sleep(1400);
        await session.click('#scheduleCard-day > summary');
        await sleep(600);

        const desktop = await session.eval(geometrySource());
        check('Desktop: несколько колонок требуют горизонтальной прокрутки', desktop.columnCount >= 6 && desktop.scrollWidth > desktop.clientWidth, JSON.stringify(desktop));
        check('Desktop: видимая высота фиксирована, вертикальная прокрутка запрещена', desktop.overflowX === 'auto' && desktop.overflowY === 'hidden' && desktop.clientHeight === 748 && desktop.scrollHeight === desktop.clientHeight, JSON.stringify(desktop));
        check('Desktop: все колонки одной фиксированной высоты 748px', JSON.stringify(desktop.colHeights) === '[748]', JSON.stringify(desktop));
        check('Desktop: шапки 98px, дорожки 640px и начинаются на одной высоте', JSON.stringify(desktop.headHeights) === '[98]' && JSON.stringify(desktop.trackHeights) === '[640]' && JSON.stringify(desktop.trackOffsets) === '[108]', JSON.stringify(desktop));
        check('Desktop: панель часов полупрозрачна и не окрашивает область имён', desktop.gutterBackground === 'rgba(0, 0, 0, 0)' && desktop.marksBackground !== 'rgba(0, 0, 0, 0)' && desktop.marksBackdropFilter !== 'none', JSON.stringify(desktop));
        check('Desktop: панель часов совпадает с дорожкой 10:00-20:00', desktop.marksHeight === 640 && desktop.marksTopOffsetToTrack === 0 && desktop.marksBottomOffsetToTrack === 0, JSON.stringify(desktop));
        check('Desktop: крайние подписи 10:00 и 20:00 видны целиком', desktop.firstMarkText === '10:00' && desktop.lastMarkText === '20:00' && desktop.firstMarkInside && desktop.lastMarkInside, JSON.stringify(desktop));
        const timeScaleBefore = await session.eval(stickyTimeScaleSource());
        await session.eval(`(() => { const el = document.querySelector('.panel-sp-day .schedule-scroll'); el.scrollLeft = el.scrollWidth; return Math.round(el.scrollLeft); })()`);
        await sleep(100);
        const timeScaleAfter = await session.eval(stickyTimeScaleSource());
        check('Desktop: горизонтальное перемещение реально работает', timeScaleAfter.scrollLeft > 0, JSON.stringify(timeScaleAfter));
        check('Desktop: шкала времени остаётся у левого края после прокрутки', timeScaleAfter.gutterPosition === 'sticky' && Math.abs(timeScaleAfter.gutterLeft - timeScaleBefore.gutterLeft) <= 1 && Math.abs(timeScaleAfter.gutterLeft - timeScaleAfter.scrollLeftEdge) <= 1, `before=${JSON.stringify(timeScaleBefore)} after=${JSON.stringify(timeScaleAfter)}`);
        check('Desktop: после прокрутки виден график Елизаветы вместе со шкалой времени', timeScaleAfter.elizabethVisible, JSON.stringify(timeScaleAfter));
        await session.screenshot('/tmp/day-time-scale-polished-desktop.png');

        await session.setViewport(390, 844, true);
        await sleep(300);
        const mobile = await session.eval(geometrySource());
        check('Mobile: высота колонок остаётся 748px без вертикального scroll', JSON.stringify(mobile.colHeights) === '[748]' && mobile.scrollHeight === mobile.clientHeight && mobile.overflowY === 'hidden', JSON.stringify(mobile));
        check('Mobile: компактный вид по-прежнему скрывает отдельную шкалу времени', mobile.gutterDisplay === 'none', JSON.stringify(mobile));
        const mobileScrollLeft = await session.eval(`(() => { const el = document.querySelector('.panel-sp-day .schedule-scroll'); el.scrollLeft = el.scrollWidth; return Math.round(el.scrollLeft); })()`);
        check('Mobile: несколько расписаний листаются горизонтально', mobile.scrollWidth > mobile.clientWidth && mobileScrollLeft > 0, JSON.stringify(mobile));
        await session.screenshot('/tmp/day-fixed-horizontal-mobile.png');
      });
    });
  });
} catch (error) {
  console.error('CRASH:', error);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
