// Живая проверка правок карточки записи в разделе "Расписание" (13.08.2026, 6 пунктов
// Влада по живому интерфейсу + комментарий к записи):
//  1. заголовок "Услуги" без пояснения в скобках;
//  2. отдельного блока "Добавить услугу к записи" у владельца/админа нет, услуги
//     правятся верхним списком (уже оказанные - заблокированы, снятие бэкенд не умеет);
//  3. "Фактическая сумма" подтягивает сумму выбранных услуг, правится вручную,
//     комментарий объясняет отличие и переживает перезагрузку (миграция 048);
//  4. у поля суммы нет спиннера с шагом 1 (type="text" + inputmode="numeric");
//  5. "Удалить запись" - в самом низу карточки, ниже кнопок сохранения;
//  6. между кнопками сохранения есть вертикальный воздух.
//
// Всё на СВОЕЙ одноразовой базе и своём сервере (withEphemeralServer) - чужие
// фикстуры/аккаунты не нужны. Клики - реальные (s.clickAt по свежему
// getBoundingClientRect), не программный el.click(): программный обходит хит-тест и
// не поймал бы "кнопка не реагирует у Влада" (tools/cdp.mjs, правка 09.08.2026).
// Один withBrowser на весь прогон - две подряд гонятся за хардкоженным портом 9333.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickCenter(s, selector) {
  const box = await s.eval(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
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

async function login(s, base, page, email, pin) {
  await s.navigate(`${base}/${page}`);
  await sleep(500);
  for (let i = 0; i < 20 && !(await s.eval(`!!document.getElementById('loginEmail')`)); i++) await sleep(150);
  await s.type('#loginEmail', email);
  await s.type('#loginPin', pin);
  await s.click('#loginForm button[type="submit"]');
  await sleep(3000);
}

// Снимок карточки записи: значения полей, геометрия кнопок, состояние чекбоксов.
const CARD_SNAPSHOT = `(function(){
  const price = document.getElementById('bkActualPrice');
  const comment = document.getElementById('bkStaffComment');
  const submit = document.getElementById('wfSubmit');
  const priceSave = document.getElementById('bkActualPriceSave');
  const cancel = document.getElementById('wfCancel');
  const del = document.getElementById('bkDeleteBtn');
  const zone = document.getElementById('wfDangerZone');
  const box = (el) => el ? el.getBoundingClientRect() : null;
  const checks = [...document.querySelectorAll('#wfServicePicker input[type=checkbox]')]
    .map((i) => ({ id: i.value, checked: i.checked, disabled: i.disabled }));
  return {
    priceType: price?.type, priceInputMode: price?.getAttribute('inputmode'), priceValue: price?.value,
    commentPresent: !!comment, commentValue: comment?.value ?? null,
    serviceSummaryText: document.querySelector('#walkinForm details.service-edit > summary')?.textContent.trim(),
    hasServiceEditBlock: !!document.getElementById('bkServiceEditPicker'),
    hintVisible: !!document.getElementById('wfServiceEditHint') && !document.getElementById('wfServiceEditHint').hidden,
    zoneHidden: zone ? zone.hidden : null,
    deleteTop: box(del)?.top ?? null,
    submitTop: box(submit)?.top ?? null,
    submitBottom: box(submit)?.bottom ?? null,
    priceSaveBottom: box(priceSave)?.bottom ?? null,
    cancelTop: box(cancel)?.top ?? null,
    checks,
    result: document.getElementById('bkActualPriceResult')?.textContent.trim() ?? '',
  };
})()`;

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pinAdmin = randomPin();
    const pinMaster = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o59-owner',  1, 'QA Владелец', 'owner',  true, true,  true, 'o59-owner@test.local',  $1),
       ('o59-admin',  1, 'QA Админ',    'admin',  true, false, true, 'o59-admin@test.local',  $2),
       ('o59-master', 1, 'QA Мастер',   'master', true, true,  true, 'o59-master@test.local', $3)`,
      [hashPin(pinOwner), hashPin(pinAdmin), hashPin(pinMaster)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m, wd, true, '10:00', '20:00' FROM generate_series(1,7) AS wd, (VALUES ('o59-owner'),('o59-master')) AS t(m)`
    );
    // Стрижка 2000 + воск 500. Пара выбрана специально НЕ комбинируемая: стрижка
    // с бородой сворачиваются в комплексную услугу (SERVICE_COMBOS, storage.js), и
    // прогон проверял бы не автоподстановку суммы, а механику комплексов.
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('o59-owner',  'strizhka', 2000, 40),
       ('o59-owner',  'vosk',      500, 15),
       ('o59-master', 'strizhka', 1800, 40),
       ('o59-master', 'vosk',      500, 15)`
    );

    const loginRes = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o59-owner@test.local', pin: pinOwner }),
    });
    const { token } = await loginRes.json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const today = daysFromToday(0);

    const CLIENT_PHONE = '+7 999 321-45-67';
    const bookingRes = await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o59-owner', serviceIds: ['strizhka'], date: today, startTime: '15:00', clientName: 'Марат Скидочный', clientPhone: CLIENT_PHONE, channel: 'admin' }),
    });
    const booking = (await bookingRes.json()).booking;
    if (!booking?.id) throw new Error('фикстура записи не создалась');

    // Тот же клиент был и у мастера: без своего визита карточка клиента мастеру
    // закрыта целиком (403), и срезку поля проверять было бы негде.
    const masterVisitRes = await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o59-master', serviceIds: ['strizhka'], date: daysFromToday(-5), startTime: '12:00', clientName: 'Марат Скидочный', clientPhone: CLIENT_PHONE, channel: 'admin' }),
    });
    const masterVisit = (await masterVisitRes.json()).booking;
    if (!masterVisit?.id) throw new Error('фикстура визита у мастера не создалась');
    await fetch(`${apiUrl}/bookings/${masterVisit.id}/actual-price`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ actualPrice: 1500, comment: 'скидка по договорённости' }),
    });

    // Запись у мастера на сегодня - для регрессии crm-master.html: там осталась
    // СТАРАЯ карточка #bd-1 со своим блоком "Добавить услугу к записи" (общей формы
    // у мастера нет вообще), а правки этого окна шли по общим модулям.
    const masterTodayRes = await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o59-master', serviceIds: ['strizhka'], date: today, startTime: '11:00', clientName: 'Клиент Мастера', clientPhone: '+7 999 888-77-66', channel: 'admin' }),
    });
    const masterToday = (await masterTodayRes.json()).booking;
    if (!masterToday?.id) throw new Error('фикстура записи мастера на сегодня не создалась');

    // ── Слой 1: контракт (миграция 048 + расширенный PATCH /actual-price) ──────
    const withComment = await fetch(`${apiUrl}/bookings/${booking.id}/actual-price`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ actualPrice: 1700, comment: '  Владелец дал скидку постоянному  ' }),
    });
    const withCommentBody = await withComment.json();
    check('PATCH /actual-price принимает комментарий и обрезает пробелы',
      withComment.status === 200 && withCommentBody.comment === 'Владелец дал скидку постоянному',
      JSON.stringify(withCommentBody));

    const fetchBooking = async () => {
      const { bookings } = await (await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth })).json();
      return bookings.find((b) => b.id === booking.id);
    };
    const mine = await fetchBooking();
    check('GET /bookings отдаёт сумму и комментарий владельцу',
      mine?.actualPrice === 1700 && mine?.staffComment === 'Владелец дал скидку постоянному',
      JSON.stringify({ actualPrice: mine?.actualPrice, staffComment: mine?.staffComment }));

    // Старый контракт (тело без comment) НЕ должен стирать уже написанное объяснение
    await fetch(`${apiUrl}/bookings/${booking.id}/actual-price`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ actualPrice: 1600 }),
    });
    const afterLegacy = await fetchBooking();
    check('запрос без поля comment не стирает комментарий (обратная совместимость)',
      afterLegacy.actualPrice === 1600 && afterLegacy.staffComment === 'Владелец дал скидку постоянному',
      JSON.stringify({ actualPrice: afterLegacy.actualPrice, staffComment: afterLegacy.staffComment }));

    const tooLong = await fetch(`${apiUrl}/bookings/${booking.id}/actual-price`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ actualPrice: 1600, comment: 'я'.repeat(501) }),
    });
    check('слишком длинный комментарий отбивается 400, а не режется молча',
      tooLong.status === 400 && (await tooLong.json()).error === 'comment_too_long', `status=${tooLong.status}`);

    // Мастеру ни сумма, ни объяснение к ней не видны - тот же уровень, что был у actualPrice
    const masterToken = (await (await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o59-master@test.local', pin: pinMaster }),
    })).json()).token;
    const clientId = (await (await fetch(`${apiUrl}/clients?phone=${encodeURIComponent(CLIENT_PHONE)}`, { headers: auth })).json()).id;
    const cardOwner = await (await fetch(`${apiUrl}/clients/${clientId}`, { headers: auth })).json();
    check('карточка клиента: владелец видит комментарий в истории визитов',
      cardOwner.visits?.[0]?.staffComment === 'Владелец дал скидку постоянному',
      JSON.stringify(cardOwner.visits?.[0]));
    const cardMaster = await (await fetch(`${apiUrl}/clients/${clientId}`, { headers: { Authorization: `Bearer ${masterToken}` } })).json();
    check('карточка клиента: мастеру визиты видны, но без поля комментария',
      Array.isArray(cardMaster.visits) && cardMaster.visits.length > 0
      && cardMaster.visits.every((v) => !('staffComment' in v)),
      JSON.stringify(cardMaster.visits));

    // Возвращаем запись в исходное состояние (без ручной суммы) - дальше её открывает браузер
    await fetch(`${apiUrl}/bookings/${booking.id}/actual-price`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ actualPrice: null, comment: '' }),
    });

    // ── Слой 2: живой браузер ─────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1100);
        await login(s, base, 'crm-owner.html', 'o59-owner@test.local', pinOwner);

        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        const apptSel = `.appt[data-id="${booking.id}"]`;
        if (!(await s.eval(`!!document.querySelector(${JSON.stringify(apptSel)})`))) {
          throw new Error('карточка записи не отрисовалась в дне владельца');
        }
        const opened = await clickCenter(s, apptSel);
        check('запись открывается живым кликом по карточке в дне', opened === 'OK', opened);
        await sleep(600);

        const card = await s.eval(CARD_SNAPSHOT);
        check('п.1: заголовок услуг - просто "Услуги"',
          card.serviceSummaryText === 'Услуги', `summary="${card.serviceSummaryText}"`);
        check('п.2: отдельного блока "Добавить услугу к записи" на странице нет',
          card.hasServiceEditBlock === false, `есть=${card.hasServiceEditBlock}`);
        check('п.2: сохранённая услуга отмечена и её МОЖНО снять (галочка не заблокирована)',
          card.checks.some((c) => c.id === 'strizhka' && c.checked && !c.disabled)
          && card.checks.some((c) => c.id === 'vosk' && !c.checked && !c.disabled),
          JSON.stringify(card.checks));
        check('п.2: подсказка про правку состава услуг видна в режиме редактирования',
          card.hintVisible === true, `видна=${card.hintVisible}`);
        check('п.3: в фактическую сумму подтянулась сумма услуг (2000)',
          card.priceValue === '2000', `value="${card.priceValue}"`);
        check('п.3: поле комментария есть и пустое у записи без комментария',
          card.commentPresent === true && card.commentValue === '', JSON.stringify({ p: card.commentPresent, v: card.commentValue }));
        check('п.4: поле суммы без спиннера (type=text + inputmode=numeric)',
          card.priceType === 'text' && card.priceInputMode === 'numeric', JSON.stringify({ t: card.priceType, im: card.priceInputMode }));
        check('п.5: "Удалить запись" ниже кнопок "Сохранить изменения"/"Отмена"',
          card.deleteTop !== null && card.deleteTop > card.submitTop && card.deleteTop > card.cancelTop,
          JSON.stringify({ deleteTop: card.deleteTop, submitTop: card.submitTop, cancelTop: card.cancelTop }));
        const gap = card.submitTop - card.priceSaveBottom;
        check('п.6: между "Сохранить сумму и комментарий" и "Сохранить изменения" есть воздух (>=20px)',
          gap >= 20, `gap=${Math.round(gap)}px`);

        // п.3: пересчёт при изменении состава услуг + приоритет ручной правки
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(400);
        const afterAdd = await s.eval(`document.getElementById('bkActualPrice').value`);
        check('п.3: отметил воск - сумма пересчиталась на 2500 сама',
          afterAdd === '2500', `value="${afterAdd}"`);

        await s.type('#bkActualPrice', '3000');
        await sleep(200);
        // Меняем состав ещё раз (снимаем и возвращаем воск): вписанная вручную сумма
        // после этого не должна перебиваться автоподстановкой
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(300);
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(300);
        const afterManual = await s.eval(`document.getElementById('bkActualPrice').value`);
        check('п.3: вписанную вручную сумму пересчёт услуг не затирает',
          afterManual === '3000', `value="${afterManual}"`);

        await s.type('#bkStaffComment', 'Владелец дал скидку 500 ₽');
        await clickCenter(s, '#bkActualPriceSave');
        await sleep(1500);
        const saved = await s.eval(`document.getElementById('bkActualPriceResult').textContent.trim()`);
        check('п.3: сумма и комментарий сохранились живым кликом',
          /Сохранено/.test(saved), `результат="${saved}"`);

        // Услуги записи сохраняем общей кнопкой (тот же PATCH /services, что делал
        // убранный блок) - проверяем, что убранный блок ничего не унёс с собой
        await clickCenter(s, '#wfSubmit');
        await sleep(1800);
        const submitResult = await s.eval(`document.getElementById('wfResult').textContent.trim()`);
        check('п.2: добавленная услуга сохраняется общей кнопкой "Сохранить изменения"',
          /Сохранено/.test(submitResult), `результат="${submitResult}"`);

        const afterUi = await fetchBooking();
        check('данные в базе после работы в интерфейсе: сумма 3000, комментарий, обе услуги',
          afterUi.actualPrice === 3000
          && afterUi.staffComment === 'Владелец дал скидку 500 ₽'
          && afterUi.serviceIds.includes('strizhka') && afterUi.serviceIds.includes('vosk'),
          JSON.stringify({ actualPrice: afterUi.actualPrice, staffComment: afterUi.staffComment, serviceIds: afterUi.serviceIds }));

        // Перезагрузка: сохранённая сумма и комментарий возвращаются на экран, а
        // подстановка суммы услуг (3500) их НЕ перебивает
        await s.navigate(`${base}/crm-owner.html`);
        await sleep(3000);
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        await clickCenter(s, apptSel);
        await sleep(700);
        const reopened = await s.eval(CARD_SNAPSHOT);
        check('п.3: после перезагрузки в поле сохранённая сумма 3000, а не сумма услуг 3500',
          reopened.priceValue === '3000', `value="${reopened.priceValue}"`);
        check('п.3: комментарий пережил перезагрузку и виден в карточке записи',
          reopened.commentValue === 'Владелец дал скидку 500 ₽', `value="${reopened.commentValue}"`);
        check('п.2: обе сохранённые услуги отмечены и остаются редактируемыми',
          reopened.checks.filter((c) => c.checked && !c.disabled).length === 2, JSON.stringify(reopened.checks));

        // Снятие услуги: клиент передумал уже в кресле (13.08.2026)
        const beforeRemoval = await fetchBooking();
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(300);
        await clickCenter(s, '#wfSubmit');
        await sleep(2000);
        const afterRemoval = await fetchBooking();
        check('снятие услуги: воск ушёл из записи, стрижка осталась',
          afterRemoval.serviceIds.length === 1 && afterRemoval.serviceIds[0] === 'strizhka',
          JSON.stringify(afterRemoval.serviceIds));
        check('снятие услуги: слот укоротился на длительность снятой услуги',
          afterRemoval.endTime < beforeRemoval.endTime,
          JSON.stringify({ было: beforeRemoval.endTime, стало: afterRemoval.endTime }));

        // Цвета статусов в календаре (13.08.2026): исход визита виден с одного взгляда
        const doneRes = await fetch(`${apiUrl}/bookings`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({ masterId: 'o59-owner', serviceIds: ['strizhka'], date: today, startTime: '16:00', clientName: 'Пришёл Сергей', clientPhone: null, channel: 'admin' }),
        });
        const doneBooking = (await doneRes.json()).booking;
        const noShowRes = await fetch(`${apiUrl}/bookings`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({ masterId: 'o59-owner', serviceIds: ['strizhka'], date: today, startTime: '17:00', clientName: 'Не пришёл Пётр', clientPhone: null, channel: 'admin' }),
        });
        const noShowBooking = (await noShowRes.json()).booking;
        await fetch(`${apiUrl}/bookings/${doneBooking.id}/status`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'done' }) });
        await fetch(`${apiUrl}/bookings/${noShowBooking.id}/status`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'no_show' }) });
        await s.navigate(`${base}/crm-owner.html`);
        await sleep(3000);
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        const colors = await s.eval(`(function(){
          const cls = (id) => document.querySelector('.appt[data-id="' + id + '"]')?.className || null;
          const bg = (id) => {
            const el = document.querySelector('.appt[data-id="' + id + '"]');
            return el ? getComputedStyle(el).backgroundColor : null;
          };
          return {
            waiting: cls(${JSON.stringify(booking.id)}), waitingBg: bg(${JSON.stringify(booking.id)}),
            done: cls(${JSON.stringify(doneBooking.id)}), doneBg: bg(${JSON.stringify(doneBooking.id)}),
            noShow: cls(${JSON.stringify(noShowBooking.id)}), noShowBg: bg(${JSON.stringify(noShowBooking.id)}),
          };
        })()`);
        check('календарь: ожидание - нейтральная запись с золотой полосой',
          /appt--new/.test(colors.waiting) && /appt--status-planned/.test(colors.waiting), JSON.stringify(colors.waiting));
        check('календарь: пришёл - зелёная запись с зелёной полосой',
          /appt--done/.test(colors.done) && /appt--status-done/.test(colors.done), JSON.stringify(colors.done));
        check('календарь: не пришёл - КРАСНАЯ запись, а не такая же, как ожидание',
          /appt--noshow/.test(colors.noShow) && /appt--status-noshow/.test(colors.noShow)
          && colors.noShowBg !== colors.waitingBg,
          JSON.stringify({ cls: colors.noShow, bg: colors.noShowBg, ожидание: colors.waitingBg }));
        await s.screenshot('/private/tmp/claude-501/-Users-user/dc382e00-eab6-4473-94f6-420c70bc6da1/scratchpad/okno59-statuses-after.png');

        await s.screenshot('/private/tmp/claude-501/-Users-user/dc382e00-eab6-4473-94f6-420c70bc6da1/scratchpad/okno59-owner-card.png');

        // Security: комментарий - новый пользовательский ввод, и он едет в разметку
        // двумя путями (data-атрибут карточки календаря + строка в истории визитов
        // карточки клиента). Проверяем, что он долетает ТЕКСТОМ, а не элементом.
        const XSS = '"><img src=x onerror=window.__xss=1>';
        await fetch(`${apiUrl}/bookings/${booking.id}/actual-price`, {
          method: 'PATCH', headers: auth, body: JSON.stringify({ actualPrice: 3000, comment: XSS }),
        });
        await s.navigate(`${base}/crm-owner.html`);
        await sleep(3000);
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        await clickCenter(s, apptSel);
        await sleep(700);
        const xssState = await s.eval(`({
          value: document.getElementById('bkStaffComment').value,
          injected: !!window.__xss,
          imgs: document.querySelectorAll('img[onerror]').length,
        })`);
        check('security: комментарий с HTML долетает текстом, инъекции нет',
          xssState.value === XSS && xssState.injected === false && xssState.imgs === 0,
          JSON.stringify(xssState));
        await fetch(`${apiUrl}/bookings/${booking.id}/actual-price`, {
          method: 'PATCH', headers: auth, body: JSON.stringify({ actualPrice: 3000, comment: 'Владелец дал скидку 500 ₽' }),
        });

        // ── Регрессия админа: та же карточка, тот же порядок блоков ─────────────
        await login(s, base, 'crm-admin.html', 'o59-admin@test.local', pinAdmin);
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        const adminHasAppt = await s.eval(`!!document.querySelector(${JSON.stringify(apptSel)})`);
        check('админ видит ту же запись в дне', adminHasAppt === true, `есть=${adminHasAppt}`);
        if (adminHasAppt) {
          await clickCenter(s, apptSel);
          await sleep(700);
          const adminCard = await s.eval(CARD_SNAPSHOT);
          check('админ: карточка без блока "Добавить услугу", сумма подставлена, комментарий на месте',
            adminCard.hasServiceEditBlock === false
            && adminCard.priceType === 'text'
            && adminCard.commentValue === 'Владелец дал скидку 500 ₽',
            JSON.stringify({ block: adminCard.hasServiceEditBlock, type: adminCard.priceType, comment: adminCard.commentValue }));
          check('админ: "Удалить запись" ниже кнопок сохранения',
            adminCard.deleteTop > adminCard.submitTop, JSON.stringify({ del: adminCard.deleteTop, submit: adminCard.submitTop }));
          await s.screenshot('/private/tmp/claude-501/-Users-user/dc382e00-eab6-4473-94f6-420c70bc6da1/scratchpad/okno59-admin-card.png');
        }

        // ── Регрессия мастера: его старая карточка записи не пострадала ─────────
        await login(s, base, 'crm-master.html', 'o59-master@test.local', pinMaster);
        await sleep(1000);
        const masterSel = `.appt[data-id="${masterToday.id}"]`;
        const masterApptExists = await s.eval(`!!document.querySelector(${JSON.stringify(masterSel)})`);
        check('мастер видит свою запись дня', masterApptExists === true, `есть=${masterApptExists}`);
        if (masterApptExists) {
          // 13.08.2026 (позже в тот же день, spec 2026-08-13-master-booking-card.md):
          // карточка #bd-1 у мастера удалена, запись открывается ТОЙ ЖЕ общей формой,
          // что у владельца с админом. Заодно ушла причина, по которой этот блок
          // кликал программно: раньше центр карточки записи в дне был перекрыт телом
          // всегда открытой #bd-1 (elementFromPoint возвращал DIV.booking-detail-body),
          // теперь форма скрыта до клика и настоящий клик мышью проходит - что и
          // проверяет отдельный прогон tools/verify-2026-08-13-master-booking-card.mjs.
          await s.eval(`document.querySelector(${JSON.stringify(masterSel)}).click()`);
          await sleep(800);
          const masterCard = await s.eval(`(function(){
            const form = document.getElementById('walkinForm');
            const picker = document.getElementById('wfServicePicker');
            const rows = picker ? [...picker.querySelectorAll('input[type=checkbox]')].map((i)=>({id:i.value,checked:i.checked,disabled:i.disabled})) : null;
            return {
              formOpen: !!form && form.hidden === false,
              oldCard: !!document.getElementById('bd-1'),
              oldBlock: !!document.getElementById('bkServiceEditPicker'),
              rows,
              hasActualPrice: !!document.getElementById('bkActualPrice'),
            };
          })()`);
          check('мастер: запись открывается общей формой, старой карточки больше нет',
            masterCard.formOpen === true && masterCard.oldCard === false && masterCard.oldBlock === false,
            JSON.stringify(masterCard));
          check('мастер: уже оказанная услуга заблокирована, новую можно отметить',
            Array.isArray(masterCard.rows)
            && masterCard.rows.some((r) => r.id === 'strizhka' && r.checked && r.disabled)
            && masterCard.rows.some((r) => r.id === 'vosk' && !r.checked && !r.disabled),
            JSON.stringify(masterCard.rows));
          check('мастер: фактическая сумма ему по-прежнему не показывается',
            masterCard.hasActualPrice === false, `есть=${masterCard.hasActualPrice}`);

          await s.click('#wfServicePicker input[value="vosk"]');
          await sleep(300);
          await s.click('#wfSubmit');
          await sleep(1500);
          const masterSaveResult = await s.eval(`document.getElementById('wfResult')?.textContent.trim()`);
          check('мастер: добавление услуги к записи по-прежнему сохраняется',
            /добавлен/i.test(masterSaveResult || ''), `результат="${masterSaveResult}"`);
        }
      });
    });
  });
} catch (err) {
  console.error('ПРОГОН УПАЛ:', err.message);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
