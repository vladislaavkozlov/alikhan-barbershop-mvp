// Живой прогон (20.08.2026, решение Влада): об отмене записи узнают мастер, владелец и
// администратор точки, при этом в ленте остаётся ОДНА строка на запись - прежняя
// «Новая запись» переписывается на «Запись отменена», поднимается наверх, снова
// становится непрочитанной и возвращается в колокольчик, даже если её оттуда убрали.
//
// Что доказываем на сервере:
//   1. до отмены у всех троих лежит booking_new по этой брони
//   2. после отмены у каждого ровно ОДНА строка по этой брони, тип booking_cancelled
//   3. строка снова непрочитана и снова видна в колокольчике (даже если была убрана)
//   4. строка поднялась наверх ленты
//   5. отмена не ломается, если уведомлений по брони не было вовсе
//
// Что доказываем в браузере:
//   6. карточка показывает «Запись отменена» и не дублирует это строкой статуса
//   7. текст клиенту предлагает перенос, а не «ждём вас»
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  return (await res.json()).token;
}
async function api(apiUrl, path, method, token, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const DATE = daysFromToday(3);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    const adminPin = randomPin();
    const masterPin = randomPin();
    await db.query(`INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
      VALUES ('ot-owner', 1, 'QA Владелец', 'owner', true, false, true, 'ot-owner@alikhan.test', $1)`, [hashPin(ownerPin)]);
    await db.query(`INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
      VALUES ('ot-admin', 1, 'QA Администратор', 'admin', true, false, true, 'ot-admin@alikhan.test', $1)`, [hashPin(adminPin)]);
    await db.query(`INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
      VALUES ('ot-master', 1, 'QA Мастер', 'master', true, true, true, 'ot-master@alikhan.test', $1)`, [hashPin(masterPin)]);
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT 'ot-master', id, price, duration_min FROM services`);
    await db.query(`INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
      SELECT 'ot-master', g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`);

    const ownerToken = await login(apiUrl, 'ot-owner@alikhan.test', ownerPin);
    const adminToken = await login(apiUrl, 'ot-admin@alikhan.test', adminPin);
    const masterToken = await login(apiUrl, 'ot-master@alikhan.test', masterPin);
    check('вход всех троих', !!ownerToken && !!adminToken && !!masterToken);

    const serviceId = (await db.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0].id;
    const created = await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'ot-master', serviceIds: [serviceId], date: DATE, startTime: '14:00',
      clientName: 'Иван Отменённый', clientPhone: '+7 900 777-66-55',
    });
    const bookingId = created.data?.booking?.id;
    check('запись создана', created.status === 200 && !!bookingId, JSON.stringify(created.data));

    // ── 1. до отмены - booking_new у всех троих ──────────────────────────────
    // В базе, кроме QA-персон, живут штатные Алиовсад (владелец) и Мамедхан
    // (управляющий) из миграции 002 - они тоже законно получают уведомления о записях.
    // Поэтому проверяем не общее число строк, а что нужные роли В ЧИСЛЕ получателей
    const MINE = ['ot-master', 'ot-owner', 'ot-admin'];
    const before = await db.query('SELECT staff_id, type FROM notifications WHERE booking_id = $1 ORDER BY staff_id', [bookingId]);
    const beforeMine = before.rows.filter((r) => MINE.includes(r.staff_id));
    check('до отмены уведомление есть у мастера, владельца и администратора', beforeMine.length === 3 && beforeMine.every((r) => r.type === 'booking_new'), JSON.stringify(before.rows));

    // Владелец разобрал своё уведомление: прочитал и убрал из колокольчика
    const ownerNtf = (await api(apiUrl, '/notifications', 'GET', ownerToken)).data.find((n) => n.bookingId === bookingId);
    await api(apiUrl, `/notifications/${ownerNtf.id}/dismiss`, 'POST', ownerToken);
    const bellBefore = await api(apiUrl, '/notifications?scope=bell', 'GET', ownerToken);
    check('владелец убрал уведомление из колокольчика', !bellBefore.data.some((n) => n.bookingId === bookingId));

    // Вторая запись - чтобы проверить, что отменённая поднимется НАД ней
    await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'ot-master', serviceIds: [serviceId], date: DATE, startTime: '16:00',
      clientName: 'Второй клиент', clientPhone: '+7 900 111-00-99',
    });
    await sleep(1100); // created_at ленты имеет секундную гранулярность - разводим события во времени

    // ── отмена ──────────────────────────────────────────────────────────────
    const cancelled = await api(apiUrl, `/bookings/${bookingId}/cancel`, 'POST', ownerToken);
    check('отмена принята', cancelled.status === 200 && cancelled.data?.status === 'cancelled', JSON.stringify(cancelled.data));

    // ── 2. одна строка на запись, тип booking_cancelled ──────────────────────
    const after = await db.query('SELECT staff_id, type FROM notifications WHERE booking_id = $1 ORDER BY staff_id', [bookingId]);
    // Главное свойство: НИ У КОГО не осталось двух строк об одном визите
    const perStaff = after.rows.reduce((acc, r) => ({ ...acc, [r.staff_id]: (acc[r.staff_id] ?? 0) + 1 }), {});
    check('ни у кого не задвоилось - одна строка на запись', Object.values(perStaff).every((n) => n === 1), JSON.stringify(perStaff));
    check('и это «запись отменена», а не «новая запись»', after.rows.every((r) => r.type === 'booking_cancelled'), JSON.stringify(after.rows));
    check('получатели включают мастера, владельца и администратора', MINE.every((id) => after.rows.some((r) => r.staff_id === id)), JSON.stringify(after.rows.map((r) => r.staff_id)));

    // ── 3. снова непрочитано и снова в колокольчике ──────────────────────────
    const ownerFeed = await api(apiUrl, '/notifications', 'GET', ownerToken);
    const ownerNow = ownerFeed.data.find((n) => n.bookingId === bookingId);
    check('строка снова непрочитана', ownerNow?.read === false, JSON.stringify(ownerNow));
    check('строка вернулась в колокольчик, хотя её убирали', ownerNow?.dismissed === false, JSON.stringify(ownerNow));
    const bellAfter = await api(apiUrl, '/notifications?scope=bell', 'GET', ownerToken);
    check('колокольчик её показывает', bellAfter.data.some((n) => n.bookingId === bookingId));

    // ── 4. наверху ленты ────────────────────────────────────────────────────
    check('отменённая запись стоит первой в ленте', ownerFeed.data[0]?.bookingId === bookingId, JSON.stringify(ownerFeed.data.slice(0, 2).map((n) => `${n.type}:${n.title}`)));
    check('в карточке приехал статус записи', ownerNow?.booking?.status === 'cancelled', ownerNow?.booking?.status);

    // ── 5. отмена без прежних уведомлений не ломается ───────────────────────
    const solo = await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'ot-master', serviceIds: [serviceId], date: DATE, startTime: '18:00', clientName: 'Третий', clientPhone: '+7 900 222-33-44',
    });
    await db.query('DELETE FROM notifications WHERE booking_id = $1', [solo.data.booking.id]);
    const soloCancel = await api(apiUrl, `/bookings/${solo.data.booking.id}/cancel`, 'POST', adminToken);
    const soloAfter = await db.query('SELECT staff_id, type FROM notifications WHERE booking_id = $1', [solo.data.booking.id]);
    check('отмена без прежних уведомлений проходит', soloCancel.status === 200, JSON.stringify(soloCancel.data));
    check('и создаёт уведомления с нуля', MINE.every((id) => soloAfter.rows.some((r) => r.staff_id === id && r.type === 'booking_cancelled')), JSON.stringify(soloAfter.rows));

    // ── браузер ─────────────────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 950);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'ot-owner@alikhan.test';
          document.getElementById('loginPin').value = '${ownerPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);
        await s.eval(`document.querySelector('.app-nav-item[data-section="notifications"], label[for="pt-e"]')?.click()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#notifCenter .ntf-card")')); i++) await sleep(200);

        const sel = `#notifCenter .ntf-card[data-booking-id="${bookingId}"]`;
        const text = await s.eval(`document.querySelector('${sel}')?.innerText ?? ''`);
        check('карточка говорит, что запись отменена', /Запись отменена/.test(text), text.slice(0, 200));
        check('и не повторяет это дважды', (text.match(/Запись отменена/g) || []).length === 1, text.slice(0, 200));
        // Ловушка, на которую наступили: подпись под отменённой записью говорила
        // «перенесена только что». Проверяем словом, а не только фактом наличия строки
        const line = await s.eval(`document.querySelector('${sel} .ntf-time')?.innerText ?? ''`);
        check('подпись говорит «отменена», а не «перенесена»', /отменена/.test(line) && !/перенесена/.test(line), line);

        check('карточка непрочитанная', JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('${sel}.ntf-card--unread'))`)) === true);

        const wa = await s.eval(`document.querySelector('${sel} [data-msg-link="whatsapp"]')?.getAttribute('href') ?? ''`);
        const msg = decodeURIComponent(wa.split('text=')[1] ?? '');
        check('клиенту предлагается перенос, а не «ждём вас»', /отменена/.test(msg) && !/Ждём вас/.test(msg), msg.slice(0, 160));

        await s.screenshot('/tmp/verify-otmena.png');
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exitCode = 1;
