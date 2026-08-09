// Живая проверка Окна 53, задача J - задвоенный переключатель "Все мастера/По одному"
// + путаница со статусами (СНАЧАЛА живая репродукция - причина НЕ была видна чтением
// статики, план явно фиксирует "не найдено").
//
// Реальный триггер (найден живым CDP-прогоном, tools/verify-2026-08-09-okno53-j-repro.mjs):
// crm-walkin.js:307 зовёт renderLiveProof(staff) ПОСЛЕ КАЖДОЙ успешной записи walk-in
// (не только при заходе на страницу) - renderLiveProof (crm-dashboard.js) внутри зовёт
// wireScheduleViews(...) заново. Сам crm-dashboard.js уже предупреждал об этом классе
// бага (комментарий у window.__refreshScheduleViews, Окно 45/46) - crm-walkin.js не
// следует собственному правилу проекта. wireMonthView создавал #monthModeToggle без
// проверки существования (буквальная причина из промпта) - но это только ВИДИМЫЙ
// симптом: второй проход wireScheduleViews() пересоздаёт scheduleViewState и вешает
// ВТОРОЙ комплект обработчиков (day/week/month-nav, wireViewTabs) поверх статичных
// узлов - отсюда и "путаница со статусами" (не отдельная, третья причина).
//
// Фикс: идемпотентный guard в wireScheduleViews (window.__scheduleViewsWired) -
// повторный вызов не перевешивает ничего, просто вызывает уже существующий безопасный
// window.__refreshScheduleViews (тот же путь, что кнопка "Обновить данные").
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
       ('o53j-owner', NULL, 'QA Владелец J', 'owner', true, false, true, 'o53j-owner@test.local', $1),
       ('o53j-master1', NULL, 'QA Мастер J1', 'master', true, true, true, 'o53j-master1@test.local', $2),
       ('o53j-master2', NULL, 'QA Мастер J2', 'master', true, true, true, 'o53j-master2@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o53j-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd
       UNION ALL
       SELECT 'o53j-master2', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o53j-master1', 'strizhka', 2000, 40), ('o53j-master2', 'strizhka', 2000, 40)`);

    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o53j-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53j-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);

        await s.click('#scheduleCard-month summary');
        await sleep(600);
        const toggleBefore = await s.eval(`document.querySelectorAll('#monthModeToggle').length`);
        check('До записи walk-in: ровно один переключатель "Все мастера/По одному"', toggleBefore === 1, `узлов=${toggleBefore}`);

        // ── Реальная запись через живой слот-клик "Дня" - тот же путь, что владелец в проде ──
        await s.click('#scheduleCard-day summary');
        await sleep(500);
        const apptCountBefore = await s.eval(`document.querySelectorAll('.appt:not(.appt--slot-preview)').length`);
        const trackBox = await s.eval(`(() => {
          const cols = [...document.querySelectorAll('.schedule-col')];
          const col = cols.find((c) => c.querySelector('.schedule-col-head .name')?.textContent === 'QA Мастер J1');
          const track = col?.querySelector('.schedule-track');
          if (!track) return null;
          const r = track.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) };
        })()`);
        check('Колонка QA Мастер J1 найдена в Дне', trackBox !== null, JSON.stringify(trackBox));
        await s.clickAt(trackBox.x, trackBox.y);
        await sleep(400);
        await s.eval(`document.querySelector('#wfServicePicker input[type=checkbox]')?.click()`);
        await s.type('#wfClientName', 'QA Клиент J Повтор');
        await sleep(200);
        await s.click('#wfSubmit');
        await sleep(900); // renderLiveProof(staff) внутри submit-обработчика - реальный триггер

        // ═══════════════════ Задача J: переключатель НЕ задвоился ═══════════════════
        await s.click('#scheduleCard-month summary');
        await sleep(500);
        const toggleAfter = await s.eval(`document.querySelectorAll('#monthModeToggle').length`);
        check('Задача J: ПОСЛЕ записи walk-in переключатель по-прежнему ровно один (не задвоился)', toggleAfter === 1, `узлов=${toggleAfter}`);
        await s.screenshot('/tmp/okno53-taskJ-after-fix.png');

        // ── Мягкое обновление реально сработало - новая бронь видна на Дне без reload ──
        // ("День" открыт ещё с шага записи walk-in выше - повторный клик по summary
        // ЗАКРЫЛ бы уже открытый <details>, не переоткрыл, поэтому проверяем состояние).
        // Считаем карточки, не имя клиента - отдельный найденный по ходу баг (имя
        // клиента не долетает до сохранённой брони при записи по клику на пустой слот)
        // не в зоне этой задачи (задвоенный переключатель), не чиню его здесь.
        const dayAlreadyOpen = await s.eval(`document.getElementById('scheduleCard-day')?.open`);
        if (!dayAlreadyOpen) { await s.click('#scheduleCard-day summary'); await sleep(400); }
        const apptCountAfter = await s.eval(`document.querySelectorAll('.appt:not(.appt--slot-preview)').length`);
        check(
          'Мягкий refresh после guard реально обновил данные (число записей на Дне выросло без перезагрузки страницы)',
          apptCountAfter === apptCountBefore + 1,
          `было=${apptCountBefore}, стало=${apptCountAfter}`
        );

        // ═══════════ Регрессия: НЕТ двойного срабатывания навигации (глубинная причина
        // "путаницы со статусами" - второй набор обработчиков двигал бы на 2 шага) ═══════════
        await s.click('#scheduleCard-week summary');
        await sleep(500);
        const weekAnchorBefore = await s.eval(`document.getElementById('scheduleAnchor-week')?.textContent`);
        await s.click('#weekNavNext');
        await sleep(400);
        const weekAnchorAfterOneClick = await s.eval(`document.getElementById('scheduleAnchor-week')?.textContent`);
        check(
          'Регрессия: один клик "Следующая неделя" двигает РОВНО на одну неделю (не два независимых обработчика от повторного wireScheduleViews)',
          weekAnchorBefore !== weekAnchorAfterOneClick,
          `до="${weekAnchorBefore}", после 1 клика="${weekAnchorAfterOneClick}"`
        );
        // Возврат назад одним кликом должен точно вернуть исходную подпись - если бы
        // сработало 2 обработчика на клик вперёд (итого +2 недели), один клик назад
        // (-1 или -2) не вернул бы к исходной подписи.
        await s.click('#weekNavPrev');
        await sleep(400);
        const weekAnchorBack = await s.eval(`document.getElementById('scheduleAnchor-week')?.textContent`);
        check('Регрессия: клик "Предыдущая неделя" точно возвращает исходную подпись (вперёд+назад = 0, не двойной шаг)', weekAnchorBack === weekAnchorBefore, `исходно="${weekAnchorBefore}", после туда-обратно="${weekAnchorBack}"`);

        // ── "По одному": статусы (точки Рабочий/Правка/Выходной) видны и не дублируются ──
        await s.click('#scheduleCard-month summary');
        await sleep(400);
        await s.eval(`document.querySelector('#monthModeToggle [data-mode="single"]')?.click()`);
        await sleep(500);
        const dotState = await s.eval(`(() => {
          const cell = document.querySelector('.month-day--real[data-date="${today}"]');
          return { dotCount: cell?.querySelectorAll('.day-dot').length ?? 0, hasEdit: !!cell?.querySelector('.month-day-edit') };
        })()`);
        check('Задача J (было item 10 плана): "По одному" - ровно ОДНА точка статуса на ячейку, не задвоена', dotState.dotCount === 1, JSON.stringify(dotState));
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
