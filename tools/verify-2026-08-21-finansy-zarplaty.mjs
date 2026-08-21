// Живой прогон раздела "Финансы" владельца (21.08.2026, правка Влада из 9 пунктов).
// Что доказываем в реальном браузере, а не в предположении:
//   1. подписи-пояснения убраны, слова "реально" в разделе нет вовсе
//   2. блок "Зарплаты мастеров" строится по составу команды - новый сотрудник с
//      включённым "Принимает клиентов" попадает туда сам, без правки разметки
//   3. у владельца и управляющего то же поле "Ставка от выручки, %", что у мастера,
//      а не мёртвая надпись "Зарплата 100% от выручки". Ставку задаёт владелец, за
//      него её никто не выдумывает - незаполненная равна нулю
//   4. рядом с именем в "Финансах" стоит аватар, как в остальных разделах
//   5. САМОЕ ВАЖНОЕ: в деньги идут только состоявшиеся визиты (зелёная карточка,
//      status='done'). Ожидание, неявка и отмена не добавляют ни рубля - ни в
//      выручку, ни в зарплату, ни за день, ни за любой другой период
//   6. подсказка о негодной ставке приходит всплывающим сообщением
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Локальная дата, не UTC: "День" в CRM открывается по дате БРАУЗЕРА (тот же урок, что
// в verify-2026-08-20-top-master-crm.mjs)
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = todayLocal();
const JAN1 = `${new Date().getFullYear()}-01-01`;

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    // Управляющий - и логин для прогона, и одновременно проверка пункта 3: он
    // оказывает услуги, значит у него должна быть своя карточка со ставкой
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('zp-boss', 1, 'QA Управляющий', 'manager', true, true, true, 'zp-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    // Новый мастер - ровно тот случай, который до правки в "Финансы" не попадал:
    // строки в master_payroll_settings у него нет, id не из тройки master-1/2/3
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email)
       VALUES ('zp-new', 1, 'QA Новый Мастер', 'master', true, true, false, 'zp-new@alikhan.test')`
    );
    for (const id of ['zp-boss', 'zp-new']) {
      await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT $1, id, price, duration_min FROM services`, [id]);
    }

    // Ставки из сида: master-1 (владелец Алиовсад) 100%, master-2 100%, master-3 40%
    const seedPct = await db.query(`SELECT master_id, pct FROM master_payroll_settings ORDER BY master_id`);
    check('сид ставок на месте (100/100/40)', seedPct.rows.length === 3, JSON.stringify(seedPct.rows));

    // ── Фикстура денег. Все брони - одна "Стрижка" за 2000 ₽ ──────────────────
    // Только 'done' - зелёная карточка. Остальные три статуса стоят рядом
    // специально: до правки они молча попадали в те же суммы
    const rows = [
      ['zp-b1', 'master-2', TODAY, '11:00', '11:40', 'done'],
      ['zp-b2', 'master-2', TODAY, '12:00', '12:40', 'done'],
      ['zp-b3', 'master-2', TODAY, '13:00', '13:40', 'planned'],
      ['zp-b4', 'master-2', TODAY, '14:00', '14:40', 'cancelled'],
      ['zp-b5', 'master-2', TODAY, '15:00', '15:40', 'no_show'],
      ['zp-b6', 'master-3', TODAY, '11:00', '11:40', 'done'],
      ['zp-b7', 'master-1', TODAY, '11:00', '11:40', 'done'],
      ['zp-b8', 'zp-new', TODAY, '11:00', '11:40', 'done'],
      ['zp-b9', 'master-2', JAN1, '11:00', '11:40', 'done'],
      ['zp-b10', 'master-2', JAN1, '12:00', '12:40', 'planned'],
    ];
    for (const [id, masterId, date, start, end, status] of rows) {
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel, walkin_name)
         VALUES ($1, 1, $2, NULL, $3, $4, $5, $6, 'walkin', 'QA Клиент')`,
        [id, masterId, date, start, end, status]
      );
      await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'strizhka')`, [id]);
    }

    // Ожидаемые цифры считаем из БАЗЫ, а не литералом: цена услуги у каждого мастера
    // своя (master_services, у Екатерины стрижка дешевле), ставки - из сида 005.
    // Литерал здесь означал бы, что прогон проверяет мою арифметику, а не продукт
    const priceRows = await db.query(`SELECT master_id, price FROM master_services WHERE service_id = 'strizhka'`);
    const priceOf = Object.fromEntries(priceRows.rows.map((r) => [r.master_id, Number(r.price)]));
    const pctRows = await db.query(`SELECT master_id, pct FROM master_payroll_settings`);
    const roleRows = await db.query(`SELECT id, role FROM staff`);
    const roleOf = Object.fromEntries(roleRows.rows.map((r) => [r.id, r.role]));
    const pctFromDb = Object.fromEntries(pctRows.rows.map((r) => [r.master_id, Number(r.pct)]));
    // Тот же дефолт, что в интерфейсе (defaultPctFor, assets/crm-shared.js)
    const pctOf = (id) => pctFromDb[id] ?? 0;

    const done = rows.filter((r) => r[5] === 'done');
    const doneToday = done.filter((r) => r[2] === TODAY);
    const sumRevenue = (list) => list.reduce((sum, r) => sum + priceOf[r[1]], 0);
    const sumPayroll = (list) => list.reduce((sum, r) => sum + (priceOf[r[1]] * pctOf(r[1])) / 100, 0);
    const revenueToday = sumRevenue(doneToday);
    const payrollToday = sumPayroll(doneToday);
    const revenueYear = sumRevenue(done);
    const payrollYear = sumPayroll(done);
    // toLocaleString('ru-RU') разделяет разряды НЕразрывным пробелом. innerText из
    // браузера прогон нормализует (\s ловит и его), поэтому ожидание нормализуем тем же
    const money = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`.replace(/\s/g, ' ');
    const perMasterToday = (id) => sumPayroll(doneToday.filter((r) => r[1] === id));

    // Ставка мимо формы (старая вкладка, прямой вызов API) - раньше диапазон держал
    // только CHECK таблицы, и запрос падал в 500 "Сервер не смог обработать запрос"
    const token = (await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'zp-boss@alikhan.test', pin: bossPin }),
    }).then((r) => r.json())).token;
    const badPct = await fetch(`${apiUrl}/payroll-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ masterId: 'master-3', pct: 150 }),
    });
    const badPctBody = await badPct.json();
    check('ставка вне 0-100 мимо формы - внятный отказ 400, а не 500', badPct.status === 400 && badPctBody.error === 'invalid_pct', `${badPct.status} ${JSON.stringify(badPctBody)}`);

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'zp-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // Вкладка "Финансы" (panel-c) + ждём, пока карточки ЗП построятся
        await s.eval(`document.querySelector('#pt-c, [for="pt-c"]')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#payrollStaffList .payroll-card [data-amount="day"]'))`)); i++) await sleep(200);
        // и пока в суммах не останется "считаю…"
        for (let i = 0; i < 80 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-c .unsure'))`)); i++) await sleep(200);

        const panelText = norm(await s.eval(`document.querySelector('.panel-c')?.innerText || ''`));

        // ── 1. подписи убраны ────────────────────────────────────────────────
        const gone = [
          'Неделя/Месяц/Квартал/Год считается с начала периода по сегодня',
          'За день - реальная сумма по записям в базе на сегодня',
          'По ставке своего мастера от той же реальной выручки',
          'Выручка минус зарплаты',
          'Зарплата 100% от выручки',
          'За сегодня, по ставке из поля выше',
          'выберите даты и нажмите',
          'По броням этого мастера за выбранный диапазон дат',
        ];
        for (const phrase of gone) {
          check(`подпись убрана: "${phrase}"`, !panelText.includes(phrase));
        }
        check('слова "реально" в "Финансах" не осталось', !panelText.includes('реально'), panelText.slice(0, 200));

        // ── 2. состав карточек = все, кто принимает клиентов ──────────────────
        const cards = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#payrollStaffList .payroll-card')].map((c) => ({
          id: c.dataset.masterId,
          name: c.querySelector('.summary-meta .name')?.textContent ?? '',
          role: c.querySelector('.summary-meta .role')?.textContent ?? '',
          avatar: !!c.querySelector('summary .avatar'),
          pct: c.querySelector('[data-pct-input]')?.value ?? null,
          day: (c.querySelector('[data-amount="day"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          week: (c.querySelector('[data-amount="week"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          month: (c.querySelector('[data-amount="month"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        })))`));
        const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
        const expected = ['master-1', 'master-2', 'master-3', 'zp-boss', 'zp-new'];
        check('карточка есть у каждого, кто принимает клиентов', expected.every((id) => byId[id]), JSON.stringify(cards.map((c) => c.id)));
        check('новый мастер (zp-new) подтянулся в "Финансы" сам', !!byId['zp-new'], JSON.stringify(cards.map((c) => c.id)));
        check('администратор и владелец-нестригущий в блок не попали', !byId['admin-loc1-test'] && !byId['owner-test'], JSON.stringify(cards.map((c) => c.id)));

        // ── 3. то же поле ставки у владельца и управляющего ───────────────────
        // У владельца ставка 100 - это значение из сида (миграция 005), не дефолт.
        // Ставит её Алихан сам: 0 = "мои стрижки остаются в чистом доходе"
        check('у владельца (master-1) поле "Ставка от выручки, %" со значением из базы', byId['master-1']?.pct === '100', JSON.stringify(byId['master-1']));
        check('у управляющего то же поле ставки, значение ещё не задано (0)', byId['zp-boss']?.pct === '0', JSON.stringify(byId['zp-boss']));
        check('у нового мастера ставку никто не выдумал (0, ждёт владельца)', byId['zp-new']?.pct === '0', JSON.stringify(byId['zp-new']));
        check('подпись "ставка ещё не задана" стоит у тех, кому её не задавали', JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#payrollStaffList .payroll-card')].filter((c) => (c.querySelector('[data-pct-note]')?.textContent ?? '').includes('не задана')).map((c) => c.dataset.masterId))`)).join(',') === 'zp-boss,zp-new', 'ожидались zp-boss и zp-new');
        const pctLabels = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#payrollStaffList .payroll-card .field-grid label')].map((l) => l.textContent.trim()))`));
        check('поле ставки с одной и той же подписью есть у каждой карточки', pctLabels.length === cards.length && pctLabels.every((t) => t === 'Ставка от выручки, %'), JSON.stringify(pctLabels));

        // ── 4. аватар рядом с именем ──────────────────────────────────────────
        check('рядом с именем в "Финансах" стоит аватар', cards.every((c) => c.avatar), JSON.stringify(cards.map((c) => [c.id, c.avatar])));

        // ── 5. деньги: только состоявшиеся визиты ─────────────────────────────
        check(`ЗП master-2 за день = только 2 состоявшихся визита из 5 броней (${money(perMasterToday('master-2'))})`, byId['master-2']?.day === money(perMasterToday('master-2')), byId['master-2']?.day);
        check(`ЗП master-3 за день по своей ставке (${money(perMasterToday('master-3'))})`, byId['master-3']?.day === money(perMasterToday('master-3')), byId['master-3']?.day);
        check(`владелец больше не "Не начисляется" - у него своя сумма (${money(perMasterToday('master-1'))})`, byId['master-1']?.day === money(perMasterToday('master-1')), byId['master-1']?.day);
        check('новый мастер со ставкой 0 показывает 0 ₽, а не пустоту', byId['zp-new']?.day === money(0), byId['zp-new']?.day);
        check('управляющий без визитов - 0 ₽', byId['zp-boss']?.day === money(0), byId['zp-boss']?.day);
        check('неделя/месяц у master-2 тоже без ожидающих и отменённых', byId['master-2']?.week === money(perMasterToday('master-2')) && byId['master-2']?.month === money(perMasterToday('master-2')), `${byId['master-2']?.week} / ${byId['master-2']?.month}`);

        const stat = async (id) => norm(await s.eval(`document.getElementById(${JSON.stringify(id)})?.textContent || ''`));
        check(`Выручка за день = ${money(revenueToday)} (только зелёные визиты)`, (await stat('rvAllDayRevenue')) === money(revenueToday), await stat('rvAllDayRevenue'));
        check(`Зарплаты за день = ${money(payrollToday)}`, (await stat('rvAllDayPayroll')) === money(payrollToday), await stat('rvAllDayPayroll'));
        check(`Чистый доход за день = ${money(revenueToday - payrollToday)}`, (await stat('rvAllDayNet')) === money(revenueToday - payrollToday), await stat('rvAllDayNet'));
        check(`Выручка за год = ${money(revenueYear)} (ожидающая бронь 1 января не в счёт)`, (await stat('rvAllYearRevenue')) === money(revenueYear), await stat('rvAllYearRevenue'));
        check(`Зарплаты за год = ${money(payrollYear)}`, (await stat('rvAllYearPayroll')) === money(payrollYear), await stat('rvAllYearPayroll'));
        // Квартал/месяц/неделя - без январской брони, ровно сегодняшние цифры
        check('Квартал/Месяц/Неделя считают тот же сегодняшний факт', (await stat('rvAllQuarterRevenue')) === money(revenueToday) && (await stat('rvAllMonthRevenue')) === money(revenueToday) && (await stat('rvAllWeekRevenue')) === money(revenueToday), `${await stat('rvAllQuarterRevenue')} / ${await stat('rvAllMonthRevenue')} / ${await stat('rvAllWeekRevenue')}`);

        // "Задать период" - тот же фильтр на произвольном диапазоне
        await s.eval(`(function(){
          const card = document.querySelector('.payroll-card[data-master-id="master-2"]');
          card.setAttribute('open','');
          card.querySelector('.payroll-period-pill[data-period="period"]').click();
          const dates = card.querySelectorAll('.payroll-date-slot .custom-date');
          dates[0].dataset.value = ${JSON.stringify(JAN1)};
          dates[1].dataset.value = ${JSON.stringify(TODAY)};
          card.querySelector('[data-period-show]').click();
        })()`);
        await sleep(400);
        const periodAmount = norm(await s.eval(`document.querySelector('.payroll-card[data-master-id="master-2"] [data-amount="period"]')?.textContent || ''`));
        const expectedPeriod = sumPayroll(done.filter((r) => r[1] === 'master-2'));
        check(`"Задать период" с 1 января: ${money(expectedPeriod)} - три состоявшихся визита из шести`, periodAmount === money(expectedPeriod), periodAmount);

        // ── 6. подсказка о негодной ставке - всплывающим сообщением ───────────
        await s.eval(`(function(){
          const card = document.querySelector('.payroll-card[data-master-id="master-3"]');
          card.setAttribute('open','');
          const input = card.querySelector('[data-pct-input]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '150');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          card.querySelector('[data-pct-save]').click();
        })()`);
        await sleep(600);
        const toast = norm(await s.eval(`document.querySelector('.crm-toast--error .crm-toast__text')?.textContent || ''`));
        check('негодная ставка объясняется всплывающим сообщением', toast === 'Ставка должна быть числом от 0 до 100', toast);
        const notSaved = await db.query(`SELECT pct FROM master_payroll_settings WHERE master_id = 'master-3'`);
        check('и в базу негодная ставка не ушла', Number(notSaved.rows[0].pct) === 40, String(notSaved.rows[0].pct));

        // Годная ставка сохраняется и сразу пересчитывает сумму этой карточки
        await s.eval(`document.querySelector('.crm-toast__close')?.click()`);
        await s.eval(`(function(){
          const card = document.querySelector('.payroll-card[data-master-id="master-3"]');
          const input = card.querySelector('[data-pct-input]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '50');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          card.querySelector('[data-pct-save]').click();
        })()`);
        await sleep(2500);
        const savedPct = await db.query(`SELECT pct FROM master_payroll_settings WHERE master_id = 'master-3'`);
        check('годная ставка сохранена (40 → 50)', Number(savedPct.rows[0].pct) === 50, String(savedPct.rows[0].pct));
        for (let i = 0; i < 40 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-c .unsure'))`)); i++) await sleep(200);
        const m3Day = norm(await s.eval(`document.querySelector('.payroll-card[data-master-id="master-3"] [data-amount="day"]')?.textContent || ''`));
        const expectedM3 = (priceOf['master-3'] * 50) / 100;
        check(`после смены ставки сумма пересчиталась без перезагрузки (${money(expectedM3)})`, m3Day === money(expectedM3), m3Day);

        // Новую ставку принимает и сотрудник, у которого строки в базе не было
        await s.eval(`(function(){
          const card = document.querySelector('.payroll-card[data-master-id="zp-new"]');
          card.setAttribute('open','');
          const input = card.querySelector('[data-pct-input]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '45');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          card.querySelector('[data-pct-save]').click();
        })()`);
        await sleep(2500);
        const newPct = await db.query(`SELECT pct FROM master_payroll_settings WHERE master_id = 'zp-new'`);
        check('ставка нового мастера завелась в базе с нуля', Number(newPct.rows[0]?.pct) === 45, JSON.stringify(newPct.rows));

        // Снимок для глаз - оба блока раскрыты, иначе на картинке два свёрнутых
        // заголовка и по ней ничего не видно
        await s.eval(`document.querySelectorAll('.panel-c details.staff-card').forEach((d) => d.setAttribute('open',''))`);
        await s.eval(`document.querySelector('.crm-toast__close')?.click()`);
        await sleep(500);
        await s.eval(`document.querySelector('#payrollStaffList')?.scrollIntoView({ block: 'start' })`);
        await sleep(400);
        await s.screenshot('/tmp/verify-finansy-zarplaty.png');
        await s.eval(`document.querySelector('#rvAllDayRevenue')?.scrollIntoView({ block: 'center' })`);
        await sleep(400);
        await s.screenshot('/tmp/verify-finansy-vyruchka.png');

        // Телефон - основной экран, с которого Влад смотрит результат. Четыре пилюли
        // периода в карточке не должны выпирать за края (у .seg-bar.master-pill-row
        // на узком экране свой горизонтальный скролл, см. mockup-crm.css)
        await s.setViewport(390, 844, true);
        await sleep(600);
        await s.eval(`document.querySelectorAll('.panel-c details.staff-card').forEach((d) => d.setAttribute('open',''))`);
        await s.eval(`document.querySelector('#payrollStaffList .payroll-card')?.scrollIntoView({ block: 'start' })`);
        await sleep(500);
        const overflow = JSON.parse(await s.eval(`(function(){
          const w = window.visualViewport ? window.visualViewport.width : window.innerWidth;
          const wide = [...document.querySelectorAll('#payrollStaffList .payroll-card *')]
            .filter((n) => n.getBoundingClientRect().right > w + 1)
            .map((n) => n.className || n.tagName);
          return JSON.stringify({ w, wide: wide.slice(0, 5) });
        })()`));
        check('на телефоне карточка ЗП не вылезает за край экрана', overflow.wide.length === 0, JSON.stringify(overflow));
        await s.screenshot('/tmp/verify-finansy-mobile.png');
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err);
}

summary();
if (crashed) process.exitCode = 1;
