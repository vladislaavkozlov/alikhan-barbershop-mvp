// Живая проверка второй итерации правок панели "Запись" в разделе "Расписание"
// (13.08.2026, 7 пунктов Влада по живому интерфейсу):
//  1. поле "Мастер" - в одной строке с датой и временем, не дропдаун во всю панель;
//  2. заголовка "Услуги" и подсказки про факт оказанных услуг нет, список остался в
//     той же пунктирной рамке и не сворачивается;
//  3. строки итога ("Выбрано услуг: N · итого M мин · сумма") нет;
//  4. подписей под "Фактическая сумма" и "Комментарий к записи" нет;
//  5. своей кнопки "Сохранить сумму и комментарий" нет - сохраняет общая кнопка;
//  6. "Сохранить изменения" неактивна, пока ничего не изменили, и оживает на ЛЮБОЕ
//     изменение (услуги, время, мастер, сумма, комментарий, статус визита);
//  9. смена статуса + "Сохранить изменения" отвечает "Сохранено", а не "Изменений
//     не было".
//
// Своя одноразовая база и свой сервер (withEphemeralServer) - чужие фикстуры и
// аккаунты не нужны. Клики реальные (s.clickAt по свежему getBoundingClientRect),
// один withBrowser на весь прогон (порт отладки в cdp.mjs захардкожен).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_DIR = '/private/tmp/claude-501/-Users-user/87aa7dce-bde4-436c-bcda-0b4b4efe5f3a/scratchpad';

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

