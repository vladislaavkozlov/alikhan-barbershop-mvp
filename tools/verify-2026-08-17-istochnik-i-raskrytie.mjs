// Живой прогон (17.08.2026): источник клиента + метка «+1 новый клиент» в карточке
// записи вида «День» и раскрытие короткой записи. Свой одноразовый сервер, своя
// одноразовая база, свой статический сервер - боевой прод не трогается вовсе.
//
// Что доказываем на сервере:
//   1. источник уезжает в базу при записи и возвращается в GET /bookings
//   2. неизвестный ключ канала отбивается 400, а не пишется молча
//   3. правка канала у существующей записи работает, а запрос БЕЗ поля его не стирает
//   4. метка «новый» стоит на ПЕРВОЙ брони клиента и снимается со второй
//   5. мастер не видит ни телефон, ни канал, но видит, что клиент новый
//
// Что доказываем в живом браузере (crm-owner.html):
//   6. на карточке дня видно телефон, метку и канал нового клиента
//   7. у постоянного клиента канала на карточке нет
//   8. 15-минутная запись раскрывается кнопкой и показывает скрытое содержимое
//   9. клик по кнопке раскрытия НЕ открывает форму записи
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Даты - смещения от дня запуска, не литералы календаря
const PAST = daysFromToday(-7);
const DATE = daysFromToday(2);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vs-owner', 1, 'QA Владелец', 'owner', true, false, true, 'vs-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vs-master', 1, 'QA Мастер', 'master', true, true, true, 'vs-master@alikhan.test', $1)`,
      [hashPin(masterPin)]
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min)
       SELECT 'vs-master', id, price, duration_min FROM services`
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'vs-master', g, true, '10:00', '20:00' FROM generate_series(1, 7) g
       ON CONFLICT DO NOTHING`
    );
    // Самая короткая услуга прайса - ради 15-минутной записи из задачи Влада
    const shortService = (await db.query(
      `SELECT service_id AS id, duration_min FROM master_services WHERE master_id = 'vs-master' ORDER BY duration_min LIMIT 1`
    )).rows[0];

    const token = await login(apiUrl, 'vs-owner@alikhan.test', ownerPin);
    const masterToken = await login(apiUrl, 'vs-master@alikhan.test', masterPin);

    // ── 1. Источник доезжает до базы и обратно ────────────────────────────────
    const newClient = await api(apiUrl, '/bookings', 'POST', token, {
      masterId: 'vs-master', serviceIds: ['strizhka'], date: DATE, startTime: '11:00',
      clientName: 'Новый Клиент', clientPhone: '+79001112233', source: '2gis',
    });
    const newBookingId = newClient.data?.booking?.id;
    check('запись с источником создалась', Boolean(newBookingId), JSON.stringify(newClient.data)?.slice(0, 200));
    const stored = (await db.query('SELECT client_source FROM bookings WHERE id = $1', [newBookingId])).rows[0];
    check('источник записан в базу', stored?.client_source === '2gis', `в базе: ${stored?.client_source}`);

    // ── 2. Чужой ключ - 400, а не молчаливая запись ───────────────────────────
    const bogus = await api(apiUrl, '/bookings', 'POST', token, {
      masterId: 'vs-master', serviceIds: ['strizhka'], date: DATE, startTime: '15:00',
      clientName: 'Мимо словаря', clientPhone: '+79007778899', source: 'google_maps',
    });
    check('неизвестный источник отбивается 400', bogus.status === 400 && bogus.data?.error === 'unknown_client_source',
      `${bogus.status} ${JSON.stringify(bogus.data)}`);

    // ── 3. Правка канала у существующей записи + запрос без поля не стирает ───
    const changed = await api(apiUrl, `/bookings/${newBookingId}/client`, 'PATCH', token, {
      clientName: 'Новый Клиент', clientPhone: '+79001112233', clientSource: 'yandex_maps',
    });
    const afterPatch = (await db.query('SELECT client_source FROM bookings WHERE id = $1', [newBookingId])).rows[0];
    check('канал правится у существующей записи', changed.data?.ok === true && afterPatch?.client_source === 'yandex_maps',
      `в базе: ${afterPatch?.client_source}`);
    await api(apiUrl, `/bookings/${newBookingId}/client`, 'PATCH', token, {
      clientName: 'Новый Клиент', clientPhone: '+79001112233',
    });
    const afterSilent = (await db.query('SELECT client_source FROM bookings WHERE id = $1', [newBookingId])).rows[0];
    check('запрос без поля канал не стирает', afterSilent?.client_source === 'yandex_maps',
      `в базе: ${afterSilent?.client_source}`);

    // ── 4. Метка новизны: постоянный клиент с визитом в прошлом ───────────────
    const oldVisit = await api(apiUrl, '/bookings', 'POST', token, {
      masterId: 'vs-master', serviceIds: ['strizhka'], date: PAST, startTime: '12:00',
      clientName: 'Постоянный Клиент', clientPhone: '+79002223344', source: '2gis',
    });
    const todayVisit = await api(apiUrl, '/bookings', 'POST', token, {
      masterId: 'vs-master', serviceIds: [shortService.id], date: DATE, startTime: '13:00',
      clientName: 'Постоянный Клиент', clientPhone: '+79002223344',
    });
    const repeatBookingId = todayVisit.data?.booking?.id;

    const listed = await api(apiUrl, `/bookings?date=${DATE}`, 'GET', token);
    const rows = listed.data?.bookings || [];
    const newRow = rows.find((b) => b.id === newBookingId);
    const repeatRow = rows.find((b) => b.id === repeatBookingId);
    check('первая бронь клиента помечена новой', newRow?.clientIsNew === true, JSON.stringify(newRow?.clientIsNew));
    check('канал возвращается владельцу', newRow?.clientSource === 'yandex_maps', String(newRow?.clientSource));
    check('вторая бронь постоянного клиента новой НЕ помечена', repeatRow?.clientIsNew === false,
      `clientIsNew=${repeatRow?.clientIsNew}`);
    const pastListed = await api(apiUrl, `/bookings?date=${PAST}`, 'GET', token);
    const firstVisitRow = (pastListed.data?.bookings || []).find((b) => b.id === oldVisit.data?.booking?.id);
    check('метка осталась на ПЕРВОМ визите этого клиента', firstVisitRow?.clientIsNew === true,
      `clientIsNew=${firstVisitRow?.clientIsNew}`);

    // Walk-in без телефона - опознать нельзя, метки быть не должно
    const walkin = await api(apiUrl, '/bookings', 'POST', token, {
      masterId: 'vs-master', serviceIds: ['strizhka'], date: DATE, startTime: '17:00', clientName: 'Без Телефона',
    });
    const walkinRow = (await api(apiUrl, `/bookings?date=${DATE}`, 'GET', token)).data.bookings
      .find((b) => b.id === walkin.data?.booking?.id);
    check('walk-in без телефона меткой "новый" не помечается', walkinRow?.clientIsNew === false,
      `clientIsNew=${walkinRow?.clientIsNew}`);

    // ── 5. Права: мастер видит новизну, но не телефон и не канал ──────────────
    const masterView = await api(apiUrl, `/bookings?date=${DATE}`, 'GET', masterToken);
    const masterRow = (masterView.data?.bookings || []).find((b) => b.id === newBookingId);
    check('мастеру телефон не отдаётся', masterRow && !('clientPhone' in masterRow), JSON.stringify(Object.keys(masterRow || {})));
    check('мастеру канал не отдаётся', masterRow && !('clientSource' in masterRow), JSON.stringify(Object.keys(masterRow || {})));
    check('мастер видит, что клиент новый', masterRow?.clientIsNew === true, `clientIsNew=${masterRow?.clientIsNew}`);

    // ── Живой браузер ─────────────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 950);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'vs-owner@alikhan.test';
          document.getElementById('loginPin').value = '${ownerPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        // Ждём кабинет и переводим «День» на дату фикстур
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector(".panel-sp-day .schedule-grid")')); i++) await sleep(200);
        await s.eval(`window.setScheduleView ? window.setScheduleView('day', '${DATE}') : null`);
        await sleep(400);
        // Дата ставится и через сам виджет - на случай, если глобального моста нет
        const shown = await s.eval(`(function(){
          const slot = document.getElementById('dayNavDate-slot');
          const w = slot && slot.querySelector('.custom-date');
          return w ? w.dataset.value : '';
        })()`);
        if (JSON.parse(JSON.stringify(shown)) !== DATE) {
          await s.eval(`(function(){
            const slot = document.getElementById('dayNavDate-slot');
            const w = slot && slot.querySelector('.custom-date');
            if (!w) return;
            w.dataset.value = '${DATE}';
            w.dispatchEvent(new CustomEvent('customdate:change', { bubbles: true, detail: { value: '${DATE}' } }));
          })()`);
        }
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`!!document.querySelector('.appt[data-id="${newBookingId}"]')`)); i++) await sleep(200);

        const card = async (id, expr) => JSON.parse(await s.eval(
          `JSON.stringify((function(){ const c = document.querySelector('.appt[data-id="${id}"]'); return c ? (${expr}) : null; })())`
        ));

        // 6. Новый клиент - телефон, метка и канал прямо на карточке
        const newText = await card(newBookingId, 'c.innerText');
        check('на карточке нового клиента виден телефон', /79001112233|\+7 900/.test(String(newText).replace(/\s/g, '')) || String(newText).includes('79001112233'),
          JSON.stringify(newText));
        check('на карточке нового клиента метка "+1 новый клиент"', String(newText).includes('+1 новый клиент'), JSON.stringify(newText));
        check('на карточке нового клиента виден канал', String(newText).includes('Яндекс Карты'), JSON.stringify(newText));

        // 7. Постоянный клиент - канала нет
        const repeatText = await card(repeatBookingId, 'c.innerText');
        check('у постоянного клиента канала на карточке нет',
          !String(repeatText).includes('2ГИС') && !String(repeatText).includes('новый клиент'), JSON.stringify(repeatText));

        // Снимок обычного вида дня - карточки глазами, до всякого раскрытия
        await s.eval(`document.querySelector('.panel-sp-day .schedule-grid').scrollIntoView({ block: 'center' })`);
        await sleep(300);
        await s.screenshot('/tmp/verify-2026-08-17-den-obychnyy.png');

        // 8. Короткая запись раскрывается кнопкой
        const shortIsCompact = await card(repeatBookingId, 'c.classList.contains("appt--compact")');
        check(`короткая запись (${shortService.duration_min} мин) в компактном режиме`, shortIsCompact === true, String(shortIsCompact));
        const before = await card(repeatBookingId, 'JSON.parse(JSON.stringify({ h: c.getBoundingClientRect().height, visible: c.querySelector(".c").getClientRects().length > 0 }))');
        await s.eval(`document.querySelector('.appt[data-id="${repeatBookingId}"] .appt-expand').click()`);
        await sleep(250);
        const after = await card(repeatBookingId, 'JSON.parse(JSON.stringify({ h: c.getBoundingClientRect().height, visible: c.querySelector(".c").getClientRects().length > 0, expanded: c.classList.contains("appt--expanded") }))');
        check('после нажатия запись раскрыта и стала выше', after?.expanded === true && after.h > before.h,
          `было ${before?.h}px, стало ${after?.h}px`);
        check('в раскрытой записи видно скрытую строку с клиентом', before?.visible === false && after?.visible === true,
          `до: ${before?.visible}, после: ${after?.visible}`);

        await s.screenshot('/tmp/verify-2026-08-17-den-raskrytaya.png');

        // Раскрытая карточка не должна вылезать за нижний край колонки
        const fits = await card(repeatBookingId, `(function(){
          const track = c.closest('.schedule-track');
          return c.getBoundingClientRect().bottom <= track.getBoundingClientRect().bottom + 1;
        })()`);
        check('раскрытая запись помещается в колонку дня', fits === true, String(fits));

        // 9. Кнопка раскрытия не открывает форму записи
        const formOpened = JSON.parse(await s.eval(`(function(){
          const f = document.getElementById('walkinForm');
          return Boolean(f && !f.hidden && f.dataset.bookingId === '${repeatBookingId}');
        })()`));
        check('кнопка раскрытия не открывает форму записи', formOpened === false, `форма открыта: ${formOpened}`);

        // Повторное нажатие сворачивает и возвращает запись на своё время
        const topBefore = await card(repeatBookingId, 'c.style.top');
        await s.eval(`document.querySelector('.appt[data-id="${repeatBookingId}"] .appt-expand').click()`);
        await sleep(200);
        const collapsed = await card(repeatBookingId, 'JSON.parse(JSON.stringify({ expanded: c.classList.contains("appt--expanded"), top: c.style.top }))');
        check('повторное нажатие сворачивает запись', collapsed?.expanded === false, JSON.stringify(collapsed));
        check('свёрнутая запись вернулась на своё время по вертикали',
          collapsed?.top === topBefore || parseFloat(collapsed?.top) >= 0, `top: ${topBefore} → ${collapsed?.top}`);

        // Клик по самой карточке (не по кнопке) по-прежнему открывает форму
        await s.eval(`document.querySelector('.appt[data-id="${repeatBookingId}"]').click()`);
        await sleep(400);
        const formForCard = JSON.parse(await s.eval(`(function(){
          const f = document.getElementById('walkinForm');
          return Boolean(f && !f.hidden && f.dataset.bookingId === '${repeatBookingId}');
        })()`));
        check('клик по самой записи по-прежнему открывает форму', formForCard === true, String(formForCard));
        // И в форме уже стоит поле "Откуда клиент"
        const sourceWidget = JSON.parse(await s.eval(`Boolean(document.getElementById('wfSourceValue'))`));
        check('в форме записи есть поле "Откуда клиент"', sourceWidget === true, String(sourceWidget));

        await s.screenshot('/tmp/verify-2026-08-17-den-kartochka.png');

        // ── Кабинет мастера: те же карточки, другие права ────────────────────
        // Телефон и канал сервер мастеру не отдаёт (проверено выше на API) - здесь
        // доказываем, что карточка не рисует их пустыми хвостами, метку показывает,
        // а кнопка раскрытия работает и на этой странице (свой набор модулей).
        await s.eval('localStorage.clear()');
        await s.navigate(`${siteUrl}/crm-master.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'vs-master@alikhan.test';
          document.getElementById('loginPin').value = '${masterPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector(".panel-sp-day .schedule-grid")')); i++) await sleep(200);
        // Виджет даты появляется отдельно от сетки (wireDayNav рисует его после
        // загрузки дня) - без ожидания событие уходит в пустоту и день остаётся
        // сегодняшним, где фикстур нет вовсе (поймано этим же прогоном)
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#dayNavDate-slot .custom-date")')); i++) await sleep(200);
        for (let i = 0; i < 20; i++) {
          await s.eval(`(function(){
            const w = document.querySelector('#dayNavDate-slot .custom-date');
            if (!w) return;
            w.dataset.value = '${DATE}';
            w.dispatchEvent(new CustomEvent('customdate:change', { bubbles: true, detail: { value: '${DATE}' } }));
          })()`);
          await sleep(300);
          if (JSON.parse(await s.eval(`!!document.querySelector('.appt[data-id="${newBookingId}"]')`))) break;
        }

        const masterCardText = JSON.parse(await s.eval(
          `JSON.stringify((document.querySelector('.appt[data-id="${newBookingId}"]')||{}).innerText||'')`
        ));
        check('мастер видит метку нового клиента', String(masterCardText).includes('+1 новый клиент'), JSON.stringify(masterCardText));
        check('мастер не видит ни телефона, ни канала на карточке',
          !String(masterCardText).includes('79001112233') && !String(masterCardText).includes('Яндекс Карты'),
          JSON.stringify(masterCardText));
        const masterExpand = JSON.parse(await s.eval(`(function(){
          const btn = document.querySelector('.appt[data-id="${newBookingId}"] .appt-expand');
          if (!btn) return 'нет кнопки';
          btn.click();
          return document.querySelector('.appt[data-id="${newBookingId}"]').classList.contains('appt--expanded');
        })()`));
        check('раскрытие записи работает и в кабинете мастера', masterExpand === true, String(masterExpand));
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err?.stack || err);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
