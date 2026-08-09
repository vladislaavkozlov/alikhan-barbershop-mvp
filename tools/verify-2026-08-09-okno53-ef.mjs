// Живая проверка Окна 53, задачи E и F (ПРОМПТ-ОКНО-53-БАГИ-РАСПИСАНИЯ-ВЛАДЕЛЕЦ.md).
//
// E - попап date-picker'а закрывался сам после клика "›"/"‹" (shiftCustomDateMonth
// пересобирал panel.innerHTML целиком, глобальный "клик вне - закрыть" видел
// отсоединённый e.target). Фикс - вариант (а) из промпта: точечное обновление
// подписи месяца + сетки дней, кнопки навигации остаются теми же узлами.
//
// F - честная поправка к тексту промпта: crm-walkin.js УЖЕ не передаёт minDate в
// date-picker (снято правкой 08.08.2026 вечером, до этого окна). Живым grep'ом по
// "date <"/todayStr() найден РЕАЛЬНЫЙ текущий блокер - assets/crm-calendar.js:156
// wireEmptySlotInteraction молча выходил на прошедшую дату, не вешая обработчик
// клика по пустому месту вообще (клиент не мог даже открыть форму записи, не то что
// сохранить). Бэкенд (createBookingTx: `isPast && !isStaff`) для персонала уже
// разрешал прошлое - фронт запрещал то, что сервер давно пропускает. Убрана ранняя
// проверка, DoD промпта ("на Дне выбрать прошедшую дату → интерактивный выбор
// времени → запись сохраняется") проверяется именно через этот путь.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pastDate = daysFromToday(-5);

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o53ef-owner', NULL, 'QA Владелец EF', 'owner', true, false, true, 'o53ef-owner@test.local', $1),
       ('o53ef-master1', NULL, 'QA Мастер EF', 'master', true, true, true, 'o53ef-master1@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o53ef-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o53ef-master1', 'strizhka', 2000, 40)`
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
    await login('o53ef-owner@test.local', pinOwner);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53ef-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        await s.click('#scheduleCard-day summary');
        await sleep(500);

        // ═══════════ Задача E, часть 1 - попап "Дня" не закрывается при листании ═══════════
        await s.click('#dayNavDate-slot .custom-date-trigger');
        await sleep(300);
        const openBefore = await s.eval(`document.getElementById('dayNavDate')?.classList.contains('open')`);
        check('Задача E: попап "Дня" открыт после клика по триггеру', openBefore === true, `open=${openBefore}`);

        for (let i = 1; i <= 3; i++) {
          const btnBox = await s.eval(`(() => {
            const btn = document.querySelector('#dayNavDate-slot .custom-date-nav-btn[aria-label="Предыдущий месяц"]');
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`);
          await s.clickAt(btnBox.x, btnBox.y);
          await sleep(250);
          const stillOpen = await s.eval(`document.getElementById('dayNavDate')?.classList.contains('open')`);
          check(`Задача E: попап "Дня" остаётся открытым после клика "‹" #${i} (реальный clickAt, не el.click())`, stillOpen === true, `open=${stillOpen}`);
        }
        const monthLabelAfter3 = await s.eval(`document.querySelector('#dayNavDate-slot .custom-date-month-label')?.textContent`);
        check('Задача E: подпись месяца сдвинулась на 3 месяца назад (точечное обновление сработало)', /Май 2026/.test(monthLabelAfter3 || ''), `label="${monthLabelAfter3}"`);

        // Вернуть попап обратно на текущий месяц (Май → Август, 3 клика "›"), затем
        // выбрать КОНКРЕТНО pastDate кликом по дню - заодно проверяет, что клик по дню
        // ДОЛЖЕН закрывать попап (осознанное поведение pickCustomDateDay, не трогать),
        // и детерминированно ставит "День" на нужную прошедшую дату для Задачи F ниже
        // (надёжнее, чем относительная навигация dayNavPrev x N от неизвестного состояния).
        for (let i = 0; i < 3; i++) {
          const nextBox = await s.eval(`(() => {
            const btn = document.querySelector('#dayNavDate-slot .custom-date-nav-btn[aria-label="Следующий месяц"]');
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`);
          await s.clickAt(nextBox.x, nextBox.y);
          await sleep(200);
        }
        const pastDayBox = await s.eval(`(() => {
          const btn = document.querySelector('#dayNavDate-slot .custom-date-cell[data-date="${pastDate}"]');
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        check('Попап вернулся на август - целевая прошедшая дата найдена в сетке', pastDayBox !== null, JSON.stringify(pastDayBox));
        await s.clickAt(pastDayBox.x, pastDayBox.y);
        await sleep(300);
        const closedAfterPick = await s.eval(`document.getElementById('dayNavDate')?.classList.contains('open')`);
        check('Задача E: клик по конкретному дню по-прежнему закрывает попап (pickCustomDateDay не тронут)', closedAfterPick === false, `open=${closedAfterPick}`);
        await s.screenshot('/tmp/okno53-taskE-day-popup-open.png');

        // ═══════════════════ Задача F - живая репродукция ДО фикса задокументирована в
        // истории (git show родительского коммита) - здесь проверка ПОСЛЕ фикса. ══════════
        const dayNowShown = await s.eval(`document.getElementById('dayNavDate')?.dataset.value`);
        check('Клик по дню в попапе действительно перевёл "День" на нужную прошедшую дату', dayNowShown === pastDate, `dayNavDate=${dayNowShown}, ожидали ${pastDate}`);

        // ".schedule-col-head .name" ловит и колонку hour-gutter ("--" слева, не мастер) -
        // фильтруем ТОЛЬКО настоящие колонки мастеров (.schedule-col), иначе индекс съезжает.
        const trackBox = await s.eval(`(() => {
          const cols = [...document.querySelectorAll('.schedule-col')];
          const col = cols.find((c) => c.querySelector('.schedule-col-head .name')?.textContent === 'QA Мастер EF');
          const track = col?.querySelector('.schedule-track');
          if (!track) return null;
          const r = track.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) };
        })()`);
        check('Найдена колонка QA Мастер EF в Дне на прошедшей дате', trackBox !== null, JSON.stringify(trackBox));

        const formHiddenBefore = await s.eval(`document.getElementById('walkinForm')?.hidden`);
        await s.clickAt(trackBox.x, trackBox.y);
        await sleep(400);
        const formHiddenAfter = await s.eval(`document.getElementById('walkinForm')?.hidden`);
        check(
          'Задача F: клик по пустому месту на ПРОШЕДШЕЙ дате открывает форму записи (раньше wireEmptySlotInteraction выходил рано, обработчик клика не вешался вообще)',
          formHiddenBefore === true && formHiddenAfter === false,
          `before=${formHiddenBefore}, after=${formHiddenAfter}`
        );

        const wfState = await s.eval(`({
          modeLabel: document.getElementById('wfModeLabel')?.textContent,
          dateTimeVisible: document.getElementById('wfDateTimeRow')?.hidden === false,
          dateValue: document.getElementById('wfDate-slot')?.querySelector('.custom-date')?.dataset.value,
        })`);
        check('Задача F: открылся режим "Новая запись на выбранное время" (интерактивный, как для будущих дат)', wfState.modeLabel === 'Новая запись на выбранное время', JSON.stringify(wfState));
        check('Задача F: блок даты/времени виден (интерактивный выбор, не просто "сейчас")', wfState.dateTimeVisible === true, JSON.stringify(wfState));
        check('Задача F: дата в виджете записи предзаполнена именно прошедшей датой клика', wfState.dateValue === pastDate, `dateValue=${wfState.dateValue}, ожидали ${pastDate}`);

        // ═══════════ Задача E, часть 2 - тот же попап-виджет внутри формы walk-in ═══════════
        await s.click('#wfDate-slot .custom-date-trigger');
        await sleep(300);
        const wfPopupOpen = await s.eval(`document.querySelector('#wfDate-slot .custom-date')?.classList.contains('open')`);
        check('Задача E (форма записи): попап даты открывается и там же', wfPopupOpen === true, `open=${wfPopupOpen}`);
        const wfNavBox = await s.eval(`(() => {
          const btn = document.querySelector('#wfDate-slot .custom-date-nav-btn[aria-label="Предыдущий месяц"]');
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        await s.clickAt(wfNavBox.x, wfNavBox.y);
        await sleep(250);
        const wfStillOpen = await s.eval(`document.querySelector('#wfDate-slot .custom-date')?.classList.contains('open')`);
        check('Задача E (форма записи): попап остаётся открытым после клика "‹" (виджет общий - фикс применён везде)', wfStillOpen === true, `open=${wfStillOpen}`);
        await s.clickAt(700, 30); // закрыть кликом вне
        await sleep(200);

        // Выбираем услугу и сохраняем запись на прошедшую дату - ключевой сценарий DoD Задачи F
        const serviceCheck = await s.eval(`(() => {
          const cb = document.querySelector('#wfServicePicker input[type=checkbox]');
          if (!cb) return 'NOT_FOUND';
          cb.click();
          return 'OK';
        })()`);
        check('Услуга выбрана в форме записи', serviceCheck === 'OK', serviceCheck);
        await s.type('#wfClientName', 'QA Клиент Задним Числом');
        await sleep(200);
        const submitDisabledBefore = await s.eval(`document.getElementById('wfSubmit')?.disabled`);
        check('Кнопка "Сохранить запись" разблокирована после выбора услуги', submitDisabledBefore === false, `disabled=${submitDisabledBefore}`);
        await s.click('#wfSubmit');
        await sleep(700);
        const wfResult = await s.eval(`({ hidden: document.getElementById('wfResult')?.hidden, text: document.getElementById('wfResult')?.textContent })`);
        check('Задача F: запись на прошедшую дату СОХРАНЯЕТСЯ (сервер принял, isStaff разрешает isPast)', wfResult.hidden === false && !/ошибк|нельзя записать в прошлое/i.test(wfResult.text || ''), JSON.stringify(wfResult));
        await s.screenshot('/tmp/okno53-taskF-past-booking-saved.png');

        const dbCheck = await db.query(`SELECT date, status FROM bookings WHERE master_id = 'o53ef-master1' AND date = $1`, [pastDate]);
        check('Задача F: бронь реально записана в БД на прошедшую дату со статусом planned', dbCheck.rows.length === 1 && dbCheck.rows[0].status === 'planned', JSON.stringify(dbCheck.rows));

        // ── Регрессия: обычная запись на БУДУЩУЮ дату по-прежнему работает как раньше ──
        const futureDate = daysFromToday(3);
        const futureRes = await fetch(`${apiUrl}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await login('o53ef-owner@test.local', pinOwner)).token}` },
          body: JSON.stringify({ masterId: 'o53ef-master1', serviceIds: ['strizhka'], date: futureDate, startTime: '11:00', clientName: 'QA Регресс Будущее', clientPhone: '', channel: 'admin' }),
        });
        check('Регрессия: запись на будущую дату по-прежнему сохраняется (200)', futureRes.status === 200, `status=${futureRes.status}`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
