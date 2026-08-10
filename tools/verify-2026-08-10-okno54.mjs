// Живая проверка Окна 54 (10.08.2026) - бэкенд-контракт под слияние форм записи
// (Окно 55): Задача A - поиск клиента по телефону (GET /clients?phone=), Задача B -
// перенос записи (PATCH /bookings/:id/reschedule). Чистый API, без CDP - в этом окне
// фронтенда нет вообще по условию ТЗ.
//
// Прогон полностью автономен: своя одноразовая база + свой сервер на эфемерном порту
// (withEphemeralServer), QA-фикстуры сеются ЗДЕСЬ прямыми INSERT, не миграцией -
// правило проекта после инцидента 04.08.2026 с 031_cleanup_qa_window19.sql (CLAUDE.md).
// Прод не трогается ни на одном шаге.
import { withEphemeralServer, hashPin, randomPin, daysFromToday, makeChecker } from './verify-lib.mjs';

const { check, summary } = makeChecker();

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pinOwner = randomPin();
  const pinAdmin = randomPin();
  const pinMaster = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('w54-owner',  NULL, 'QA Владелец',   'owner',  true, false, true, 'w54-owner@test.local',  $1),
     ('w54-admin',  1,    'QA Админ',      'admin',  true, false, true, 'w54-admin@test.local',  $2),
     ('w54-m1',     1,    'QA Мастер 1',   'master', true, true,  true, 'w54-m1@test.local',     $3),
     ('w54-m2',     1,    'QA Мастер 2',   'master', true, true,  true, 'w54-m2@test.local',     $4),
     ('w54-m-off',  1,    'QA Без графика','master', true, true,  true, 'w54-moff@test.local',   $5)`,
    [hashPin(pinOwner), hashPin(pinAdmin), hashPin(pinMaster), hashPin(randomPin()), hashPin(randomPin())]
  );
  // m1 и m2 работают все 7 дней 10:00-20:00; m-off намеренно без единой строки
  // графика (рубеж master_not_bookable).
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT m, wd, true, '10:00', '20:00' FROM generate_series(1, 7) AS wd, unnest(ARRAY['w54-m1','w54-m2']) AS m`
  );
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
     ('w54-m1', 'strizhka', 2000, 40),
     ('w54-m2', 'strizhka', 2200, 60),
     ('w54-m-off', 'strizhka', 2000, 40)`
  );

  async function login(email, pin) {
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin }),
    });
    const { token } = await res.json();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
  const owner = await login('w54-owner@test.local', pinOwner);
  const admin = await login('w54-admin@test.local', pinAdmin);
  const master = await login('w54-m1@test.local', pinMaster);

  const day = daysFromToday(3); // заведомо будущее - past_time не мешает
  const dayNext = daysFromToday(4);

  async function book(headers, { masterId, date, startTime, clientName, clientPhone }) {
    const res = await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers,
      body: JSON.stringify({ masterId, serviceIds: ['strizhka'], date, startTime, clientName, clientPhone, channel: 'admin' }),
    });
    return { status: res.status, data: await res.json() };
  }

  // ══ ЗАДАЧА A - поиск клиента по телефону ═══════════════════════════════════
  console.log('\n── Задача A: GET /clients?phone= ──');

  // Клиент заводится тем же путём, что в реальной жизни - через сохранение брони
  // (INSERT ... ON CONFLICT (phone)), а не прямым INSERT в clients: проверяем поиск
  // ровно по тем данным, которые реально накапливает прод.
  const seeded = await book(owner, { masterId: 'w54-m1', date: day, startTime: '11:00', clientName: 'Сергей', clientPhone: '+7 999 123 45 67' });
  check('фикстура: бронь с телефоном создана', seeded.status === 200 && seeded.data.ok === true);

  const foundRes = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent('+7 999 123 45 67')}`, { headers: owner });
  const found = await foundRes.json();
  check('Сценарий 1: существующий телефон - 200', foundRes.status === 200);
  check('Сценарий 1: карточка с id/name/phone/noShowStreak/risk', !!found.id && found.name === 'Сергей' && found.phone === '+7 999 123 45 67' && found.noShowStreak === 0 && !!found.risk);
  check('Сценарий 1: lastVisit с мастером и услугами последнего визита', found.lastVisit?.masterId === 'w54-m1' && found.lastVisit?.services?.[0]?.id === 'strizhka');

  const missRes = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent('+79995550000')}`, { headers: owner });
  const miss = await missRes.json();
  check('Сценарий 2: несуществующий телефон - 404 client_not_found', missRes.status === 404 && miss.error === 'client_not_found');

  // Сценарий 3 - те же цифры в разных форматах находят ОДНОГО клиента. Ключевой
  // сценарий окна: в базе телефон лежит с пробелами (публичный виджет), а
  // администратор в Окне 55 наберёт как придётся.
  const formats = ['+79991234567', '8 999 123-45-67', '89991234567', '9991234567', '8(999)123-45-67'];
  const idsByFormat = [];
  for (const raw of formats) {
    const r = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent(raw)}`, { headers: owner });
    const d = await r.json();
    idsByFormat.push(`${r.status}:${d.id ?? d.error}`);
  }
  check(
    `Сценарий 3: ${formats.length} форматов одного номера - один и тот же клиент`,
    new Set(idsByFormat).size === 1 && idsByFormat[0] === `200:${found.id}`,
    JSON.stringify(idsByFormat)
  );

  const masterViewRes = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent('+79991234567')}`, { headers: master });
  const masterView = await masterViewRes.json();
  check('Сценарий 4: мастер получает карточку, но БЕЗ телефона', masterViewRes.status === 200 && masterView.id === found.id && !('phone' in masterView));
  check('Сценарий 4: мастер видит в истории только свои визиты', masterView.visits.every((v) => v.masterId === 'w54-m1'));

  const noParamRes = await fetch(`${apiUrl}/clients`, { headers: owner });
  const noParam = await noParamRes.json();
  check('Сценарий 5: без phone и risk - прежние 400 missing_fields', noParamRes.status === 400 && noParam.error === 'missing_fields');

  const riskRes = await fetch(`${apiUrl}/clients?risk=true`, { headers: owner });
  check('регресс: ветка ?risk=true не сломана (200, массив)', riskRes.status === 200 && Array.isArray(await riskRes.json()));

  const anonRes = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent('+79991234567')}`);
  check('без токена телефон клиента не отдаётся (401)', anonRes.status === 401);

  // ══ ЗАДАЧА B - перенос записи ══════════════════════════════════════════════
  console.log('\n── Задача B: PATCH /bookings/:id/reschedule ──');

  async function reschedule(headers, id, payload) {
    const res = await fetch(`${apiUrl}/bookings/${encodeURIComponent(id)}/reschedule`, {
      method: 'PATCH', headers, body: JSON.stringify(payload),
    });
    return { status: res.status, data: await res.json() };
  }
  async function bookingById(id) {
    const r = await db.query('SELECT master_id, location_id, to_char(date, \'YYYY-MM-DD\') AS date, start_time, end_time, status FROM bookings WHERE id = $1', [id]);
    return r.rows[0];
  }

  // Сценарий 1 - перенос на свободный слот ДРУГОГО мастера.
  const movable = seeded.data.booking.id;
  const before = await bookingById(movable);
  const moved = await reschedule(owner, movable, { masterId: 'w54-m2', date: dayNext, startTime: '15:00' });
  const after = await bookingById(movable);
  check('Сценарий 1: перенос на свободный слот другого мастера - 200', moved.status === 200 && moved.data.ok === true);
  check('Сценарий 1: та же строка обновлена (master/date/start)', after.master_id === 'w54-m2' && after.date === dayNext && after.start_time === '15:00');
  check('Сценарий 1: длительность пересчитана по прайсу НОВОГО мастера (60 мин у m2 против 40 у m1)', after.end_time === '16:00');
  check('Сценарий 1: id брони не изменился (booking_services/actual_price остались на нём)', !!(await bookingById(movable)));
  const oldSlotFree = await book(owner, { masterId: 'w54-m1', date: day, startTime: '11:00', clientName: 'Проверка', clientPhone: '+79990000001' });
  check('Сценарий 1: СТАРЫЙ слот освободился - на него встаёт новая запись', oldSlotFree.status === 200 && oldSlotFree.data.ok === true);

  // Сценарий 2 - перенос на уже занятый слот.
  const blocker = await book(owner, { masterId: 'w54-m2', date: dayNext, startTime: '17:00', clientName: 'Занял', clientPhone: '+79990000002' });
  check('фикстура: занимающая бронь создана', blocker.status === 200);
  const beforeConflict = await bookingById(movable);
  const conflict = await reschedule(owner, movable, { masterId: 'w54-m2', date: dayNext, startTime: '17:30' });
  const afterConflict = await bookingById(movable);
  check('Сценарий 2: перенос на занятый слот - 409 overlap (тот же код, что у создания)', conflict.status === 409 && conflict.data.reason === 'overlap');
  check('Сценарий 2: исходная запись НЕ изменена', JSON.stringify(afterConflict) === JSON.stringify(beforeConflict));

  // Сценарий 3 - вне рабочего графика (до начала смены) и мастер без графика вовсе.
  const outside = await reschedule(owner, movable, { masterId: 'w54-m2', date: dayNext, startTime: '08:00' });
  check('Сценарий 3: слот вне рабочего окна - 409 schedule_blocked', outside.status === 409 && outside.data.reason === 'schedule_blocked');
  const notBookable = await reschedule(owner, movable, { masterId: 'w54-m-off', date: dayNext, startTime: '15:00' });
  check('Сценарий 3: мастер без единого рабочего дня - 409 master_not_bookable', notBookable.status === 409 && notBookable.data.reason === 'master_not_bookable');

  // Сценарий 4 - "без изменений": запись не конфликтует сама с собой.
  const noop = await reschedule(owner, movable, { masterId: 'w54-m2', date: dayNext, startTime: '15:00' });
  const afterNoop = await bookingById(movable);
  check('Сценарий 4: перенос без изменений - 200, не ложный конфликт с самой собой', noop.status === 200 && noop.data.ok === true);
  check('Сценарий 4: запись осталась на своём месте', afterNoop.master_id === 'w54-m2' && afterNoop.date === dayNext && afterNoop.start_time === '15:00');

  // Сценарий 5 - отменённая запись.
  const cancelMe = await book(owner, { masterId: 'w54-m1', date: dayNext, startTime: '12:00', clientName: 'Отменённый', clientPhone: '+79990000003' });
  await fetch(`${apiUrl}/bookings/${encodeURIComponent(cancelMe.data.booking.id)}/cancel`, { method: 'POST', headers: owner });
  const cancelledMove = await reschedule(owner, cancelMe.data.booking.id, { masterId: 'w54-m1', date: dayNext, startTime: '13:00' });
  check('Сценарий 5: перенос отменённой записи - 409 booking_cancelled', cancelledMove.status === 409 && cancelledMove.data.error === 'booking_cancelled');

  // Сценарий 6 - гонка: два РАЗНЫХ переноса на один и тот же новый слот
  // одновременно. Проходит ровно один, второй получает overlap.
  const racerA = await book(owner, { masterId: 'w54-m1', date: dayNext, startTime: '10:00', clientName: 'Гонка А', clientPhone: '+79990000004' });
  const racerB = await book(owner, { masterId: 'w54-m1', date: dayNext, startTime: '14:00', clientName: 'Гонка Б', clientPhone: '+79990000005' });
  const [resA, resB] = await Promise.all([
    reschedule(owner, racerA.data.booking.id, { masterId: 'w54-m2', date: dayNext, startTime: '18:00' }),
    reschedule(owner, racerB.data.booking.id, { masterId: 'w54-m2', date: dayNext, startTime: '18:00' }),
  ]);
  const okCount = [resA, resB].filter((r) => r.status === 200).length;
  const conflictCount = [resA, resB].filter((r) => r.status === 409 && r.data.reason === 'overlap').length;
  check('Сценарий 6: гонка двух переносов на один слот - ровно один прошёл', okCount === 1, `A=${resA.status}/${resA.data.reason ?? 'ok'} B=${resB.status}/${resB.data.reason ?? 'ok'}`);
  check('Сценарий 6: второй получил 409 overlap, а не 500 и не дубль', conflictCount === 1);
  const slot18 = await db.query(`SELECT count(*) FROM bookings WHERE master_id = 'w54-m2' AND date = $1 AND start_time = '18:00' AND status != 'cancelled'`, [dayNext]);
  check('Сценарий 6: в базе на спорном слоте ровно одна запись', Number(slot18.rows[0].count) === 1);

  // Роли и чужие точки.
  const masterTry = await reschedule(master, movable, { masterId: 'w54-m1', date: dayNext, startTime: '11:00' });
  check('роли: мастер переносить не может - 401 (та же матрица, что у удаления/actual-price)', masterTry.status === 401);
  const adminOk = await reschedule(admin, movable, { masterId: 'w54-m2', date: dayNext, startTime: '15:00' });
  check('роли: администратор своей точки переносит штатно - 200', adminOk.status === 200);
  const missing = await reschedule(owner, 'booking-которой-нет', { masterId: 'w54-m2', date: dayNext, startTime: '15:00' });
  check('несуществующая бронь - 404 booking_not_found', missing.status === 404 && missing.data.error === 'booking_not_found');
  const noFields = await fetch(`${apiUrl}/bookings/${encodeURIComponent(movable)}/reschedule`, { method: 'PATCH', headers: owner, body: JSON.stringify({ masterId: 'w54-m2' }) });
  check('без date/startTime - 400 missing_fields', noFields.status === 400);
  const anonMove = await fetch(`${apiUrl}/bookings/${encodeURIComponent(movable)}/reschedule`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterId: 'w54-m2', date: dayNext, startTime: '15:00' }),
  });
  check('аноним переносить не может - 401 (реестр ROUTES, default-deny)', anonMove.status === 401);

  // ══ ЗАДАЧА C - уведомления при переносе ════════════════════════════════════
  // Решение Влада «да, сообщить». Здесь проверяется именно то, что офлайн-тест
  // проверить не может: реальные уникальные индексы миграции 015 в паре с
  // ON CONFLICT DO UPDATE (режим refresh) и новые типы из миграции 042 - то есть
  // что CHECK-constraint пропускает 'booking_moved_out'/'booking_moved_in', и что
  // повторный перенос обновляет уведомление вместо молчаливого проглатывания.
  console.log('\n── Задача C: уведомления при переносе ──');

  async function notifications(staffId, bookingId) {
    const r = await db.query(
      'SELECT type, title, body, read_at FROM notifications WHERE staff_id = $1 AND booking_id = $2 ORDER BY type',
      [staffId, bookingId]
    );
    return r.rows;
  }

  const notifyMe = await book(owner, { masterId: 'w54-m1', date: dayNext, startTime: '16:00', clientName: 'Уведомлённый', clientPhone: '+79990000006' });
  const notifyId = notifyMe.data.booking.id;
  check('фикстура: бронь для проверки уведомлений создана', notifyMe.status === 200);

  // Перенос №1: смена мастера внутри точки.
  const move1 = await reschedule(owner, notifyId, { masterId: 'w54-m2', date: dayNext, startTime: '19:00' });
  check('Задача C: перенос прошёл и вернул число адресатов', move1.status === 200 && typeof move1.data.booking.notified === 'number' && move1.data.booking.notified > 0, `notified=${move1.data.booking.notified}`);
  const oldMaster1 = await notifications('w54-m1', notifyId);
  const newMaster1 = await notifications('w54-m2', notifyId);
  check('Задача C: СТАРЫЙ мастер получил booking_moved_out (новый тип прошёл CHECK миграции 042)', oldMaster1.some((n) => n.type === 'booking_moved_out'));
  check('Задача C: в тексте старому мастеру есть куда ушла (имя нового мастера и новое время)', oldMaster1.find((n) => n.type === 'booking_moved_out')?.body?.includes('QA Мастер 2') && oldMaster1.find((n) => n.type === 'booking_moved_out')?.body?.includes('19:00'));
  check('Задача C: НОВЫЙ мастер получил booking_moved_in', newMaster1.some((n) => n.type === 'booking_moved_in'));
  const admin1 = await notifications('w54-admin', notifyId);
  check('Задача C: админ точки получил booking_moved_in (одна строка, не две)', admin1.filter((n) => n.type === 'booking_moved_in').length === 1);
  check('Задача C: перенос внутри одной точки НЕ порождает админу "ушла с точки"', !admin1.some((n) => n.type === 'booking_moved_out'));

  // Перенос №2 той же брони - без него дедуп-индекс notifications_booking_dedup
  // молча проглотил бы уведомление, и первое осталось бы врать про время.
  // Сравниваем именно С ТЕКСТОМ ДО второго переноса: наличие/отсутствие конкретного
  // времени в body ничего не доказывает - в формате "было → стало" старое время
  // законно остаётся в строке как точка отсчёта.
  const bodyBefore = newMaster1.find((n) => n.type === 'booking_moved_in')?.body;
  await db.query('UPDATE notifications SET read_at = now() WHERE booking_id = $1', [notifyId]);
  const move2 = await reschedule(owner, notifyId, { masterId: 'w54-m2', date: dayNext, startTime: '11:00' });
  check('фикстура: второй перенос той же брони прошёл', move2.status === 200);
  const newMaster2 = await notifications('w54-m2', notifyId);
  const moveIn2 = newMaster2.find((n) => n.type === 'booking_moved_in');
  check('Задача C: повторный перенос ОБНОВИЛ уведомление, а не был проглочен дедупом', !!moveIn2 && moveIn2.body !== bodyBefore && moveIn2.body.includes('11:00'), `было: ${bodyBefore} · стало: ${moveIn2?.body}`);
  check('Задача C: обновлённое уведомление снова непрочитанное - повторный перенос это новая информация', moveIn2?.read_at === null);
  check('Задача C: у нового мастера всё равно ОДНА строка на бронь, не две', newMaster2.filter((n) => n.type === 'booking_moved_in').length === 1);

  // Перенос №3 - обратно к первому мастеру: у него не должно остаться двух
  // взаимоисключающих утверждений об одной брони («ушла» и «у вас»). Смотрим только
  // типы переноса: booking_new с момента создания брони - другое событие, живёт своей
  // жизнью и сниматься не должно.
  const move3 = await reschedule(owner, notifyId, { masterId: 'w54-m1', date: dayNext, startTime: '11:00' });
  check('фикстура: перенос обратно к первому мастеру прошёл', move3.status === 200);
  const oldMaster3 = await notifications('w54-m1', notifyId);
  const moveTypes3 = oldMaster3.map((n) => n.type).filter((t) => t.startsWith('booking_moved_'));
  check('Задача C: у вернувшегося мастера остался только booking_moved_in, "ушла" снята', moveTypes3.join(',') === 'booking_moved_in', oldMaster3.map((n) => n.type).join(','));
  check('Задача C: уведомление о СОЗДАНИИ брони при этом не пострадало', oldMaster3.some((n) => n.type === 'booking_new'));

  // Перенос «без изменений» - не должен добавить ни строки.
  const beforeNoop = await db.query('SELECT count(*) FROM notifications WHERE booking_id = $1', [notifyId]);
  await reschedule(owner, notifyId, { masterId: 'w54-m1', date: dayNext, startTime: '11:00' });
  const afterNoopCount = await db.query('SELECT count(*) FROM notifications WHERE booking_id = $1', [notifyId]);
  check('Задача C: перенос без изменений не добавил уведомлений', beforeNoop.rows[0].count === afterNoopCount.rows[0].count);

  // Уведомления реально видны в личном кабинете, а не только лежат в таблице.
  const bellRes = await fetch(`${apiUrl}/notifications`, { headers: master });
  const bell = await bellRes.json();
  check('Задача C: уведомление о переносе отдаётся через GET /notifications мастеру', bellRes.status === 200 && bell.some((n) => n.type === 'booking_moved_in' && n.bookingId === notifyId), JSON.stringify(bell.map((n) => n.type)));

  // Ни одна из проверок выше не должна была создать уведомление тому, кто к брони
  // отношения не имеет. Допустимый круг считается ИЗ БАЗЫ, а не списком QA-аккаунтов:
  // на точке 1 сидит ещё и Мамедхан (master-2) из базовых миграций - он реальный
  // админ этой точки и адресат законный. Хардкод "только w54-*" ловил бы его как
  // постороннего и врал бы про утечку.
  const allowed = await db.query(
    `SELECT id FROM staff WHERE id IN ('w54-m1','w54-m2') OR (role = 'admin' AND location_id = 1)`
  );
  const allowedIds = allowed.rows.map((r) => r.id);
  const strangers = await db.query(
    `SELECT DISTINCT staff_id FROM notifications
     WHERE booking_id = $1 AND type IN ('booking_moved_out','booking_moved_in')
       AND staff_id <> ALL($2)`,
    [notifyId, allowedIds]
  );
  check('Задача C: уведомления о переносе не ушли посторонним (владелец не адресат)', strangers.rows.length === 0, JSON.stringify(strangers.rows));
  check('Задача C: владелец точно НЕ в числе адресатов переноса', (await notifications('w54-owner', notifyId)).length === 0);
});

if (!summary()) process.exit(1);
