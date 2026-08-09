// РЕПРОДУКЦИЯ Окна 53, задача J (запускать ДО фикса).
//
// Гипотеза плана: wireMonthView создаёт #monthModeToggle без проверки существования -
// при повторном запуске получаются два независимых узла. Что вызывает повторный
// запуск - искали живым grep'ом (не в статике, план явно говорит "не нашёл"):
// crm-walkin.js:307 зовёт renderLiveProof(staff) ПОСЛЕ КАЖДОЙ успешной записи walk-in
// (не только при заходе на страницу) - renderLiveProof (crm-dashboard.js) внутри
// вызывает wireScheduleViews({...}) заново, а тот - wireMonthView заново. Комментарий
// в САМОМ crm-dashboard.js (Окно 46) уже предупреждал: "renderLiveProof вызывать
// повторно нельзя... wire*-функции вешают обработчики на статичные DOM-узлы один раз,
// повторный вызов задвоил бы клики" - crm-walkin.js нарушает это же правило.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const before = await s.eval(`document.querySelectorAll('#monthModeToggle').length`);
      console.log(`ДО записи walk-in: #monthModeToggle узлов = ${before}`);

      // Реальная запись через живой слот-клик "Дня" (не программный вызов) - тот же
      // путь, который реально проходит владелец в проде.
      await s.click('#scheduleCard-day summary');
      await sleep(500);
      const trackBox = await s.eval(`(() => {
        const cols = [...document.querySelectorAll('.schedule-col')];
        const col = cols.find((c) => c.querySelector('.schedule-col-head .name')?.textContent === 'QA Мастер J1');
        const track = col?.querySelector('.schedule-track');
        if (!track) return null;
        const r = track.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) };
      })()`);
      await s.clickAt(trackBox.x, trackBox.y);
      await sleep(400);
      await s.eval(`document.querySelector('#wfServicePicker input[type=checkbox]')?.click()`);
      await s.type('#wfClientName', 'QA Клиент J Повтор');
      await sleep(200);
      await s.click('#wfSubmit');
      await sleep(900); // renderLiveProof(staff) внутри submit-обработчика

      await s.click('#scheduleCard-month summary'); // если карточка закрылась/пере-раскрылась
      await sleep(400);
      const after = await s.eval(`document.querySelectorAll('#monthModeToggle').length`);
      const pillTexts = await s.eval(`[...document.querySelectorAll('#monthModeToggle')].map(el => el.textContent.trim())`);
      console.log(`ПОСЛЕ записи walk-in (renderLiveProof вызван повторно): #monthModeToggle узлов = ${after}`);
      console.log('Содержимое найденных узлов:', JSON.stringify(pillTexts));
      await s.screenshot('/tmp/okno53-taskJ-BEFORE-repro.png');
    });
  });
});
