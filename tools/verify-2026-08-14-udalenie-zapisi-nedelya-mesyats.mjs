// Живая проверка бага P1 из аудита 14.08.2026: после удаления записи вид "День"
// обновлялся сразу, а "Неделя" и "Месяц" продолжали показывать удалённую запись до
// перезагрузки страницы (владелец видел запись-призрак и мог планировать по
// неактуальному расписанию).
//
// Причина (assets/crm-booking-status.js, doDelete): успешный DELETE /bookings/:id
// убирал из DOM только саму карточку `.appt--selected` в календаре Дня. Неделя и
// Месяц рисуются СВОИМИ запросами (GET /schedule-range, crm-schedule-view-week.js /
// crm-schedule-view-month.js) - их разметка оставалась ровно такой, какой была на
// момент последней загрузки: чип "10:00 Имя" в неделе и счётчик "N записей" в месяце.
//
// Фикс: после удаления зовём window.__refreshScheduleViews({ all: true }) - тот же
// безопасный путь перечитывания, что уже использует кнопка "Обновить данные". Флаг
// all добавлен здесь же (assets/crm-schedule-views.js, refresh) и нужен потому, что
// закрытая карточка держит в DOM уже отрисованную разметку, а обработчик раскрытия
// зовёт setView только при СМЕНЕ вида - свёрнутая "Неделя", бывшая активным видом,
// после раскрытия показала бы старый рендер.
//
// Два сценария в одном браузере (памятка: два withBrowser подряд гонятся за портом
// 9333): владелец (crm-owner.html, карточки-details) и администратор (crm-admin.html,
// старые radio-вкладки) - правка трогает общий модуль, значит вторая роль тоже под
// регресс-проверкой.
//
// Запуск: node tools/verify-2026-08-14-udalenie-zapisi-nedelya-mesyats.mjs
// (нужен локальный Postgres; своя одноразовая база и свой сервер поднимаются сами)
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLIENT_NAME = 'QA Призрак Записи';
const ADMIN_CLIENT_NAME = 'QA Призрак Админский';

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pinAdmin = randomPin();
    // Дата брони - ЗАВТРА (тот же профиль сценария, что в аудите: запись на будущий
    // день), смещением от дня запуска, не литералом календаря. Все три вида делят
    // общую дату (scheduleViewState, Окно 25), поэтому один шаг "следующий день"
    // в Дне переводит на эту дату и Неделю, и Месяц - граница недели/месяца
    // сценарий не ломает.
    const target = daysFromToday(1);

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('d814-owner', NULL, 'QA Владелец Удаление', 'owner', true, false, true, 'd814-owner@test.local', $1),
       ('d814-admin', 1, 'QA Админ Удаление', 'admin', true, false, true, 'd814-admin@test.local', $3),
       ('d814-master1', 1, 'QA Мастер Удаление', 'master', true, true, true, 'd814-master1@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin()), hashPin(pinAdmin)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'd814-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('d814-master1', 'strizhka', 2000, 40)`);

    // Записи создаёт КЛИЕНТ с публичного сайта (анонимный POST /bookings) - ровно как
    // в шагах аудита, не служебной вставкой в базу. Две штуки: одну удалит владелец,
    // вторую - администратор своим сценарием.
    async function bookAsClient(startTime, clientName, phone) {
      const created = await fetch(`${apiUrl}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          masterId: 'd814-master1',
          serviceIds: ['strizhka'],
          date: target,
          startTime,
          clientName,
          clientPhone: phone,
        }),
      });
      const body = await created.json();
      if (!created.ok || !body.booking?.id) {
        throw new Error(`POST /bookings ${startTime} → ${created.status} ${JSON.stringify(body)}`);
      }
      return body.booking.id;
    }

    const bookingId = await bookAsClient('10:00', CLIENT_NAME, '+79990000814');
    const bookingIdAdmin = await bookAsClient('12:00', ADMIN_CLIENT_NAME, '+79990000815');

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        // Один ридер на оба сценария: разметка Дня/Недели/Месяца общая, отличается
        // только оболочка страницы (карточки-details vs radio-вкладки).
        const viewsOf = (apptId) => s.eval(`(() => {
          const appt = document.querySelector('.appt[data-id="' + ${JSON.stringify(apptId)} + '"]');
          const weekCell = document.querySelector('.week-day-cell[data-open-day="${target}"]');
          const weekChips = weekCell ? [...weekCell.querySelectorAll('.week-appt-chip')].map((n) => n.textContent.trim()) : null;
          const monthCell = document.querySelector('.month-day--real[data-date="${target}"]');
          return {
            dayHasAppt: !!appt,
            weekCellFound: !!weekCell,
            weekChips,
            monthCellFound: !!monthCell,
            monthCount: monthCell?.querySelector('.appt-count')?.textContent.trim() ?? null,
          };
        })()`);

        async function deleteOpenedBooking(apptId) {
          await s.eval(`document.querySelector('.appt[data-id="' + ${JSON.stringify(apptId)} + '"]').click()`);
          await sleep(700);
          const ready = await s.eval(`!!document.getElementById('bkDeleteBtn')`);
          await s.click('#bkDeleteBtn');
          await sleep(300);
          await s.click('#bkDeleteYes');
          await sleep(2000); // DELETE + перечитывание видов
          return ready;
        }

        // ═════════════ Сценарий 1: ВЛАДЕЛЕЦ (crm-owner.html, карточки) ═════════════
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(400);
        await s.type('#loginEmail', 'd814-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1500);
        // Реальная навигация после логина сбрасывает device-metrics override - вернуть
        await s.setViewport(1440, 1100, true);

        // Переводим общую дату на день записи и раскрываем все три карточки
        await s.click('#scheduleCard-day summary');
        await sleep(600);
        await s.click('#dayNavNext');
        await sleep(800);
        await s.click('#scheduleCard-week summary');
        await sleep(900);
        await s.click('#scheduleCard-month summary');
        await sleep(900);

        const before = await viewsOf(bookingId);
        check('Владелец. День: запись видна в календаре до удаления', before.dayHasAppt, JSON.stringify(before));
        check('Владелец. Неделя: ячейка нужного дня найдена', before.weekCellFound, JSON.stringify(before));
        check(
          'Владелец. Неделя: чип записи виден до удаления',
          Array.isArray(before.weekChips) && before.weekChips.some((t) => t.includes(CLIENT_NAME)),
          JSON.stringify(before.weekChips)
        );
        check('Владелец. Месяц: ячейка нужного дня найдена', before.monthCellFound, JSON.stringify(before));
        check(
          'Владелец. Месяц: счётчик записей виден до удаления (в дне две брони)',
          typeof before.monthCount === 'string' && before.monthCount.startsWith('2 '),
          `счётчик="${before.monthCount}"`
        );

        const ownerBtnReady = await deleteOpenedBooking(bookingId);
        check('Владелец. Панель записи открыта, кнопка "Удалить запись" на месте', ownerBtnReady === true);
        const rowText = await s.eval(`document.getElementById('bkDeleteRow')?.textContent.trim()`);
        check('Владелец. Строка удаления сообщает об успехе', rowText === 'Запись удалена', `текст="${rowText}"`);

        // Ассерты на МЕХАНИЗМ (исчез след конкретной записи), не на агрегат
        const after = await viewsOf(bookingId);
        check('Владелец. День: запись исчезла сразу (то, что работало и раньше)', after.dayHasAppt === false, JSON.stringify(after));
        check(
          'БАГ P1 (владелец). Неделя обновилась без перезагрузки - чипа удалённой записи больше нет',
          Array.isArray(after.weekChips) && !after.weekChips.some((t) => t.includes(CLIENT_NAME)),
          `чипы после удаления=${JSON.stringify(after.weekChips)}`
        );
        check(
          'БАГ P1 (владелец). Месяц обновился без перезагрузки - счётчик стал "1 запись"',
          typeof after.monthCount === 'string' && after.monthCount.startsWith('1 '),
          `счётчик после удаления="${after.monthCount}"`
        );
        check(
          'Владелец. Чужая запись того же дня осталась на месте (удалили ровно одну)',
          Array.isArray(after.weekChips) && after.weekChips.some((t) => t.includes(ADMIN_CLIENT_NAME)),
          JSON.stringify(after.weekChips)
        );

        // Страницу НЕ перезагружали - иначе проверка была бы бессмысленной
        const noReload = await s.eval(`performance.getEntriesByType('navigation').length === 1`);
        check('Владелец. Проверка честная: перезагрузки страницы не было', noReload === true);

        // Регрессия: кнопка "Обновить данные" по-прежнему работает и не ломает виды
        await s.click('#refreshBtn');
        await sleep(1500);
        const afterRefresh = await viewsOf(bookingId);
        check(
          'Регрессия. Кнопка "Обновить данные": удалённая запись не возвращается ни в один вид',
          afterRefresh.dayHasAppt === false && !afterRefresh.weekChips.some((t) => t.includes(CLIENT_NAME)),
          JSON.stringify(afterRefresh)
        );
        check(
          'Регрессия. Виды остались отрисованными (ячейки недели/месяца на месте, не пустой экран)',
          afterRefresh.weekCellFound && afterRefresh.monthCellFound,
          JSON.stringify(afterRefresh)
        );
        await s.screenshot('/tmp/verify-2026-08-14-udalenie-owner.png');

        // ═══════ Сценарий 2: АДМИНИСТРАТОР (crm-admin.html, radio-вкладки) ═══════
        // Здесь карточек-details нет вообще - до правки refresh() на этой странице был
        // полным no-op, то есть расписание не перечитывалось ни кнопкой "Обновить
        // данные", ни после удаления.
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(500);
        await s.type('#loginEmail', 'd814-admin@test.local');
        await s.type('#loginPin', pinAdmin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1600);
        await s.setViewport(1440, 1100, true);

        await s.click('#dayNavNext');
        await sleep(800);
        // Прогреваем Неделю и Месяц (они должны быть УЖЕ отрисованы к моменту
        // удаления - иначе возврат на них загрузил бы свежие данные сам и проверка
        // ничего бы не доказала), затем возвращаемся на День и удаляем оттуда.
        await s.eval(`document.getElementById('sp-week').click()`);
        await sleep(900);
        await s.eval(`document.getElementById('sp-month').click()`);
        await sleep(900);
        await s.eval(`document.getElementById('sp-day').click()`);
        await sleep(800);

        const adminBefore = await viewsOf(bookingIdAdmin);
        check('Админ. День: своя запись видна до удаления', adminBefore.dayHasAppt, JSON.stringify(adminBefore));
        check(
          'Админ. Неделя: чип записи виден до удаления',
          Array.isArray(adminBefore.weekChips) && adminBefore.weekChips.some((t) => t.includes(ADMIN_CLIENT_NAME)),
          JSON.stringify(adminBefore.weekChips)
        );
        check(
          'Админ. Месяц: счётчик записей виден до удаления',
          typeof adminBefore.monthCount === 'string' && adminBefore.monthCount.startsWith('1 '),
          `счётчик="${adminBefore.monthCount}"`
        );

        const adminBtnReady = await deleteOpenedBooking(bookingIdAdmin);
        check('Админ. Панель записи открыта, кнопка "Удалить запись" на месте', adminBtnReady === true);

        const adminAfter = await viewsOf(bookingIdAdmin);
        check('Админ. День: запись исчезла сразу', adminAfter.dayHasAppt === false, JSON.stringify(adminAfter));
        check(
          'БАГ P1 (админ). Неделя обновилась без перезагрузки - чипа удалённой записи больше нет',
          Array.isArray(adminAfter.weekChips) && !adminAfter.weekChips.some((t) => t.includes(ADMIN_CLIENT_NAME)),
          `чипы после удаления=${JSON.stringify(adminAfter.weekChips)}`
        );
        check(
          'БАГ P1 (админ). Месяц обновился без перезагрузки - счётчика записей на дне нет',
          adminAfter.monthCount === null,
          `счётчик после удаления="${adminAfter.monthCount}"`
        );
        const adminNoReload = await s.eval(`performance.getEntriesByType('navigation').length === 1`);
        check('Админ. Проверка честная: перезагрузки страницы не было', adminNoReload === true);
        await s.screenshot('/tmp/verify-2026-08-14-udalenie-admin.png');
      });
    });

    // Сервер тоже должен считать записи удалёнными (не только экран)
    const left = await db.query('SELECT id FROM bookings WHERE id = ANY($1)', [[bookingId, bookingIdAdmin]]);
    check('База: обеих записей действительно нет', left.rows.length === 0, `строк=${left.rows.length}`);
  });
} catch (err) {
  console.error('Прогон упал:', err);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
