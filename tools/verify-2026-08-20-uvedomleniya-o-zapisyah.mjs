// Живой прогон (20.08.2026): раздел «Уведомления» и колокольчик показывают одно и то
// же - записи клиентов, - и из уведомления можно провалиться в саму запись и написать
// клиенту. Своя одноразовая база, свой одноразовый сервер, свой статический сервер -
// боевой прод не трогается вовсе.
//
// Что доказываем на сервере:
//   1. запись клиента создаёт уведомление СРАЗУ, и владелец его получает (до правки -
//      только мастер и админ точки)
//   2. лента отдаёт саму запись: дату, время, мастера, клиента, услуги
//   3. телефон клиента в ленте виден владельцу и НЕ виден мастеру (разд.12 п.1)
//   4. типов, кроме записевых, в базе не появляется - CHECK миграции 051 отбивает
//   5. роутов заявок на график больше нет (404), форма мастера осталась бы без сервера
//
// Что доказываем в живом браузере (crm-owner.html):
//   6. раздел «Уведомления» показывает карточку записи, а не заявки на график
//   7. на карточке есть «Открыть запись» и кнопки связи с клиентом
//   8. клик по «Открыть запись» уводит в «Расписание» на дату записи и открывает её
//   9. колокольчик показывает ту же запись сжатой строкой
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  const data = await res.json();
  return data.token;
}