// Снимок панели: геометрия полей строки "Дата/Время/Мастер", наличие убранных
// элементов, состояние кнопки сохранения.
const PANEL_SNAPSHOT = `(function(){
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
  };
  const form = document.getElementById('walkinForm');
  const svc = document.querySelector('#walkinForm .service-edit');
  const submit = document.getElementById('wfSubmit');
  return {
    dateBox: box('#wfDate-slot .custom-date'),
    timeBox: box('#wfTime-slot .custom-select'),
    masterBox: box('#wfMaster-slot .custom-select'),
    masterFieldInDateRow: !!document.querySelector('#wfDateTimeRow > #wfMasterRow'),
    formWidth: form ? Math.round(form.getBoundingClientRect().width) : null,
    hasSummaryEl: !!document.getElementById('wfSummary'),
    hasServiceHint: !!document.getElementById('wfServiceEditHint'),
    hasPriceSaveBtn: !!document.getElementById('bkActualPriceSave'),
    serviceIsDetails: svc ? svc.tagName === 'DETAILS' : null,
    serviceBorder: svc ? getComputedStyle(svc).borderStyle : null,
    serviceHintsInside: document.querySelectorAll('#wfEditExtras .section-hint').length,
    hasSummaryTextOnScreen: /Выбрано услуг|Выберите хотя бы одну услугу/.test(form ? form.innerText : ''),
    submitDisabled: submit ? submit.disabled : null,
    submitLabel: submit ? submit.textContent.trim() : null,
    priceValue: document.getElementById('bkActualPrice')?.value ?? null,
    commentValue: document.getElementById('bkStaffComment')?.value ?? null,
    result: document.getElementById('wfResult')?.textContent.trim() ?? '',
  };
})()`;

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pinAdmin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o60-owner',  1, 'QA Владелец', 'owner',  true, true,  true, 'o60-owner@test.local',  $1),
       ('o60-admin',  1, 'QA Админ',    'admin',  true, false, true, 'o60-admin@test.local',  $2),
       ('o60-second', 1, 'QA Мастер 2', 'master', true, true,  false, null, null)`,
      [hashPin(pinOwner), hashPin(pinAdmin)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m, wd, true, '10:00', '20:00' FROM generate_series(1,7) AS wd, (VALUES ('o60-owner'),('o60-second')) AS t(m)`
    );
    // Стрижка + воск: пара НЕ комбинируемая (стрижка с бородой сворачиваются в
    // комплекс, SERVICE_COMBOS в storage.js - проверялась бы не та механика)
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('o60-owner',  'strizhka', 2000, 40),
       ('o60-owner',  'vosk',      500, 15),
       ('o60-second', 'strizhka', 1800, 40),
       ('o60-second', 'vosk',      500, 15)`
    );

    const { token } = await (await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o60-owner@test.local', pin: pinOwner }),
    })).json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const today = daysFromToday(0);

    const booking = (await (await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o60-owner', serviceIds: ['strizhka'], date: today, startTime: '15:00', clientName: 'Тимур Проверкин', clientPhone: '+7 999 111-22-33', channel: 'admin' }),
    })).json()).booking;
    if (!booking?.id) throw new Error('фикстура записи не создалась');

    const fetchBooking = async () => {
      const { bookings } = await (await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth })).json();
      return bookings.find((b) => b.id === booking.id);
    };

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1100);
        await login(s, base, 'crm-owner.html', 'o60-owner@test.local', pinOwner);

        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        const apptSel = `.appt[data-id="${booking.id}"]`;
        if (!(await s.eval(`!!document.querySelector(${JSON.stringify(apptSel)})`))) {
          throw new Error('карточка записи не отрисовалась в дне владельца');
        }
        check('запись открывается живым кликом по карточке в дне',
          (await clickCenter(s, apptSel)) === 'OK');
        await sleep(700);

        const p = await s.eval(PANEL_SNAPSHOT);
        await s.screenshot(`${SHOT_DIR}/okno60-owner-panel.png`);

        // п.1 - мастер стоит в одной строке с датой/временем и той же ширины
        check('п.1: поле "Мастер" лежит в строке даты и времени',
          p.masterFieldInDateRow === true, `внутри=${p.masterFieldInDateRow}`);
        check('п.1: мастер на одной высоте с датой и временем (одна строка)',
          p.masterBox && p.dateBox && Math.abs(p.masterBox.top - p.dateBox.top) <= 4,
          JSON.stringify({ master: p.masterBox, date: p.dateBox }));
        check('п.1: ширина дропдауна мастера ≈ ширина даты, а не во всю панель',
          p.masterBox && p.dateBox && Math.abs(p.masterBox.width - p.dateBox.width) <= 6
          && p.masterBox.width < p.formWidth * 0.55,
          JSON.stringify({ masterW: p.masterBox?.width, dateW: p.dateBox?.width, formW: p.formWidth }));

        // п.2 - список услуг без заголовка/подсказки, в той же пунктирной рамке
        check('п.2: заголовка "Услуги" и <details> больше нет, рамка осталась пунктирной',
          p.serviceIsDetails === false && p.serviceBorder === 'dashed',
          JSON.stringify({ details: p.serviceIsDetails, border: p.serviceBorder }));
        check('п.2: подсказки "Отметьте, что мастер сделал по факту…" нет',
          p.hasServiceHint === false, `есть=${p.hasServiceHint}`);

        // п.3 - строка итога по услугам
        check('п.3: строки "Выбрано услуг: … итого … ₽" на экране нет',
          p.hasSummaryEl === false && p.hasSummaryTextOnScreen === false,
          JSON.stringify({ el: p.hasSummaryEl, text: p.hasSummaryTextOnScreen }));

        // п.4 - подписи под суммой и комментарием
        check('п.4: подписей под "Фактическая сумма" и "Комментарий" нет',
          p.serviceHintsInside === 0, `подписей=${p.serviceHintsInside}`);

        // п.5 - своя кнопка сохранения суммы
        check('п.5: кнопки "Сохранить сумму и комментарий" нет',
          p.hasPriceSaveBtn === false, `есть=${p.hasPriceSaveBtn}`);

        // п.6 - кнопка неактивна до изменений
        check('п.6: "Сохранить изменения" неактивна сразу после открытия записи',
          p.submitDisabled === true && p.submitLabel === 'Сохранить изменения',
          JSON.stringify({ disabled: p.submitDisabled, label: p.submitLabel }));

        const submitDisabled = async () => s.eval(`document.getElementById('wfSubmit').disabled`);

        // услуги: отметил → активна, снял обратно → снова неактивна (сравнение идёт
        // со снимком "как было", а не с фактом "что-то трогали")
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(350);
        check('п.6: отметил вторую услугу - кнопка стала активна',
          (await submitDisabled()) === false);
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(350);
        check('п.6: снял её обратно - кнопка снова погасла (вернулись к исходному)',
          (await submitDisabled()) === true);

        // комментарий
        await s.type('#bkStaffComment', 'Скидка от владельца');
        await sleep(300);
        check('п.6: правка комментария поднимает кнопку',
          (await submitDisabled()) === false);

        // сумма
        await s.type('#bkActualPrice', '1700');
        await sleep(300);
        check('п.6: правка фактической суммы держит кнопку активной',
          (await submitDisabled()) === false);

        // сохранение общей кнопкой: сумма и комментарий должны уехать без своей кнопки
        await clickCenter(s, '#wfSubmit');
        await sleep(2000);
        const afterSave = await s.eval(PANEL_SNAPSHOT);
        check('п.5: сумма и комментарий сохранились общей кнопкой',
          /Сохранено/.test(afterSave.result) && /сумма и комментарий/.test(afterSave.result),
          `результат="${afterSave.result}"`);
        const inDb = await fetchBooking();
        check('п.5: в базе сумма 1700 и комментарий из формы',
          inDb.actualPrice === 1700 && inDb.staffComment === 'Скидка от владельца',
          JSON.stringify({ actualPrice: inDb.actualPrice, staffComment: inDb.staffComment }));
        check('п.6: после сохранения кнопка снова неактивна',
          afterSave.submitDisabled === true, `disabled=${afterSave.submitDisabled}`);

        // время: смена через виджет тоже поднимает кнопку
        await clickCenter(s, '#wfTime-slot .custom-select-trigger');
        await sleep(300);
        await clickCenter(s, '#wfTime-slot .custom-select-option[data-value="16:00"]');
        await sleep(400);
        check('п.6: смена времени поднимает кнопку',
          (await submitDisabled()) === false);
        await clickCenter(s, '#wfSubmit');
        await sleep(2200);
        const moved = await fetchBooking();
        check('перенос сохранился общей кнопкой (15:00 → 16:00)',
          moved.startTime === '16:00', `startTime=${moved.startTime}`);

        // мастер: смена мастера поднимает кнопку
        await clickCenter(s, '#wfMaster-slot .custom-select-trigger');
        await sleep(300);
        await clickCenter(s, '#wfMaster-slot .custom-select-option[data-value="o60-second"]');
        await sleep(500);
        check('п.6: смена мастера поднимает кнопку',
          (await submitDisabled()) === false);
        // возвращаем мастера обратно - дальше проверяем статус на исходной записи
        await clickCenter(s, '#wfMaster-slot .custom-select-trigger');
        await sleep(300);
        await clickCenter(s, '#wfMaster-slot .custom-select-option[data-value="o60-owner"]');
        await sleep(500);

        // п.9 - статус визита
        await s.navigate(`${base}/crm-owner.html`);
        await sleep(3000);
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        await clickCenter(s, apptSel);
        await sleep(700);
        check('п.9: до правок кнопка снова неактивна (перезагруженная запись)',
          (await submitDisabled()) === true);
        await clickCenter(s, '#wfStatusRow label[for="st-came"]');
        await sleep(900);
        check('п.9: смена статуса визита поднимает кнопку',
          (await submitDisabled()) === false);
        await clickCenter(s, '#wfSubmit');
        await sleep(2000);
        const afterStatus = await s.eval(PANEL_SNAPSHOT);
        check('п.9: результат говорит "Сохранено: статус визита", а не "Изменений не было"',
          /Сохранено/.test(afterStatus.result) && /статус визита/.test(afterStatus.result)
          && !/Изменений не было/.test(afterStatus.result),
          `результат="${afterStatus.result}"`);
        const statusInDb = await fetchBooking();
        check('п.9: статус в базе действительно "пришёл"',
          statusInDb.status === 'done', `status=${statusInDb.status}`);
        await s.screenshot(`${SHOT_DIR}/okno60-owner-status-saved.png`);

        // ── Регрессия админа: та же панель, те же правки ────────────────────────
        await login(s, base, 'crm-admin.html', 'o60-admin@test.local', pinAdmin);
        await clickCenter(s, '#scheduleCard-day > summary');
        await sleep(1500);
        const adminHasAppt = await s.eval(`!!document.querySelector(${JSON.stringify(apptSel)})`);
        check('админ видит ту же запись в дне', adminHasAppt === true, `есть=${adminHasAppt}`);
        if (adminHasAppt) {
          await clickCenter(s, apptSel);
          await sleep(700);
          const a = await s.eval(PANEL_SNAPSHOT);
          await s.screenshot(`${SHOT_DIR}/okno60-admin-panel.png`);
          check('админ: те же правки на месте (мастер в строке, без итога, без своей кнопки, кнопка погашена)',
            a.masterFieldInDateRow === true && a.hasSummaryEl === false
            && a.hasPriceSaveBtn === false && a.serviceHintsInside === 0
            && a.submitDisabled === true,
            JSON.stringify({ master: a.masterFieldInDateRow, summary: a.hasSummaryEl, btn: a.hasPriceSaveBtn, hints: a.serviceHintsInside, disabled: a.submitDisabled }));
        }
      });
    });
  });
} catch (err) {
  console.error('ПРОГОН УПАЛ:', err.message);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
