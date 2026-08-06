// Живая проверка Окна 37 - единый бэкенд-резолвер ЗП (GET /payroll,
// computeMasterPayroll) на реальном Postgres, не только на fake-клиенте из
// tests/api.payroll-period.test.js. DoD промпта: "мастер с известной историей
// броней/ставкой → цифра за неделю/месяц/произвольный период сходится с ручным
// расчётом". Брони вставляются НАПРЯМУЮ в БД (не через POST /bookings) - публичный
// эндпоинт бронирования намеренно отклоняет прошедшие даты (past_time), а реальная
// история ЗП по определению в прошлом.
//
// Своя эфемерная база/сервер (tools/verify-lib.mjs), свой fixture-мастер - тот же
// приём, что уже применён в verify-2026-08-06-okno35-master-lost-schedule.mjs.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insertBooking(db, { id, masterId, date, serviceIds, legacyServiceId }) {
  await db.query(
    `INSERT INTO bookings (id, master_id, service_id, date, start_time, end_time, status, channel)
     VALUES ($1, $2, $3, $4, '10:00', '11:00', 'done', 'admin')`,
    [id, masterId, legacyServiceId ?? null, date]
  );
  if (!legacyServiceId) {
    for (const serviceId of serviceIds) {
      await db.query('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [id, serviceId]);
    }
  }
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('verify-master-o37', NULL, 'QA Мастер Окно37', 'master', true, true, true, 'verify-master-o37@test.local', $1)`,
      [hashPin(masterPin)]
    );
    // Своя ставка ЗП, не переиспользуем master-1/2/3 - изолированная фикстура,
    // реальных данные Алихана не трогает.
    await db.query(`INSERT INTO master_payroll_settings (master_id, pct) VALUES ('verify-master-o37', 50)`);

    // day1 (вчера): стрижка (2000, через booking_services) + борода (1600, legacy
    // bookings.service_id, БЕЗ строки в booking_services) = 3600 - живьём проверяет
    // и основной путь, и фолбэк на старые однo-услужные брони одновременно.
    const day1 = daysFromToday(-1);
    await insertBooking(db, { id: 'o37-b1', masterId: 'verify-master-o37', date: day1, serviceIds: ['strizhka'] });
    await insertBooking(db, { id: 'o37-b2', masterId: 'verify-master-o37', date: day1, legacyServiceId: 'boroda' });

    // day5 (5 дней назад): комплекс (3500) - попадает в "неделю" ([-6;0]), не в "день".
    const day5 = daysFromToday(-5);
    await insertBooking(db, { id: 'o37-b3', masterId: 'verify-master-o37', date: day5, serviceIds: ['kompleks-strizhka-boroda'] });

    // day20 (20 дней назад): воск (500) - попадает в "месяц" ([-25;0]), не в "неделю".
    const day20 = daysFromToday(-20);
    await insertBooking(db, { id: 'o37-b4', masterId: 'verify-master-o37', date: day20, serviceIds: ['vosk'] });

    const today = daysFromToday(0);
    const loginRes = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verify-master-o37@test.local', pin: masterPin }),
    });
    check('логин мастера - 200 OK', loginRes.status === 200);
    const { token } = await loginRes.json();
    const auth = { Authorization: `Bearer ${token}` };

    const getPayroll = async (from, to) => {
      const res = await fetch(`${apiUrl}/payroll?masterId=verify-master-o37&from=${from}&to=${to}`, { headers: auth });
      if (res.status !== 200) throw new Error(`GET /payroll ${from}..${to} → ${res.status}: ${JSON.stringify(await res.json())}`);
      return res.json();
    };

    // ── Слой 1: контракт бэкенда напрямую ──────────────────────────────────
    const day = await getPayroll(day1, day1);
    check('"День" (только day1): revenue=3600 (2000+1600, включая legacy service_id фолбэк)', day.revenue === 3600, `получено ${day.revenue}`);
    check('"День": payroll=1800 (50% от 3600)', day.payroll === 1800, `получено ${day.payroll}`);

    const week = await getPayroll(daysFromToday(-6), today);
    check('"Неделя" ([-6;0]): revenue=7100 (day1 3600 + day5 3500, БЕЗ day20)', week.revenue === 7100, `получено ${week.revenue}`);
    check('"Неделя": payroll=3550', week.payroll === 3550, `получено ${week.payroll}`);

    const month = await getPayroll(daysFromToday(-25), today);
    check('"Месяц" ([-25;0]): revenue=7600 (day1+day5+day20, все 4 брони)', month.revenue === 7600, `получено ${month.revenue}`);
    check('"Месяц": payroll=3800', month.payroll === 3800, `получено ${month.payroll}`);

    const custom = await getPayroll(day5, day5);
    check('"Задать период" (только day5): revenue=3500 (только комплекс)', custom.revenue === 3500, `получено ${custom.revenue}`);
    check('"Задать период": payroll=1750', custom.payroll === 1750, `получено ${custom.payroll}`);

    const noAuthRes = await fetch(`${apiUrl}/payroll?masterId=verify-master-o37&from=${today}&to=${today}`);
    check('без токена - 401 (не public)', noAuthRes.status === 401);

    // Мастер не может подсмотреть чужую ЗП, даже явно указав чужой masterId -
    // роль форсирует свой id (тот же приём, что у /payroll-settings и /bookings).
    const otherMasterId = 'verify-master-o37-b';
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ($1, NULL, 'QA Другой мастер', 'master', true, true, true, 'verify-master-o37-b@test.local', $2)`,
      [otherMasterId, hashPin(randomPin())]
    );
    await db.query(`INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, 100)`, [otherMasterId]);
    await insertBooking(db, { id: 'o37-b5', masterId: otherMasterId, date: day1, serviceIds: ['strizhka'] });
    const spoofed = await getPayroll(day1, day1).then(async () => {
      const res = await fetch(`${apiUrl}/payroll?masterId=${otherMasterId}&from=${day1}&to=${day1}`, { headers: auth });
      return res.json();
    });
    check('подстановка чужого masterId в query игнорируется - видит только СВОЮ ЗП (3600), не чужую', spoofed.revenue === 3600, `получено ${spoofed.revenue}`);

    // ── Слой 2: живой браузер - вкладка "Моя зарплата" на crm-master.html ────
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-master.html`);
        await s.setViewport(1280, 1400, true);
        await sleep(400);

        await s.type('#loginEmail', 'verify-master-o37@test.local');
        await s.type('#loginPin', masterPin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(900); // login + renderLiveProof (несколько параллельных fetch)

        await s.click('label[for="pt-b"]'); // вкладка "Моя зарплата"
        await sleep(200);

        const dayText = await s.eval(`document.getElementById('myPayrollDay')?.textContent`);
        check('вкладка "Моя зарплата": "За день" не показывает "считаю…"/"000 ₽ пример"', !/000 ₽|считаю…/.test(dayText || ''), `текст: "${dayText}"`);

        const weekText = await s.eval(`document.getElementById('myPayrollWeek')?.textContent`);
        const monthText = await s.eval(`document.getElementById('myPayrollMonth')?.textContent`);
        check('"За неделю" содержит реальную цифру', /\d/.test(weekText || ''), `текст: "${weekText}"`);
        check('"За месяц" содержит реальную цифру', /\d/.test(monthText || ''), `текст: "${monthText}"`);

        // Выдуманные секции полностью убраны из DOM.
        const retentionSection = await s.eval(`Array.from(document.querySelectorAll('h2')).some(h => h.textContent.includes('возвращаемость'))`);
        check('"Моя возвращаемость клиентов" отсутствует в DOM', retentionSection === false);
        const acquisitionSection = await s.eval(`Array.from(document.querySelectorAll('h2')).some(h => h.textContent.includes('Как приходят'))`);
        check('"Как приходят мои клиенты" отсутствует в DOM', acquisitionSection === false);

        // "Задать период" - живой клик по реальному сценарию (day5, только комплекс).
        await s.click('label[for="zpmp-period"]');
        await sleep(150);
        const dateSlots = await s.eval(`document.querySelectorAll('.payroll-date-slot .custom-date').length`);
        check('date-picker "Задать период" отрисован (2 слота)', dateSlots === 2);
        await s.eval(`document.querySelectorAll('.payroll-date-slot .custom-date')[0].dataset.value = '${day5}'`);
        await s.eval(`document.querySelectorAll('.payroll-date-slot .custom-date')[1].dataset.value = '${day5}'`);
        await s.click('#myPayrollPeriodBtn');
        await sleep(500);
        const periodText = await s.eval(`document.getElementById('myPayrollPeriodAmount')?.textContent`);
        check('"Задать период" после клика показывает реальную сумму 1 750 ₽ (не "000 ₽ пример")', /1[\s ]?750/.test(periodText || ''), `текст: "${periodText}"`);

        await s.screenshot('/tmp/okno37-my-payroll-tab.png');

        // Вкладка "Год" ("Мой день") - без выдуманных "N записей пример".
        await s.click('label[for="pt-a"]');
        await sleep(150);
        await s.click('label[for="sp-year"]');
        await sleep(150);
        const ymNoteCount = await s.eval(`document.querySelectorAll('.year-month .ym-note').length`);
        check('вкладка "Год": ни одного .ym-note ("N записей пример") не осталось в разметке месяцев', ymNoteCount === 0, `найдено ${ymNoteCount}`);
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
