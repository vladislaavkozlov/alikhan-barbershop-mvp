// Живая проверка правок интерфейса расписания/CRM владельца по прямым правкам
// Влада 07.08.2026 (после Окон 43/44): якорь-заголовок Дня убран, дубль-алерт
// заявок убран, карточки заявок мастеров, "Клиент А" → "Запись клиента",
// вкладка "Год" удалена, "пример"-бейджи у имён убраны, "Зарплата"/"Настройка ЗП"
// переехали в "Финансы", "Возвращаемость клиентов" переехала в новую вкладку
// "Аналитика" (sidebar), SVG-иконки вместо эмодзи, колокольчик+письмо объединены,
// "Роль" - custom-select вместо нативного select. Один прогон на все правки одной
// сессии - тот же приём withEphemeralServer/withStaticServer/withBrowser, что и
// у остальных verify-скриптов проекта.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('ui07-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'ui07-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    // Реальные сидовые мастера (миграция 002) - HTML статично ссылается на master-1/2/3
    // (data-master-id, id="payrollMaster1Day" и т.п.), фикстура графика нужна, чтобы
    // они не попали в mastersWithoutSchedule и не испортили другие проверки.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    // Заявка мастера "на рассмотрении" - проверка карточки в "Заявки мастеров" +
    // риск-клиент - проверка суммарного бейджа объединённого колокольчика.
    await db.query(
      `INSERT INTO schedule_change_requests (master_id, request_type, date_from, date_to, status)
       VALUES ('master-1', 'day_off', $1, $1, 'pending')`,
      [daysFromToday(5)]
    );
    await db.query(`INSERT INTO clients (id, name, phone, no_show_streak) VALUES ('ui07-c-risk', 'КЮ Тестовый Риск', '+79990043001', 2)`);
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel)
       VALUES ('ui07-b-risk', 1, 'master-1', NULL, 'ui07-c-risk', $1, '10:00', '10:40', 'no_show', 'admin')`,
      [daysFromToday(-1)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        const consoleErrors = [];
        s.onConsoleError?.((msg) => consoleErrors.push(msg));

        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'ui07-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);

        // ── sidebar: 4 пункта, SVG-иконки, порядок Расписание/Команда/Финансы/Аналитика ──
        const navLabels = JSON.parse(
          await s.eval(`JSON.stringify([...document.querySelectorAll('.app-nav-label')].map(e => e.textContent.trim()))`)
        );
        check(
          'Sidebar: 4 пункта в порядке Расписание/Команда/Финансы/Аналитика',
          JSON.stringify(navLabels) === JSON.stringify(['Расписание', 'Команда', 'Финансы', 'Аналитика']),
          JSON.stringify(navLabels)
        );
        const svgIconCount = await s.eval(`document.querySelectorAll('.app-nav-icon svg').length`);
        check('Все 4 иконки sidebar - SVG, не эмодзи', svgIconCount === 4, `найдено ${svgIconCount}`);

        // ── топбар: один колокольчик, не два ──
        const bellCount = await s.eval(`document.querySelectorAll('.notif-bell').length`);
        check('Топбар: ровно 1 кнопка-колокольчик (было 2)', bellCount === 1, `найдено ${bellCount}`);
        await sleep(200);
        const badgeText = await s.eval(`document.getElementById('msgBellBadge')?.textContent`);
        const badgeHidden = await s.eval(`document.getElementById('msgBellBadge')?.hidden`);
        check(
          'Бейдж колокольчика суммирует уведомления+риск-клиентов (>0, не скрыт)',
          badgeHidden === false && Number(badgeText) > 0,
          `text=${badgeText} hidden=${badgeHidden}`
        );
        const bellHasSvg = await s.eval(`!!document.querySelector('#msgBellIcon svg')`);
        check('Иконка колокольчика - SVG', bellHasSvg === true, String(bellHasSvg));

        // ── Расписание: якорь пуст на Дне, вкладок 3 (без Года), "Запись клиента" ──
        await s.eval(`window.crmGoToSection('schedule')`);
        await sleep(300);
        const anchorText = await s.eval(`document.getElementById('scheduleViewAnchor')?.textContent`);
        check('Якорь-подпись на вкладке "День" пуст', anchorText === '', `"${anchorText}"`);
        const schedTabs = JSON.parse(
          await s.eval(`JSON.stringify([...document.querySelectorAll('.panel-a .seg-tabs > .seg-bar label')].map(e=>e.textContent.trim()))`)
        );
        check(
          'Вкладок расписания 3 (День/Неделя/Месяц), "Год" нет',
          JSON.stringify(schedTabs) === JSON.stringify(['День', 'Неделя', 'Месяц']),
          JSON.stringify(schedTabs)
        );
        const bookingSummary = await s.eval(`document.getElementById('bd-now')?.textContent`);
        check('Заглушка записи по умолчанию - "Запись клиента"', bookingSummary === 'Запись клиента', `"${bookingSummary}"`);

        const alertsRequestsGone = await s.eval(`!document.getElementById('ownerAlertsRequests')`);
        check('Дублирующий compact-алерт заявок (#ownerAlertsRequests) удалён из DOM', alertsRequestsGone === true, String(alertsRequestsGone));

        // ── "Заявки мастеров" - карточки, не плоский текст ──
        await sleep(500); // initOwnerScheduleRequests подгружает список асинхронно
        const reqCardCount = await s.eval(`document.querySelectorAll('#ownerReqList .req-card').length`);
        check('"Заявки мастеров" рендерятся как .req-card (не .break-row)', reqCardCount >= 1, `найдено ${reqCardCount}`);
        const reqBadgeText = await s.eval(`document.querySelector('#ownerReqList .req-card .badge')?.textContent`);
        check('Карточка заявки показывает статусный бейдж', reqBadgeText === 'На рассмотрении', `"${reqBadgeText}"`);
        await s.screenshot('/tmp/ui07-schedule-day.png');

        // ── Команда: без "пример" у имён, "Роль" - custom-select, без Зарплаты/Возвращаемости ──
        await s.eval(`window.crmGoToSection('team')`);
        await sleep(300);
        // Именно бейдж-"пример" рядом с ИМЕНЕМ мастера убран (устарел - сотрудники
        // реальные), а не любое слово "пример" на вкладке: честные "00% пример" на
        // ещё не подключённых метриках ("Как приходят клиенты") сознательно
        // оставлены - это другой, актуальный disclaimer про фейковые цифры, не
        // про мастеров.
        const nameExampleBadges = await s.eval(`document.querySelectorAll('.panel-b .name .badge-example').length`);
        check('У имён мастеров не осталось бейджа "пример"', nameExampleBadges === 0, `найдено ${nameExampleBadges}`);
        const roleIsCustomSelect = await s.eval(`!!document.querySelector('#roleSelect-master-1.custom-select') && !document.querySelector('select.role-select')`);
        check('"Роль" - custom-select, нативных <select class="role-select"> не осталось', roleIsCustomSelect === true, String(roleIsCustomSelect));
        // Живой клик по кастомному селекту роли Мамедхана (владелец меняет его на "Мастер")
        await s.click('#roleSelect-master-2 .custom-select-trigger');
        await sleep(150);
        const listOpen = await s.eval(`!document.querySelector('#roleSelect-master-2 .custom-select-list').hidden`);
        check('Клик по триггеру "Роль" открывает список опций', listOpen === true, String(listOpen));
        await s.click('#roleSelect-master-2 .custom-select-option[data-value="master"]');
        await sleep(500);
        const roleNote2 = await s.eval(`document.getElementById('roleNote-master-2')?.textContent`);
        const roleLabel2 = await s.eval(`document.getElementById('roleLabel-master-2')?.textContent`);
        check('Смена роли через custom-select реально сохраняется на сервере', roleNote2 === 'Сохранено' && roleLabel2 === 'Мастер', `note="${roleNote2}" label="${roleLabel2}"`);
        const teamHeadingsList = JSON.parse(
          await s.eval(`JSON.stringify([...document.querySelectorAll('.panel-b h4')].map(e=>e.textContent.trim()))`)
        );
        check(
          'В "Команде" не осталось h4 "Зарплата"/"Возвращаемость клиентов"',
          !teamHeadingsList.some((t) => t.includes('Зарплата') || t.includes('Возвращаемость')),
          JSON.stringify(teamHeadingsList)
        );
        await s.screenshot('/tmp/ui07-team.png');

        // ── Финансы: "Зарплаты мастеров" + "Настройка ЗП" на месте, якорь работает ──
        await s.eval(`window.crmGoToSection('finance')`);
        await sleep(300);
        const financeH2 = JSON.parse(
          await s.eval(`JSON.stringify([...document.querySelectorAll('.panel-c h2')].map(e=>e.textContent.trim()))`)
        );
        check(
          'В "Финансы" есть "Выручка", "Зарплаты мастеров", "Настройка ЗП"',
          ['Выручка', 'Зарплаты мастеров', 'Настройка ЗП'].every((t) => financeH2.includes(t)),
          JSON.stringify(financeH2)
        );
        const zpAnchorWorks = await s.eval(`!!document.querySelector('.panel-c a[href="#nastroika-zp"]') && !!document.getElementById('nastroika-zp')`);
        check('Ссылка "Перейти к настройке ЗП" ведёт на элемент в той же вкладке', zpAnchorWorks === true, String(zpAnchorWorks));
        await s.screenshot('/tmp/ui07-finance.png');

        // ── Аналитика: новая вкладка, "Возвращаемость клиентов" ──
        await s.eval(`window.crmGoToSection('analytics')`);
        await sleep(300);
        const analyticsVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-d')).display !== 'none'`);
        const analyticsText = await s.eval(`document.querySelector('.panel-d').textContent`);
        check('Вкладка "Аналитика" открывается и виден заголовок', analyticsVisible === true, `visible=${analyticsVisible}`);
        check('"Аналитика" содержит "Возвращаемость клиентов"', analyticsText.includes('Возвращаемость клиентов'), analyticsText.includes('Возвращаемость клиентов') ? 'ок' : 'не найдено');

        // ── Правки второй волны (07.08.2026, вечер) ──────────────────────────
        await s.eval(`window.crmGoToSection('schedule')`);
        await sleep(300);
        const sidebarBrandGone = await s.eval(`!document.querySelector('.app-sidebar-brand')`);
        check('Дублирующий "АЛИХАН" над sidebar-меню убран', sidebarBrandGone === true, String(sidebarBrandGone));

        const colHeadDir = await s.eval(`getComputedStyle(document.querySelector('.panel-a .schedule-col-head')).flexDirection`);
        check('Шапка колонки мастера в "День" - колонкой (имя под кружком)', colHeadDir === 'column', colHeadDir);
        const colHeadAlign = await s.eval(`getComputedStyle(document.querySelector('.panel-a .schedule-col-head')).alignItems`);
        check('Шапка колонки мастера центрирована', colHeadAlign === 'center', colHeadAlign);

        const trackHeightDay1 = await s.eval(`Math.round(document.querySelector('.panel-a .schedule-track').getBoundingClientRect().height)`);
        // Листаем на +5 дней вперёд (гарантированно без брони этого фикстур-набора) - высота обязана остаться той же.
        for (let i = 0; i < 5; i++) {
          await s.click('#dayNavNext');
          await sleep(150);
        }
        const trackHeightDay2 = await s.eval(`Math.round(document.querySelector('.panel-a .schedule-track').getBoundingClientRect().height)`);
        check(
          'Высота сетки "День" не меняется при листании дат (640px, было min-height)',
          trackHeightDay1 === 640 && trackHeightDay2 === 640,
          `день1=${trackHeightDay1}px день2=${trackHeightDay2}px`
        );

        await s.eval(`window.crmGoToSection('team')`);
        await sleep(300);
        const teamH2 = await s.eval(`document.querySelector('.panel-b h2')?.textContent.trim()`);
        check('Заголовок раздела - только "Команда" (без дубля "Сотрудники")', teamH2 === 'Команда', `"${teamH2}"`);
        const teamTextNoLeaks = await s.eval(`document.querySelector('.panel-b').textContent`);
        check(
          'Убраны пояснение под "Ролью" и текст "staff.provides_services"',
          !teamTextNoLeaks.includes('Одна роль на сотрудника') && !teamTextNoLeaks.includes('staff.provides_services'),
          teamTextNoLeaks.includes('staff.provides_services') ? 'provides_services ещё на месте' : 'ок'
        );

        await s.eval(`window.crmGoToSection('finance')`);
        await sleep(300);
        const zpSectionText = await s.eval(`document.getElementById('nastroika-zp')?.textContent.trim()`);
        check('"Настройка ЗП" очищена от текстов/поля, якорь на месте', zpSectionText === 'Настройка ЗП', `"${zpSectionText}"`);

        check('Нет JS console-ошибок за весь сценарий', consoleErrors.length === 0, JSON.stringify(consoleErrors));

        await s.eval(`window.crmGoToSection('schedule')`);
        await sleep(300);
        await s.screenshot('/tmp/ui07-schedule-corrections.png');
        await s.setViewport(390, 844, true);
        await sleep(300);
        await s.screenshot('/tmp/ui07-mobile-day.png');
      });
    });
  });
} catch (err) {
  check('Скрипт отработал без исключений', false, err.stack || String(err));
}

summary();
