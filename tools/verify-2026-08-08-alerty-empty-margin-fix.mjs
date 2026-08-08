// Живая проверка правки 08.08.2026 (Влад прислал 2 скриншота: в "Команде"/
// "Финансах"/"Аналитике"/"Уведомлениях" первая карточка начинается сразу под
// рамкой блока, а в "Расписании" - заметно ниже) - причина: #ownerAlertsSchedule
// (класс .breaks-list) держал margin-bottom:12px даже будучи пустым (нет реальных
// предупреждений о мастерах без графика) - margin это свойство самого блока, не
// зависит от наличия детей. .breaks-list:empty{margin-bottom:0} убирает утечку
// (тот же приём, что у .view-anchor:empty). Если в реальных данных владельца
// сейчас ЕСТЬ настоящее предупреждение "нет рабочего графика" - тогда "Расписание"
// законно ниже (актуальное предупреждение, не баг) - это отдельный сценарий,
// не проверяем здесь.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('em-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'em-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    // Все мастера С графиком - алертов "нет рабочего графика" быть не должно.
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'em-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'em-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1500); // ждём загрузки /owner/alerts

        const alertsEmpty = await s.eval(`document.getElementById('ownerAlertsSchedule')?.innerHTML === ''`);
        check('Тестовые мастера все с графиком - контейнер алертов реально пуст', alertsEmpty === true, `${alertsEmpty}`);

        const gapSchedule = await s.eval(`
          (() => {
            const sec = document.querySelector('.panel-a > section');
            const cards = document.querySelector('.panel-a .staff-list.schedule-view-cards');
            return Math.round(cards.getBoundingClientRect().top - sec.getBoundingClientRect().top);
          })()
        `);

        await s.click('.app-nav-item[data-section="team"]');
        await sleep(300);
        const gapTeam = await s.eval(`
          (() => {
            const sec = document.querySelector('.panel-b > section');
            const cards = document.querySelector('.panel-b .staff-list');
            return Math.round(cards.getBoundingClientRect().top - sec.getBoundingClientRect().top);
          })()
        `);

        check(
          'Без активных алертов первая карточка "Расписания" начинается на ТОЙ ЖЕ высоте от рамки блока, что и "Команды"',
          gapSchedule === gapTeam,
          `Расписание: ${gapSchedule}px, Команда: ${gapTeam}px`
        );

        await s.click('.app-nav-item[data-section="schedule"]');
        await sleep(300);
        await s.screenshot('/tmp/verify-alerts-empty-margin.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
