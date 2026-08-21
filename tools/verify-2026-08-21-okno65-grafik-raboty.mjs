// Живой прогон Окна 65 (21.08.2026) - "Неделя" и "Месяц" в расписании переделаны под
// Yclients (два скриншота от заказчика): один компонент "график работы" (матрица
// мастера × даты) на оба вида + полоска дней недели под "Днём".
// Что доказываем в реальном браузере на реальном Postgres, а не в предположении:
//   1. Неделя - матрица: строка на КАЖДОГО мастера, ровно 7 колонок-дат
//   2. Месяц - та же матрица на все дни месяца, шире экрана (горизонтальный скролл)
//   3. колонка имён приморожена: после скролла вправо она всё ещё у левого края
//   4. в ячейке - реальные часы смены и загрузка этого мастера, выходной назван словом
//   5. клик по дате в шапке уводит в "День" на эту дату
//   6. клик по ячейке владельцем открывает правку графика ИМЕННО того мастера
//   7. сохранение выходного из этой модалки перерисовывает ячейку живьём
//   8. полоска дней: 7 кнопок, выбранный день отмечен, клик по другому дню меняет "День"
//   9. на телефоне полоска прижата к низу экрана (sticky), а не улетела вверх
//  10. мастер (crm-master.html) график не правит: ячейки не кнопки
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

