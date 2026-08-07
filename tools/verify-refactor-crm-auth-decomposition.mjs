// Регрессионный прогон для декомпозиции assets/crm-auth.js (structural refactoring,
// см. plans/2026-08-07-crm-auth-decomposition.md). Гоняется ЦЕЛИКОМ после каждой
// фазы переноса домена - ловит регрессию в любой из уже перенесённых частей, не
// только в текущей. До первого переноса должен быть зелёным на НЕТРОНУТОМ
// crm-auth.js - это baseline.
//
// Покрывает по одному smoke-сценарию на каждый домен из плана: auth/сессия,
// дашборд-цифры (renderLiveProof), виджеты даты/времени, портфолио+роль
// сотрудника, разовый+недельный редактор графика, услуги/цены мастера, форма
// заявки на график (мастер), периоды ЗП/выручки, self-view/self-data мастера,
// радио статуса брони, walk-in визард (сквозной сценарий с реальным сохранением).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pinAdmin = randomPin();
    const pinMaster = randomPin();

    // Свежие QA-аккаунты (не трогаем сидовые master-1/2/3/owner-test/admin-*-test -
    // их PIN неизвестен, см. память feedback_hardkodit-pin-fikstury-protiv-boevogo-api).
    // location_id=1 (засеян миграцией 002) - у админа/owner-страницы есть смысл "своя точка".
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('rf-owner', NULL, 'QA Владелец Рефакторинг', 'owner', true, false, true, 'rf-owner@test.local', $1),
       ('rf-admin', 1, 'QA Админ Рефакторинг', 'admin', true, false, true, 'rf-admin@test.local', $2),
       ('rf-master', 1, 'QA Мастер Рефакторинг', 'master', true, true, true, 'rf-master@test.local', $3)`,
      [hashPin(pinOwner), hashPin(pinAdmin), hashPin(pinMaster)]
    );

    // rf-master получает рабочий недельный график (нужен для schedule-editor/
    // self-data-tab/walk-in доступности) - широкое окно 00:00-23:59 (не 10:00-20:00
    // магазина), чтобы сквозной walk-in сценарий не зависел от времени суток, в
    // которое реально запускается этот verify-скрипт (walk-in ставит бронь на
    // "сейчас", см. wireWalkIn/openForWalkin в crm-auth.js).
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'rf-master', wd, true, '00:00', '23:59' FROM generate_series(1, 7) AS wd`
    );
    // Сидовые master-1/2/3 (миграция 002) - тоже получают график, иначе испортят
    // сравнения на owner-странице (payroll-карточки/схед-редактор считают по ним).
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );

    // rf-master получает услугу (нужна для walk-in service picker + self-data-tab
    // services list) - услуга 'strizhka' уже засеяна миграцией 002.
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('rf-master', 'strizhka', 2000, 40)`
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
    // Живой пре-чек через API (не только браузер) - подтверждает, что бэкенд-контракт
    // цел независимо от фронтенда (Impact Analysis, Stage 7).
    await login('rf-owner@test.local', pinOwner);
    await login('rf-admin@test.local', pinAdmin);
    await login('rf-master@test.local', pinMaster);
    check('API: логин владельца/админа/мастера работает (бэкенд не тронут переносом)', true);

    await withStaticServer(apiUrl, async (base) => {
      const uiLogin = async (s, email, pin) => {
        await s.type('#loginEmail', email);
        await s.type('#loginPin', pin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300); // login + renderLiveProof (несколько параллельных fetch)
      };

      // ── OWNER ──────────────────────────────────────────────────────────────
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await uiLogin(s, 'rf-owner@test.local', pinOwner);

        const sessionText = await s.eval(`document.getElementById('sessionInfo')?.textContent`);
        check('[owner] вход успешен, sessionInfo показывает владельца', (sessionText || '').includes('владелец'), `"${sessionText}"`);

        // Домен: дашборд (renderLiveProof) - цифры реально считаются, не "000 ₽ пример"
        await sleep(600);
        const revenueText = await s.eval(`document.getElementById('rvAllDayRevenue')?.textContent`);
        check('[owner] renderLiveProof: "Выручка сегодня" отрендерена (не пусто)', !!revenueText && revenueText.trim().length > 0, `"${revenueText}"`);

        // Домен: виджеты даты/времени - custom-date/custom-select реально строятся в DOM
        const hasCustomDate = await s.eval(`!!document.querySelector('.custom-date')`);
        const hasCustomSelect = await s.eval(`!!document.querySelector('.custom-select')`);
        check('[owner] виджет даты (.custom-date) отрендерен где-то на странице', hasCustomDate === true);
        check('[owner] виджет времени (.custom-select) отрендерен где-то на странице', hasCustomSelect === true);

        // Домен: портфолио/роль сотрудника - карточка сотрудника рендерится с реальными полями
        const roleSelectExists = await s.eval(`!!document.querySelector('.role-select[data-master-id="master-1"]')`);
        check('[owner] редактор роли сотрудника (.role-select) для master-1 в DOM', roleSelectExists === true);

        // Домен: разовый редактор графика (master-1 - schedule)
        const schedCurrentText = await s.eval(`document.getElementById('schedCurrent-master-1')?.textContent`);
        check('[owner] разовый редактор графика master-1 загрузил текущее состояние', !!schedCurrentText && schedCurrentText.trim().length > 0, `"${schedCurrentText}"`);

        // Домен: недельный редактор графика - 7 иконок дней недели
        const weekdayIconCount = await s.eval(`document.querySelectorAll('#weeklyEditor-master-1 .weekday-icon').length`);
        check('[owner] недельный редактор графика master-1: 7 иконок дней недели', weekdayIconCount === 7, `найдено ${weekdayIconCount}`);

        // Домен: услуги/цены мастера - service-picker с чекбоксами услуг
        const servicePickerCount = await s.eval(`document.querySelector('.service-picker[data-master-id="master-1"]')?.querySelectorAll('.service-check').length`);
        check('[owner] редактор услуг мастера (.service-picker) для master-1 содержит чекбоксы', (servicePickerCount || 0) > 0, `найдено ${servicePickerCount}`);

        // Домен: периоды ЗП/выручки - карточка "Выручка" Week/Month отрендерена
        const weekRevenueText = await s.eval(`document.getElementById('rvAllWeekRevenue')?.textContent`);
        check('[owner] renderRevenuePeriods: "Выручка" за неделю отрендерена', !!weekRevenueText && weekRevenueText.trim().length > 0, `"${weekRevenueText}"`);

        // Домен: радио статуса брони - открыть пример-запись и переключить статус (если есть живая бронь)
        const hasStatusRadios = await s.eval(`document.querySelectorAll('input[name="bstatus"]').length`);
        check('[owner] радио статуса брони (bstatus) присутствуют в DOM', hasStatusRadios > 0, `найдено ${hasStatusRadios}`);

        // Домен: walk-in - на owner-странице прямой кнопки "+" нет с Окна 31
        // (05.08.2026, полировка - см. tools/verify-2026-08-05-okno31-*.mjs), openForWalkin
        // доступен только через window.openRebookBooking (карточка клиента → "Записать
        // снова", assets/crm-clients.js). Проверяем именно этот реальный путь входа.
        const rebookFnExists = await s.eval(`typeof window.openRebookBooking`);
        check('[owner] window.openRebookBooking (единственный путь в openForWalkin) - функция', rebookFnExists === 'function', `typeof = ${rebookFnExists}`);
        if (rebookFnExists === 'function') {
          await s.eval(`window.openRebookBooking('master-1', 'Иван 1 (пример)', 'QA Клиент', '+70000000000', ['strizhka'])`);
          await sleep(200);
          const formVisible = await s.eval(`document.getElementById('walkinForm')?.hidden === false`);
          const pickerCount = await s.eval(`document.getElementById('wfServicePicker')?.querySelectorAll('.service-check').length`);
          check('[owner] openRebookBooking открывает форму walk-in', formVisible === true);
          check('[owner] walk-in service picker заполнен услугами master-1', (pickerCount || 0) > 0, `найдено ${pickerCount}`);
        }

        await s.screenshot('/tmp/refactor-crm-auth-owner.png');
      });
      await sleep(1500);

      // ── ADMIN ──────────────────────────────────────────────────────────────
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await uiLogin(s, 'rf-admin@test.local', pinAdmin);
        const sessionText = await s.eval(`document.getElementById('sessionInfo')?.textContent`);
        check('[admin] вход успешен, sessionInfo показывает администратора', (sessionText || '').includes('администратор'), `"${sessionText}"`);
        const revenueTodayText = await s.eval(`document.getElementById('revenueTodayAmount')?.textContent`);
        check('[admin] renderLiveProof: "Выручка сегодня" (админ) отрендерена', !!revenueTodayText && revenueTodayText.trim().length > 0, `"${revenueTodayText}"`);
      });
      await sleep(1500);

      // ── MASTER ─────────────────────────────────────────────────────────────
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-master.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await uiLogin(s, 'rf-master@test.local', pinMaster);
        const sessionText = await s.eval(`document.getElementById('sessionInfo')?.textContent`);
        check('[master] вход успешен, sessionInfo показывает мастера', (sessionText || '').includes('мастер'), `"${sessionText}"`);

        // Домен: self-view - бейдж имени
        const badgeText = await s.eval(`document.getElementById('selfNameBadge')?.textContent`);
        check('[master] wireMasterSelfView: бейдж имени показывает реальное имя', badgeText === 'QA Мастер Рефакторинг', `"${badgeText}"`);

        // Домен: self-data-tab - услуги read-only список
        const selfServiceCount = await s.eval(`document.getElementById('selfServicePicker')?.querySelectorAll('.service-check').length`);
        check('[master] self-data-tab: read-only список услуг заполнен', (selfServiceCount || 0) > 0, `найдено ${selfServiceCount}`);

        // Домен: форма заявки на график - элементы присутствуют, история загружена
        const reqSubmitExists = await s.eval(`!!document.getElementById('reqSubmitBtn')`);
        check('[master] форма заявки на график (reqSubmitBtn) в DOM', reqSubmitExists === true);
        const reqHistoryText = await s.eval(`document.getElementById('reqHistory')?.textContent`);
        check('[master] история заявок на график загружена (не пусто/не завис на загрузке)', !!reqHistoryText && reqHistoryText.trim().length > 0, `"${reqHistoryText}"`);

        // Домен: walk-in solo - клик по "+ Новая запись" открывает форму
        const soloBtnExists = await s.eval(`!!document.getElementById('walkinSoloTrigger')`);
        check('[master] кнопка "+ Новая запись" (walkinSoloTrigger) в DOM', soloBtnExists === true);
        if (soloBtnExists) {
          await s.click('#walkinSoloTrigger');
          await sleep(200);
          const formHidden = await s.eval(`document.getElementById('walkinForm')?.hidden`);
          check('[master] клик по "+ Новая запись" открывает форму walk-in', formHidden === false, `hidden=${formHidden}`);

          // Сквозной сценарий walk-in: реально выбрать услугу и сохранить запись,
          // проверить что бронь появилась в БД (не просто "форма открылась").
          const serviceCheckbox = await s.eval(`document.querySelector('#wfServicePicker input[type="checkbox"]')?.value`);
          if (serviceCheckbox) {
            await s.click('#wfServicePicker input[type="checkbox"]');
            await sleep(150);
            await s.click('#wfSubmit');
            await sleep(700);
            const resultText = await s.eval(`document.getElementById('wfResult')?.textContent`);
            check('[master] walk-in: сохранение показывает "Готово"', (resultText || '').includes('Готово'), `"${resultText}"`);
          }
        }
      });
      await sleep(1500);

      // Impact Analysis: booking из сквозного walk-in сценария реально лежит в БД
      const { rows } = await db.query(`SELECT id, master_id, status FROM bookings WHERE master_id = 'rf-master'`);
      check('[БД] walk-in booking реально сохранён в bookings (master_id=rf-master)', rows.length >= 1, `найдено строк: ${rows.length}`);
      if (rows.length >= 1) {
        check('[БД] walk-in booking получил статус "done" (клиент физически в кресле)', rows[0].status === 'done', `status=${rows[0].status}`);
      }
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
