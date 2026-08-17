// Проверка серверной половины живого обновления (17.08.2026) на СВОЁМ одноразовом
// сервере и своей одноразовой базе - боевой прод не трогается вовсе.
//
// Что доказываем:
//   1. GET /events отдаёт поток и не закрывает соединение
//   2. созданная запись прилетает подписчику САМА, без всяких запросов с его стороны
//   3. то же для изменения графика и карточки сотрудника
//   4. GET /changes (фолбэк на случай, если прокси не пропустит поток) двигает отметки
//   5. аноним в поток не попадает
import { withEphemeralServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();

// Читает поток в фоне и складывает пришедшие события в массив
function listen(apiUrl, token) {
  const events = [];
  const state = { events, stop: () => {} };
  (async () => {
    const res = await fetch(`${apiUrl}/events`, { headers: { Authorization: `Bearer ${token}` } });
    state.status = res.status;
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    state.stop = () => reader.cancel().catch(() => {});
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  })().catch(() => {});
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждём событие нужного типа, но не дольше лимита - «мгновенно» должно означать
// доли секунды, а не «когда-нибудь»
async function waitEvent(state, type, limitMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const found = state.events.find((e) => e.type === type);
    if (found) return { found, ms: Date.now() - started };
    await sleep(50);
  }
  return { found: null, ms: limitMs };
}

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pin = randomPin();
  const ownerId = 'vt-owner-live';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Владелец живого обновления', 'owner', true, false, true, 'live-owner@alikhan.test', $2)`,
    [ownerId, hashPin(pin)]
  );
  const masterId = 'vt-master-live';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Мастер живого обновления', 'master', true, true, true, 'live-master@alikhan.test', $2)`,
    [masterId, hashPin(randomPin())]
  );
  // Мастеру нужен рабочий день и услуга, иначе запись не создастся
  // Колонки называются work_start/work_end (миграция 022), не start_time - и неделя
  // здесь 1..7 (1=Пн), а не 0..6
  for (let weekday = 1; weekday <= 7; weekday++) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '09:00', '21:00') ON CONFLICT DO NOTHING`,
      [masterId, weekday]
    );
  }
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     VALUES ($1, 'strizhka', 1000, 60) ON CONFLICT DO NOTHING`,
    [masterId]
  );

  const login = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'live-owner@alikhan.test', pin }),
  });
  const { token } = await login.json();
  check('владелец вошёл', Boolean(token));

  // ── 1. поток открывается и здоровается
  const stream = listen(apiUrl, token);
  const hello = await waitEvent(stream, 'hello', 3000);
  check('GET /events отдаёт поток и не закрывает соединение', Boolean(hello.found), `за ${hello.ms}мс`);

  const health = await (await fetch(`${apiUrl}/health`)).json();
  check('сервер видит подписчика', health.liveSubscribers === 1, `liveSubscribers=${health.liveSubscribers}`);

  // ── 2. новая запись прилетает сама
  const date = daysFromToday(1);
  const before = stream.events.length;
  const created = await fetch(`${apiUrl}/bookings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ masterId, serviceIds: ['strizhka'], date, startTime: '12:00', clientName: 'Живой клиент', channel: 'admin' }),
  });
  const createdBody = await created.json();
  check('запись создана', created.status === 200 && createdBody.ok !== false, JSON.stringify(createdBody).slice(0, 120));

  const bookingEvent = await waitEvent(stream, 'bookings', 3000);
  check('ГЛАВНОЕ: событие о новой записи пришло подписчику само', Boolean(bookingEvent.found), `за ${bookingEvent.ms}мс`);
  check('событие пришло быстрее секунды', bookingEvent.ms < 1000, `${bookingEvent.ms}мс`);
  check('в событии есть дата и мастер', bookingEvent.found?.date === date && bookingEvent.found?.masterId === masterId, JSON.stringify(bookingEvent.found));
  check('подписчик не делал ни одного запроса за данными', stream.events.length > before);

  // ── 3. график и карточка сотрудника
  stream.events.length = 0;
  // Контракт роута - weeklyChanges с workStart/workEnd (api/lib/schedule-core.js,
  // validateWeeklyChanges), не days/startTime: на неверном теле роут отвечает 400 и
  // до publish дело не доходит вовсе
  const weekRes = await fetch(`${apiUrl}/master-weekly-schedule`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ masterId, weeklyChanges: [{ weekday: 1, isWorking: false }] }),
  });
  check('график сохранён', weekRes.status === 200, `статус ${weekRes.status}`);
  const scheduleEvent = await waitEvent(stream, 'schedule', 3000);
  check('изменение графика прилетает подписчику', Boolean(scheduleEvent.found), `за ${scheduleEvent.ms}мс`);

  stream.events.length = 0;
  await fetch(`${apiUrl}/staff/${masterId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Мастер живого обновления', email: 'live-master@alikhan.test', phone: null, locationId: 1, employed: true, providesServices: false }),
  });
  const staffEvent = await waitEvent(stream, 'staff', 3000);
  check('изменение карточки сотрудника прилетает подписчику', Boolean(staffEvent.found), `за ${staffEvent.ms}мс`);
  const scheduleAfterStaff = await waitEvent(stream, 'schedule', 1000);
  check('смена «принимает клиентов» заодно двигает расписание', Boolean(scheduleAfterStaff.found));

  // ── 4. фолбэк опросом
  const changesRes = await fetch(`${apiUrl}/changes`, { headers: { Authorization: `Bearer ${token}` } });
  const changes = await changesRes.json();
  check('GET /changes отвечает отметками времени', changesRes.status === 200 && typeof changes.bookings === 'number', JSON.stringify(changes));
  check('отметки сдвинулись после изменений', changes.bookings > 0 && changes.staff > 0 && changes.schedule > 0, JSON.stringify(changes));

  // ── 5. аноним в поток не попадает
  const anon = await fetch(`${apiUrl}/events`);
  check('аноним в поток не допущен', anon.status === 401, `статус ${anon.status}`);
  await anon.body?.cancel().catch(() => {});

  stream.stop();
  await sleep(300);
  const healthAfter = await (await fetch(`${apiUrl}/health`)).json();
  check('после ухода подписчика реестр пустеет', healthAfter.liveSubscribers === 0, `liveSubscribers=${healthAfter.liveSubscribers}`);
});

process.exit(summary() ? 0 : 1);
