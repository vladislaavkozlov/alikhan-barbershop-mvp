// Живая проверка правок 13.08.2026 (вечер, 4 пункта Влада по панели "Запись" в
// разделе "Расписание" + один мелкий баг боковой панели):
//  1. статусы называются "Ожидание / Обслужен / Не пришёл", и выбранный красится тем
//     же цветом, что его запись в календаре "День" (акцент / зелёный / красный);
//  2. клик по радио статуса НЕ пишет в базу - изменения вступают в силу только по
//     кнопке "Сохранить изменения";
//  3. кнопка активна ровно тогда, когда в записи что-то изменили (включая статус),
//     а успешный результат - одно слово "Сохранено" без перечисления и подписи;
//  4. ошибка сохранения показывается на том же месте (#wfResult), ниже кнопок, в
//     красной рамке;
//  5. управляющий (роль manager, работает на странице владельца) видит в боковой
//     панели "Управляющий", а не "Владелец".
//
// Своя одноразовая база и свой сервер (withEphemeralServer), клики реальные
// (s.clickAt по свежему getBoundingClientRect), один withBrowser на весь прогон -
// порт отладки в cdp.mjs захардкожен, второй браузер подряд гонится за него.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_DIR = '/private/tmp/claude-501/-Users-user/118c871c-71b2-4c65-960b-24441d7d4bce/scratchpad';

// Цвета из assets/mockup-crm.css - те же токены, которыми покрашены записи в
// календаре "День" (.appt--status-planned/done/noshow)
const ACCENT = 'rgb(198, 161, 91)';
const SUCCESS = 'rgb(111, 174, 124)';
const DANGER = 'rgb(193, 85, 74)';

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

// ВАЖНО: форма входа физически лежит в DOM даже при активной сессии (её только
// скрывает loginGate), поэтому "просто заполнить поля" при живой сессии молча ничего
// не даёт - остаётся залогинен прежний сотрудник. Перед каждым входом чистим
// localStorage и перезагружаем страницу, иначе смена пользователя в прогоне
// незаметно не происходит (наступил на это при первом запуске).
async function login(s, base, page, email, pin) {
  await s.navigate(`${base}/${page}`);
  await sleep(400);
  await s.eval(`localStorage.clear()`);
  await s.navigate(`${base}/${page}`);
  await sleep(500);
  for (let i = 0; i < 20 && !(await s.eval(`!!document.getElementById('loginEmail')`)); i++) await sleep(150);
  await s.type('#loginEmail', email);
  await s.type('#loginPin', pin);
  await s.click('#loginForm button[type="submit"]');
  await sleep(3000);
}

