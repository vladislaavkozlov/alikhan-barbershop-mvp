// Живая проверка Окна 53, задачи A/B/C/D (ПРОМПТ-ОКНО-53-БАГИ-РАСПИСАНИЯ-ВЛАДЕЛЕЦ.md).
// A - "03.08" вместо "3.8" на Неделе. B - "01".."09" вместо "1".."9" на Месяце.
// C - hover чернит и число, и % загрузки на Неделе (не только число). D - подсветка
// "сегодня" на Дне (через date-picker, своей сетки у Дня нет), Неделе, Месяце.
// Сегодняшняя дата запуска (2026-08-09, воскресенье) - удачное совпадение: текущая
// ISO-неделя (Пн 03.08 - Вс 09.08) сама содержит однозначные числа дня, навигация не
// нужна для проверки A. Month всегда содержит 01-09 в начале месяца - для B тоже без навигации.
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
       ('o53-owner', NULL, 'QA Владелец 53', 'owner', true, false, true, 'o53-owner@test.local', $1),
       ('o53-master1', NULL, 'QA Мастер 53', 'master', true, true, true, 'o53-master1@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o53-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o53-master1', 'strizhka', 2000, 40)`
    );
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o53-b1', 1, 'o53-master1', 'strizhka', NULL, $1, '10:00', '12:00', 'planned', 'admin')`,
      [today]
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
    await login('o53-owner@test.local', pinOwner);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);

        // ═══════════ Задача D (часть 1) - "сегодня" в date-picker'е Дня ═══════════
        await s.click('#scheduleCard-day summary');
        await sleep(500);
        await s.click('#dayNavDate-slot .custom-date-trigger');
        await sleep(300);
        const dayPickerToday = await s.eval(`(() => {
          const el = document.querySelector('#dayNavDate-slot .custom-date-cell[data-date="${today}"]');
          return el ? { hasClass: el.classList.contains('is-today'), isButton: el.tagName === 'BUTTON' } : null;
        })()`);
        check('Задача D: попап даты "Дня" отмечает сегодняшнюю ячейку .is-today', dayPickerToday?.hasClass === true, JSON.stringify(dayPickerToday));
        await s.screenshot('/tmp/okno53-taskD-day-picker.png');
        // закрыть попап кликом вне (иначе останется open поверх скриншотов недели/месяца)
        await s.clickAt(700, 50);
        await sleep(200);

        // ═══════════════════ Задача A + C + D (Неделя) ═══════════════════
        await s.click('#scheduleCard-week summary');
        await sleep(600);

        const weekLabels = await s.eval(`[...document.querySelectorAll('#weekGrid .num')].map(e => e.textContent.trim())`);
        check(
          'Задача A: подписи дней Недели в формате "ДД.ММ" с ведущим нулём (напр. "Пн 03.08")',
          weekLabels.some((t) => /0[3-9]\.08/.test(t)) && !weekLabels.some((t) => /\s[1-9]\.\d\b/.test(t) && !/0[1-9]\./.test(t)),
          JSON.stringify(weekLabels)
        );

        const todayWeekCell = await s.eval(`document.querySelector('#weekGrid [data-open-day="${today}"]')?.classList.contains('is-today')`);
        check('Задача D: ячейка сегодняшнего дня на Неделе имеет .is-today', todayWeekCell === true, `is-today=${todayWeekCell}`);

        // Задача C: hover красит .num И .week-load-pct в один и тот же цвет (var(--leather))
        const cellBox = await s.eval(`(() => {
          const el = document.querySelector('#weekGrid [data-open-day="${today}"]');
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + 10), y: Math.round(r.top + 10) };
        })()`);
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cellBox.x, y: cellBox.y });
        await sleep(200);
        const hoverColors = await s.eval(`(() => {
          const cell = document.querySelector('#weekGrid [data-open-day="${today}"]');
          const num = cell.querySelector('.num');
          const pct = cell.querySelector('.week-load-pct');
          return { num: getComputedStyle(num).color, pct: pct ? getComputedStyle(pct).color : null };
        })()`);
        check(
          'Задача C: при hover .week-load-pct получает тот же цвет, что и номер дня (оба чернеют)',
          hoverColors.pct !== null && hoverColors.pct === hoverColors.num,
          JSON.stringify(hoverColors)
        );
        await s.eval(`document.getElementById('scheduleCard-week').scrollIntoView({block:'start'})`);
        await sleep(200);
        await s.screenshot('/tmp/okno53-taskAC-week.png');

        // ═══════════════════ Задача B + D (Месяц) ═══════════════════
        await s.click('#scheduleCard-month summary');
        await sleep(600);
        await s.eval(`document.getElementById('scheduleCard-month').scrollIntoView({block:'start'})`);
        await sleep(200);

        const monthNums = await s.eval(`[...document.querySelectorAll('#monthGrid .month-day--real .num')].map(e => e.textContent.trim())`);
        const hasSingleDigitBare = monthNums.some((t) => /^[1-9](\s|%|$)/.test(t) && !/^0[1-9]/.test(t));
        check('Задача B: числа дней Месяца двузначные (01, 02, ... 09), не "1, 2, ...9"', !hasSingleDigitBare, JSON.stringify(monthNums.slice(0, 12)));

        const todayMonthCell = await s.eval(`document.querySelector('.month-day--real[data-date="${today}"]')?.classList.contains('is-today')`);
        check('Задача D: ячейка сегодняшнего дня на Месяце имеет .is-today', todayMonthCell === true, `is-today=${todayMonthCell}`);
        await s.screenshot('/tmp/okno53-taskBD-month.png');

        // ── Регрессия: клик по дню в Месяце по-прежнему открывает День с той же датой (Окно 25) ──
        await s.click(`.month-day--real[data-date="${today}"]`);
        await sleep(400);
        const dayOpened = await s.eval(`document.getElementById('scheduleCard-day')?.open`);
        check('Регрессия: клик по дню в Месяце раскрывает карточку "День" (Окно 25/45 не сломаны)', dayOpened === true, `open=${dayOpened}`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
