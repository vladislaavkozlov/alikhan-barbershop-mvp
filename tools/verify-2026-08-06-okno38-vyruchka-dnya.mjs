// Живая проверка Окна 38 - дневная выручка администратору (GET /revenue/today,
// computeRevenueToday) на реальном Postgres, не только на fake-клиенте из
// tests/api.revenue-today.test.js. DoD промпта: "администратор точки видит цифру,
// совпадающую с ручным SUM по sales за сегодня на той же точке; владелец видит
// суммарно по всем точкам, контракт не ломается при второй точке" - здесь ровно
// две точки (locations 1 и 2, засеяны миграцией 002_schema.sql), проверяется и то,
// и другое.
//
// Брони/продажи вставляются НАПРЯМУЮ в БД (тот же приём, что уже применён в
// verify-2026-08-06-okno37-edinyy-rezolver-zp.mjs) - POST /bookings отклоняет
// прошедшие даты, а нам ещё нужна "вчерашняя" продажа, которая НЕ должна попасть
// в сегодняшнюю сумму.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insertBooking(db, { id, locationId, masterId }) {
  await db.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, date, start_time, end_time, status, channel)
     VALUES ($1, $2, $3, 'strizhka', CURRENT_DATE, '10:00', '11:00', 'done', 'admin')`,
    [id, locationId, masterId]
  );
}

async function insertSale(db, { id, bookingId, amount, createdAt }) {
  await db.query(`INSERT INTO sales (id, booking_id, item_name, amount, created_at) VALUES ($1, $2, 'Воск для укладки', $3, $4)`, [
    id,
    bookingId,
    amount,
    createdAt,
  ]);
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinMaster1 = randomPin();
    const pinMaster2 = randomPin();
    const pinAdmin1 = randomPin();
    const pinAdmin2 = randomPin();
    const pinOwner = randomPin();

    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o38-master1', 1, 'QA Мастер Точка 1', 'master', true, true, true, 'o38-master1@test.local', $1),
       ('o38-master2', 2, 'QA Мастер Точка 2', 'master', true, true, true, 'o38-master2@test.local', $2),
       ('o38-admin1', 1, 'QA Админ Точка 1', 'admin', true, false, true, 'o38-admin1@test.local', $3),
       ('o38-admin2', 2, 'QA Админ Точка 2', 'admin', true, false, true, 'o38-admin2@test.local', $4),
       ('o38-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'o38-owner@test.local', $5)`,
      [hashPin(pinMaster1), hashPin(pinMaster2), hashPin(pinAdmin1), hashPin(pinAdmin2), hashPin(pinOwner)]
    );

    // Точка 1: две брони сегодня (мастер уже "провёл" визит), продажи 500+1200 -
    // ожидаемая сумма сегодня 1700. Плюс продажа-ловушка "вчера" (2000) - НЕ
    // должна попасть в сумму, если границы дня посчитаны верно.
    await insertBooking(db, { id: 'o38-b1', locationId: 1, masterId: 'o38-master1' });
    await insertBooking(db, { id: 'o38-b2', locationId: 1, masterId: 'o38-master1' });
    await insertSale(db, { id: 'o38-s1', bookingId: 'o38-b1', amount: 500, createdAt: 'now()' });
    await db.query(`INSERT INTO sales (id, booking_id, item_name, amount, created_at) VALUES ('o38-s2', 'o38-b1', 'Шампунь', 1200, now())`);
    await db.query(
      `INSERT INTO sales (id, booking_id, item_name, amount, created_at) VALUES ('o38-s-yesterday', 'o38-b2', 'Ловушка-вчера', 2000, now() - interval '1 day')`
    );

    // Точка 2: одна продажа сегодня (800) - изолирует Точку 1 от Точки 2.
    await insertBooking(db, { id: 'o38-b3', locationId: 2, masterId: 'o38-master2' });
    await db.query(`INSERT INTO sales (id, booking_id, item_name, amount, created_at) VALUES ('o38-s3', 'o38-b3', 'Гель', 800, now())`);

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

    const authAdmin1 = await login('o38-admin1@test.local', pinAdmin1);
    const authAdmin2 = await login('o38-admin2@test.local', pinAdmin2);
    const authOwner = await login('o38-owner@test.local', pinOwner);
    const authMaster1 = await login('o38-master1@test.local', pinMaster1);

    const getRevenue = async (auth, qs = '') => {
      const res = await fetch(`${apiUrl}/revenue/today${qs}`, { headers: auth });
      return { status: res.status, body: res.status === 200 ? await res.json() : await res.json().catch(() => ({})) };
    };

    // ── Слой 1: контракт бэкенда напрямую ──────────────────────────────────
    const admin1Res = await getRevenue(authAdmin1);
    check('Администратор Точки 1: revenue=1700 (500+1200 сегодня, БЕЗ вчерашней продажи-ловушки 2000)', admin1Res.body.revenue === 1700, `получено ${admin1Res.body.revenue}`);

    const admin2Res = await getRevenue(authAdmin2);
    check('Администратор Точки 2: revenue=800 (изолирован от суммы Точки 1)', admin2Res.body.revenue === 800, `получено ${admin2Res.body.revenue}`);

    // Администратор не может подсмотреть чужую точку, даже явно передав locationId.
    const admin2SpoofRes = await getRevenue(authAdmin2, '?locationId=1');
    check('Администратор Точки 2 с чужим ?locationId=1 в query всё равно видит СВОЮ точку (800), не чужую', admin2SpoofRes.body.revenue === 800, `получено ${admin2SpoofRes.body.revenue}`);

    const ownerAllRes = await getRevenue(authOwner);
    check('Владелец без locationId: revenue=2500 (1700+800, сумма ПО ВСЕМ точкам) - контракт не ломается при второй точке', ownerAllRes.body.revenue === 2500, `получено ${ownerAllRes.body.revenue}`);

    const ownerLoc1Res = await getRevenue(authOwner, '?locationId=1');
    check('Владелец с явным ?locationId=1: revenue=1700 (только эта точка)', ownerLoc1Res.body.revenue === 1700, `получено ${ownerLoc1Res.body.revenue}`);

    const masterRes = await getRevenue(authMaster1);
    check('Мастер получает 401 (роут только owner/admin, тот же уровень доступа, что /sales)', masterRes.status === 401, `статус ${masterRes.status}`);

    const noAuthRes = await fetch(`${apiUrl}/revenue/today`);
    check('без токена - 401', noAuthRes.status === 401);

    // ── Слой 2: живой браузер - crm-admin.html, вкладка "Расписание" (цифра сверху) ──
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-admin.html`);
        await s.setViewport(1280, 1000, true);
        await sleep(400);

        await s.type('#loginEmail', 'o38-admin1@test.local');
        await s.type('#loginPin', pinAdmin1);
        await s.click('#loginForm button[type="submit"]');
        await sleep(900); // login + renderLiveProof

        const text = await s.eval(`document.getElementById('revenueTodayAmount')?.textContent`);
        check('crm-admin.html: "Выручка сегодня" показывает 1 700 ₽ (совпадает с ручным SUM по sales), не "считаю…"', /1[\s ]?700/.test(text || ''), `текст: "${text}"`);
        check('crm-admin.html: не осталась заглушка "считаю…"', !/считаю…/.test(text || ''), `текст: "${text}"`);

        await s.screenshot('/tmp/okno38-revenue-today-admin.png');
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
