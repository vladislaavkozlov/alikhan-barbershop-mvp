// Живая проверка правки клиента у существующей записи (Влад, 16.08.2026:
// "не сохраняются изменения имени и номера в существующей карточке, кнопка
// сохранить неактивна").
//
// Что проверяем на самом деле:
//  1) роут PATCH /bookings/:id/client реально меняет имя и телефон брони;
//  2) телефон в другом формате находит ТОГО ЖЕ клиента, а не заводит второго
//     (unique-индекс clients_phone_key построен на сырой строке, поэтому
//     "+7 903 444 44 44" и "+79034444444" без нормализации дали бы двоих);
//  3) пустой телефон отвязывает бронь от клиента, но имя не теряется (walkin_name);
//  4) в живой форме владельца правка имени ВКЛЮЧАЕТ кнопку "Сохранить изменения"
//     (это и был баг: имя с телефоном не входили в снимок "как было") и после
//     сохранения новое имя приходит с сервера, а не только рисуется на экране.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error(`логин ${email} → ${res.status}`);
  return (await res.json()).token;
}
async function api(apiUrl, path, method, token, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Дата брони - смещение от сегодня, не литерал календаря
const DATE = daysFromToday(3);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vk-owner', 1, 'QA Владелец', 'owner', true, false, true, 'vk-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vk-master', 1, 'QA Мастер', 'master', true, true, true, 'vk-master@alikhan.test', $1)`,
      [hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min)
       SELECT 'vk-master', id, price, duration_min FROM services`
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'vk-master', g, true, '10:00', '20:00' FROM generate_series(1, 7) g
       ON CONFLICT DO NOTHING`
    );

    const token = await login(apiUrl, 'vk-owner@alikhan.test', ownerPin);

    // ── Запись, которую будем править. Клиент с телефоном - как у Влада на скриншоте
    const created = await api(apiUrl, '/bookings', 'POST', token, {
      masterId: 'vk-master',
      serviceIds: ['strizhka'],
      date: DATE,
      startTime: '11:00',
      clientName: 'Владимир',
      clientPhone: '+79034444444',
    });
    const bookingId = created.data?.booking?.id || created.data?.id;
    check('бронь для правки создана', Boolean(bookingId), JSON.stringify(created.data)?.slice(0, 200));
    if (!bookingId) throw new Error('нет id брони - дальше проверять нечего');

    const clientsBefore = Number((await db.query('SELECT count(*)::int AS n FROM clients')).rows[0].n);

    // ── 1. Имя и телефон меняются
    const patched = await api(apiUrl, `/bookings/${bookingId}/client`, 'PATCH', token, {
      clientName: 'Владимир Козлов',
      clientPhone: '+7 903 444 44 44', // ТОТ ЖЕ номер, другой формат
    });
    check('PATCH /bookings/:id/client отвечает ok', patched.status === 200 && patched.data?.ok === true,
      `${patched.status} ${JSON.stringify(patched.data)}`);

    const listed = await api(apiUrl, `/bookings?date=${DATE}`, 'GET', token);
    const row = (listed.data?.bookings || []).find((b) => b.id === bookingId);
    check('имя клиента в записи обновилось', row?.clientName === 'Владимир Козлов', `в выдаче: ${row?.clientName}`);

    const clientsAfter = Number((await db.query('SELECT count(*)::int AS n FROM clients')).rows[0].n);
    check('тот же номер в другом формате не завёл второго клиента', clientsAfter === clientsBefore,
      `было ${clientsBefore}, стало ${clientsAfter}`);

    // ── 2. Другой (новый) номер - заводится новый клиент, бронь уходит к нему
    const moved = await api(apiUrl, `/bookings/${bookingId}/client`, 'PATCH', token, {
      clientName: 'Владимир Козлов',
      clientPhone: '+79051112233',
    });
    const boundTo = (await db.query('SELECT client_id FROM bookings WHERE id = $1', [bookingId])).rows[0].client_id;
    const newClient = (await db.query('SELECT id, name FROM clients WHERE phone = $1', ['+79051112233'])).rows[0];
    check('новый номер привязал бронь к новому клиенту', moved.data?.ok === true && boundTo === newClient?.id,
      `booking.client_id=${boundTo}, новый клиент=${newClient?.id}`);

    // ── 3. Пустой телефон - отвязка, имя остаётся на самой брони
    const unbound = await api(apiUrl, `/bookings/${bookingId}/client`, 'PATCH', token, {
      clientName: 'Аноним',
      clientPhone: '',
    });
    const after = (await db.query('SELECT client_id, walkin_name FROM bookings WHERE id = $1', [bookingId])).rows[0];
    check('пустой телефон отвязывает клиента, имя остаётся на записи',
      unbound.data?.ok === true && after.client_id === null && after.walkin_name === 'Аноним',
      `client_id=${after.client_id}, walkin_name=${after.walkin_name}`);

    // ── 4. Недописанный номер - отказ, а не клиент-обрубок в базе
    const badPhone = await api(apiUrl, `/bookings/${bookingId}/client`, 'PATCH', token, {
      clientName: 'Аноним',
      clientPhone: '+7903',
    });
    check('недописанный номер отклонён', badPhone.status === 400 && badPhone.data?.error === 'invalid_client_phone',
      `${badPhone.status} ${JSON.stringify(badPhone.data)}`);

    // ── 5. Живая форма владельца: кнопка и реальное сохранение
    // Возвращаем записи нормального клиента, чтобы форма открылась как у Влада
    await api(apiUrl, `/bookings/${bookingId}/client`, 'PATCH', token, {
      clientName: 'Владимир',
      clientPhone: '+79034444444',
    });

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
        await s.eval(
          `document.getElementById('loginEmail').value = 'vk-owner@alikhan.test';
           document.getElementById('loginPin').value = '${ownerPin}';
           document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
        );
        await sleep(2500);

        // Открываем запись той же точкой входа, что и клик по карточке в календаре
        const opened = await s.eval(
          `(() => {
             window.openBookingEdit?.({ dataset: {
               id: '${bookingId}', client: 'Владимир', phone: '+79034444444',
               masterId: 'vk-master', master: 'QA Мастер',
               serviceIds: 'strizhka', date: '${DATE}', startTime: '11:00',
               realStatus: 'planned', noshowStreak: '0', requiresPrepayment: 'false',
               actualPrice: '', staffComment: '',
             }, classList: { add() {}, remove() {} } });
             return document.getElementById('wfClientName')?.value ?? null;
           })()`
        );
        check('форма открылась на этой записи с её именем', opened === 'Владимир', `в поле: ${opened}`);

        const disabledBefore = await s.eval(`document.getElementById('wfSubmit')?.disabled`);
        check('до правки кнопка "Сохранить изменения" неактивна', disabledBefore === true, `disabled=${disabledBefore}`);

        // Правим имя и телефон ровно так, как это делает человек - вводом в поле
        await s.eval(
          `(() => {
             const name = document.getElementById('wfClientName');
             const phone = document.getElementById('wfClientPhone');
             name.value = 'Владимир Козлов';
             name.dispatchEvent(new Event('input', { bubbles: true }));
             phone.value = '+79051112233';
             phone.dispatchEvent(new Event('input', { bubbles: true }));
           })()`
        );
        await sleep(300);
        const disabledAfter = await s.eval(`document.getElementById('wfSubmit')?.disabled`);
        check('правка имени и телефона включает кнопку (это и был баг)', disabledAfter === false,
          `disabled=${disabledAfter}`);

        await s.eval(`document.getElementById('wfSubmit')?.click()`);
        await sleep(2000);
        const resultText = await s.eval(`document.getElementById('wfResult')?.textContent?.trim()`);
        check('форма отчиталась об успехе', /Сохранено/.test(resultText || ''), `текст: ${resultText}`);

        // Улика не с экрана, а из базы - экран мог просто нарисовать введённое
        const saved = (await db.query(
          `SELECT COALESCE(c.name, b.walkin_name) AS name, c.phone
             FROM bookings b LEFT JOIN clients c ON c.id = b.client_id WHERE b.id = $1`,
          [bookingId]
        )).rows[0];
        check('в базе новое имя и новый телефон', saved.name === 'Владимир Козлов' && saved.phone === '+79051112233',
          `name=${saved.name}, phone=${saved.phone}`);

        const disabledAgain = await s.eval(`document.getElementById('wfSubmit')?.disabled`);
        check('после сохранения кнопка снова гаснет', disabledAgain === true, `disabled=${disabledAgain}`);
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exit(1);
