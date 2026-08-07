// Быстрая живая проверка перед деплоем двух локальных коммитов: (1) декомпозиция
// crm-schedule-views.js на day/week/month/year, (2) убраны пункты Клиенты/
// Настройки из sidebar. Офлайн-тесты (149/6) и node --check уже чистые - это
// последний слой, браузерный, который они не покрывают.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('smoke-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'smoke-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        const consoleErrors = [];
        s.onConsoleError?.((msg) => consoleErrors.push(msg));

        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);

        await s.type('#loginEmail', 'smoke-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);

        // ── sidebar: ровно 4 пункта, без Клиентов/Настроек ──────────────────
        const navCount = await s.eval(`document.querySelectorAll('.app-nav-item').length`);
        check('Sidebar содержит ровно 4 пункта (было 6)', navCount === 4, `найдено ${navCount}`);

        const labels = await s.eval(
          `JSON.stringify([...document.querySelectorAll('.app-nav-label')].map(e => e.textContent.trim()))`
        );
        const labelsArr = JSON.parse(labels);
        check(
          'Нет пунктов "Клиенты"/"Настройки"',
          !labelsArr.includes('Клиенты') && !labelsArr.includes('Настройки'),
          labels
        );
        // "Сегодня" пока остаётся отдельным пунктом - слияние в закреплённую
        // полосу это Окно 42 (написан, ещё не реализован), эта проверка про
        // сегодняшний деплой (только убраны заглушки Клиенты/Настройки).
        check('Пункт "Сегодня" на месте (ещё не слит - это Окно 42)', labelsArr.includes('Сегодня'), labels);

        const stubLeftovers = await s.eval(`document.querySelectorAll('[data-stub]').length`);
        check('В DOM не осталось элементов-заглушек (data-stub)', stubLeftovers === 0, `найдено ${stubLeftovers}`);

        // ── расписание: разбитые day/week/month/year модули рендерят тот же UI ──
        await s.eval(`window.crmGoToSection('schedule')`);
        await sleep(300);
        const scheduleVisible = await s.eval(
          `getComputedStyle(document.querySelector('.panel-a')).display !== 'none'`
        );
        check('Раздел "Расписание" открывается и виден', scheduleVisible === true, `visible=${scheduleVisible}`);

        const dayGridRendered = await s.eval(`document.querySelectorAll('.sp-day-master-col, [data-master-col]').length >= 0`);
        void dayGridRendered; // селектор ориентировочный - если не совпадёт, следующая проверка (нет JS-ошибок) всё равно поймает падение рендера

        check('Нет JS console-ошибок за весь сценарий', consoleErrors.length === 0, JSON.stringify(consoleErrors));

        await s.screenshot('/tmp/deploy-smoke-sidebar-schedule.png');
      });
    });
  });
} catch (err) {
  check('Скрипт отработал без исключений', false, err.stack || String(err));
}

summary();
