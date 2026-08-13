// Живая проверка прав управляющего (баг с прода 13.08.2026: Мамедхан менял статус
// визита и получал "Не удалось сохранить: статус визита: HTTP 401").
// Четыре роута держали список ролей литералом ['owner','admin','master'] и роль
// manager из Окна 57 в них не попала:
//   PATCH /bookings/:id/status      - статус визита
//   PATCH /bookings/:id/services    - дописать услугу к записи
//   GET   /clients                  - клиенты в зоне риска и поиск по телефону
//   GET   /clients/:id              - карточка клиента
// Проверяем прямыми запросами к своему одноразовому серверу: управляющий проходит,
// мастер и админ доступ не потеряли, а посторонний по-прежнему получает 401.
import { withEphemeralServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pins = { owner: randomPin(), manager: randomPin(), admin: randomPin(), master: randomPin() };
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o62-owner',   1, 'QA Владелец',    'owner',   true, true,  true, 'o62-owner@test.local',   $1),
       ('o62-manager', 1, 'QA Управляющий', 'manager', true, false, true, 'o62-manager@test.local', $2),
       ('o62-admin',   1, 'QA Админ',       'admin',   true, false, true, 'o62-admin@test.local',   $3),
       ('o62-master',  1, 'QA Мастер',      'master',  true, true,  true, 'o62-master@test.local',  $4)`,
      [hashPin(pins.owner), hashPin(pins.manager), hashPin(pins.admin), hashPin(pins.master)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'o62-master', wd, true, '10:00', '20:00' FROM generate_series(1,7) AS wd`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('o62-master', 'strizhka', 2000, 40), ('o62-master', 'vosk', 500, 15)`
    );

    const login = async (role) => (await (await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `o62-${role}@test.local`, pin: pins[role] }),
    })).json()).token;

    const tokens = {
      owner: await login('owner'),
      manager: await login('manager'),
      admin: await login('admin'),
      master: await login('master'),
    };
    const hdr = (role) => ({ Authorization: `Bearer ${tokens[role]}`, 'Content-Type': 'application/json' });
    const today = daysFromToday(0);

    const makeBooking = async (startTime) => (await (await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: hdr('owner'),
      body: JSON.stringify({ masterId: 'o62-master', serviceIds: ['strizhka'], date: today, startTime, clientName: 'Клиент Прав', clientPhone: '+7 999 222-33-44', channel: 'admin' }),
    })).json()).booking;

    // ── Статус визита ───────────────────────────────────────────────────────
    const b1 = await makeBooking('11:00');
    const statusRes = await fetch(`${apiUrl}/bookings/${encodeURIComponent(b1.id)}/status`, {
      method: 'PATCH', headers: hdr('manager'), body: JSON.stringify({ status: 'done' }),
    });
    check('управляющий меняет статус визита (был 401)', statusRes.status === 200, `HTTP ${statusRes.status}`);
    const { bookings } = await (await fetch(`${apiUrl}/bookings?date=${today}`, { headers: hdr('owner') })).json();
    check('статус реально записался в базу',
      bookings.find((b) => b.id === b1.id)?.status === 'done',
      `status=${bookings.find((b) => b.id === b1.id)?.status}`);

    // ── Услуги записи ───────────────────────────────────────────────────────
    const svcRes = await fetch(`${apiUrl}/bookings/${encodeURIComponent(b1.id)}/services`, {
      method: 'PATCH', headers: hdr('manager'), body: JSON.stringify({ serviceIds: ['vosk'] }),
    });
    check('управляющий дописывает услугу к записи', svcRes.status === 200, `HTTP ${svcRes.status}`);

    // ── Клиенты ─────────────────────────────────────────────────────────────
    // ?risk=true - тот же параметр, что шлёт CRM (assets/crm-clients.js); голый
    // /clients отвечает 400 missing_fields любой роли, это не про права
    const riskRes = await fetch(`${apiUrl}/clients?risk=true`, { headers: hdr('manager') });
    check('управляющий открывает список клиентов в зоне риска', riskRes.status === 200, `HTTP ${riskRes.status}`);
    const lookupRes = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent('+7 999 222-33-44')}`, { headers: hdr('manager') });
    check('управляющий ищет клиента по телефону при записи', lookupRes.status === 200, `HTTP ${lookupRes.status}`);
    const clientId = (await lookupRes.json()).id;
    const cardRes = await fetch(`${apiUrl}/clients/${encodeURIComponent(clientId)}`, { headers: hdr('manager') });
    check('управляющий открывает карточку клиента', cardRes.status === 200, `HTTP ${cardRes.status}`);

    // ── Регрессия: другие роли не потеряли доступ ───────────────────────────
    const b2 = await makeBooking('12:00');
    const masterStatus = await fetch(`${apiUrl}/bookings/${encodeURIComponent(b2.id)}/status`, {
      method: 'PATCH', headers: hdr('master'), body: JSON.stringify({ status: 'done' }),
    });
    check('мастер по-прежнему ставит статус своей записи', masterStatus.status === 200, `HTTP ${masterStatus.status}`);

    const b3 = await makeBooking('13:00');
    const adminStatus = await fetch(`${apiUrl}/bookings/${encodeURIComponent(b3.id)}/status`, {
      method: 'PATCH', headers: hdr('admin'), body: JSON.stringify({ status: 'no_show' }),
    });
    check('админ по-прежнему ставит статус', adminStatus.status === 200, `HTTP ${adminStatus.status}`);

    const anon = await fetch(`${apiUrl}/bookings/${encodeURIComponent(b3.id)}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'planned' }),
    });
    check('без входа статус по-прежнему не поменять', anon.status === 401, `HTTP ${anon.status}`);

    const anonCard = await fetch(`${apiUrl}/clients/${encodeURIComponent(clientId)}`);
    check('карточка клиента без входа закрыта', anonCard.status === 401, `HTTP ${anonCard.status}`);
  });
} catch (err) {
  console.error('ПРОГОН УПАЛ:', err.message);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
