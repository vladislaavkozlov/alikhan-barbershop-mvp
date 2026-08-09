// РЕПРОДУКЦИЯ Окна 53, задача I (запускать ДО фикса - фиксирует баг как он есть).
// Гипотеза из плана: weekMasterId/monthMasterId - независимые переменные, обе по
// умолчанию masters[0], но расходятся после переключения мастера в ОДНОМ виде - на
// самом деле сравниваются РАЗНЫЕ мастера, не разные формулы одного мастера.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pinOwner = randomPin();
  const today = daysFromToday(0);
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('o53i-owner', NULL, 'QA Владелец I', 'owner', true, false, true, 'o53i-owner@test.local', $1),
     ('o53i-master1', NULL, 'QA Мастер Раз', 'master', true, true, true, 'o53i-master1@test.local', $2),
     ('o53i-master2', NULL, 'QA Мастер Два', 'master', true, true, true, 'o53i-master2@test.local', $2)`,
    [hashPin(pinOwner), hashPin(randomPin())]
  );
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'o53i-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd
     UNION ALL
     SELECT 'o53i-master2', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
  );
  await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('o53i-master1', 'strizhka', 2000, 40), ('o53i-master2', 'strizhka', 2000, 40)`);
  // master1: 6 часов доступно (480 мин), занято 1 час (60 мин) → 12%. master2: занято 4 часа (240 мин) → 50%.
  await db.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
     ('o53i-b1', 1, 'o53i-master1', 'strizhka', NULL, $1, '10:00', '11:00', 'planned', 'admin'),
     ('o53i-b2', 1, 'o53i-master2', 'strizhka', NULL, $1, '10:00', '14:00', 'planned', 'admin')`,
    [today]
  );

  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'o53i-owner@test.local', pin: pinOwner }),
  });
  if (res.status !== 200) throw new Error(`login → ${res.status}`);

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.navigate(`${base}/crm-owner.html`);
      await s.setViewport(1440, 1000, true);
      await sleep(400);
      await s.type('#loginEmail', 'o53i-owner@test.local');
      await s.type('#loginPin', pinOwner);
      await s.click('#loginForm button[type="submit"]');
      await sleep(1300);

      // Неделя: явно переключаем на "QA Мастер Два"
      await s.click('#scheduleCard-week summary');
      await sleep(600);
      await s.eval(`[...document.querySelectorAll('#weekMasterSwitch .master-pill')].find((b) => b.textContent === 'QA Мастер Два')?.click()`);
      await sleep(500);
      const weekPct = await s.eval(`document.querySelector('#weekGrid [data-open-day="${today}"] .week-load-pct')?.textContent`);
      const weekActiveMaster = await s.eval(`document.querySelector('#weekMasterSwitch .master-pill.active')?.textContent`);

      // Месяц: НЕ трогаем переключатель - открываем "как есть" (дефолт)
      await s.click('#scheduleCard-month summary');
      await sleep(600);
      await s.eval(`document.querySelector('#monthModeToggle [data-mode="single"]')?.click()`);
      await sleep(500);
      const monthPct = await s.eval(`document.querySelector('.month-day--real[data-date="${today}"] .month-load-pct')?.textContent`);
      const monthActiveMaster = await s.eval(`document.querySelector('#monthMasterSwitch .master-pill.active')?.textContent`);

      console.log('РЕПРОДУКЦИЯ (ДО фикса):');
      console.log(`  Неделя: активный мастер = "${weekActiveMaster}", % загрузки за ${today} = ${weekPct}`);
      console.log(`  Месяц:  активный мастер = "${monthActiveMaster}", % загрузки за ${today} = ${monthPct}`);
      console.log(`  Владелец видит "${weekPct}" на Неделе и "${monthPct}" на Месяце для, как ему кажется, ОДНОГО и того же выбранного мастера,`);
      console.log(`  на деле смотрит на ${weekActiveMaster === monthActiveMaster ? 'ОДНОГО И ТОГО ЖЕ' : 'ДВУХ РАЗНЫХ'} мастеров.`);
      await s.screenshot('/tmp/okno53-taskI-BEFORE-repro.png');
    });
  });
});
