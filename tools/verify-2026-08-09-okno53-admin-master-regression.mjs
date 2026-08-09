// Быстрая регрессионная проверка Окна 53 на crm-admin.html/crm-master.html - файлы,
// затронутые задачами A-J (crm-calendar.js, mockup-crm.js/css, crm-schedule-view-*.js,
// crm-schedule-views.js), общие для всех трёх ролей, хотя правки делались и
// проверялись через crm-owner.html. 1-2 клика на каждую роль, не полный аудит.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinAdmin = randomPin();
    const pinMaster = randomPin();
    const today = daysFromToday(0);
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o53reg-admin', 1, 'QA Админ Regression', 'admin', true, false, true, 'o53reg-admin@test.local', $1),
       ('o53reg-master', 1, 'QA Мастер Regression', 'master', true, true, true, 'o53reg-master@test.local', $2)`,
      [hashPin(pinAdmin), hashPin(pinMaster)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o53reg-master', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o53reg-master', 'vosk', 500, 15), ('o53reg-master', 'strizhka', 2000, 40)`);
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
       ('o53reg-b1', 1, 'o53reg-master', 'vosk', NULL, $1, '11:00', '11:15', 'planned', 'admin'),
       ('o53reg-b2', 1, 'o53reg-master', 'strizhka', NULL, $1, '11:15', '11:55', 'planned', 'admin')`,
      [today]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        // ═══════════════════ crm-admin.html ═══════════════════
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53reg-admin@test.local');
        await s.type('#loginPin', pinAdmin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        const adminErr = await s.eval(`window.__jsErrors || 'нет window.__jsErrors, проверяю просто что страница отрисовалась'`);
        const adminHasDay = await s.eval(`!!document.querySelector('.schedule-grid, #dayNavDate-slot, .appt')`);
        check('crm-admin.html: страница логинится и рендерит расписание (не пустой экран/краш)', adminHasDay === true, `hasDay=${adminHasDay}, ${adminErr}`);
        const adminApptsNoOverlap = await s.eval(`(() => {
          const short = document.querySelector('.appt[data-id="o53reg-b1"]');
          const next = document.querySelector('.appt[data-id="o53reg-b2"]');
          if (!short || !next) return null;
          return { shortBottom: Math.round(short.getBoundingClientRect().bottom), nextTop: Math.round(next.getBoundingClientRect().top) };
        })()`);
        check('crm-admin.html: фикс Задачи G (короткие записи) виден и здесь - нет наложения', adminApptsNoOverlap && adminApptsNoOverlap.shortBottom <= adminApptsNoOverlap.nextTop, JSON.stringify(adminApptsNoOverlap));
        await s.screenshot('/tmp/okno53-regression-admin.png');

        // ═══════════════════ crm-master.html ═══════════════════
        await s.navigate(`${base}/crm-master.html`);
        await s.setViewport(1440, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53reg-master@test.local');
        await s.type('#loginPin', pinMaster);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        const masterHasContent = await s.eval(`!!document.querySelector('.schedule-grid, .appt, #dayNavDate-slot')`);
        check('crm-master.html: страница логинится и рендерит расписание (не пустой экран/краш)', masterHasContent === true, `hasContent=${masterHasContent}`);
        await s.screenshot('/tmp/okno53-regression-master.png');
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
