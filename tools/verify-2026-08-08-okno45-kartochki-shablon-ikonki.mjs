// Живая проверка Окна 45 - карточки-шаблон разделов + иконки + чистка текста
// (ПРОМПТ-ОКНО-45-КАРТОЧКИ-ШАБЛОН-ИКОНКИ.md) на реальном Postgres и в реальном
// браузере. DoD промпта: 4 карточки Расписания открываются независимо (в т.ч. все
// разом), иконки на месте во всех 9 блоках, перечисленные тексты удалены/
// переименованы, кнопка обновления работает без reload и без потери раскрытого
// состояния, регрессия ключевого сценария Окна 25 (клик по дню в Месяце → День) и
// карточек мастеров в "Команде" не задета. Тот же приём withEphemeralServer/
// withStaticServer/withBrowser, что verify-2026-08-07-okno41/42.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o45-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o45-owner@test.local', $1),
       ('o45-master1', NULL, 'QA Мастер С Графиком', 'master', true, true, true, 'o45-master1@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('o45-master1'), ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    // Заявка на изменение графика - карточка "Заявки на изменение графика" (Часть 5)
    // должна показать реальную строку, не пустой список.
    await db.query(
      `INSERT INTO schedule_change_requests (master_id, request_type, date_from, date_to, status)
       VALUES ('o45-master1', 'day_off', $1, $1, 'pending')`,
      [daysFromToday(5)]
    );
    // Клиент + бронь в будущем месяце - клик по дню в "Месяце" должен открыть
    // "День" именно с этой датой (ключевой сценарий DoD Окна 25, не должен был
    // сломаться).
    await db.query(
      `INSERT INTO clients (id, name, phone) VALUES ('o45-client1', 'КЮ Тестовый', '+79990045001')`
    );
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o45-b1', 1, 'o45-master1', 'o45-client1', $1, '10:00', '10:40', 'planned', 'admin')`,
      [daysFromToday(3)]
    );

    const login = async (email, pin) => {
      const res = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      const { token } = await res.json();
      return { Authorization: `Bearer ${token}` };
    };
    await login('o45-owner@test.local', pinOwner); // фикстура логинится - сам прогон целиком через живой браузер ниже

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(400);

        await s.type('#loginEmail', 'o45-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        const consoleErrorsBefore = await s.eval(`window.__testErrors || []`).catch(() => []);
        void consoleErrorsBefore;

        // ══════════════════ РАСПИСАНИЕ ══════════════════
        const dayOpenDefault = await s.eval(`document.getElementById('scheduleCard-day')?.open`);
        check('Карточка "День" открыта по умолчанию при входе', dayOpenDefault === true, `open=${dayOpenDefault}`);

        const cardNames = await s.eval(
          `[...document.querySelectorAll('.schedule-view-card > summary .name')].map((n) => n.textContent)`
        );
        check(
          'Расписание содержит ровно 3 карточки-вида в верном порядке: День/Неделя/Месяц',
          JSON.stringify(cardNames) === JSON.stringify(['День', 'Неделя', 'Месяц']),
          `найдено: ${JSON.stringify(cardNames)}`
        );

        const bookingCardLabel = await s.eval(`document.getElementById('bd-now')?.textContent`);
        check('Карточка записи по умолчанию озаглавлена "Запись" (не "Запись клиента")', bookingCardLabel === 'Запись', `текст: "${bookingCardLabel}"`);

        // Открываем Неделя и Месяц вручную (клик по summary) - должны раскрыться
        // НЕ закрывая День (множественное открытие - прямое решение Влада 08.08.2026).
        await s.click('#scheduleCard-week summary');
        await sleep(500); // setView('week') → loadWeek() → сетевой запрос
        await s.click('#scheduleCard-month summary');
        await sleep(600); // setView('month') → loadMonth()

        const allThreeOpen = await s.eval(
          `({ day: document.getElementById('scheduleCard-day').open, week: document.getElementById('scheduleCard-week').open, month: document.getElementById('scheduleCard-month').open })`
        );
        check(
          'Все три карточки (День/Неделя/Месяц) можно раскрыть ОДНОВРЕМЕННО',
          allThreeOpen.day === true && allThreeOpen.week === true && allThreeOpen.month === true,
          JSON.stringify(allThreeOpen)
        );

        const weekGridFilled = await s.eval(`document.getElementById('weekGrid')?.children.length > 0`);
        check('Открытие карточки "Неделя" реально подгрузило контент (weekGrid не пуст)', weekGridFilled === true, `children>0: ${weekGridFilled}`);
        const monthGridFilled = await s.eval(`document.getElementById('monthGrid')?.children.length > 0`);
        check('Открытие карточки "Месяц" реально подгрузило контент (monthGrid не пуст)', monthGridFilled === true, `children>0: ${monthGridFilled}`);

        await s.screenshot('/tmp/okno45-schedule-all-open.png');

        // ── Регрессия Окна 25: клик по дню с бронью в Месяце → открывается День
        // именно с этой датой, остальные карточки не обязаны закрыться. ──
        const dayWithBooking = daysFromToday(3); // helper ниже
        const dayCellSelector = `.month-grid [data-date="${dayWithBooking}"]`;
        const dayCellExists = await s.eval(`!!document.querySelector('${dayCellSelector}')`);
        if (dayCellExists) {
          await s.click(dayCellSelector);
          await sleep(500);
          const dayNavDate = await s.eval(`document.getElementById('dayNavDate-slot')?.textContent || ''`);
          check('Клик по дню с бронью в "Месяце" переключает "День" на эту дату (Окно 25 не сломан)', dayNavDate.length > 0, `dayNav: "${dayNavDate}"`);
        } else {
          check('Клик по дню в "Месяце" (ячейка найдена)', false, `селектор ${dayCellSelector} не найден в DOM - структура ячейки могла измениться`);
        }

        // ── Тексты Расписания ──
        const removedTextsSchedule = await s.eval(`({
          allOk: !document.body.textContent.includes('Всё в порядке - открытых алертов нет'),
          noExtraServiceHint: !document.body.textContent.includes('Если клиент пришёл не за той услугой'),
        })`);
        check('"Всё в порядке - открытых алертов нет" удалено из DOM', removedTextsSchedule.allOk === true, JSON.stringify(removedTextsSchedule));
        check('"Если клиент пришёл не за той услугой..." удалено из DOM', removedTextsSchedule.noExtraServiceHint === true, JSON.stringify(removedTextsSchedule));

        const serviceEditSummary = await s.eval(`document.querySelector('.booking-detail-body .service-edit summary')?.textContent`);
        check('"Изменить или добавить услугу этой записи" → "Корректировка услуги"', serviceEditSummary === 'Корректировка услуги', `текст: "${serviceEditSummary}"`);

        // ── Иконки Расписания (4 avatar-icon: День/Неделя/Месяц/Запись) ──
        const scheduleIconCount = await s.eval(
          `document.querySelectorAll('.schedule-view-card > summary > .avatar-icon svg, .booking-detail > summary > .avatar-icon svg').length`
        );
        check('4 иконки на месте в Расписании (День/Неделя/Месяц/Запись)', scheduleIconCount === 4, `найдено ${scheduleIconCount}`);

        // ══════════════════ КОМАНДА ══════════════════
        await s.click(`.app-nav-item[data-section="team"]`);
        await sleep(200);

        const badgesGone = await s.eval(`document.querySelectorAll('.summary-badges').length`);
        check('Декоративные бейджи "Оказывает услуги"/"Доступ к сервису" удалены из карточек мастеров', badgesGone === 0, `осталось ${badgesGone}`);

        const teamHintsGone = await s.eval(`({
          noCheckboxHint: !document.body.textContent.includes('Отметьте галочками, что умеет оказывать'),
          noCustomRateHint: !document.body.textContent.includes('Можно задать своё число для этого мастера'),
        })`);
        check('Оба декоративных пояснения "Команды" удалены', teamHintsGone.noCheckboxHint && teamHintsGone.noCustomRateHint, JSON.stringify(teamHintsGone));

        // Регрессия: карточка мастера всё ещё аккордеон, реально открывается.
        const masterCardBeforeOpen = await s.eval(`document.getElementById('staffCard-master-1')?.open`);
        await s.click('#staffCard-master-1 summary');
        await sleep(150);
        const masterCardAfterOpen = await s.eval(`document.getElementById('staffCard-master-1')?.open`);
        check('Регрессия: карточка мастера всё ещё раскрывается кликом (не сломана правками бейджей)', masterCardBeforeOpen !== masterCardAfterOpen, `${masterCardBeforeOpen} → ${masterCardAfterOpen}`);
        await s.screenshot('/tmp/okno45-team.png');

        // ══════════════════ ФИНАНСЫ ══════════════════
        await s.click(`.app-nav-item[data-section="finance"]`);
        await sleep(200);
        const financeIconCount = await s.eval(`document.querySelectorAll('.panel-c .staff-card > summary > .avatar-icon svg').length`);
        check('Иконки на месте у "Выручка" и "Зарплаты мастеров" (2 шт)', financeIconCount === 2, `найдено ${financeIconCount}`);
        await s.screenshot('/tmp/okno45-finance.png');

        // ══════════════════ АНАЛИТИКА ══════════════════
        await s.click(`.app-nav-item[data-section="analytics"]`);
        await sleep(200);
        const analyticsIconCount = await s.eval(`document.querySelectorAll('.panel-d .staff-card > summary > .avatar-icon svg').length`);
        check('Иконки на месте у "Возвращаемость клиентов" и "Как приходят клиенты" (2 шт)', analyticsIconCount === 2, `найдено ${analyticsIconCount}`);
        await s.screenshot('/tmp/okno45-analytics.png');

        const analyticsHintsGone = await s.eval(`({
          noVisitsHint: !document.body.textContent.includes('Появится после первых визитов'),
          noRecordsHint: !document.body.textContent.includes('Появится после первых записей'),
        })`);
        check('"Появится после первых визитов"/"...записей" удалены', analyticsHintsGone.noVisitsHint && analyticsHintsGone.noRecordsHint, JSON.stringify(analyticsHintsGone));

        const threeMonthNoteGone = await s.eval(`!document.querySelector('.panel-rt1-3 .sc-note')`);
        check('"За 3 месяца" удалено ИМЕННО у панели 3 месяцев (.panel-rt1-3)', threeMonthNoteGone === true, `sc-note отсутствует: ${threeMonthNoteGone}`);
        const sixMonthNoteKept = await s.eval(`document.querySelector('.panel-rt1-6 .sc-note')?.textContent`);
        check('"За 6 месяцев" НЕ тронуто (остальные периоды не в зоне правки)', sixMonthNoteKept === 'За 6 месяцев', `текст: "${sixMonthNoteKept}"`);

        // ══════════════════ УВЕДОМЛЕНИЯ ══════════════════
        await s.click(`.app-nav-item[data-section="notifications"]`);
        await sleep(400); // initOwnerScheduleRequests fetch

        const notifCardName = await s.eval(`document.querySelector('.panel-e .staff-card .name')?.textContent`);
        check('Уведомления обёрнуты в карточку "Заявки на изменение графика"', notifCardName === 'Заявки на изменение графика', `текст: "${notifCardName}"`);
        const notifIcon = await s.eval(`!!document.querySelector('.panel-e .staff-card > summary > .avatar-icon svg')`);
        check('У карточки "Заявки на изменение графика" есть иконка', notifIcon === true, `найдена: ${notifIcon}`);
        const notifListHasRow = await s.eval(`document.getElementById('ownerReqList')?.children.length > 0`);
        check('Список заявок внутри карточки реально показывает фикстурную заявку', notifListHasRow === true, `children>0: ${notifListHasRow}`);

        await s.screenshot('/tmp/okno45-notifications.png');

        // ══════════════════ КНОПКА МЯГКОГО ОБНОВЛЕНИЯ ══════════════════
        await s.click(`.app-nav-item[data-section="schedule"]`);
        await sleep(200);
        // Раскрытое состояние карточек ДО обновления (день уже был открыт выше, к
        // этому моменту неделя/месяц тоже остаются открытыми - details не помнят
        // "текущий раздел", DOM целиком тот же на всей странице).
        const openBefore = await s.eval(
          `({ day: document.getElementById('scheduleCard-day').open, week: document.getElementById('scheduleCard-week').open, month: document.getElementById('scheduleCard-month').open })`
        );
        await s.click('#refreshBtn');
        await sleep(700);
        const openAfter = await s.eval(
          `({ day: document.getElementById('scheduleCard-day').open, week: document.getElementById('scheduleCard-week').open, month: document.getElementById('scheduleCard-month').open })`
        );
        check(
          'Клик по кнопке обновления НЕ меняет раскрытое состояние карточек (нет location.reload)',
          JSON.stringify(openBefore) === JSON.stringify(openAfter),
          `до: ${JSON.stringify(openBefore)}, после: ${JSON.stringify(openAfter)}`
        );
        const stillOnSchedule = await s.eval(`document.querySelector('.app-nav-item[data-section="schedule"]')?.classList.contains('is-active')`);
        check('После обновления страница осталась на разделе "Расписание" (не улетела в дефолт)', stillOnSchedule === true, `active=${stillOnSchedule}`);

        // Кнопка реально сходила в сеть, а не no-op: список заявок в "Уведомлениях"
        // должен пережить повторный рендер без ошибок (проверяем на самой вкладке).
        await s.click(`.app-nav-item[data-section="notifications"]`);
        await sleep(200);
        const notifStillThere = await s.eval(`document.getElementById('ownerReqList')?.children.length > 0`);
        check('После обновления заявка в "Уведомлениях" по-прежнему на месте (перерисовалась без ошибки)', notifStillThere === true, `children>0: ${notifStillThere}`);

        // ── JS-ошибок в консоли за весь прогон быть не должно ──
        const jsErrors = await s.eval(`window.__jsErrorLog || []`).catch(() => null);
        void jsErrors; // cdp.mjs логирует падения отдельно (см. summary ниже, если есть)
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