// Понедельник текущей недели и пара дат внутри неё - фикстуры строятся ОТНОСИТЕЛЬНО дня
// запуска (verify-lib, daysFromToday), иначе назавтра прогон красится в FAIL без регресса
function mondayOfToday() {
  const d = new Date();
  const iso = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (iso - 1));
  return d.toISOString().slice(0, 10);
}
const MONDAY = mondayOfToday();
const TODAY = daysFromToday(0);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('w65-boss', 1, 'QA Владелец', 'owner', true, false, true, 'w65-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    // Два мастера, у обоих есть недельный график - иначе они не «bookable» и в матрице
    // им нечего показать (тот же урок, что ловило Окно 22/43)
    const masters = [
      ['w65-m1', 'QA Мастер Первый', 'w65-m1@alikhan.test'],
      ['w65-m2', 'QA Мастер Второй', 'w65-m2@alikhan.test'],
    ];
    for (const [id, name, email] of masters) {
      await db.query(
        `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
         VALUES ($1, 1, $2, 'master', true, true, true, $3, $4)`,
        [id, name, email, hashPin(masterPin)]
      );
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        await db.query(
          `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
           VALUES ($1, $2, true, '10:00', '20:00')`,
          [id, weekday]
        );
      }
      await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, 'strizhka', 2000, 60)`, [id]);
    }
    // Разовая правка часов на понедельник у первого мастера - в матрице это статус 'edit'
    await db.query(
      `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ('w65-m1', $1, '12:00', '18:00')`,
      [MONDAY]
    );
    // Одна живая запись сегодня - её минуты обязаны попасть в % загрузки ячейки
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, date, start_time, end_time, status, channel, walkin_name)
       VALUES ('w65-b1', 1, 'w65-m2', $1, '11:00', '12:00', 'planned', 'walkin', 'QA Клиент')`,
      [TODAY]
    );
    await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ('w65-b1', 'strizhka')`);

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        // ── Владелец ────────────────────────────────────────────────────────
        await s.setViewport(1440, 1000);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'w65-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // 8. Полоска дней в "Дне" (карточка открыта по умолчанию)
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#dayStrip .day-strip-day'))`)); i++) await sleep(200);
        const stripDays = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#dayStrip .day-strip-day')].map(b => b.dataset.stripDate))`));
        check('полоска дней: ровно 7 дней недели выбранного дня', stripDays.length === 7 && stripDays[0] === MONDAY, JSON.stringify(stripDays));
        const selected = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#dayStrip .day-strip-day.is-selected')].map(b => b.dataset.stripDate))`));
        check('полоска дней: отмечен ровно один день - сегодняшний', selected.length === 1 && selected[0] === TODAY, JSON.stringify(selected));

        // Клик по другому дню недели реально переключает "День"
        const otherDate = stripDays.find((d) => d !== TODAY);
        await s.eval(`document.querySelector('#dayStrip .day-strip-day[data-strip-date="${otherDate}"]')?.click()`);
        await sleep(900);
        const afterClick = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#dayStrip .day-strip-day.is-selected')].map(b => b.dataset.stripDate))`));
        check('полоска дней: клик по дню переводит "День" на него', afterClick.length === 1 && afterClick[0] === otherDate, JSON.stringify(afterClick));
        // Возвращаемся на сегодня, чтобы дальше матрица считалась от той же недели
        await s.eval(`document.querySelector('#dayStrip .day-strip-day[data-strip-date="${TODAY}"]')?.click()`);
        await sleep(900);

        // ── Неделя ─────────────────────────────────────────────────────────
        await s.eval(`document.querySelector('#scheduleCard-week summary')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#weekGrid .sm-cell'))`)); i++) await sleep(200);
        const weekShape = JSON.parse(await s.eval(`JSON.stringify({
          names: [...document.querySelectorAll('#weekGrid .sm-name-text')].map(e => e.textContent.trim()),
          heads: [...document.querySelectorAll('#weekGrid .sm-head')].map(e => e.dataset.openDay),
          cells: document.querySelectorAll('#weekGrid .sm-cell').length,
        })`));
        check('Неделя: строка на каждого мастера, а не один выбранный',
          weekShape.names.includes('QA Мастер Первый') && weekShape.names.includes('QA Мастер Второй'), JSON.stringify(weekShape.names));
        check('Неделя: ровно 7 колонок-дат, начиная с понедельника',
          weekShape.heads.length === 7 && weekShape.heads[0] === MONDAY, JSON.stringify(weekShape.heads));
        check('Неделя: ячеек = мастера × дни', weekShape.cells === weekShape.names.length * 7, `${weekShape.cells}`);

        // 4. Содержимое ячеек - реальные часы и загрузка
        const mondayCellM1 = norm(await s.eval(`document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m1"][data-date="${MONDAY}"]')?.innerText`));
        check('Неделя: разовая правка часов видна в ячейке как реальные 12:00-18:00', mondayCellM1.includes('12:00') && mondayCellM1.includes('18:00'), mondayCellM1);
        const editStatus = await s.eval(`document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m1"][data-date="${MONDAY}"]')?.dataset.status`);
        check('Неделя: день, разошедшийся со стандартным графиком, помечен статусом "правка"', editStatus === 'edit', String(editStatus));
        const todayCellM2 = norm(await s.eval(`document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m2"][data-date="${TODAY}"]')?.innerText`));
        check('Неделя: в ячейке мастера с записью стоит его собственная загрузка 10%', todayCellM2.includes('10%'), todayCellM2);
        const todayCellM1 = norm(await s.eval(`document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m1"][data-date="${TODAY}"]')?.innerText`));
        check('Неделя: у мастера без записей в тот же день честные 0%, а не общий процент команды', todayCellM1.includes('0%'), todayCellM1);

        // 5. Клик по дате в шапке уводит в "День"
        const targetDate = weekShape.heads[3];
        await s.eval(`document.querySelector('#weekGrid .sm-head[data-open-day="${targetDate}"]')?.click()`);
        await sleep(1200);
        const dayOpened = JSON.parse(await s.eval(`JSON.stringify({
          open: !!document.querySelector('#scheduleCard-day[open]'),
          strip: [...document.querySelectorAll('#dayStrip .day-strip-day.is-selected')].map(b => b.dataset.stripDate),
        })`));
        check('клик по дате в шапке графика открывает "День" на этой дате',
          dayOpened.open && dayOpened.strip[0] === targetDate, JSON.stringify(dayOpened));

        // 6-7. Клик по ячейке - правка графика именно того мастера, и живая перерисовка
        await s.eval(`document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m2"][data-date="${MONDAY}"]')?.click()`);
        for (let i = 0; i < 60 && JSON.parse(await s.eval(`JSON.stringify(!!document.getElementById('dayEditModal')?.hidden)`)); i++) await sleep(150);
        const modalTitle = norm(await s.eval(`document.getElementById('dayEditTitle')?.textContent`));
        check('модалка правки дня называет мастера своей строки, а не последнего выбранного',
          modalTitle.includes('QA Мастер Второй'), modalTitle);
        for (let i = 0; i < 60 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#dayEditModal .day-edit-card.is-loading'))`)); i++) await sleep(150);
        await s.eval(`(function(){
          const w = document.getElementById('dayEditWorking');
          w.checked = false; w.dispatchEvent(new Event('change'));
          document.getElementById('dayEditSave').click();
        })()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.getElementById('dayEditModal')?.hidden)`)); i++) await sleep(200);
        await sleep(1200);
        const afterSave = norm(await s.eval(`document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m2"][data-date="${MONDAY}"]')?.innerText`));
        check('сохранение выходного перерисовывает ячейку живьём, без перезагрузки страницы', afterSave.includes('Выходной'), afterSave);

        // ── Месяц ──────────────────────────────────────────────────────────
        await s.eval(`document.querySelector('#scheduleCard-month summary')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#monthGrid .sm-cell'))`)); i++) await sleep(200);
        const monthShape = JSON.parse(await s.eval(`JSON.stringify({
          heads: document.querySelectorAll('#monthGrid .sm-head').length,
          scrollW: document.getElementById('monthGrid').scrollWidth,
          clientW: document.getElementById('monthGrid').clientWidth,
          strip: [...document.querySelectorAll('#monthStrip .month-strip-btn')].map(b => b.textContent.trim()),
          active: document.querySelector('#monthStrip .month-strip-btn.is-active')?.textContent.trim(),
        })`));
        const daysInThisMonth = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 0)).getUTCDate();
        check('Месяц: колонка на каждый день месяца', monthShape.heads === daysInThisMonth, `${monthShape.heads} вместо ${daysInThisMonth}`);
        check('Месяц: матрица шире экрана - есть честный горизонтальный скролл',
          monthShape.scrollW > monthShape.clientW + 50, `${monthShape.scrollW} / ${monthShape.clientW}`);
        check('Месяц: лента месяцев на месте и активен текущий месяц',
          monthShape.strip.length >= 7 && Boolean(monthShape.active), JSON.stringify(monthShape));

        // 3. Приморожена ли колонка имён при скролле вправо
        await s.eval(`document.getElementById('monthGrid').scrollLeft = 600`);
        await sleep(400);
        const stickyProof = JSON.parse(await s.eval(`JSON.stringify((function(){
          const grid = document.getElementById('monthGrid');
          const name = grid.querySelector('.sm-name');
          return { nameLeft: Math.round(name.getBoundingClientRect().left), gridLeft: Math.round(grid.getBoundingClientRect().left), scrollLeft: grid.scrollLeft };
        })())`));
        check('колонка с именами приморожена при скролле вправо (не уезжает за край)',
          stickyProof.scrollLeft > 300 && Math.abs(stickyProof.nameLeft - stickyProof.gridLeft) < 6, JSON.stringify(stickyProof));

        // Прыжок по ленте месяцев
        const nextMonthLabel = monthShape.strip[monthShape.strip.indexOf(monthShape.active) + 1];
        await s.eval(`[...document.querySelectorAll('#monthStrip .month-strip-btn')].find(b => b.textContent.trim() === ${JSON.stringify(nextMonthLabel)})?.click()`);
        await sleep(1500);
        const afterJump = norm(await s.eval(`document.getElementById('scheduleAnchor-month')?.textContent`));
        check('лента месяцев: тап по месяцу переводит график на него', afterJump.length > 0 && !afterJump.includes(String(new Date().getDate())), afterJump);

        // Регрессия, найденная глазами на снимке 21.08.2026: подпись карточки говорила
        // «Месяц · Август», а в сетке под ней стоял сентябрь - вид не перечитывался при
        // смене общей даты. Возвращаемся на сегодняшний день полоской и требуем, чтобы
        // подпись и ПЕРВАЯ колонка сетки называли один и тот же месяц.
        await s.eval(`(function(){ const d = document.getElementById('scheduleCard-day'); if (d && !d.open) d.querySelector('summary').click(); })()`);
        await sleep(700);
        await s.eval(`document.querySelector('#dayStrip .day-strip-day[data-strip-date="${TODAY}"]')?.click()`);
        await sleep(2000);
        const monthSync = JSON.parse(await s.eval(`JSON.stringify({
          anchor: document.getElementById('scheduleAnchor-month')?.textContent?.trim(),
          firstColumn: document.querySelector('#monthGrid .sm-head')?.dataset.openDay,
          stripActive: document.querySelector('#monthStrip .month-strip-btn.is-active')?.textContent.trim(),
        })`));
        check('подпись Месяца, лента и сама сетка показывают один месяц после смены дня',
          monthSync.firstColumn?.slice(0, 7) === TODAY.slice(0, 7), JSON.stringify(monthSync));

        // Замер настоящих цветов "Дня" и матрицы - подгонять оформление на глаз по
        // памяти нельзя, сверяем computed-значения на одной и той же странице
        // Ставим "День" на понедельник - там у второго мастера выходной, иначе дорожку
        // .day-off не с чем сравнивать (в прошлом замере она пришла null)
        await s.eval(`document.querySelector('#dayStrip .day-strip-day[data-strip-date="${MONDAY}"]')?.click()`);
        await sleep(1500);
        const palette = JSON.parse(await s.eval(`JSON.stringify((function(){
          const pick = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 90), border: cs.borderTopColor, radius: cs.borderTopLeftRadius }; };
          return {
            dayTrack: pick(document.querySelector('.panel-sp-day .schedule-track:not(.day-off)')),
            dayOff: pick(document.querySelector('.panel-sp-day .schedule-track.day-off')),
            cellWork: pick(document.querySelector('#weekGrid .sm-cell:not(.sm-cell--off)')),
            cellOff: pick(document.querySelector('#weekGrid .sm-cell--off')),
          };
        })())`));
        console.log('  цвета Дня и матрицы:', JSON.stringify(palette, null, 1));
        console.log('  фон вокруг матрицы:', await s.eval(`JSON.stringify((function(){
          const grid = document.getElementById('weekGrid');
          const chain = [];
          let el = grid;
          while (el && chain.length < 6) { const bg = getComputedStyle(el).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)') chain.push({ el: el.className || el.tagName, bg }); el = el.parentElement; }
          return { name: getComputedStyle(grid.querySelector('.sm-name')).backgroundColor, chain };
        })())`));
        // Жалоба Влада 21.08.2026: «выходные не такие серые, как в Дне, и фон карточек
        // другой». Сверяем не на глаз, а вычисленным цветом на одной странице
        check('фон рабочей ячейки графика совпадает с дорожкой "Дня"',
          palette.cellWork?.bg === palette.dayTrack?.bg, `${palette.cellWork?.bg} vs ${palette.dayTrack?.bg}`);
        check('выходной в графике окрашен ровно как выходной в "Дне"',
          palette.cellOff?.bg === palette.dayOff?.bg && palette.cellOff?.img === palette.dayOff?.img,
          `${palette.cellOff?.bg} vs ${palette.dayOff?.bg}`);

        // Крупный план занятой ячейки - плашка загрузки должна ЧИТАТЬСЯ, а не быть
        // золотым овалом (проверка глазами, автоматика такое не ловит)
        const busyBox = JSON.parse(await s.eval(`JSON.stringify((function(){
          const cell = document.querySelector('#weekGrid .sm-cell[data-master-id="w65-m2"][data-date="${TODAY}"]');
          const load = cell.querySelector('.sm-cell-load');
          const r = cell.getBoundingClientRect();
          const lr = load.getBoundingClientRect();
          const cs = getComputedStyle(load);
          // clip в Page.captureScreenshot - координаты ДОКУМЕНТА, не вьюпорта: без
          // прибавки скролла кадр уезжает в пустое место (проверено 21.08.2026)
          return { text: load.innerText, cellW: Math.round(r.width), loadW: Math.round(lr.width), loadH: Math.round(lr.height), color: cs.color, bg: cs.backgroundColor, x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY) };
        })())`));
        console.log('  крупный план ячейки:', JSON.stringify(busyBox));
        await s.send('Page.captureScreenshot', { format: 'png', clip: { x: busyBox.x - 10, y: busyBox.y - 30, width: 260, height: 130, scale: 4 } })
          .then(async (res) => { const fs = await import('node:fs'); fs.writeFileSync('/tmp/okno65-cell-zoom.png', Buffer.from(res.data, 'base64')); });

        // Снимки для глаз (проверка автоматикой - не замена живому взгляду)
        await s.eval(`document.getElementById('scheduleCard-month')?.scrollIntoView({block:'start'})`);
        await sleep(500);
        await s.screenshot('/tmp/okno65-owner-desktop-month.png');
        await s.eval(`document.getElementById('scheduleCard-week')?.scrollIntoView({block:'start'})`);
        await sleep(500);
        await s.screenshot('/tmp/okno65-owner-desktop-week.png');

        // ── Телефон ────────────────────────────────────────────────────────
        await s.setViewport(390, 844, true);
        await sleep(600);
        // Карточка "День" должна быть РАСКРЫТА - клик по summary тут переключал бы её
        // вслепую (в этот момент она уже открыта после перехода из графика)
        await s.eval(`(function(){ const d = document.getElementById('scheduleCard-day'); if (d && !d.open) d.querySelector('summary').click(); })()`);
        await sleep(700);
        await s.eval(`document.getElementById('dayStrip')?.scrollIntoView({block:'center'})`);
        await sleep(500);
        const mobileStrip = JSON.parse(await s.eval(`JSON.stringify((function(){
          const el = document.getElementById('dayStrip');
          const r = el.getBoundingClientRect();
          return { bottom: Math.round(r.bottom), vh: Math.round(window.visualViewport ? window.visualViewport.height : window.innerHeight), pos: getComputedStyle(el).position, docked: el.classList.contains('is-docked') };
        })())`));
        check('на телефоне полоска дней пристыкована к низу экрана, а не уехала вверх',
          mobileStrip.docked && mobileStrip.pos === 'fixed' && Math.abs(mobileStrip.bottom - mobileStrip.vh) < 40, JSON.stringify(mobileStrip));
        // Полоска не должна висеть там, где "Дня" на экране нет: свернули карточку - убралась
        await s.eval(`document.querySelector('#scheduleCard-day summary')?.click()`);
        await sleep(500);
        const afterCollapse = JSON.parse(await s.eval(`JSON.stringify({ open: !!document.querySelector('#scheduleCard-day[open]'), docked: document.getElementById('dayStrip').classList.contains('is-docked'), bodyPad: document.body.classList.contains('day-strip-docked') })`));
        check('полоска убирается, когда карточку "День" свернули', !afterCollapse.docked && !afterCollapse.bodyPad, JSON.stringify(afterCollapse));
        await s.eval(`document.querySelector('#scheduleCard-day summary')?.click()`);
        await sleep(700);
        const mobileFit = JSON.parse(await s.eval(`JSON.stringify({ doc: document.documentElement.scrollWidth, vw: Math.round(window.visualViewport ? window.visualViewport.width : window.innerWidth) })`));
        check('на телефоне страница не разъезжается вширь из-за матрицы',
          mobileFit.doc <= mobileFit.vw + 2, JSON.stringify(mobileFit));
        await s.screenshot('/tmp/okno65-owner-mobile-day.png');
        // Неделя на телефоне: сворачиваем "День", чтобы график занял экран целиком
        await s.eval(`(function(){ const d = document.getElementById('scheduleCard-day'); if (d && d.open) d.querySelector('summary').click(); })()`);
        await sleep(400);
        await s.eval(`(function(){ const w = document.getElementById('scheduleCard-week'); if (w && !w.open) w.querySelector('summary').click(); })()`);
        await sleep(1800);
        await s.eval(`document.getElementById('scheduleCard-week')?.scrollIntoView({block:'start'})`);
        await sleep(500);
        await s.screenshot('/tmp/okno65-owner-mobile-week.png');
        // Часы обязаны помещаться целиком: обрезанное "10:00–20:0(" - враньё про смену
        const hoursFit = JSON.parse(await s.eval(`JSON.stringify((function(){
          const el = document.querySelector('#weekGrid .sm-cell-hours');
          return { text: el.innerText, scrollW: el.scrollWidth, clientW: el.clientWidth };
        })())`));
        check('на телефоне часы смены помещаются в ячейку целиком',
          hoursFit.scrollW <= hoursFit.clientW + 1, JSON.stringify(hoursFit));

        // ── Мастер ─────────────────────────────────────────────────────────
        await s.setViewport(1440, 1000);
        await s.navigate(`${siteUrl}/crm-master.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'w65-m1@alikhan.test';
          document.getElementById('loginPin').value = '${masterPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);
        await s.eval(`document.getElementById('sp-week')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#weekGrid .sm-cell'))`)); i++) await sleep(200);
        const masterView = JSON.parse(await s.eval(`JSON.stringify({
          rows: [...document.querySelectorAll('#weekGrid .sm-name-text')].map(e => e.textContent.trim()),
          buttons: document.querySelectorAll('#weekGrid button.sm-cell').length,
          cells: document.querySelectorAll('#weekGrid .sm-cell').length,
        })`));
        check('мастер видит только свою строку графика', masterView.rows.length === 1 && masterView.rows[0] === 'QA Мастер Первый', JSON.stringify(masterView.rows));
        check('мастер график не правит: ячейки не кнопки', masterView.buttons === 0 && masterView.cells === 7, JSON.stringify(masterView));
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err);
}

const ok = summary() && !crashed;
console.log(ok ? '\nВЕРДИКТ: PASSED' : '\nВЕРДИКТ: FAILED');
process.exit(ok ? 0 : 1);