async function api(apiUrl, path, method, token, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const DATE = daysFromToday(2);
const CLIENT_PHONE = '+7 900 111-22-33';

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('nv-owner', 1, 'QA Владелец', 'owner', true, false, true, 'nv-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('nv-master', 1, 'QA Мастер', 'master', true, true, true, 'nv-master@alikhan.test', $1)`,
      [hashPin(masterPin)]
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min)
       SELECT 'nv-master', id, price, duration_min FROM services`
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'nv-master', g, true, '10:00', '20:00' FROM generate_series(1, 7) g
       ON CONFLICT DO NOTHING`
    );

    const ownerToken = await login(apiUrl, 'nv-owner@alikhan.test', ownerPin);
    const masterToken = await login(apiUrl, 'nv-master@alikhan.test', masterPin);
    check('вход владельца и мастера', !!ownerToken && !!masterToken);

    const serviceRow = await db.query('SELECT id, duration_min FROM services ORDER BY sort_order NULLS LAST, id LIMIT 1');
    const serviceId = serviceRow.rows[0].id;

    // Запись создаёт КЛИЕНТ с публичного сайта (без токена) - главный сценарий Влада
    // «уведомление приходит сразу, как записался клиент»
    const created = await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'nv-master',
      serviceIds: [serviceId],
      date: DATE,
      startTime: '12:00',
      clientName: 'Пётр Тестов',
      clientPhone: CLIENT_PHONE,
    });
    check('клиент записался с публичного сайта', created.status === 200 && created.data?.ok !== false, JSON.stringify(created.data));
    const bookingId = created.data?.booking?.id;

    // ── 1. уведомление есть у обоих, сразу ────────────────────────────────────
    const ownerFeed = await api(apiUrl, '/notifications', 'GET', ownerToken);
    const masterFeed = await api(apiUrl, '/notifications', 'GET', masterToken);
    const ownerItem = ownerFeed.data?.find((n) => n.bookingId === bookingId);
    const masterItem = masterFeed.data?.find((n) => n.bookingId === bookingId);
    check('владелец получил уведомление о новой записи', !!ownerItem, JSON.stringify(ownerFeed.data));
    check('мастер получил уведомление о своей записи', !!masterItem, JSON.stringify(masterFeed.data));
    check('тип уведомления - booking_new', ownerItem?.type === 'booking_new', ownerItem?.type);

    // ── 2. лента несёт саму запись ────────────────────────────────────────────
    check('в ленте есть дата записи', ownerItem?.booking?.date === DATE, JSON.stringify(ownerItem?.booking));
    check('в ленте есть время записи', ownerItem?.booking?.startTime === '12:00', ownerItem?.booking?.startTime);
    check('в ленте есть мастер', ownerItem?.booking?.masterName === 'QA Мастер', ownerItem?.booking?.masterName);
    check('в ленте есть клиент', ownerItem?.booking?.clientName === 'Пётр Тестов', ownerItem?.booking?.clientName);
    check('в ленте есть услуга', !!ownerItem?.booking?.serviceNames, ownerItem?.booking?.serviceNames);

    // ── 3. телефон - по правилу видимости ─────────────────────────────────────
    check('владелец видит телефон клиента в ленте', ownerItem?.booking?.clientPhone === CLIENT_PHONE, ownerItem?.booking?.clientPhone);
    check('мастер НЕ видит телефон клиента в ленте', masterItem?.booking?.clientPhone === null, JSON.stringify(masterItem?.booking));

    // ── 4. лишних типов в базе не появляется ──────────────────────────────────
    const types = await db.query('SELECT DISTINCT type FROM notifications ORDER BY type');
    const typeList = types.rows.map((r) => r.type);
    check(
      'в базе только записевые типы уведомлений',
      typeList.every((t) => ['booking_new', 'booking_moved_out', 'booking_moved_in'].includes(t)),
      JSON.stringify(typeList)
    );
    // CHECK миграции 051 - не декларация, а реальный замок: пробуем вставить снятый тип
    let blocked = false;
    try {
      await db.query(
        `INSERT INTO notifications (id, staff_id, type, title) VALUES ('ntf-probe', 'nv-owner', 'booking_reminder_15', 'проба')`
      );
    } catch {
      blocked = true;
    }
    check('снятый тип booking_reminder_15 база больше не принимает', blocked);

    // ── 4b. XSS: имя клиента приезжает из АНОНИМНОГО POST /bookings с публичного
    // сайта и попадает в ленту. Ровно этим болел старый список уведомлений (найдено
    // живым прогоном 10.08.2026), поэтому проверяем не «есть ли escapeHtml в коде», а
    // что в живом DOM не появился настоящий тег
    const xssName = '<img src=x onerror="window.__xss=1">Злой';
    const xssBooking = await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'nv-master',
      serviceIds: [serviceId],
      date: DATE,
      startTime: '15:00',
      clientName: xssName,
      clientPhone: '+7 900 222-33-44',
    });
    check('запись с опасным именем принята сервером (как и любая другая)', xssBooking.status === 200, JSON.stringify(xssBooking.data));

    // ── 5. заявок на график больше нет ────────────────────────────────────────
    const reqList = await api(apiUrl, '/schedule-requests', 'GET', masterToken);
    const reqPost = await api(apiUrl, '/schedule-requests', 'POST', masterToken, {
      masterId: 'nv-master', requestType: 'day_off', category: 'otgul', dateFrom: DATE, dateTo: DATE,
    });
    check('GET /schedule-requests больше не существует (404)', reqList.status === 404, String(reqList.status));
    check('POST /schedule-requests больше не существует (404)', reqPost.status === 404, String(reqPost.status));

    // ── браузер ───────────────────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 950);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'nv-owner@alikhan.test';
          document.getElementById('loginPin').value = '${ownerPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // ── 6-7. раздел «Уведомления» ───────────────────────────────────────
        await s.eval(`document.querySelector('.app-nav-item[data-section="notifications"], label[for="pt-e"]')?.click()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#notifCenter .ntf-card")')); i++) await sleep(200);

        // Именно карточка нашей записи: лента сортируется свежим вверх, и там уже
        // лежит вторая (проверочная) запись
        const cardSel = `#notifCenter .ntf-card[data-booking-id="${bookingId}"]`;
        const cardText = await s.eval(`document.querySelector('${cardSel}')?.innerText ?? ''`);
        check('раздел показывает карточку записи', /Новая запись/.test(cardText), cardText.slice(0, 200));
        check('на карточке видно, когда придёт клиент', /12:00/.test(cardText), cardText.slice(0, 200));
        check('на карточке видно имя клиента', /Пётр Тестов/.test(cardText), cardText.slice(0, 200));
        check('на карточке видно мастера', /QA Мастер/.test(cardText), cardText.slice(0, 200));

        const xssTag = await s.eval(`JSON.stringify(!!document.querySelector('#notifCenter img[src="x"]'))`);
        const xssFlag = await s.eval(`JSON.stringify(!!window.__xss)`);
        const xssShownAsText = await s.eval(`JSON.stringify(document.querySelector('#notifCenter').innerText.includes('onerror'))`);
        check('опасное имя клиента не стало тегом в разделе', JSON.parse(xssTag) === false);
        check('обработчик из имени клиента не выполнился', JSON.parse(xssFlag) === false);
        check('опасное имя показано как обычный текст', JSON.parse(xssShownAsText) === true);

        const noReqBlock = await s.eval(`!document.getElementById('ownerReqList')`);
        check('блока заявок на график в разделе больше нет', JSON.parse(JSON.stringify(noReqBlock)) === true);

        const links = JSON.parse(await s.eval(
          `JSON.stringify([...document.querySelectorAll('${cardSel} [data-msg-link]')].map(a => a.dataset.msgLink + '|' + a.getAttribute('href')))`
        ));
        check('есть кнопка WhatsApp с номером клиента', links.some((l) => l.startsWith('whatsapp|https://wa.me/79001112233')), JSON.stringify(links));
        check('есть кнопка Telegram с номером клиента', links.some((l) => l.startsWith('telegram|tg://resolve?phone=79001112233')), JSON.stringify(links));
        check('есть кнопки СМС и звонка', links.some((l) => l.startsWith('sms|')) && links.some((l) => l.startsWith('call|')), JSON.stringify(links));
        check('текст сообщения клиенту подставлен в ссылку', links.some((l) => /%D0%90%D0%BB%D0%B8%D1%85%D0%B0%D0%BD/.test(l)), JSON.stringify(links).slice(0, 200));

        await s.screenshot('/tmp/verify-uvedomleniya-razdel.png');

        // ── 8. провал в саму запись ─────────────────────────────────────────
        await s.click(`${cardSel} [data-open-booking]`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`!!document.querySelector('.appt[data-id="${bookingId}"]')`)); i++) await sleep(200);
        const inSchedule = await s.eval(`!!document.querySelector('.appt[data-id="${bookingId}"]')`);
        check('«Открыть запись» привела к самой записи в расписании', JSON.parse(JSON.stringify(inSchedule)) === true);
        const activeSection = await s.eval(`document.querySelector('.app-nav-item.is-active')?.dataset.section ?? ''`);
        check('раздел переключился на «Расписание»', activeSection === 'schedule', activeSection);

        // ── 9. колокольчик показывает то же событие ─────────────────────────
        await s.click('#msgBell');
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.querySelector("#msgList .msg-item")')); i++) await sleep(150);
        const bellText = await s.eval(`document.querySelector('#msgList')?.innerText ?? ''`);
        check('колокольчик показывает ту же запись', /Новая запись/.test(bellText) && /12:00/.test(bellText), bellText.slice(0, 200));
        check('в колокольчике нет кнопок связи - это сжатый вид', JSON.parse(await s.eval(`JSON.stringify(!document.querySelector('#msgList [data-msg-link]'))`)) === true);

        await s.screenshot('/tmp/verify-uvedomleniya-kolokolchik.png');

        // ── 10-13. кабинет мастера: та же лента, но без телефона, и без формы отгула ──
        // Тот же браузер и повторный navigate, НЕ второй withBrowser: tools/cdp.mjs
        // держит debug-порт 9333 жёстко, и два экземпляра подряд гонятся за него -
        // прогон повисает молча (наступали на это раньше, см. память проекта).
        await s.navigate(`${siteUrl}/crm-master.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'nv-master@alikhan.test';
          document.getElementById('loginPin').value = '${masterPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        await s.click('#msgBell');
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.querySelector("#msgList .msg-item")')); i++) await sleep(150);
        const masterBell = await s.eval(`document.querySelector('#msgList')?.innerText ?? ''`);
        check('мастер видит свою запись в колокольчике', /Новая запись/.test(masterBell) && /12:00/.test(masterBell), masterBell.slice(0, 200));
        check('телефона клиента в кабинете мастера нигде нет', !/900.?111/.test(await s.eval('document.body.innerText')));

        const reqFormGone = await s.eval(`JSON.stringify(!document.getElementById('reqSubmitBtn') && !document.getElementById('reqHistory'))`);
        check('формы отгула и истории запросов у мастера больше нет', JSON.parse(reqFormGone) === true);
        // Подсказка живёт в разделе «Личные данные» - открываем его так же, как это
        // делает мастер, и читаем ВИДИМЫЙ текст: innerText закрытого раздела пуст, и
        // проверка по нему зеленела бы или краснела не по делу
        await s.eval(`document.querySelector('.app-nav-item[data-section="profile"], label[for="pt-c"]')?.click()`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval(`JSON.stringify(document.body.innerText.includes('График работы'))`)); i++) await sleep(150);
        await s.eval(`document.querySelectorAll('details.staff-card').forEach(d => { d.open = true; })`);
        await sleep(300);
        const scheduleHint = await s.eval(`JSON.stringify(document.body.innerText.includes('график меняет владелец или администратор'))`);
        check('мастеру объяснено, кто меняет график', JSON.parse(scheduleHint) === true);
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exitCode = 1;
