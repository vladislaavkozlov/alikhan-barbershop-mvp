// Живая проверка фикса "имя walk-in клиента терялось без телефона" (найдено
// живьём в Окне 53, Задача J; решение Алихана - плата 09.08.2026, память
// project_barbershop-owner-schedule-bugfixes-okno53-09-08). Чистый API, без CDP -
// баг был на уровне бэкенда (createBookingTx/listBookingsForRequest), не UI.
import { withEphemeralServer, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) {
    passed++;
    console.log(`  OK: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pinOwner = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('wn-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'wn-owner@test.local', $1),
     ('wn-master', NULL, 'QA Мастер', 'master', true, true, true, 'wn-master@test.local', $2)`,
    [hashPin(pinOwner), hashPin(randomPin())]
  );
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'wn-master', wd, true, '10:00', '20:00' FROM generate_series(1, 7) AS wd`
  );
  await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('wn-master', 'strizhka', 2000, 40)`);

  const loginRes = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'wn-owner@test.local', pin: pinOwner }),
  });
  const { token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const today = daysFromToday(0);

  // 1) Walk-in БЕЗ телефона, только имя - ровно воспроизводимый баг.
  const noPhoneRes = await fetch(`${apiUrl}/bookings`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ masterId: 'wn-master', serviceIds: ['strizhka'], date: today, startTime: '11:00', clientName: 'Ахмед', clientPhone: null, channel: 'admin' }),
  });
  const noPhoneData = await noPhoneRes.json();
  check('POST /bookings без телефона - 200 ok', noPhoneRes.status === 200 && noPhoneData.ok === true);
  check('ответ POST уже содержит clientName (было и до фикса - в базе терялось)', noPhoneData.booking?.clientName === 'Ахмед');

  // 2) Walk-in С телефоном - обычный путь, не должен был сломаться.
  const withPhoneRes = await fetch(`${apiUrl}/bookings`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ masterId: 'wn-master', serviceIds: ['strizhka'], date: today, startTime: '13:00', clientName: 'Мурад', clientPhone: '+79990001122', channel: 'admin' }),
  });
  const withPhoneData = await withPhoneRes.json();
  check('POST /bookings с телефоном - 200 ok', withPhoneRes.status === 200 && withPhoneData.ok === true);

  // 3) Ключевая проверка - GET /bookings (то, что реально видит CRM) отдаёт имя
  // ОБОИХ, не только клиента с телефоном.
  const listRes = await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth });
  const list = await listRes.json();
  const noPhoneBooking = list.bookings.find((b) => b.id === noPhoneData.booking.id);
  const withPhoneBooking = list.bookings.find((b) => b.id === withPhoneData.booking.id);
  check('GET /bookings: имя клиента БЕЗ телефона сохранилось (раньше было null/"Без имени")', noPhoneBooking?.clientName === 'Ахмед');
  check('GET /bookings: телефон клиента без телефона - явно пусто (не выдумываем)', !noPhoneBooking?.clientPhone);
  check('GET /bookings: клиент С телефоном по-прежнему работает как раньше', withPhoneBooking?.clientName === 'Мурад' && withPhoneBooking?.clientPhone === '+79990001122');

  // 4) clients-таблица - в неё попал ТОЛЬКО клиент с телефоном (решение Алихана:
  // не выдумывать identity без уникального ключа).
  const clientsCountRes = await db.query('SELECT count(*) FROM clients');
  check('в таблице clients ровно 1 запись (только Мурад, Ахмед туда не попал)', Number(clientsCountRes.rows[0].count) === 1);

  // 5) countUnidentifiedToday / GET /revenue/today - неидентифицированный визит
  // виден и посчитан.
  const revRes = await fetch(`${apiUrl}/revenue/today`, { headers: auth });
  const rev = await revRes.json();
  check('GET /revenue/today: unidentifiedCount = 1 (ровно бронь Ахмеда)', rev.unidentifiedCount === 1);
});

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
