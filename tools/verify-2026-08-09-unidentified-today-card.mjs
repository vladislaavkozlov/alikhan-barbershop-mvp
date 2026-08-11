// Живая проверка карточки "Неопознанных визитов сегодня" на crm-admin.html
// (09.08.2026) - фронтенд-довесок к бэкенд-фиксу walkin_name/countUnidentifiedToday
// (см. tools/verify-2026-08-09-walkin-name-bez-telefona.mjs - там же слой API).
// Здесь - слой браузера: карточка реально рендерится и обновляется реальным
// значением с сервера, не заглушкой "считаю…".
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinAdmin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('utc-admin', 1, 'QA Админ', 'admin', true, false, true, 'utc-admin@test.local', $1),
       ('utc-master', 1, 'QA Мастер', 'master', true, true, true, 'utc-master@test.local', $2)`,
      [hashPin(pinAdmin), hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'utc-master', wd, true, '10:00', '20:00' FROM generate_series(1, 7) AS wd`
    );
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('utc-master', 'strizhka', 2000, 40)`);

    const loginRes = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'utc-admin@test.local', pin: pinAdmin }),
    });
    const { token } = await loginRes.json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const today = daysFromToday(0);

    // 2 walk-in без телефона + 1 с телефоном, сегодня, точка админа.
    for (const [name, time] of [['Ахмед', '11:00'], ['Заур', '12:00']]) {
      const res = await fetch(`${apiUrl}/bookings`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ masterId: 'utc-master', serviceIds: ['strizhka'], date: today, startTime: time, clientName: name, clientPhone: null, channel: 'admin' }),
      });
      if (res.status !== 200) throw new Error(`fixture booking (${name}) → ${res.status}: ${await res.text()}`);
    }
    const withPhoneRes = await fetch(`${apiUrl}/bookings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ masterId: 'utc-master', serviceIds: ['strizhka'], date: today, startTime: '14:00', clientName: 'Мурад', clientPhone: '+79990001122', channel: 'admin' }),
    });
    if (withPhoneRes.status !== 200) throw new Error(`fixture booking (с телефоном) → ${withPhoneRes.status}`);

    // ── Слой 1: контракт бэкенда ────────────────────────────────────────
    const apiRes = await fetch(`${apiUrl}/revenue/today`, { headers: auth });
    const apiBody = await apiRes.json();
    check('GET /revenue/today: unidentifiedCount=2 (Ахмед+Заур, Мурад с телефоном не в счёт)', apiBody.unidentifiedCount === 2, `получено ${apiBody.unidentifiedCount}`);

    // ── Слой 2: живой браузер - карточка на crm-admin.html ──────────────
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1280, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'utc-admin@test.local');
        await s.type('#loginPin', pinAdmin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(900);

        const text = await s.eval(`document.getElementById('unidentifiedTodayCount')?.textContent`);
        check('crm-admin.html: карточка "Неопознанных визитов сегодня" показывает 2', (text || '').trim() === '2', `текст: "${text}"`);
        check('crm-admin.html: не осталась заглушка "считаю…"', !/считаю…/.test(text || ''), `текст: "${text}"`);

        const revenueText = await s.eval(`document.getElementById('revenueTodayAmount')?.textContent`);
        check('crm-admin.html: соседняя карточка "Выручка сегодня" не сломалась (по-прежнему рендерится)', !/считаю…/.test(revenueText || ''), `текст: "${revenueText}"`);

        await s.screenshot('/tmp/okno-unidentified-today-card.png');
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
