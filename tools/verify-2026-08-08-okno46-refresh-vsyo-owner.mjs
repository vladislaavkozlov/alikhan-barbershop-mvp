// Живая проверка Окна 46 (08.08.2026) - кнопка "Обновить данные" (crm-owner.html,
// #refreshBtn) должна обновлять ВЕСЬ кабинет владельца, не только "Расписание"/
// риск-список/заявки/бейдж, как было в Окне 45. Правка (см. память сессии): вынесла
// день-снапшот "Финансов" из renderLiveProof в отдельную refreshFinance()
// (assets/crm-dashboard.js) и завела реестр window.__refreshTeamSchedules
// (assets/crm-schedule-editor.js) для карточек "Разовое изменение на дату"/"График
// работы" в "Команде" - обе новые точки входа переиспользуют УЖЕ существующие
// idempotent-замыкания (loadCurrent/load/renderRevenuePeriods/...), ни разу не
// вызывая wireScheduleEditor/wireWeeklyScheduleEditor/renderLiveProof повторно
// (риск задвоения обработчиков, из-за которого Окно 45 само не трогало эти
// wire*-функции напрямую).
//
// DoD этого прогона:
//  1. Данные РЕАЛЬНО обновляются: меняем бэкенд напрямую (SQL/API, не через кнопку),
//     жмём "Обновить данные" НЕ перезагружая страницу, проверяем, что новые цифры/
//     текст появились в "Финансы" (день) и "Команда" (разовый перерыв + недельный
//     график).
//  2. Обработчики НЕ задваиваются: жмём кнопку 3 раза подряд (полными циклами), затем
//     ОДИН раз каждую форму, которая теоретически могла бы задвоиться (ставка
//     Елизаветы, разовый перерыв мастера-1) - считаем реальные сетевые запросы к
//     конкретным роутам через инструментированный window.fetch, ожидаем ровно 1.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('o46-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o46-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    const login = async (email, pin) => {
      const res = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      const { token } = await res.json();
      return { Authorization: `Bearer ${token}` };
    };
    const authOwner = await login('o46-owner@test.local', pinOwner);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1200, true);
        await sleep(400);
        await s.type('#loginEmail', 'o46-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1500); // login + renderLiveProof (первый, полный) + initAppShell

        // ── Снимок ДО правки бэкенда ────────────────────────────────────────
        const before = await s.eval(`({
          revenue: document.getElementById('rvAllDayRevenue')?.textContent.trim(),
          m1Day: document.getElementById('payrollMaster1Day')?.textContent.trim(),
          schedCurrent: document.getElementById('schedCurrent-master-1')?.textContent.trim(),
          mondayIcon: document.getElementById('weekly-master-1-1-icon')?.className,
        })`);
        check(
          'До правки: "Разовое изменение" мастера-1 показывает "не задано" (перерыва ещё нет)',
          /не задано/.test(before.schedCurrent || ''),
          before.schedCurrent
        );
        check(
          'До правки: понедельник мастера-1 отмечен как рабочий (дефолт 10:00-20:00)',
          (before.mondayIcon || '').includes('is-working'),
          before.mondayIcon
        );

        // ── Меняем бэкенд НАПРЯМУЮ (не через кнопку/форму) ──────────────────
        // 1. Финансы: реальная бронь мастера-1 сегодня → должна поднять
        //    "Выручка"/"Расчёт ЗП → За день" на карточке мастера-1.
        await db.query(
          `INSERT INTO bookings (id, location_id, master_id, service_id, date, start_time, end_time, status, channel)
           VALUES ('o46-booking-1', NULL, 'master-1', 'strizhka', CURRENT_DATE, '11:00', '11:40', 'done', 'admin')`
        );
        // 2. Команда → "Разовое изменение на дату": перерыв на сегодня через тот же
        //    POST /schedule, что и форма "Сохранить перерыв/выходной".
        const schedRes = await fetch(`${apiUrl}/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authOwner },
          body: JSON.stringify({
            masterId: 'master-1',
            date: new Date().toISOString().slice(0, 10),
            startTime: '10:00',
            endTime: '20:00',
            breaks: [{ startTime: '15:00', endTime: '15:45' }],
          }),
        });
        check('Фикстура: POST /schedule (разовый перерыв мастера-1 на сегодня) принят', schedRes.status === 200, `status=${schedRes.status}`);
        // 3. Команда → "График работы": понедельник мастера-1 - выходной.
        await db.query(
          `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
           VALUES ('master-1', 1, false, NULL, NULL)
           ON CONFLICT (master_id, weekday) DO UPDATE SET is_working = false, work_start = NULL, work_end = NULL`
        );

        // ── Жмём "Обновить данные" (без перезагрузки страницы) ──────────────
        // Правка по вопросу Влада 08.08.2026 ("почему видно обновление только в
        // Уведомлениях") - "Финансы"/"Команда" получили тот же плейсхолдер
        // "считаю…"/"загружаю…", что уже был у "Заявок". Синхронная часть клика
        // (Promise.all внутри refreshBtn-обработчика запускает каждую async-функцию
        // до её первого await синхронно) успевает выставить плейсхолдер ДО того,
        // как s.click() вернёт управление - читаем DOM сразу после клика, без sleep,
        // чтобы поймать именно этот момент, не гадать по таймингу сети.
        await s.click('#refreshBtn');
        const duringRefresh = await s.eval(`({
          revenue: document.getElementById('rvAllDayRevenue')?.textContent.trim(),
          weekly: document.getElementById('weeklyEditor-master-1')?.textContent.trim(),
        })`);
        check(
          '"Выручка" (день) мелькает плейсхолдером "считаю…" сразу после клика "Обновить" (видимый сигнал обновления, не тихая подмена)',
          /считаю/.test(duringRefresh.revenue || ''),
          duringRefresh.revenue
        );
        check(
          '"График работы" мастера-1 мелькает плейсхолдером "загружаю…" сразу после клика "Обновить"',
          /загружаю/.test(duringRefresh.weekly || ''),
          duringRefresh.weekly
        );

        await sleep(1200);

        const after = await s.eval(`({
          revenue: document.getElementById('rvAllDayRevenue')?.textContent.trim(),
          m1Day: document.getElementById('payrollMaster1Day')?.textContent.trim(),
          schedCurrent: document.getElementById('schedCurrent-master-1')?.textContent.trim(),
          mondayIcon: document.getElementById('weekly-master-1-1-icon')?.className,
          stillOnSameTab: document.getElementById('pt-b')?.checked === false && !!document.getElementById('crmMain'),
        })`);

        check(
          'После клика "Обновить": "Выручка" (день) изменилась и не показывает "считаю…"',
          after.revenue !== before.revenue && !/считаю/.test(after.revenue || ''),
          `до="${before.revenue}" после="${after.revenue}"`
        );
        check(
          'После клика "Обновить": "Расчёт ЗП → За день" мастера-1 изменился (не 000 ₽)',
          after.m1Day !== before.m1Day && !/^0/.test((after.m1Day || '').replace(/\s/g, '')),
          `до="${before.m1Day}" после="${after.m1Day}"`
        );
        check(
          'После клика "Обновить": "Разовое изменение на дату" мастера-1 показывает новый перерыв 15:00–15:45',
          /15:00.*15:45/.test(after.schedCurrent || ''),
          after.schedCurrent
        );
        check(
          'После клика "Обновить": понедельник мастера-1 в "Графике работы" стал выходным (без перезагрузки страницы)',
          (after.mondayIcon || '').includes('is-off') && !(after.mondayIcon || '').includes('is-working'),
          after.mondayIcon
        );

        await s.screenshot('/tmp/okno46-refresh-team-finance-updated.png');

        // ── Обработчики не задваиваются: 3 полных цикла кнопки, потом по одному
        //    клику на формы, которые теоретически могли бы задвоиться ──────────
        const setupCounter = await s.eval(`(function(){
          window.__reqCounts = {};
          const orig = window.fetch.bind(window);
          window.fetch = (url, opts) => {
            const u = typeof url === 'string' ? url : url.url;
            const method = (opts && opts.method) || 'GET';
            const path = u.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
            const key = method + ' ' + path;
            window.__reqCounts[key] = (window.__reqCounts[key] || 0) + 1;
            return orig(url, opts);
          };
          return 'OK';
        })()`);
        check('Счётчик сетевых запросов установлен в странице', setupCounter === 'OK', setupCounter);

        for (let i = 0; i < 3; i++) {
          await s.click('#refreshBtn');
          await sleep(900); // дожидаемся конца цикла (refreshBtn.disabled=false) перед следующим кликом
        }

        // Ставка Елизаветы - тот же клик, что и раньше в поле (значение не меняем,
        // просто жмём "Сохранить ставку").
        await s.click('#elizavetaPctSave');
        await sleep(500);

        // "Сохранить перерыв/выходной" мастера-1 - повторный клик с теми же полями
        // (виджет даты уже проинициализирован на сегодня).
        await s.click('#schedSave-master-1');
        await sleep(600);

        const counts = await s.eval(`window.__reqCounts`);
        const putPayroll = counts['PUT /payroll-settings'] || 0;
        const postSchedule = counts['POST /schedule'] || 0;
        const getSchedule = counts['GET /schedule'] || 0;

        check(
          '3 клика "Обновить" + 1 клик "Сохранить ставку" → ровно ОДИН PUT /payroll-settings (обработчик не задвоен)',
          putPayroll === 1,
          `PUT /payroll-settings вызван ${putPayroll} раз(а)`
        );
        check(
          '3 клика "Обновить" + 1 клик "Сохранить перерыв" → ровно ОДИН POST /schedule (обработчик не задвоен)',
          postSchedule === 1,
          `POST /schedule вызван ${postSchedule} раз(а)`
        );
        check(
          '3 полных цикла "Обновить данные" реально дёргали GET /schedule (карточки мастеров) минимум 3 раза (кнопка не no-op)',
          getSchedule >= 3,
          `GET /schedule вызван ${getSchedule} раз(а)`
        );

        // Побочный эффект последнего клика "Сохранить перерыв/выходной" - реальный
        // оверврайт брейка на сегодня (виджет даты уже стоит на сегодня, время по
        // умолчанию 13:00-14:00) - подтверждаем, что бэкенд принял ровно один запрос,
        // не разбираем итоговое время (не предмет этого окна).
        const finalNote = await s.eval(`document.getElementById('schedNote-master-1')?.textContent`);
        check('"Сохранить перерыв/выходной" реально отработал (заметка не пустая)', !!(finalNote || '').trim(), finalNote);

        // ── Impact Analysis: страница не перезагружалась ни разу за весь прогон -
        //    остались залогинены на той же вкладке, sessionInfo на месте.
        const stillLoggedIn = await s.eval(`document.getElementById('sessionInfo')?.textContent`);
        check('Ни один клик "Обновить" не увёл со страницы (location.reload не вызывался)', /QA Владелец/.test(stillLoggedIn || ''), stillLoggedIn);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
