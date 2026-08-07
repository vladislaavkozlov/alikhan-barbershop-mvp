// Живая проверка Окна 43 - Расписание · День, time-grid (ПРОМПТ-ОКНО-43-РАСПИСАНИЕ-
// ДЕНЬ.md) на реальном Postgres и в реальном браузере. DoD промпта: time-grid
// рендерится по реальным записям (позиционирование по времени УЖЕ было в проекте -
// это окно добавляет 3 реальных пробела: полосу слева по статусу, линию "сейчас" и
// клик-по-пустому-слоту), линия "сейчас" на верном месте, клик по пустому слоту
// открывает форму с верным предзаполнением, мастер без графика показывает текст
// вместо колонки, регрессия Недели/Месяца/Года не задета. Тот же приём
// withEphemeralServer/withStaticServer/withBrowser, что и Окна 41/42.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Та же шкала, что assets/crm-calendar.js (DAY_START_MIN/DAY_END_MIN/PX_PER_MIN).
const DAY_START_MIN = 600;
const DAY_END_MIN = 1200;
const PX_PER_MIN = 64 / 60;

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const today = daysFromToday(0);

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o43-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o43-owner@test.local', $1),
       ('o43-master1', NULL, 'QA Мастер С Графиком', 'master', true, true, true, 'o43-master1@test.local', $2),
       ('o43-master2', NULL, 'QA Мастер Без Графика', 'master', true, true, true, 'o43-master2@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    // master1 - полный рабочий график; master2 намеренно без единой строки (тест
    // текста "Нет графика" вместо колонки). Сидовые master-1/2/3 (миграция 002)
    // тоже получают график - иначе они попали бы в колонки без графика и испортили
    // точное сравнение количества/содержимого колонок.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('o43-master1'), ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o43-master1', 'strizhka', 2000, 40)`
    );

    // Три брони master1 на сегодня - по одной на каждый статус, для проверки полосы
    // слева (планова "зелёная", завершена "серая", не пришёл "красная").
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o43-b-planned', 1, 'o43-master1', 'strizhka', NULL, $1, '11:00', '11:40', 'planned', 'admin'),
       ('o43-b-done', 1, 'o43-master1', 'strizhka', NULL, $1, '13:00', '13:40', 'done', 'admin'),
       ('o43-b-noshow', 1, 'o43-master1', 'strizhka', NULL, $1, '15:00', '15:40', 'no_show', 'admin')`,
      [today]
    );
    await db.query(
      `INSERT INTO booking_services (booking_id, service_id) VALUES
       ('o43-b-planned', 'strizhka'), ('o43-b-done', 'strizhka'), ('o43-b-noshow', 'strizhka')`
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
    await login('o43-owner@test.local', pinOwner);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);

        await s.type('#loginEmail', 'o43-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300); // login + renderLiveProof + /schedule×2 + /bookings + renderDayCalendar

        // ── Time-grid: колонки на мастера, позиционирование по реальному времени ──
        // 5 = 3 сидовых мастера (Алиовсад/Мамедхан/Елизавета, миграция 002) + 2 фикстуры
        // этого прогона (master1 с графиком, master2 без) - владелец видит вообще всех.
        const colCount = await s.eval(`document.querySelectorAll('.panel-sp-day .schedule-grid > .schedule-col').length`);
        check('Дневной вид рендерит колонку на каждого мастера (5: 3 сидовых + 2 фикстуры)', colCount === 5, `колонок: ${colCount}`);
        const fixtureNames = await s.eval(`[...document.querySelectorAll('.panel-sp-day .schedule-grid > .schedule-col .name')].map((n) => n.textContent)`);
        check('Обе фикстуры этого прогона видны как отдельные колонки', fixtureNames.includes('QA Мастер С Графиком') && fixtureNames.includes('QA Мастер Без Графика'), `имена: ${JSON.stringify(fixtureNames)}`);

        const plannedTop = await s.eval(`document.querySelector('[data-id="o43-b-planned"]')?.style.top`);
        check('Бронь 11:00 спозиционирована по реальному времени (top ≠ 0, не список подряд)', plannedTop === '64px', `top=${plannedTop}`); // (11:00-10:00)*64/60 = 64px

        // ── Полоса слева по статусу (зелёная/серая/красная) ──────────────────
        const stripePlanned = await s.eval(`document.querySelector('[data-id="o43-b-planned"]')?.classList.contains('appt--status-planned')`);
        const stripeDone = await s.eval(`document.querySelector('[data-id="o43-b-done"]')?.classList.contains('appt--status-done')`);
        const stripeNoshow = await s.eval(`document.querySelector('[data-id="o43-b-noshow"]')?.classList.contains('appt--status-noshow')`);
        check('Планова запись получает полосу "подтверждена" (зелёная)', stripePlanned === true, `planned=${stripePlanned}`);
        check('Завершённая запись получает полосу "завершена" (серая)', stripeDone === true, `done=${stripeDone}`);
        check('Неявка получает полосу "не пришёл" (красная)', stripeNoshow === true, `noshow=${stripeNoshow}`);

        // ── Мастер без графика - текст вместо колонки со слотами ─────────────
        const noScheduleText = await s.eval(`document.querySelector('.schedule-track.no-schedule .day-off-label')?.textContent`);
        check('Мастер без графика показывает текст "Нет графика" вместо колонки со слотами', (noScheduleText || '').includes('Нет графика'), `текст: "${noScheduleText}"`);
        const noScheduleHasNoAppts = await s.eval(`document.querySelector('.schedule-track.no-schedule .appt') === null`);
        check('У колонки "без графика" нет ни записей, ни пустых слотов - только текст', noScheduleHasNoAppts === true, `чисто=${noScheduleHasNoAppts}`);

        await s.screenshot('/tmp/okno43-day-timegrid.png');

        // ── Линия "сейчас" ────────────────────────────────────────────────────
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        const expectInRange = nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN;
        const lineState = await s.eval(`(() => {
          const line = document.querySelector('.now-line');
          if (!line) return null;
          return { hidden: line.hidden, top: line.style.top };
        })()`);
        if (expectInRange) {
          const expectedTop = Math.round((nowMin - DAY_START_MIN) * PX_PER_MIN);
          const actualTop = Number(String(lineState?.top || '0').replace('px', ''));
          check('Линия "сейчас" видна (текущее время внутри 10:00-20:00)', lineState?.hidden === false, JSON.stringify(lineState));
          check('Линия "сейчас" на верном месте относительно текущего времени (±3px)', Math.abs(actualTop - expectedTop) <= 3, `ожидали ~${expectedTop}px, получили ${lineState?.top}`);
        } else {
          check('Линия "сейчас" скрыта вне рабочего окна 10:00-20:00 (прогон вне часов работы)', lineState?.hidden === true, JSON.stringify(lineState));
        }

        // ── Клик по пустому слоту открывает форму с предзаполнением ──────────
        // Синтетический MouseEvent с явным clientY (el.click() из cdp.mjs даёт
        // clientY=0 - не годится для проверки позиционного клика), таргет - трек
        // ИМЕННО master1 фикстуры (найден по подписи колонки, не tracks[0] - сидовые
        // мастера идут раньше по алфавитному id "master-1" < "o43-master1"), время
        // цели - 17:00.
        const targetTime = '17:00';
        const clickResult = await s.eval(`(() => {
          const cols = [...document.querySelectorAll('.panel-sp-day .schedule-grid > .schedule-col')];
          const col = cols.find((c) => c.querySelector('.name')?.textContent === 'QA Мастер С Графиком');
          const track = col?.querySelector('.schedule-track');
          if (!track) return 'NO_TRACK';
          const rect = track.getBoundingClientRect();
          const clientY = rect.top + (17*60 - 600) * (64/60); // 17:00 → px по той же формуле, что positionStyle
          const clientX = rect.left + rect.width / 2;
          const ev = new MouseEvent('click', { bubbles: true, clientX, clientY });
          track.dispatchEvent(ev);
          return 'OK';
        })()`);
        check('Синтетический клик по пустому месту трека диспатчится без ошибок', clickResult === 'OK', `результат: ${clickResult}`);
        await sleep(200);

        const formState = await s.eval(`({
          formHidden: document.getElementById('walkinForm')?.hidden,
          modeLabel: document.getElementById('wfModeLabel')?.textContent,
          masterName: document.getElementById('wfMasterName')?.textContent,
          dateTimeRowHidden: document.getElementById('wfDateTimeRow')?.hidden,
          date: document.getElementById('wfDateValue')?.dataset.value,
          time: document.getElementById('wfTimeValue')?.dataset.value,
        })`);
        check('Клик по пустому слоту открывает форму записи (не скрыта)', formState.formHidden === false, JSON.stringify(formState));
        check('Форма подписана "Новая запись на выбранное время" (не "Повторная запись")', formState.modeLabel === 'Новая запись на выбранное время', `label="${formState.modeLabel}"`);
        check('Мастер предзаполнен верно (QA Мастер С Графиком)', formState.masterName === 'QA Мастер С Графиком', `master="${formState.masterName}"`);
        check('Дата предзаполнена сегодняшним днём', formState.date === today, `date=${formState.date}, ожидали ${today}`);
        check('Время предзаполнено временем клика (17:00, снэп до 15 мин)', formState.time === targetTime, `time=${formState.time}, ожидали ${targetTime}`);

        // ── Клик по реальной записи по-прежнему открывает её (регрессия, не эта задача) ──
        await s.click('#wfCancel');
        await sleep(150);
        await s.click('[data-id="o43-b-planned"]');
        await sleep(150);
        const bookingDetailOpen = await s.eval(`document.getElementById('bd-now')?.textContent`);
        check('Клик по реальной записи по-прежнему открывает карточку редактирования (регрессия)', (bookingDetailOpen || '').includes('11:00'), `текст: "${bookingDetailOpen}"`);

        // ── Регрессия: Неделя/Месяц/Год того же раздела не задеты ────────────
        await s.click('label[for="sp-week"]');
        await sleep(300);
        const weekHasContent = await s.eval(`document.getElementById('weekGrid')?.children.length > 0`);
        check('Регрессия: вид "Неделя" по-прежнему рендерится', weekHasContent === true, `weekGrid children>0: ${weekHasContent}`);

        await s.click('label[for="sp-month"]');
        await sleep(300);
        const monthHasContent = await s.eval(`document.getElementById('monthGrid')?.children.length > 0`);
        check('Регрессия: вид "Месяц" по-прежнему рендерится', monthHasContent === true, `monthGrid children>0: ${monthHasContent}`);

        await s.click('label[for="sp-year"]');
        await sleep(300);
        const yearHasContent = await s.eval(`document.getElementById('yearGrid')?.children.length > 0`);
        check('Регрессия: вид "Год" по-прежнему рендерится', yearHasContent === true, `yearGrid children>0: ${yearHasContent}`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