// Снимок статусной строки и строки результата. Геометрия результата нужна пункту 4:
// "внизу" - это не фигура речи, а ниже кнопок сохранения.
const PANEL_SNAPSHOT = `(function(){
  const labelInfo = (forId) => {
    const el = document.querySelector('#wfStatusRow label[for="' + forId + '"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: el.textContent.trim(), borderColor: cs.borderTopColor, color: cs.color };
  };
  const result = document.getElementById('wfResult');
  const actions = document.querySelector('#walkinForm .wf-actions');
  const submit = document.getElementById('wfSubmit');
  const rr = result && !result.hidden ? result.getBoundingClientRect() : null;
  const ar = actions ? actions.getBoundingClientRect() : null;
  return {
    wait: labelInfo('st-wait'),
    came: labelInfo('st-came'),
    no: labelInfo('st-no'),
    checkedRadio: document.querySelector('input[name="bstatus"]:checked')?.id ?? null,
    realStatus: document.getElementById('walkinForm')?.dataset.realStatus ?? null,
    submitDisabled: submit ? submit.disabled : null,
    submitLabel: submit ? submit.textContent.trim() : null,
    resultText: result && !result.hidden ? result.textContent.trim() : '',
    resultClass: result ? result.className : null,
    resultBorderColor: rr ? getComputedStyle(result).borderTopColor : null,
    resultBelowActions: rr && ar ? rr.top >= ar.bottom : null,
    price: document.getElementById('bkActualPrice')?.value ?? null,
    statusNoteVisible: !!(document.getElementById('bk-status-note') && !document.getElementById('bk-status-note').hidden),
    sidebarProfile: document.getElementById('appShellProfile')?.textContent.trim() ?? null,
    topbarRole: document.querySelector('#roleSwitch [data-role]:not([hidden])')?.textContent.trim() ?? null,
  };
})()`;

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    const pinManager = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('o61-owner',   1, 'QA Владелец',   'owner',   true, true, true, 'o61-owner@test.local',   $1),
       ('o61-manager', 1, 'QA Управляющий','manager', true, true, true, 'o61-manager@test.local', $2)`,
      [hashPin(pinOwner), hashPin(pinManager)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m, wd, true, '10:00', '20:00' FROM generate_series(1,7) AS wd, (VALUES ('o61-owner')) AS t(m)`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('o61-owner', 'strizhka', 2000, 40),
       ('o61-owner', 'vosk',      500, 15)`
    );

    const { token } = await (await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'o61-owner@test.local', pin: pinOwner }),
    })).json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const today = daysFromToday(0);

    const booking = (await (await fetch(`${apiUrl}/bookings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ masterId: 'o61-owner', serviceIds: ['strizhka'], date: today, startTime: '15:00', clientName: 'Тимур Проверкин', clientPhone: '+7 999 111-22-33', channel: 'admin' }),
    })).json()).booking;
    if (!booking?.id) throw new Error('фикстура записи не создалась');

    const fetchBooking = async () => {
      const { bookings } = await (await fetch(`${apiUrl}/bookings?date=${today}`, { headers: auth })).json();
      return bookings.find((b) => b.id === booking.id);
    };
    const apptSel = `.appt[data-id="${booking.id}"]`;

    async function openBooking(s) {
      await clickCenter(s, '#scheduleCard-day > summary');
      await sleep(1500);
      if (!(await s.eval(`!!document.querySelector(${JSON.stringify(apptSel)})`))) {
        throw new Error('карточка записи не отрисовалась в дне владельца');
      }
      await clickCenter(s, apptSel);
      await sleep(700);
    }

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1100);
        await login(s, base, 'crm-owner.html', 'o61-owner@test.local', pinOwner);
        await openBooking(s);

        const p0 = await s.eval(PANEL_SNAPSHOT);
        await s.screenshot(`${SHOT_DIR}/okno61-status-opened.png`);

        // ── п.1: названия и цвета ─────────────────────────────────────────────
        check('п.1: статусы названы "Ожидание / Обслужен / Не пришёл"',
          p0.wait?.text === 'Ожидание' && p0.came?.text === 'Обслужен' && p0.no?.text === 'Не пришёл',
          JSON.stringify({ wait: p0.wait?.text, came: p0.came?.text, no: p0.no?.text }));
        check('п.1: у только что открытой записи выбрано "Ожидание" с акцентной обводкой',
          p0.checkedRadio === 'st-wait' && p0.wait?.borderColor === ACCENT,
          JSON.stringify({ checked: p0.checkedRadio, border: p0.wait?.borderColor }));

        // ── п.2: клик по радио в базу НЕ пишет ────────────────────────────────
        check('п.2: до правок кнопка "Сохранить изменения" неактивна',
          p0.submitDisabled === true && p0.submitLabel === 'Сохранить изменения',
          JSON.stringify({ disabled: p0.submitDisabled, label: p0.submitLabel }));

        await clickCenter(s, '#wfStatusRow label[for="st-no"]');
        await sleep(900);
        const p1 = await s.eval(PANEL_SNAPSHOT);
        const dbAfterClick = await fetchBooking();
        check('п.2: клик по "Не пришёл" НЕ уходит в базу - там всё ещё planned',
          dbAfterClick.status === 'planned', `status=${dbAfterClick.status}`);
        check('п.2: реальный статус на форме тоже не подменён кликом',
          p1.realStatus === 'planned', `realStatus=${p1.realStatus}`);
        check('п.1: выбранная неявка обведена красным (как её запись в календаре)',
          p1.no?.borderColor === DANGER && p1.no?.color === DANGER,
          JSON.stringify({ border: p1.no?.borderColor, color: p1.no?.color }));
        check('п.3: смена статуса поднимает кнопку сохранения',
          p1.submitDisabled === false, `disabled=${p1.submitDisabled}`);

        // Возврат к исходному статусу гасит кнопку обратно - признак строится на
        // сравнении со снимком "как было", а не на факте "что-то трогали"
        await clickCenter(s, '#wfStatusRow label[for="st-wait"]');
        await sleep(700);
        check('п.3: вернул статус как был - кнопка снова погасла',
          (await s.eval(`document.getElementById('wfSubmit').disabled`)) === true);

        // ── п.3: сохранение по кнопке, результат одним словом ─────────────────
        await clickCenter(s, '#wfStatusRow label[for="st-came"]');
        await sleep(700);
        await clickCenter(s, '#wfSubmit');
        await sleep(2200);
        const p2 = await s.eval(PANEL_SNAPSHOT);
        const dbAfterSave = await fetchBooking();
        await s.screenshot(`${SHOT_DIR}/okno61-status-saved.png`);
        check('п.2: статус уехал в базу именно по кнопке (planned → done)',
          dbAfterSave.status === 'done', `status=${dbAfterSave.status}`);
        check('п.3: результат - ровно "Сохранено", без перечисления и подписи',
          p2.resultText === 'Сохранено', `результат="${p2.resultText}"`);
        check('п.3: после сохранения кнопка снова неактивна',
          p2.submitDisabled === true, `disabled=${p2.submitDisabled}`);
        check('п.1: сохранённый "Обслужен" обведён зелёным',
          p2.came?.borderColor === SUCCESS && p2.came?.color === SUCCESS,
          JSON.stringify({ border: p2.came?.borderColor, color: p2.came?.color }));
        check('п.4: уведомление лежит ниже кнопок сохранения',
          p2.resultBelowActions === true, `ниже=${p2.resultBelowActions}`);

        // ── п.6: фактическая сумма идёт за составом услуг в ОБЕ стороны ───────
        // Баг Влада: "добавляешь услугу - сумма растёт, убираешь - не уменьшается".
        // Ключ именно в повторе после сохранения: до него автоподстановка работала,
        // а сохранённая сумма замораживала поле навсегда.
        check('п.6: при открытии в сумме стоит состав услуг (2000)',
          p2.price === '2000', `сумма="${p2.price}"`);
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(600);
        check('п.6: добавили услугу - сумма выросла (2500)',
          (await s.eval(`document.getElementById('bkActualPrice').value`)) === '2500');
        await clickCenter(s, '#wfSubmit');
        await sleep(2200);
        const saved = await fetchBooking();
        check('п.6: сохранилось - в базе состав из двух услуг и сумма 2500',
          saved.serviceIds.length === 2 && saved.actualPrice === 2500,
          JSON.stringify({ services: saved.serviceIds, actualPrice: saved.actualPrice }));
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(700);
        check('п.6: сняли услугу ПОСЛЕ сохранения - сумма уменьшилась (2000)',
          (await s.eval(`document.getElementById('bkActualPrice').value`)) === '2000',
          `сумма="${await s.eval(`document.getElementById('bkActualPrice').value`)}"`);
        await clickCenter(s, '#wfSubmit');
        await sleep(2200);
        const shrunk = await fetchBooking();
        check('п.6: уменьшенная сумма уехала в базу (2000)',
          shrunk.actualPrice === 2000 && shrunk.serviceIds.length === 1,
          JSON.stringify({ actualPrice: shrunk.actualPrice, services: shrunk.serviceIds }));

        // Ручную скидку автоподстановка по-прежнему не затирает
        await s.eval(`(function(){ const i = document.getElementById('bkActualPrice'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await s.type('#bkActualPrice', '1500');
        await sleep(400);
        await clickCenter(s, '#wfSubmit');
        await sleep(2200);
        await s.navigate(`${base}/crm-owner.html`);
        await sleep(3000);
        await openBooking(s);
        const discounted = await s.eval(PANEL_SNAPSHOT);
        check('п.6: ручная скидка 1500 пережила переоткрытие записи',
          discounted.price === '1500', `сумма="${discounted.price}"`);
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(700);
        check('п.6: и добавление услуги её не затирает (скидка остаётся 1500)',
          (await s.eval(`document.getElementById('bkActualPrice').value`)) === '1500');
        await clickCenter(s, '#wfServicePicker input[value="vosk"]');
        await sleep(600);
        await s.screenshot(`${SHOT_DIR}/okno61-price-follows-services.png`);

        // ── п.4: ошибка на том же месте и в красной рамке ─────────────────────
        // Портим токен - PATCH статуса (единственная правка) вернёт 401, ровно тот
        // случай, который Влад видел живьём ("Не удалось сохранить: HTTP 401")
        await s.eval(`localStorage.setItem('alikhan-crm:token', 'broken-token-for-401')`);
        await clickCenter(s, '#wfStatusRow label[for="st-no"]');
        await sleep(700);
        await clickCenter(s, '#wfSubmit');
        await sleep(2200);
        const p3 = await s.eval(PANEL_SNAPSHOT);
        await s.screenshot(`${SHOT_DIR}/okno61-status-error.png`);
        check('п.4: ошибка попала в ту же строку результата, а не в отдельную подпись',
          /Не удалось сохранить/.test(p3.resultText) && /401/.test(p3.resultText) && p3.statusNoteVisible === false,
          JSON.stringify({ текст: p3.resultText, отдельнаяПодпись: p3.statusNoteVisible }));
        check('п.4: строка ошибки в красной рамке',
          /wf-result--err/.test(p3.resultClass || '') && p3.resultBorderColor === DANGER,
          JSON.stringify({ class: p3.resultClass, border: p3.resultBorderColor }));
        check('п.4: строка ошибки на том же месте - ниже кнопок',
          p3.resultBelowActions === true, `ниже=${p3.resultBelowActions}`);
        check('п.2: провалившееся сохранение не изменило статус в базе',
          (await fetchBooking()).status === 'done', 'статус остался done');

        // ── п.5: роль управляющего в боковой панели ───────────────────────────
        await login(s, base, 'crm-owner.html', 'o61-manager@test.local', pinManager);
        await sleep(1200);
        const m = await s.eval(PANEL_SNAPSHOT);
        await s.screenshot(`${SHOT_DIR}/okno61-manager-sidebar.png`);
        check('п.5: боковая панель показывает управляющему "Управляющий", не "Владелец"',
          m.sidebarProfile === 'Управляющий', `в панели="${m.sidebarProfile}"`);
        check('п.5: шапка и боковая панель говорят одно и то же',
          m.topbarRole === 'Управляющий' && m.sidebarProfile === m.topbarRole,
          JSON.stringify({ шапка: m.topbarRole, панель: m.sidebarProfile }));

        // Регрессия: владельцу подпись не сломали
        await login(s, base, 'crm-owner.html', 'o61-owner@test.local', pinOwner);
        await sleep(1200);
        const o = await s.eval(PANEL_SNAPSHOT);
        check('п.5: владельцу по-прежнему "Владелец" в обоих местах',
          o.sidebarProfile === 'Владелец' && o.topbarRole === 'Владелец',
          JSON.stringify({ шапка: o.topbarRole, панель: o.sidebarProfile }));
      });
    });
  });
} catch (err) {
  console.error('ПРОГОН УПАЛ:', err.message);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
