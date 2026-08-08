// Живая проверка правки 08.08.2026 (жалоба Влада на скриншот crm-owner.html):
// 1) карточка "Запись" в Расписании раньше жила на легаси-компоненте
//    details.booking-detail (другой шрифт заголовка, chevron слева через
//    summary::before) - переведена на тот же details.staff-card, что и
//    День/Неделя/Месяц, и перенесена в общий .staff-list.schedule-view-cards -
//    ровно то, что уже требовала КОНВЕНЦИЯ-КАРТОЧКИ-РАЗДЕЛОВ.md (Окно 45 упустил
//    именно эту карточку).
// 2) общий якорь "Месяц · Август 2026" висел ОДНИМ блоком над всеми карточками
//    (актуально было для старого .seg-tabs с одной видимой панелью) - теперь
//    подпись живёт внутри своей карточки (Неделя/Месяц), не "убегает" от неё.
// Тот же приём withEphemeralServer/withStaticServer/withBrowser, что у
// verify-2026-08-08-okno45-kartochki-shablon-ikonki.mjs.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('zc-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'zc-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    const login = async (email, pin) => {
      const res = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      return res.json();
    };
    await login('zc-owner@test.local', pinOwner);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(400);
        await s.type('#loginEmail', 'zc-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        // ── 1) "Запись" на том же компоненте, что День/Неделя/Месяц ──
        const legacyGone = await s.eval(`document.querySelectorAll('.booking-detail, .booking-detail-body').length`);
        check('Легаси-компонент .booking-detail/.booking-detail-body больше не встречается на странице', legacyGone === 0, `найдено ${legacyGone}`);

        const cardsInSameList = await s.eval(
          `[...document.querySelectorAll('.staff-list.schedule-view-cards > details.staff-card')].map((d) => d.id)`
        );
        check(
          'Все 4 карточки (День/Неделя/Месяц/Запись) - прямые дети одного .staff-list.schedule-view-cards',
          JSON.stringify(cardsInSameList) === JSON.stringify(['scheduleCard-day', 'scheduleCard-week', 'scheduleCard-month', 'bd-1']),
          `найдено: ${JSON.stringify(cardsInSameList)}`
        );

        // ── DOM-форма summary одинакова у всех 4 (иконка → summary-meta → chevron
        // ПОСЛЕДНИМ ребёнком) - гарантирует единый шрифт/позицию стрелки без ручной
        // сверки каждой карточки по отдельности. ──
        const summaryShapes = await s.eval(`
          [...document.querySelectorAll('.staff-list.schedule-view-cards > details.staff-card > summary')].map((sum) => {
            const kids = [...sum.children].map((k) => k.className);
            return kids;
          })
        `);
        const uniformShape = summaryShapes.every(
          (kids) => kids.length === 3 && kids[0] === 'avatar-icon' && kids[1] === 'summary-meta' && kids[2] === 'chevron'
        );
        check(
          'У всех 4 карточек одинаковая структура summary (avatar-icon, summary-meta, chevron последним)',
          uniformShape,
          JSON.stringify(summaryShapes)
        );

        // Шрифт заголовка одинаков у всех 4 (раньше "Запись" была var(--accent),
        // 0.86rem, 600 - золотая и мельче остальных).
        const nameFontStyles = await s.eval(`
          [...document.querySelectorAll('.staff-list.schedule-view-cards > details.staff-card .summary-meta .name')].map((n) => {
            const cs = getComputedStyle(n);
            return cs.fontSize + '|' + cs.fontWeight + '|' + cs.color;
          })
        `);
        const uniformFont = nameFontStyles.every((f) => f === nameFontStyles[0]);
        check('Шрифт заголовка (размер/начертание/цвет) одинаков у всех 4 карточек', uniformFont, JSON.stringify(nameFontStyles));

        // ── Отступы между карточками одинаковы (один flex gap, не свой margin-top
        // у "Запись") ──
        const gaps = await s.eval(`
          (() => {
            const items = [...document.querySelectorAll('.staff-list.schedule-view-cards > details.staff-card')];
            const rects = items.map((el) => el.getBoundingClientRect());
            const out = [];
            for (let i = 1; i < rects.length; i++) out.push(Math.round(rects[i].top - rects[i - 1].bottom));
            return out;
          })()
        `);
        const uniformGaps = gaps.every((g) => g === gaps[0]);
        check('Вертикальные отступы между всеми 4 карточками одинаковы', uniformGaps, JSON.stringify(gaps));

        await s.screenshot('/tmp/zc-schedule-collapsed.png');

        // ── 2) якорь даты живёт ВНУТРИ своей карточки, не отдельным блоком ──
        const anchorFloating = await s.eval(`!!document.getElementById('scheduleViewAnchor')`);
        check('Отдельный плавающий якорь #scheduleViewAnchor убран с owner-страницы', anchorFloating === false, `найден: ${anchorFloating}`);

        const weekAnchorInsideCard = await s.eval(`!!document.querySelector('#scheduleCard-week #scheduleAnchor-week')`);
        check('Подпись даты Недели физически лежит ВНУТРИ карточки "Неделя"', weekAnchorInsideCard === true, `${weekAnchorInsideCard}`);
        const monthAnchorInsideCard = await s.eval(`!!document.querySelector('#scheduleCard-month #scheduleAnchor-month')`);
        check('Подпись даты Месяца физически лежит ВНУТРИ карточки "Месяц"', monthAnchorInsideCard === true, `${monthAnchorInsideCard}`);

        // Раскрываем Месяц - подпись должна заполниться реальным текстом вида
        // "Месяц · <Месяц> <Год>", не пустой строкой.
        await s.click('#scheduleCard-month summary');
        await sleep(600);
        const monthAnchorText = await s.eval(`document.getElementById('scheduleAnchor-month')?.textContent || ''`);
        check('Подпись Месяца заполнена реальным текстом ("Месяц · <месяц> <год>")', /^Месяц · /.test(monthAnchorText), `текст: "${monthAnchorText}"`);
        const weekAnchorText = await s.eval(`document.getElementById('scheduleAnchor-week')?.textContent || ''`);
        check('Подпись Недели заполнена реальным текстом ("Неделя · ...") даже когда открыт Месяц (общая дата)', /^Неделя · /.test(weekAnchorText), `текст: "${weekAnchorText}"`);

        await s.screenshot('/tmp/zc-schedule-month-open.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
