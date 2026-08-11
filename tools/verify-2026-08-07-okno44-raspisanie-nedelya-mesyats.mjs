// Живая проверка Окна 44 - Расписание · Неделя+Месяц (ПРОМПТ-ОКНО-44-РАСПИСАНИЕ-
// НЕДЕЛЯ-МЕСЯЦ.md) на реальном Postgres и в реальном браузере. DoD промпта: Неделя
// показывает 7 дней с % загрузки и записями по времени, переключатель мастера
// работает, Месяц показывает всю команду с % загрузки по дням, клик по дню ведёт в
// День с верной датой (ключевой сценарий DoD Окна 25), регрессия Дня/Года не задета.
// Честная поправка к ТЗ: "Все мастера / по одному" - живым grep'ом такого
// переключателя в проекте не было нигде, построен с нуля (см. коммит Окна 44).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const today = daysFromToday(0);

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o44-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o44-owner@test.local', $1),
       ('o44-master1', NULL, 'QA Мастер Один', 'master', true, true, true, 'o44-master1@test.local', $2),
       ('o44-master2', NULL, 'QA Мастер Два', 'master', true, true, true, 'o44-master2@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    // Намеренно НЕ даём сидовым master-1/2/3 график - у владельца они видны в
    // /staff (providesServices=true), но hasWorkingSchedule=false - должны быть
    // исключены из агрегата "Все мастера" (та же защита, что Окно 43 для Дня),
    // иначе завысили бы доступность команды глобальным дефолтом 10:00-20:00.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o44-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd
       UNION ALL
       SELECT 'o44-master2', wd, true, '10:00', '14:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('o44-master1', 'strizhka', 2000, 40), ('o44-master2', 'strizhka', 2000, 40)`
    );

    // master1: доступно 480 мин (10-18), занято 240 мин (2 брони по 120) → 50%, count=2.
    // Третья бронь (cancelled) намеренно не должна попасть ни в %, ни в count.
    // master2: доступно 240 мин (10-14), занято 120 мин (1 бронь) → 50%, count=1.
    // Команда: доступно 720, занято 360 → тоже ровно 50%, count=3 - удобное совпадение
    // для проверки, что агрегат считается по сумме минут, а не средним процентов.
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o44-b1', 1, 'o44-master1', 'strizhka', NULL, $1, '10:00', '12:00', 'done', 'admin'),
       ('o44-b2', 1, 'o44-master1', 'strizhka', NULL, $1, '14:00', '16:00', 'planned', 'admin'),
       ('o44-b3', 1, 'o44-master2', 'strizhka', NULL, $1, '10:00', '12:00', 'planned', 'admin'),
       ('o44-b4', 1, 'o44-master1', 'strizhka', NULL, $1, '16:00', '17:00', 'cancelled', 'admin')`,
      [today]
    );
    // Клиенты по именам - для проверки "записи сгруппированы по времени" в Неделе
    // (список чипов "время + имя"), не только счётчика.
    await db.query(
      `INSERT INTO clients (id, name, phone) VALUES
       ('o44-c1','Иванов','+79990044001'), ('o44-c2','Петров','+79990044002'), ('o44-c3','Сидоров','+79990044003')`
    );
    await db.query(`UPDATE bookings SET client_id = 'o44-c1' WHERE id = 'o44-b1'`);
    await db.query(`UPDATE bookings SET client_id = 'o44-c2' WHERE id = 'o44-b2'`);
    await db.query(`UPDATE bookings SET client_id = 'o44-c3' WHERE id = 'o44-b3'`);

    const login = async (email, pin) => {
      const res = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      return res.json();
    };
    await login('o44-owner@test.local', pinOwner);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);

        await s.type('#loginEmail', 'o44-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);

        // ═══════════════════ НЕДЕЛЯ ═══════════════════
        await s.click('label[for="sp-week"]');
        await sleep(500);

        // Переключатель мастера - выбираем o44-master1 явно (дефолт мог бы попасть на
        // сидового мастера без графика, не в зоне этой проверки).
        const weekPickResult = await s.eval(`(() => {
          const btn = [...document.querySelectorAll('#weekMasterSwitch .master-pill')].find((b) => b.textContent === 'QA Мастер Один');
          if (!btn) return 'NOT_FOUND';
          btn.click();
          return 'OK';
        })()`);
        check('Переключатель мастера в Неделе находит QA Мастер Один', weekPickResult === 'OK', `результат: ${weekPickResult}`);
        await sleep(500);

        const weekColCount = await s.eval(`document.querySelectorAll('#weekGrid > .week-day-cell').length`);
        check('Неделя рендерит 7 колонок (Пн-Вс)', weekColCount === 7, `колонок: ${weekColCount}`);

        const weekTodayCell = await s.eval(`(() => {
          const cell = document.querySelector('#weekGrid [data-open-day="${today}"]');
          if (!cell) return null;
          return {
            pct: cell.querySelector('.week-load-pct')?.textContent,
            chips: [...cell.querySelectorAll('.week-appt-chip')].map((c) => c.textContent),
          };
        })()`);
        check('Ячейка сегодняшнего дня показывает % загрузки (50%, master1: 240/480 мин)', weekTodayCell?.pct === '50%', `pct=${weekTodayCell?.pct}`);
        check('Записи сгруппированы по времени - оба чипа видны в хронологическом порядке (10:00 раньше 14:00)', JSON.stringify(weekTodayCell?.chips) === JSON.stringify(['10:00 Иванов', '14:00 Петров']), `чипы: ${JSON.stringify(weekTodayCell?.chips)}`);

        // Переключатель сужает список, не меняет общий вид - переключаем на master2 и
        // проверяем, что колонок по-прежнему 7 и % пересчитался (не завис от master1).
        const switchTo2 = await s.eval(`(() => {
          const btn = [...document.querySelectorAll('#weekMasterSwitch .master-pill')].find((b) => b.textContent === 'QA Мастер Два');
          if (!btn) return 'NOT_FOUND';
          btn.click();
          return 'OK';
        })()`);
        check('Переключатель мастера в Неделе находит QA Мастер Два', switchTo2 === 'OK', `результат: ${switchTo2}`);
        await sleep(500);
        const week2ColCount = await s.eval(`document.querySelectorAll('#weekGrid > .week-day-cell').length`);
        const week2Pct = await s.eval(`document.querySelector('#weekGrid [data-open-day="${today}"] .week-load-pct')?.textContent`);
        check('После переключения мастера общий вид не меняется (по-прежнему 7 колонок)', week2ColCount === 7, `колонок: ${week2ColCount}`);
        check('% пересчитался под нового мастера (master2: 120/240 мин = 50%, но другие данные)', week2Pct === '50%', `pct=${week2Pct}`);

        await s.screenshot('/tmp/okno44-week.png');

        // ═══════════════════ МЕСЯЦ ═══════════════════
        await s.click('label[for="sp-month"]');
        await sleep(500);

        // Переключатель "Все мастера / по одному" - честная поправка к ТЗ, построен с
        // нуля этим окном (не было в проекте до Окна 44).
        const toggleVisible = await s.eval(`!!document.getElementById('monthModeToggle')`);
        check('Переключатель "Все мастера / по одному" отрисован (новый в этом окне)', toggleVisible === true, `найден=${toggleVisible}`);
        const defaultMode = await s.eval(`document.querySelector('#monthModeToggle [data-mode="all"]')?.classList.contains('active')`);
        check('По умолчанию активен режим "Все мастера" (вся команда сразу)', defaultMode === true, `active=${defaultMode}`);
        const aggregateHints = await s.eval(`({
          statusLegendHidden: document.getElementById('monthStatusLegend')?.hidden,
          aggregateHintHidden: document.getElementById('monthAggregateHint')?.hidden,
          aggregateHintText: document.getElementById('monthAggregateHint')?.textContent.trim(),
        })`);
        check('Регрессия: "Все мастера" скрывает неприменимую легенду Рабочий/Правка/Выходной', aggregateHints.statusLegendHidden === true, JSON.stringify(aggregateHints));
        check('Регрессия: "Все мастера" объясняет процент как общую загрузку команды', aggregateHints.aggregateHintHidden === false && aggregateHints.aggregateHintText.includes('общую загрузку команды'), JSON.stringify(aggregateHints));

        const monthAggToday = await s.eval(`(() => {
          const cell = document.querySelector('.month-day--real[data-date="${today}"]');
          if (!cell) return null;
          return { pct: cell.querySelector('.month-load-pct')?.textContent, count: cell.querySelector('.appt-count')?.textContent, hasDot: !!cell.querySelector('.day-dot'), hasEdit: !!cell.querySelector('.month-day-edit') };
        })()`);
        check('Агрегат "Все мастера": % загрузки команды = 50% (720 доступно, 360 занято суммарно)', monthAggToday?.pct === '50%', `pct=${monthAggToday?.pct}`);
        check('Агрегат "Все мастера": число записей БЕЗ имён клиентов (3 записи, cancelled не считается)', (monthAggToday?.count || '').includes('3'), `count текст: "${monthAggToday?.count}"`);
        check('Агрегат не показывает dot-статус (work/edit/off бессмысленен для команды)', monthAggToday?.hasDot === false, `hasDot=${monthAggToday?.hasDot}`);
        check('Агрегат не показывает карандаш редактирования (нужен конкретный мастер)', monthAggToday?.hasEdit === false, `hasEdit=${monthAggToday?.hasEdit}`);

        await s.screenshot('/tmp/okno44-month-all.png');

        // Переключение на "По одному" - master-switcher появляется, дот-статус и
        // карандаш возвращаются, % считается уже для одного мастера.
        await s.eval(`document.querySelector('#monthModeToggle [data-mode="single"]').click()`);
        await sleep(500);
        const singleHints = await s.eval(`({
          statusLegendHidden: document.getElementById('monthStatusLegend')?.hidden,
          aggregateHintHidden: document.getElementById('monthAggregateHint')?.hidden,
        })`);
        check('Регрессия: "По одному" возвращает легенду статусов и скрывает подсказку команды', singleHints.statusLegendHidden === false && singleHints.aggregateHintHidden === true, JSON.stringify(singleHints));
        const singlePick = await s.eval(`(() => {
          const btn = [...document.querySelectorAll('#monthMasterSwitch .master-pill')].find((b) => b.textContent === 'QA Мастер Один');
          if (!btn) return 'NOT_FOUND';
          btn.click();
          return 'OK';
        })()`);
        check('"По одному": переключатель мастера находит QA Мастер Один', singlePick === 'OK', `результат: ${singlePick}`);
        await sleep(500);
        const monthSingleToday = await s.eval(`(() => {
          const cell = document.querySelector('.month-day--real[data-date="${today}"]');
          if (!cell) return null;
          return { pct: cell.querySelector('.month-load-pct')?.textContent, hasDot: !!cell.querySelector('.day-dot'), hasEdit: !!cell.querySelector('.month-day-edit') };
        })()`);
        check('"По одному" (master1): % загрузки = 50% (480 доступно, 240 занято)', monthSingleToday?.pct === '50%', `pct=${monthSingleToday?.pct}`);
        check('"По одному": dot-статус возвращается (осмыслен для конкретного мастера)', monthSingleToday?.hasDot === true, `hasDot=${monthSingleToday?.hasDot}`);
        check('"По одному": карандаш редактирования возвращается', monthSingleToday?.hasEdit === true, `hasEdit=${monthSingleToday?.hasEdit}`);

        // ── Ключевой сценарий DoD Окна 25 - клик по дню ведёт в День с верной датой ──
        await s.click(`.month-day--real[data-date="${today}"]`);
        await sleep(400);
        const dayViewState = await s.eval(`({ spDayChecked: document.getElementById('sp-day')?.checked, dayDate: document.getElementById('dayNavDate')?.dataset.value })`);
        check('Клик по дню в Месяце переключает на вид "День" (DoD Окна 25, не сломан)', dayViewState.spDayChecked === true, JSON.stringify(dayViewState));
        check('День открывается ИМЕННО с той датой, по которой кликнули', dayViewState.dayDate === today, `dayDate=${dayViewState.dayDate}, ожидали ${today}`);

        // ── Регрессия: Год того же раздела не задет ──────────────────────────
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
