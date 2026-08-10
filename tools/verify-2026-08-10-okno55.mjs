// Живая проверка Окна 55 (10.08.2026) - слияние форм записи + идентификация клиента
// по телефону + режим редактирования существующей записи.
//
// Что проверяется (по DoD промпта окна):
//  Задача B - ввод телефона СУЩЕСТВУЮЩЕГО клиента показывает "Клиент найден: имя,
//             N визитов" и автозаполняет имя; НОВЫЙ номер показывает "Новый клиент";
//             ни то, ни другое не блокирует сохранение.
//  Задача C - клик по существующей записи открывает ОДНУ общую форму с заголовком
//             "Редактирование записи"; смена мастера на свободного сохраняется и
//             СТАРЫЙ СЛОТ ОСВОБОЖДАЕТСЯ (проверяем записью другого клиента на него);
//             перенос на занятый слот даёт ПОНЯТНУЮ ошибку и не портит запись;
//             статус и удаление работают как раньше.
//  Задача D - на crm-owner.html не осталось ни #bd-1, ни живого openBooking; на
//             crm-master.html старая карточка ЖИВА (мастер записи не переносит -
//             прямое указание Влада 10.08.2026, подтверждено бэкендом: requireRole
//             owner/admin у /reschedule).
//  Задача F - XSS: имя клиента с тегом из АНОНИМНОЙ записи долетает до уведомления
//             мастера как ТЕКСТ, не как элемент; иконки booking_moved_out/in разные.
//
// Клики - реальные, через s.clickAt(x,y) (Input.dispatchMouseEvent), не el.click():
// программный клик обходит хит-тест браузера и не поймал бы баг "кнопка не
// реагирует у Влада, а тесты зелёные" (см. tools/cdp.mjs, правка 09.08.2026).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Реальный клик по центру элемента - координаты берём из живого getBoundingClientRect.
async function clickCenter(s, selector) {
  const box = await s.eval(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
  })()`);
  if (!box) return 'NOT_FOUND';
  if (box.w === 0 || box.h === 0) return 'ZERO_SIZE';
  await sleep(120);
  const fresh = await s.eval(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  await s.clickAt(fresh.x, fresh.y);
  await sleep(250);
  return 'OK';
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o55-owner',  1, 'QA Владелец', 'owner',  true, true,  true, 'o55-owner@test.local',  $1),
       ('o55-master', 1, 'QA Мастер-2', 'master', true, true,  true, 'o55-master@test.local', $2)`,
      [hashPin(pinOwner), hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m, wd, true, '10:00', '20:00' FROM generate_series(1,7) AS wd, (VALUES ('o55-owner'),('o55-master')) AS t(m)`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('o55-owner',  'strizhka', 2000, 40),
       ('o55-master', 'strizhka', 1800, 40)`
    );

    const loginRes = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o55-owner@test.local', pin: pinOwner }),
    });
    const { token } = await loginRes.json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const today = daysFromToday(0);
    const tomorrow = daysFromToday(1);

    // Постоянный клиент с историей: 2 прошлых визита + 1 будущий (его и будем править).
    const KNOWN_PHONE = '+7 999 111-22-33';
    for (const [d, t] of [[daysFromToday(-7), '11:00'], [daysFromToday(-3), '12:00']]) {
      const r = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ masterId: 'o55-owner', serviceIds: ['strizhka'], date: d, startTime: t, clientName: 'Рустам Постоянный', clientPhone: KNOWN_PHONE, channel: 'admin' }),
      });
      if (r.status !== 200) throw new Error(`fixture history → ${r.status}: ${await r.text()}`);
    }
    const editableRes = await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o55-owner', serviceIds: ['strizhka'], date: today, startTime: '15:00', clientName: 'Рустам Постоянный', clientPhone: KNOWN_PHONE, channel: 'admin' }),
    });
    const editable = (await editableRes.json()).booking;
    if (!editable?.id) throw new Error('fixture editable booking failed');

    // Занятый слот у ДРУГОГО мастера - для проверки понятной ошибки при переносе.
    const blockerRes = await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o55-master', serviceIds: ['strizhka'], date: today, startTime: '17:00', clientName: 'Занимающий Слот', clientPhone: '+79995556677', channel: 'admin' }),
    });
    if (blockerRes.status !== 200) throw new Error('fixture blocker booking failed');

    // ── Слой 1: контракты Окна 54, на которые опирается фронт ──────────────
    const foundRes = await fetch(`${apiUrl}/clients?phone=${encodeURIComponent(KNOWN_PHONE)}`, { headers: auth });
    const foundCard = await foundRes.json();
    check('GET /clients?phone= (существующий): 200 + имя + история 3 визита',
      foundRes.status === 200 && foundCard.name === 'Рустам Постоянный' && foundCard.visits.length === 3,
      `status=${foundRes.status} name=${foundCard.name} visits=${foundCard.visits?.length}`);

    const missRes = await fetch(`${apiUrl}/clients?phone=%2B79990000000`, { headers: auth });
    check('GET /clients?phone= (нового номера): 404', missRes.status === 404, `status=${missRes.status}`);

    // ── Слой 2: живой браузер ──────────────────────────────────────────────
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1000);
        // Вход - через РЕАЛЬНУЮ форму логина, как в остальных verify-скриптах
        // проекта: подсунуть токен в localStorage мало, crm-auth.js хранит ещё и
        // карточку сотрудника (alikhan-crm:staff), без неё страница остаётся на
        // экране входа и renderLiveProof не запускается вовсе.
        await s.navigate(`${base}/crm-owner.html`);
        await sleep(500);
        await s.type('#loginEmail', 'o55-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(3000);

        // --- Задача D: старой формы на owner нет, новая форма на месте ---
        const dom = await s.eval(`({
          bd1: !!document.getElementById('bd-1'),
          openBookingFn: typeof window.openBooking,
          openEditFn: typeof window.openBookingEdit,
          form: !!document.getElementById('walkinForm'),
          hint: !!document.getElementById('wfClientHint'),
          masterRow: !!document.getElementById('wfMasterRow'),
          editControls: !!document.getElementById('wfEditControls'),
          apptCount: document.querySelectorAll('.appt').length,
        })`);
        check('Задача D: карточки #bd-1 на crm-owner.html больше нет', dom.bd1 === false, `bd-1 present=${dom.bd1}`);
        check('Задача C: window.openBookingEdit зарегистрирована', dom.openEditFn === 'function', `typeof=${dom.openEditFn}`);
        check('Задача C: элементы режима edit есть в разметке (мастер-дропдаун + контролы)',
          dom.form && dom.hint && dom.masterRow && dom.editControls,
          JSON.stringify(dom));

        // --- Задача B: НОВЫЙ номер → "новый клиент" ---
        await s.eval(`window.openSlotBooking('o55-owner','QA Владелец',${JSON.stringify(tomorrow)},'11:00')`);
        await sleep(400);
        await s.type('#wfClientPhone', '+7 999 000-00-00');
        await sleep(1200);
        const newHint = await s.eval(`(function(){
          const h = document.getElementById('wfClientHint');
          return { hidden: h.hidden, cls: h.className, text: h.textContent.trim(), name: document.getElementById('wfClientName').value };
        })()`);
        check('Задача B: новый номер → признак "Новый клиент" виден',
          newHint.hidden === false && /Новый клиент/.test(newHint.text) && /--new/.test(newHint.cls),
          JSON.stringify(newHint));
        check('Задача B: имя при новом клиенте НЕ автозаполнено', newHint.name === '', `name="${newHint.name}"`);

        // --- Задача B: СУЩЕСТВУЮЩИЙ номер → "клиент найден" + автозаполнение ---
        await s.type('#wfClientPhone', KNOWN_PHONE);
        await sleep(1500);
        const foundHint = await s.eval(`(function(){
          const h = document.getElementById('wfClientHint');
          return {
            hidden: h.hidden, cls: h.className, text: h.textContent.trim(),
            name: document.getElementById('wfClientName').value,
            repeatBtn: !!document.getElementById('wfClientRepeat'),
            submitDisabled: document.getElementById('wfSubmit').disabled,
          };
        })()`);
        check('Задача B: существующий номер → "Клиент найден: имя, N визитов"',
          foundHint.hidden === false && /Клиент найден: Рустам Постоянный/.test(foundHint.text) && /3 визита/.test(foundHint.text),
          JSON.stringify(foundHint));
        check('Задача B: имя автозаполнено найденным клиентом', foundHint.name === 'Рустам Постоянный', `name="${foundHint.name}"`);
        check('Задача B: предложено (не форсировано) "Как в прошлый раз"', foundHint.repeatBtn === true, `btn=${foundHint.repeatBtn}`);

        // Сохранение НЕ заблокировано опознанием: живой клик по "Как в прошлый раз",
        // затем реальный клик по "Сохранить запись".
        await clickCenter(s, '#wfClientRepeat');
        const afterRepeat = await s.eval(`document.getElementById('wfSubmit').disabled`);
        check('Задача B: после подстановки услуг кнопка сохранения активна', afterRepeat === false, `disabled=${afterRepeat}`);
        await clickCenter(s, '#wfSubmit');
        await sleep(2000);
        const saveResult = await s.eval(`document.getElementById('wfResult').textContent.trim()`);
        check('Задача B: запись существующего клиента сохранилась живым кликом',
          /^Готово/.test(saveResult), `wfResult="${saveResult}"`);

        // --- Задача C: открыть СУЩЕСТВУЮЩУЮ запись живым кликом по карточке ---
        // Раздел "Расписание" держит День/Неделю/Месяц в сворачиваемых карточках
        // (details.staff-card, КОНВЕНЦИЯ-КАРТОЧКИ-РАЗДЕЛОВ.md) - по умолчанию "День"
        // ЗАКРЫТ: записи есть в DOM, но клиппированы по высоте, и живой клик по ним
        // физически не проходит. Пользователь сначала раскрывает раздел - тест делает
        // то же самое, иначе он проверял бы не тот сценарий.
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        const apptSel = `.appt[data-id="${editable.id}"]`;
        const apptExists = await s.eval(`!!document.querySelector(${JSON.stringify(apptSel)})`);
        // Запись-фикстура создана на СЕГОДНЯ - дневной календарь открыт именно на
        // сегодняшнем дне, карточка .appt должна быть в DOM сразу после рендера.
        if (!apptExists) {
          throw new Error(`карточка записи ${editable.id} не отрисована в календаре - клик проверять негде`);
        }
        const clicked = await clickCenter(s, apptSel);
        await sleep(1200);
        const editState = await s.eval(`(function(){
          const f = document.getElementById('walkinForm');
          return {
            clicked: ${JSON.stringify(clicked)},
            formHidden: f.hidden,
            label: document.getElementById('wfModeLabel').textContent.trim(),
            bookingId: f.dataset.bookingId || null,
            masterRowHidden: document.getElementById('wfMasterRow').hidden,
            editControlsHidden: document.getElementById('wfEditControls').hidden,
            phone: document.getElementById('wfClientPhone').value,
            client: document.getElementById('wfClientName').value,
            submitLabel: document.getElementById('wfSubmit').textContent.trim(),
            deleteRowFilled: (document.getElementById('bkDeleteRow').innerHTML || '').includes('Удалить запись'),
            statusChecked: (document.querySelector('input[name="bstatus"]:checked') || {}).id || null,
          };
        })()`);
        check('Задача C: клик по записи открыл форму в режиме "Редактирование записи"',
          editState.formHidden === false && editState.label === 'Редактирование записи',
          JSON.stringify(editState));
        check('Задача C: id записи попал на форму (панель для статуса/удаления)',
          editState.bookingId === editable.id, `dataset.bookingId=${editState.bookingId}`);
        check('Задача C: мастер-дропдаун и контролы edit показаны',
          editState.masterRowHidden === false && editState.editControlsHidden === false,
          JSON.stringify(editState));
        check('Задача C: клиент/телефон записи подставлены (не гоняем через поиск заново)',
          editState.client === 'Рустам Постоянный' && /999/.test(editState.phone),
          `client="${editState.client}" phone="${editState.phone}"`);
        check('Задача C: кнопка удаления перенесена и отрисована', editState.deleteRowFilled === true, `deleteRow=${editState.deleteRowFilled}`);
        check('Задача C: статус-радио отражает реальный статус записи (planned → st-wait)',
          editState.statusChecked === 'st-wait', `checked=${editState.statusChecked}`);

        // --- Задача C: перенос на ЗАНЯТЫЙ слот → понятная ошибка, запись не испорчена ---
        await s.eval(`(function(){
          const sel = document.querySelector('#wfMasterValue');
          const opt = [...sel.querySelectorAll('.custom-select-option')].find(o => o.dataset.value === 'o55-master');
          window.pickCustomSelectOption(opt);
          const t = document.getElementById('wfTimeValue');
          t.dataset.value = '17:00';
          t.querySelector('.custom-select-trigger').textContent = '17:00';
        })()`);
        await sleep(500);
        await clickCenter(s, '#wfSubmit');
        await sleep(2500);
        const conflict = await s.eval(`document.getElementById('wfResult').textContent.trim()`);
        check('Задача C: перенос на занятый слот → понятная ошибка (не "HTTP 409")',
          /уже есть другая запись|занято/.test(conflict) && !/HTTP/.test(conflict),
          `wfResult="${conflict}"`);
        const notBroken = await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth });
        const listAfterFail = (await notBroken.json()).bookings || [];
        const stillThere = listAfterFail.find((b) => b.id === editable.id);
        check('Задача C: после неудачного переноса запись НЕ испорчена (мастер/время прежние)',
          stillThere && stillThere.masterId === 'o55-owner' && stillThere.startTime === '15:00',
          JSON.stringify(stillThere && { m: stillThere.masterId, t: stillThere.startTime }));

        // --- Задача C: перенос на СВОБОДНЫЙ слот другого мастера → успех ---
        await s.eval(`(function(){
          const t = document.getElementById('wfTimeValue');
          t.dataset.value = '19:00';
          t.querySelector('.custom-select-trigger').textContent = '19:00';
        })()`);
        await sleep(400);
        await clickCenter(s, '#wfSubmit');
        await sleep(2500);
        const okText = await s.eval(`document.getElementById('wfResult').textContent.trim()`);
        check('Задача C: перенос на свободный слот сохранён', /^Сохранено/.test(okText), `wfResult="${okText}"`);

        const movedRes = await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth });
        const moved = ((await movedRes.json()).bookings || []).find((b) => b.id === editable.id);
        check('Задача C: в базе новый мастер и новое время',
          moved && moved.masterId === 'o55-master' && moved.startTime === '19:00',
          JSON.stringify(moved && { m: moved.masterId, t: moved.startTime }));

        // Старый слот освободился - доказываем записью другого клиента ровно на него.
        const reuseRes = await fetch(`${apiUrl}/bookings`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({ masterId: 'o55-owner', serviceIds: ['strizhka'], date: today, startTime: '15:00', clientName: 'Новый На Старый Слот', clientPhone: '+79993334455', channel: 'admin' }),
        });
        check('Задача C: СТАРЫЙ слот освободился - на 15:00 записался другой клиент',
          reuseRes.status === 200, `POST /bookings → ${reuseRes.status}: ${reuseRes.status === 200 ? '' : await reuseRes.text()}`);

        // --- Задача C: статус меняется как раньше (PATCH /status через новую панель) ---
        await clickCenter(s, 'label[for="st-came"]');
        await sleep(2000);
        const statusRes = await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth });
        const afterStatus = ((await statusRes.json()).bookings || []).find((b) => b.id === editable.id);
        check('Задача C: статус сохранён через перенесённое радио (planned → done)',
          afterStatus && afterStatus.status === 'done', `status=${afterStatus && afterStatus.status}`);

        // --- Задача C: удаление работает как раньше (двухшаговое подтверждение) ---
        await clickCenter(s, '#bkDeleteBtn');
        await sleep(400);
        await clickCenter(s, '#bkDeleteYes');
        await sleep(2500);
        const delRes = await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth });
        const afterDelete = ((await delRes.json()).bookings || []).find((b) => b.id === editable.id);
        check('Задача C: удаление записи из новой формы работает', afterDelete === undefined, `запись всё ещё есть: ${!!afterDelete}`);
        const closedForm = await s.eval(`(function(){
          const f = document.getElementById('walkinForm');
          return { hidden: f.hidden, bookingId: f.dataset.bookingId || null };
        })()`);
        check('Задача C: после удаления форма закрыта и id записи снят (иначе следующее "Сохранить" ушло бы в 404)',
          closedForm.hidden === true && closedForm.bookingId === null, JSON.stringify(closedForm));
      });

      // --- Задача F: XSS в уведомлениях ---
      const xssName = '<img src=x onerror=window.__xss=1>';
      const anonRes = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterId: 'o55-master', serviceIds: ['strizhka'], date: tomorrow, startTime: '13:00', clientName: xssName, clientPhone: '+79997778899', channel: 'site' }),
      });
      check('Задача F: анонимная запись с тегом в имени принята бэкендом (баг именно фронтовый)',
        anonRes.status === 200, `POST /bookings → ${anonRes.status}`);

      const masterPin = randomPin();
      await db.query(`UPDATE staff SET pin_hash = $1 WHERE id = 'o55-master'`, [hashPin(masterPin)]);
      const mLogin = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'o55-master@test.local', pin: masterPin }),
      });
      const mToken = (await mLogin.json()).token;

      await withBrowser(async (s) => {
        await s.setViewport(1440, 1000);
        await s.navigate(`${base}/crm-master.html`);
        await sleep(500);
        await s.type('#loginEmail', 'o55-master@test.local');
        await s.type('#loginPin', masterPin);
        await s.click('#loginForm button[type="submit"]');
        await sleep(3000);

        // Задача D (обратная сторона): у мастера старая карточка ЖИВА.
        const masterDom = await s.eval(`({
          bd1: !!document.getElementById('bd-1'),
          openBookingFn: typeof window.openBooking,
          openEditFn: typeof window.openBookingEdit,
          form: !!document.getElementById('walkinForm'),
        })`);
        check('Задача D: на crm-master.html карточка #bd-1 ОСТАЛАСЬ (мастер записи не переносит)',
          masterDom.bd1 === true && masterDom.openBookingFn === 'function',
          JSON.stringify(masterDom));
        check('Задача D: у мастера режим edit не регистрируется вовсе',
          masterDom.openEditFn === 'undefined' && masterDom.form === false,
          JSON.stringify(masterDom));

        await clickCenter(s, '#msgBell');
        await sleep(2500);
        const xss = await s.eval(`(function(){
          const list = document.querySelector('.msg-list') || document.getElementById('msgList');
          const html = list ? list.innerHTML : '';
          const titles = [...document.querySelectorAll('.msg-title,.msg-sub')].map(n => n.textContent);
          return {
            xssFired: window.__xss === 1,
            injectedImg: !!document.querySelector('.msg-list img, .msg-body img'),
            escaped: html.includes('&lt;img'),
            asText: titles.some(t => t.includes('<img src=x')),
            icons: [...document.querySelectorAll('.msg-ico')].map(n => n.textContent),
          };
        })()`);
        check('Задача F: XSS не сработал (window.__xss не выставлен)', xss.xssFired !== true, `xssFired=${xss.xssFired}`);
        check('Задача F: инъекция не превратилась в DOM-элемент <img>', xss.injectedImg === false, `img=${xss.injectedImg}`);
        check('Задача F: имя с тегом отрисовано как ТЕКСТ (экранировано)',
          xss.escaped === true || xss.asText === true, JSON.stringify({ escaped: xss.escaped, asText: xss.asText }));
      });
    });

    // --- Задача F: иконки booking_moved_out/in различаются (проверка карты типов) ---
    const iconSrc = await (await import('node:fs/promises')).readFile('assets/crm-notifications.js', 'utf8');
    const out = iconSrc.match(/booking_moved_out:\s*'([^']+)'/)?.[1];
    const inn = iconSrc.match(/booking_moved_in:\s*'([^']+)'/)?.[1];
    check('Задача F: booking_moved_out/in имеют СВОИ и РАЗНЫЕ иконки (не дефолтный 🔔)',
      !!out && !!inn && out !== inn, `out=${out} in=${inn}`);
  });
} finally {
  summary('Окно 55 - слияние форм записи, идентификация по телефону, режим редактирования');
}
