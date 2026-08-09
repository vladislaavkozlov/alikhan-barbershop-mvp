// Живая проверка Окна 53, задача I - расхождение % загрузки Неделя/Месяц.
//
// Живая репродукция ДО фикса (см. git log этого коммита - tools/verify-2026-08-09-
// okno53-i-repro.mjs) подтвердила гипотезу плана: weekMasterId/monthMasterId - НЕЗАВИСИМЫЕ
// переменные (обе по умолчанию masters[0], расходятся после переключения мастера в ОДНОМ
// виде) - Неделя показывала "QA Мастер Два" 50%, Месяц - "Алиовсад" 0% - ДВА РАЗНЫХ
// мастера, не одна и та же формула с разным результатом.
//
// Фикс: выбор мастера живёт в общем scheduleViewState.masterId (тем же принципом, что
// уже применён к дате, Окно 25) - переключение в одном виде синхронно обновляет и другой,
// если он открыт одновременно (Окно 45 разрешает несколько карточек сразу).
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
    // master1: занято 1 час/8 → 12%. master2: занято 4 часа/8 → 50%. Разные числа НА
    // РАЗНЫХ мастерах - фикс должен показывать ОДНО и то же число для ОДНОГО мастера
    // независимо от того, в каком виде его выбрали.
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

        // Открываем ОБЕ карточки сразу (Окно 45 - несколько одновременно) - ключевой
        // сценарий кросс-обновления: переключаем мастера в Неделе, Месяц должен
        // обновиться САМ, без отдельного клика по нему.
        await s.click('#scheduleCard-week summary');
        await sleep(500);
        await s.click('#scheduleCard-month summary');
        await sleep(500);
        await s.eval(`document.querySelector('#monthModeToggle [data-mode="single"]')?.click()`);
        await sleep(500);

        const beforeSwitch = await s.eval(`({
          weekActive: document.querySelector('#weekMasterSwitch .master-pill.active')?.textContent,
          monthActive: document.querySelector('#monthMasterSwitch .master-pill.active')?.textContent,
        })`);
        check('До переключения: Неделя и Месяц уже показывают ОДНОГО мастера (общий дефолт)', beforeSwitch.weekActive === beforeSwitch.monthActive, JSON.stringify(beforeSwitch));

        // Переключаем мастера в Неделе на "QA Мастер Два"
        await s.eval(`[...document.querySelectorAll('#weekMasterSwitch .master-pill')].find((b) => b.textContent === 'QA Мастер Два')?.click()`);
        await sleep(600);

        const afterSwitch = await s.eval(`({
          weekActive: document.querySelector('#weekMasterSwitch .master-pill.active')?.textContent,
          monthActive: document.querySelector('#monthMasterSwitch .master-pill.active')?.textContent,
          weekPct: document.querySelector('#weekGrid [data-open-day="${today}"] .week-load-pct')?.textContent,
          monthPct: document.querySelector('.month-day--real[data-date="${today}"] .month-load-pct')?.textContent,
        })`);
        check(
          'Задача I: переключение мастера в Неделе СИНХРОННО обновило активного мастера в Месяце (кросс-обновление открытых карточек)',
          afterSwitch.monthActive === 'QA Мастер Два',
          JSON.stringify(afterSwitch)
        );
        check(
          'Задача I: Неделя и Месяц теперь показывают ОДНОГО мастера',
          afterSwitch.weekActive === afterSwitch.monthActive,
          JSON.stringify(afterSwitch)
        );
        check(
          'Задача I: % загрузки СОВПАДАЕТ на Неделе и Месяце для одного мастера/дня (50%, master2: 240/480 мин)',
          afterSwitch.weekPct === afterSwitch.monthPct && afterSwitch.weekPct === '50%',
          JSON.stringify(afterSwitch)
        );
        await s.screenshot('/tmp/okno53-taskI-after-fix-synced.png');

        // ── Обратное направление: переключаем в Месяце, Неделя должна подхватить ──
        await s.eval(`[...document.querySelectorAll('#monthMasterSwitch .master-pill')].find((b) => b.textContent === 'QA Мастер Раз')?.click()`);
        await sleep(600);
        const reverse = await s.eval(`({
          weekActive: document.querySelector('#weekMasterSwitch .master-pill.active')?.textContent,
          monthActive: document.querySelector('#monthMasterSwitch .master-pill.active')?.textContent,
          weekPct: document.querySelector('#weekGrid [data-open-day="${today}"] .week-load-pct')?.textContent,
          monthPct: document.querySelector('.month-day--real[data-date="${today}"] .month-load-pct')?.textContent,
        })`);
        check('Задача I (обратное направление): переключение в Месяце обновило Неделю', reverse.weekActive === 'QA Мастер Раз' && reverse.weekActive === reverse.monthActive, JSON.stringify(reverse));
        // 60/480 = 12.5% -> Math.round даёт 13% (не 12, как в первом черновике проверки -
        // не баг продукта, ошибка моего же ожидания при написании теста), проверяем
        // главное - совпадение чисел, не конкретное округление.
        check('Задача I (обратное направление): проценты снова совпадают (master1: 60/480 мин)', reverse.weekPct === reverse.monthPct && reverse.weekPct === '13%', JSON.stringify(reverse));

        // ── Регрессия: клик по дню в Месяце по-прежнему открывает День с той же датой (Окно 25) ──
        await s.click(`.month-day--real[data-date="${today}"]`);
        await sleep(400);
        const dayOpened = await s.eval(`document.getElementById('scheduleCard-day')?.open`);
        check('Регрессия: клик по дню в Месяце по-прежнему открывает "День" (Окно 25/45 не сломаны)', dayOpened === true, `open=${dayOpened}`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
