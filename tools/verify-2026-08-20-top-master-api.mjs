// Живой прогон контракта «топ-мастер по услуге» (20.08.2026, Фаза 1 плана
// plans/2026-08-20-top-master-tarif.md). Доказывает на эфемерной базе, что миграция 054
// применяется и что оба потребителя контракта (CRM и публичный сайт) получат то, на что
// будут опираться:
//   1. миграция 054 создала master_services.is_top и bookings.master_tier
//   2. владелец включает топ-услугу и свою цену через PUT /master-services/:m/:s
//   3. цена-мусор (0, дробь, минус, строка) отбивается 400 invalid_price, а не уезжает
//      в прайс каталожной подменой
//   4. GET /master-services и GET /public/masters отдают isTop
//   5. запись к топ-мастеру получает master_tier='top', к обычному - 'standard'
//   6. смена состава услуг пересчитывает тариф (сняли топ-услугу - визит стал обычным)
//   7. перенос записи к другому мастеру считает тариф по НОВОМУ мастеру
import { withEphemeralServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const DATE = daysFromToday(1);

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  return (await res.json()).token;
}

const api = (apiUrl, token) => async (path, method = 'GET', body) => {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('tm-owner', 1, 'QA Владелец', 'owner', true, false, true, 'tm-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    // Два мастера с одинаковым набором услуг: разница будет только в галке «топ» -
    // ровно как у Алихана, где топовость это решение владельца, а не другой каталог
    for (const [id, name] of [['tm-top', 'Топ Мастер'], ['tm-usual', 'Обычный Мастер']]) {
      await db.query(
        `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email)
         VALUES ($1, 1, $2, 'master', true, true, false, $1 || '@alikhan.test')`,
        [id, name]
      );
      await db.query(
        `INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT $1, id, price, duration_min FROM services`,
        [id]
      );
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`,
        [id]
      );
    }

    // ── 1. миграция 054 ──────────────────────────────────────────────────────
    const cols = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'master_services' AND column_name = 'is_top')
           OR (table_name = 'bookings' AND column_name = 'master_tier')`
    );
    check('миграция 054: обе колонки на месте', cols.rows.length === 2, cols.rows.map((r) => `${r.table_name}.${r.column_name}`).join(', '));

    const token = await login(apiUrl, 'tm-owner@alikhan.test', ownerPin);
    const call = api(apiUrl, token);
    check('вход владельца', !!token);

    // ── 2. владелец делает стрижку у tm-top топовой и дороже ────────────────
    const put = await call('/master-services/tm-top/strizhka', 'PUT', { enabled: true, price: 3000, durationMin: 40, isTop: true });
    check('PUT принимает isTop и цену', put.status === 200 && put.data?.isTop === true && put.data?.price === 3000, JSON.stringify(put.data));

    // ── 3. мусор в цене - отказ, а не подмена каталожной ────────────────────
    for (const bad of [0, -100, 1500.5, '2500', null]) {
      const res = await call('/master-services/tm-top/boroda', 'PUT', { enabled: true, price: bad, durationMin: 30 });
      check(`цена ${JSON.stringify(bad)} отбита 400`, res.status === 400 && res.data?.error === 'invalid_price', `${res.status} ${JSON.stringify(res.data)}`);
    }
    const borodaPrice = await db.query(`SELECT price FROM master_services WHERE master_id = 'tm-top' AND service_id = 'boroda'`);
    check('цена бороды в базе не пострадала от отказов', borodaPrice.rows[0].price === 1600, String(borodaPrice.rows[0].price));

    // ── 4. isTop виден обоим потребителям ───────────────────────────────────
    const ms = await call('/master-services');
    const topRow = ms.data.find((r) => r.masterId === 'tm-top' && r.serviceId === 'strizhka');
    const usualRow = ms.data.find((r) => r.masterId === 'tm-usual' && r.serviceId === 'strizhka');
    check('GET /master-services: топ-услуга помечена', topRow?.isTop === true && topRow?.price === 3000, JSON.stringify(topRow));
    check('GET /master-services: обычная услуга не помечена', usualRow?.isTop === false, JSON.stringify(usualRow));

    const pub = await fetch(`${apiUrl}/public/masters`).then((r) => r.json());
    const pubTop = pub.find((m) => m.id === 'tm-top')?.services.find((s) => s.id === 'strizhka');
    const pubUsual = pub.find((m) => m.id === 'tm-usual')?.services.find((s) => s.id === 'strizhka');
    check('публичный виджет видит топ-услугу и её цену', pubTop?.isTop === true && pubTop?.price === 3000, JSON.stringify(pubTop));
    check('публичный виджет видит обычную услугу', pubUsual?.isTop === false && pubUsual?.price === 2000, JSON.stringify(pubUsual));

    // ── 5. тариф записи ─────────────────────────────────────────────────────
    const bookTop = await call('/bookings', 'POST', {
      masterId: 'tm-top', serviceIds: ['strizhka'], date: DATE, startTime: '11:00', clientName: 'Клиент Топ', clientPhone: '+79001112233',
    });
    const bookUsual = await call('/bookings', 'POST', {
      masterId: 'tm-usual', serviceIds: ['strizhka'], date: DATE, startTime: '12:00', clientName: 'Клиент Обычный', clientPhone: '+79004445566',
    });
    check('запись к топ-мастеру создана', bookTop.status === 200 || bookTop.status === 201, JSON.stringify(bookTop.data));
    const tiers = await db.query(`SELECT id, master_id, master_tier FROM bookings ORDER BY start_time`);
    check('визит к топ-мастеру помечен top', tiers.rows[0]?.master_tier === 'top', JSON.stringify(tiers.rows[0]));
    check('визит к обычному мастеру помечен standard', tiers.rows[1]?.master_tier === 'standard', JSON.stringify(tiers.rows[1]));
    check('POST /bookings отработал у обычного мастера', bookUsual.status === 200 || bookUsual.status === 201, JSON.stringify(bookUsual.data));

    const list = await call(`/bookings?date=${DATE}`);
    const listTop = list.data?.bookings?.find((b) => b.masterId === 'tm-top');
    check('GET /bookings отдаёт masterTier', listTop?.masterTier === 'top', JSON.stringify(listTop));

    // ── 6. сняли топ-услугу с визита - тариф вернулся к обычному ────────────
    const topBookingId = tiers.rows[0].id;
    // PUT - полный состав записи (server.mjs), PATCH ниже - дописать услугу к нему
    const setServices = await call(`/bookings/${encodeURIComponent(topBookingId)}/services`, 'PUT', { serviceIds: ['vosk'] });
    check('состав услуг заменён', setServices.status === 200, JSON.stringify(setServices.data));
    const afterSet = await db.query('SELECT master_tier FROM bookings WHERE id = $1', [topBookingId]);
    check('после снятия топ-услуги визит стал обычным', afterSet.rows[0].master_tier === 'standard', String(afterSet.rows[0].master_tier));

    // дописали топ-услугу обратно - визит снова топовый
    const addServices = await call(`/bookings/${encodeURIComponent(topBookingId)}/services`, 'PATCH', { serviceIds: ['strizhka'] });
    check('услуга дописана', addServices.status === 200, JSON.stringify(addServices.data));
    const afterAdd = await db.query('SELECT master_tier FROM bookings WHERE id = $1', [topBookingId]);
    check('дописали топ-услугу - визит снова топовый', afterAdd.rows[0].master_tier === 'top', String(afterAdd.rows[0].master_tier));

    // ── 7. перенос к обычному мастеру считает тариф по нему ─────────────────
    const moved = await call(`/bookings/${encodeURIComponent(topBookingId)}/reschedule`, 'PATCH', {
      masterId: 'tm-usual', date: DATE, startTime: '15:00',
    });
    check('запись перенесена к другому мастеру', moved.status === 200, JSON.stringify(moved.data));
    const afterMove = await db.query('SELECT master_tier FROM bookings WHERE id = $1', [topBookingId]);
    check('после переноса тариф считается по новому мастеру', afterMove.rows[0].master_tier === 'standard', String(afterMove.rows[0].master_tier));
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err);
}

summary();
if (crashed) process.exit(1);
