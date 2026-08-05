// Проверка Окна 21 - календарь клиента красит недоступные даты серым ДО клика,
// используя GET /schedule-availability.
//
// Задача E промпта Окна 29 (05.08.2026) - переписано на автономность (было
// tools/verify-2026-08-04-okno21-realnaya-dostupnost.mjs, аудит 05.08 нашёл 2 дыры):
//   1. Требовал заранее заготовленных QA-фикстур недоступности (master-1 закрыт на
//      конкретные литералы дат 20/21/22/24/25/26.08.2026) - на пустой базе или в
//      чужой сессии фикстур нет вовсе, 4/4 "серая дата" FAIL, хотя механизм цел.
//   2. Требовал ВНЕШНЕ поднятого сервера на общей alikhan_test.
// Теперь весь стенд свой (tools/verify-lib.mjs), фикстуры - даты ОТНОСИТЕЛЬНО дня
// запуска (daysFromToday), не литералы календаря - сеются и проверяются в одном
// прогоне, назавтра не протухают.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();

async function readDayStates(s) {
  return s.eval(`Array.from(document.querySelectorAll('#cal-grid .cal-day')).map((b) => ({
    iso: b.dataset.iso,
    disabled: b.disabled,
  }))`);
}

// Смещения от сегодняшнего дня (не литералы календаря) - все внутри текущего
// видимого месяца календаря (до +16 дней), чтобы прогон не зависел от навигации
// по месяцам виджета.
const FULLY_BOOKED = daysFromToday(10);      // весь день занят одной бронью 10:00-20:00
const TOO_SHORT_REMAINDER = daysFromToday(11); // свободно только 30 мин, услуга 60 мин не влезает
const OTHER_MASTER_DAYOFF = daysFromToday(12); // выходной у ДРУГОГО мастера - master-1 работает
const ENOUGH_REMAINDER = daysFromToday(14);   // свободно 2 часа, услуга 60 мин влезает
const EMPTY_DAY = daysFromToday(15);          // пустой день, стандартный график
const EXPLICIT_DAYOFF = daysFromToday(16);    // разовая правка "выходной весь день"

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  // master-1: обычный рабочий график каждый день (нужен и для видимости в списке
  // выбора, и для бронируемости - Задача C промпта Окна 29).
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'master-1', d, true, '10:00', '20:00' FROM generate_series(1,7) d`
  );

  async function fullDayShift(masterId, date, breakStart, breakEnd) {
    const shift = await db.query(
      `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, '10:00', '20:00') RETURNING id`,
      [masterId, date]
    );
    if (breakStart) {
      await db.query(`INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)`, [shift.rows[0].id, breakStart, breakEnd]);
    }
  }

  // FULLY_BOOKED: одна бронь на весь рабочий день.
  await db.query(
    `INSERT INTO bookings (id, master_id, date, start_time, end_time, status, channel)
     VALUES ('verify-okno21-fb', 'master-1', $1, '10:00', '20:00', 'planned', 'client')`,
    [FULLY_BOOKED]
  );
  // TOO_SHORT_REMAINDER: занято 10:00-19:30, свободно только 30 мин.
  await db.query(
    `INSERT INTO bookings (id, master_id, date, start_time, end_time, status, channel)
     VALUES ('verify-okno21-ts', 'master-1', $1, '10:00', '19:30', 'planned', 'client')`,
    [TOO_SHORT_REMAINDER]
  );
  // OTHER_MASTER_DAYOFF: выходной у master-2 (master-1 в этот день работает штатно).
  // master-2 своего стандартного графика не имеет - разовая правка ставится напрямую.
  await fullDayShift('master-2', OTHER_MASTER_DAYOFF, '10:00', '20:00');
  // ENOUGH_REMAINDER: занято 10:00-18:00, свободно 2 часа.
  await db.query(
    `INSERT INTO bookings (id, master_id, date, start_time, end_time, status, channel)
     VALUES ('verify-okno21-en', 'master-1', $1, '10:00', '18:00', 'planned', 'client')`,
    [ENOUGH_REMAINDER]
  );
  // EMPTY_DAY: без записей и без правок - стандартный график как есть.
  // EXPLICIT_DAYOFF: разовая правка "выходной весь день" у master-1.
  await fullDayShift('master-1', EXPLICIT_DAYOFF, '10:00', '20:00');

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.navigate(`${base}/index.html`);
      await s.setViewport(390, 900, true);
      await new Promise((r) => setTimeout(r, 400));

      // master-1 = Алиовсад, первая карточка в #master-grid.
      await s.click('#master-grid .option-card');
      await new Promise((r) => setTimeout(r, 300)); // ждём GET /master-services + renderServiceOptions

      const clickedService = await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#service-grid .option-card'));
        const target = btns.find((b) => b.querySelector('.opt-name')?.textContent === 'Тонировка седых волос');
        if (!target) return false;
        target.click();
        return true;
      })()`);
      check('карточка услуги "Тонировка седых волос" найдена и кликнута', clickedService === true);

      await new Promise((r) => setTimeout(r, 500)); // refreshCalendarAvailability - реальный сетевой запрос

      await s.click('#date-toggle');
      await new Promise((r) => setTimeout(r, 150));

      const dayStates = await readDayStates(s);
      const byIso = new Map(dayStates.map((d) => [d.iso, d]));

      for (const [label, iso] of [
        ['день полностью забронирован', FULLY_BOOKED],
        ['остаток окна короче услуги (30мин < 60)', TOO_SHORT_REMAINDER],
        ['разовая правка «выходной весь день»', EXPLICIT_DAYOFF],
      ]) {
        const state = byIso.get(iso);
        check(`${iso} серая ДО клика (${label})`, state ? state.disabled === true : false);
      }
      for (const [label, iso] of [
        ['выходной у ДРУГОГО мастера, master-1 работает', OTHER_MASTER_DAYOFF],
        ['остаток 2ч >= 60мин', ENOUGH_REMAINDER],
        ['пустой день', EMPTY_DAY],
      ]) {
        const state = byIso.get(iso);
        check(`${iso} НЕ серая (${label})`, state ? state.disabled === false : false);
      }

      // Клик по серой дате не должен ничего выбирать.
      const beforeLabel = await s.eval(`document.getElementById('date-toggle-label').textContent`);
      await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
        const target = btns.find((b) => b.dataset.iso === '${EXPLICIT_DAYOFF}');
        if (target) target.click();
      })()`);
      await new Promise((r) => setTimeout(r, 100));
      const afterLabel = await s.eval(`document.getElementById('date-toggle-label').textContent`);
      check('клик по серой (реально недоступной) дате не меняет выбор', beforeLabel === afterLabel);

      // ── Регрессия: обычная доступная дата бронируется штатно ──────────────
      await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
        const target = btns.find((b) => b.dataset.iso === '${EMPTY_DAY}');
        if (target) target.click();
      })()`);
      await new Promise((r) => setTimeout(r, 500)); // refreshSlots - реальный сетевой запрос

      const slotButtons = await s.eval(`Array.from(document.querySelectorAll('#slots-wrap .slot-btn')).map((b) => b.textContent)`);
      check('на доступную дату сервер вернул непустой список слотов', Array.isArray(slotButtons) && slotButtons.length > 0);

      if (Array.isArray(slotButtons) && slotButtons.length > 0) {
        await s.click('#slots-wrap .slot-btn');
        await new Promise((r) => setTimeout(r, 100));
        const submitDisabled = await s.eval(`document.getElementById('f-submit').disabled`);
        const slotSelected = await s.eval(`document.querySelector('#slots-wrap .slot-btn.selected') !== null`);
        check('слот на доступную дату кликается и визуально выбирается (обычный сценарий не сломан)', slotSelected === true);
        check('кнопка подтверждения остаётся заблокированной без согласия на 152-ФЗ (не регрессия, штатное поведение)', submitDisabled === true);
      }
    });
  });
});
} catch (err) {
  crashed = true;
  console.error('Прогон упал с ошибкой:', err);
}
process.exit(summary() && !crashed ? 0 : 1);
