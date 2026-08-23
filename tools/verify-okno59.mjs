// Живой прогон Окна 59 «Недополученная прибыль» (22.08.2026).
//
// Проверяем на эфемерной базе с заранее посчитанными руками цифрами: сеем визиты так,
// чтобы правильный ответ был известен до запуска, и сверяем и API, и то, что человек
// реально видит на экране.
//
// Раскладка фикстуры (сегодня = день прогона):
//   c1 «Просроченный»  - срок 14 дней, последний визит 40 дней назад, цена визита 2000
//                        → пропущено 2 визита (40 дней / 14 = 2 полных срока прошли),
//                          отвал 4000 ₽
//   c2 «В сроке»       - срок 60 дней, последний визит 10 дней назад → нигде не всплывает
//   c3 «Разрежённый»   - согласовано 56 дней при рекомендованных 28 (ровно 2x, выше
//                        порога 1.5), 3 визита за 112 дней → по рекомендованному
//                        уместилось бы 4 интервала вместо 2, недобор 2 визита × 2000
//                          = 4000 ₽ потенциала
//   неявка nsh1        - 1 запись × 2000 ₽ = 2000 ₽ потерь
//   walk-in без телефона - закрывается без срока вообще
// Итого карточка: потеряно 4000 + 2000, потенциал 4000, всего 10000 ₽
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
// check из verify-lib принимает УСЛОВИЕ вторым аргументом. Обёртка ниже сравнивает
// факт с ожиданием сама и печатает оба значения при расхождении: иначе любая непустая
// строка выглядела бы пройденной проверкой, даже когда цифра не сошлась
const eq = (label, actual, expected) =>
  check(label, String(actual) === String(expected), `получено: ${actual} · ожидалось: ${expected}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('n59-boss', 1, 'QA Владелец', 'owner', true, false, true, 'n59-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('n59-m1', 1, 'QA Мастер', 'master', true, true, true, 'n59-m1@alikhan.test', $1)`,
      [hashPin(masterPin)]
    );
    await db.query(`INSERT INTO services (id, name, category, price, duration_min) VALUES ('n59-cut', 'QA Стрижка', 'base', 1500, 60)
                    ON CONFLICT (id) DO NOTHING`);
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ('n59-m1', 'n59-cut', 2000, 60)
                    ON CONFLICT (master_id, service_id) DO UPDATE SET price = 2000`);

    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         VALUES ('n59-m1', $1, true, '10:00', '20:00')`,
        [weekday]
      );
    }

    const clients = [
      ['n59-c1', 'QA Просроченный', '+79990591111', 14, null, 'recommended'],
      ['n59-c2', 'QA В сроке', '+79990592222', 60, null, 'schedule'],
      ['n59-c3', 'QA Разрежённый', '+79990593333', 56, 28, 'price'],
      ['n59-c4', 'QA Новый без срока', '+79990594444', null, null, null],
    ];
    for (const [id, name, phone, days, rec, reason] of clients) {
      await db.query(
        'INSERT INTO clients (id, name, phone, renew_days, renew_days_recommended, renew_reason) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, name, phone, days, rec, reason]
      );
    }

    let seq = 0;
    const addBooking = async (clientId, dayOffset, status = 'done') => {
      const id = `n59-b${++seq}`;
      await db.query(
        `INSERT INTO bookings (id, master_id, location_id, client_id, service_id, date, start_time, end_time, status)
         VALUES ($1, 'n59-m1', 1, $2, 'n59-cut', $3, '11:00', '12:00', $4)`,
        [id, clientId, daysFromToday(dayOffset), status]
      );
      await db.query('INSERT INTO booking_services (booking_id, service_id) VALUES ($1, $2)', [id, 'n59-cut']);
      return id;
    };

    await addBooking('n59-c1', -40);
    await addBooking('n59-c2', -10);
    await addBooking('n59-c3', -112);
    await addBooking('n59-c3', -56);
    await addBooking('n59-c3', 0);
    await addBooking(null, -3); // walk-in без телефона
    await addBooking('n59-c2', -5, 'no_show'); // неявка

    const login = async (email, pin) =>
      (await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      })).json();
    const bossToken = (await login('n59-boss@alikhan.test', bossPin)).token;
    const masterToken = (await login('n59-m1@alikhan.test', masterPin)).token;
    const api = (path, token = bossToken, init = {}) =>
      fetch(`${apiUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });

    // ── 1. Миграция реально применилась на чистой базе ─────────────────────────
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'clients' AND column_name LIKE 'renew%' ORDER BY column_name`
    );
    eq(
      'миграция 056: все шесть полей срока на месте',
      cols.rows.map((r) => r.column_name).join(','),
      'renew_days,renew_days_recommended,renew_note,renew_reason,renew_set_at,renew_set_by'
    );

    // ── 2. Закрытие визита без срока у клиента с телефоном - отказ ─────────────
    const bNew = await addBooking('n59-c4', 0, 'planned');
    const noRenew = await api(`/bookings/${bNew}/status`, bossToken, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    eq('визит клиента без срока не закрывается', `${noRenew.status} ${(await noRenew.json()).error}`, '400 renew_required');

    // ── 3. «Не обсуждали» даёт ровно месяц, что бы ни прислал интерфейс ────────
    const withDefault = await api(`/bookings/${bNew}/status`, bossToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done', renew: { reason: 'not_discussed', days: 120 } }),
    });
    const savedDefault = (await db.query('SELECT renew_days, renew_reason, renew_set_by FROM clients WHERE id = $1', ['n59-c4'])).rows[0];
    eq('«не обсуждали» - ровно 30 дней', `${withDefault.status} ${savedDefault.renew_days} ${savedDefault.renew_reason}`, '200 30 not_discussed');
    eq('записано, кто поставил срок', savedDefault.renew_set_by, 'n59-boss');

    // ── 4. Повторное закрытие того же клиента срока уже не требует ─────────────
    const again = await addBooking('n59-c4', 0, 'planned');
    const againRes = await api(`/bookings/${again}/status`, bossToken, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    eq('постоянного клиента повторно не допрашивают', String(againRes.status), '200');

    // ── 5. Walk-in без телефона закрывается без срока ──────────────────────────
    const walkin = `n59-walkin`;
    await db.query(
      `INSERT INTO bookings (id, master_id, location_id, client_id, service_id, date, start_time, end_time, status, walkin_name)
       VALUES ($1, 'n59-m1', 1, NULL, 'n59-cut', $2, '15:00', '16:00', 'planned', 'Прохожий')`,
      [walkin, daysFromToday(0)]
    );
    const walkinRes = await api(`/bookings/${walkin}/status`, bossToken, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    eq('walk-in без телефона про срок не спрашивают', String(walkinRes.status), '200');

    // ── 6. Откат статуса срок не стирает ──────────────────────────────────────
    await api(`/bookings/${bNew}/status`, bossToken, { method: 'PATCH', body: JSON.stringify({ status: 'planned' }) });
    const afterRollback = (await db.query('SELECT renew_days FROM clients WHERE id = $1', ['n59-c4'])).rows[0];
    eq('откат статуса не отменяет договорённость', String(afterRollback.renew_days), '30');

    // ── 7. Деньги в карточке ──────────────────────────────────────────────────
    const money = await (await api(`/finance/missed-profit?from=${daysFromToday(-200)}&to=${daysFromToday(0)}`)).json();
    eq('отвал - два пропущенных визита по 2000', String(money.lostLapsed), '4000');
    eq('потенциал разрежённого - два визита по 2000', String(money.potentialSparse), '4000');
    eq('неявка - по цене несостоявшегося визита', String(money.lostNoShow), '2000');
    eq('общая сумма', String(money.total), '10000');
    eq('счётчики людей', JSON.stringify(money.counts), JSON.stringify({ overdue: 1, sparse: 1, noShow: 1 }));

    // ── 8. Пустой период - прочерк, а не ноль ─────────────────────────────────
    const empty = await (await api(`/finance/missed-profit?from=${daysFromToday(-400)}&to=${daysFromToday(-300)}`)).json();
    eq('нет данных за период - null, а не 0', JSON.stringify([empty.total, empty.lostLapsed]), '[null,null]');

    // ── 9. Списки ─────────────────────────────────────────────────────────────
    const overdueList = await (await api(`/finance/missed-profit/clients?from=${daysFromToday(-200)}&to=${daysFromToday(0)}&kind=overdue`)).json();
    eq('в списке «кому звонить» - просроченный', overdueList.clients.map((c) => c.name).join(','), 'QA Просроченный');
    eq('в списке есть телефон для связи', overdueList.clients[0].phone, '+79990591111');
    const sparseList = await (await api(`/finance/missed-profit/clients?from=${daysFromToday(-200)}&to=${daysFromToday(0)}&kind=sparse`)).json();
    eq('в списке «кому объяснить срок» - разрежённый', sparseList.clients.map((c) => c.name).join(','), 'QA Разрежённый');

    // ── 10. Возвращаемость считает по сроку клиента, а не по общему месяцу ────
    // c2 был 10 дней назад при сроке 60 - он в сроке и в знаменатель не идёт;
    // c1 при сроке 14 и визите 40 дней назад - уже не вернулся
    const lapsed = await (await api('/analytics/lapsed?months=12')).json();
    eq(
      'невернувшиеся - по личному сроку клиента',
      lapsed.clients.map((c) => c.name).sort().join(','),
      'QA Просроченный'
    );

    // ── 11. Доля обсуждённых сроков ───────────────────────────────────────────
    const discussed = await (await api('/analytics/renew-discussed?months=12')).json();
    const m1 = discussed.masters.find((m) => m.masterId === 'n59-m1');
    // Активные клиенты мастера: c1 (recommended), c2 (schedule), c3 (price), c4
    // (not_discussed) → обсуждено 3 из 4
    eq('доля обсуждённых сроков по мастеру', `${m1.discussed} из ${m1.clients} = ${m1.pct}%`, '3 из 4 = 75%');

    // ── 12. Права: мастер не закрывает визиты вовсе (правка Влада 22.08.2026) ──
    const masterBooking = await addBooking('n59-c2', 0, 'planned');
    const masterCloses = await api(`/bookings/${masterBooking}/status`, masterToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done', renew: { reason: 'recommended', days: 28 } }),
    });
    eq('мастер не может отметить визит обслуженным', String(masterCloses.status), '403');
    const stillPlanned = (await db.query('SELECT status FROM bookings WHERE id = $1', [masterBooking])).rows[0];
    eq('запись осталась в прежнем статусе', stillPlanned.status, 'planned');
    const masterNoShow = await api(`/bookings/${masterBooking}/status`, masterToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'no_show' }),
    });
    eq('мастер не отмечает и неявку', String(masterNoShow.status), '403');
    const masterSetsRenew = await api('/clients/n59-c2/renew', masterToken, {
      method: 'PATCH',
      body: JSON.stringify({ renew: { days: 28, reason: 'recommended' } }),
    });
    eq('мастер не правит срок и из карточки клиента', String(masterSetsRenew.status), '403');

    // Администратор - может: это его работа
    const adminPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('n59-adm', 1, 'QA Администратор', 'admin', true, false, true, 'n59-adm@alikhan.test', $1)`,
      [hashPin(adminPin)]
    );
    const adminToken = (await login('n59-adm@alikhan.test', adminPin)).token;
    const adminCloses = await api(`/bookings/${masterBooking}/status`, adminToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done', renew: { reason: 'recommended', days: 28 } }),
    });
    eq('администратор визит закрывает', String(adminCloses.status), '200');

    // ── 12b. Права: мастеру телефон клиента по-прежнему не отдаём ─────────────
    const cardForMaster = await (await api('/clients/n59-c1', masterToken)).json();
    eq('мастер не получает телефон клиента', String(cardForMaster.phone), 'undefined');
    eq('но срок клиента мастер видит', String(cardForMaster.renew?.days), '14');
    const moneyForMaster = await api(`/finance/missed-profit?from=${daysFromToday(-200)}&to=${daysFromToday(0)}`, masterToken);
    // 401, а не 403: реестр роутов в api/server.mjs отсекает роль ДО обработчика - тот
    // же ответ мастеру даёт и /payroll, поведение общее для всех денежных ручек
    eq('деньги мастеру закрыты', String(moneyForMaster.status), '401');

    // ── 13. Правка срока из карточки клиента ──────────────────────────────────
    const patched = await api('/clients/n59-c1/renew', bossToken, {
      method: 'PATCH',
      body: JSON.stringify({ renew: { days: 21, reason: 'hair', note: 'жёсткие волосы' } }),
    });
    const patchedRow = (await db.query('SELECT renew_days, renew_reason, renew_note FROM clients WHERE id = $1', ['n59-c1'])).rows[0];
    eq(
      'срок правится из карточки клиента',
      `${patched.status} ${patchedRow.renew_days} ${patchedRow.renew_reason} ${patchedRow.renew_note}`,
      '200 21 hair жёсткие волосы'
    );
    const badDays = await api('/clients/n59-c1/renew', bossToken, {
      method: 'PATCH',
      body: JSON.stringify({ renew: { days: 3, reason: 'hair' } }),
    });
    eq('срок вне границ не принимается', `${badDays.status} ${(await badDays.json()).error}`, '400 invalid_renew_days');

    // ── 14. Экран владельца ───────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (session) => {
        const s = session;
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(() => {
          document.getElementById('loginEmail').value = 'n59-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 80 && !(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // Карточка «Недополученная прибыль» в «Финансах»
        await s.eval(`document.querySelector('.app-nav-item[data-section="finance"], label[for="pt-c"]')?.click()`);
        await sleep(400);
        const cardFound = (
          await s.eval(`(() => {
            const cards = [...document.querySelectorAll('.panel-c details.staff-card')];
            const card = cards.find((c) => c.querySelector('.name')?.textContent.includes('Недополученная прибыль'));
            if (!card) return 'нет карточки';
            card.open = true;
            return 'есть';
          })()`)
        );
        eq('карточка «Недополученная прибыль» стоит в «Финансах»', cardFound, 'есть');
        // Смотрим вкладку «Год»: фикстура нарочно растянута на 112 дней, и на «Месяце»
        // часть людей в окно не попадает - это правильное поведение (см.
        // missedVisitsInWindow), но проверять списки удобнее там, где видны все
        await s.eval(`document.getElementById('mp-year')?.click()`);
        for (let i = 0; i < 60 && !(await s.eval(`!!document.querySelector('#mpYear .stat-card')`)); i++) await sleep(200);
        const totalOnScreen = norm((await s.eval(`document.querySelector('#mpYear .stat-card--net .sc-value')?.textContent ?? ''`)));
        eq('на экране стоит сумма, а не заглушка', /\d/.test(totalOnScreen) ? 'сумма' : totalOnScreen, 'сумма');
        const wording = norm((await s.eval(`document.querySelector('#mpYear .mp-legend')?.textContent ?? ''`)));
        eq(
          'разрежённость подписана не как потеря',
          wording.includes('ничего салону не должны') ? 'честно' : wording,
          'честно'
        );

        // Список «кому звонить сейчас»
        await s.eval(`document.querySelector('#mpYear [data-mp-kind="overdue"]')?.click()`);
        for (let i = 0; i < 50 && !(await s.eval(`!!document.querySelector('#mpList .an-lapsed-row')`)); i++) await sleep(200);
        const listNames = norm((await s.eval(`[...document.querySelectorAll('#mpList .mp-name')].map((n) => n.textContent).join(',')`)));
        eq('список «кому звонить» открывается поимённо', listNames, 'QA Просроченный');
        const hasMessengers = (await s.eval(`!!document.querySelector('#mpList .an-lapsed-actions a, #mpList .an-lapsed-actions button')`));
        eq('в списке есть кнопки связи', String(hasMessengers), 'true');

        // Мобильная ширина: без горизонтального переполнения
        await s.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
        await sleep(500);
        const overflow = (await s.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`));
        eq('360px: нет горизонтальной прокрутки в «Финансах»', String(overflow <= 0), 'true');
        await s.send('Emulation.clearDeviceMetricsOverride');

        // Поле срока в форме закрытия визита
        await s.eval(`document.querySelector('.app-nav-item[data-section="schedule"], label[for="pt-a"]')?.click()`);
        await sleep(600);
        const openedBooking = (
          await s.eval(`(() => {
            const appt = document.querySelector('.appt[data-booking-id], .appt');
            if (!appt) return 'нет записей в дне';
            appt.click();
            return 'открыл';
          })()`)
        );
        if (openedBooking === 'открыл') {
          for (let i = 0; i < 40 && (await s.eval(`!!document.getElementById('walkinForm')?.hidden`)); i++) await sleep(200);
          await s.eval(`document.getElementById('st-came')?.click()`);
          await sleep(300);
          const renewVisible = (await s.eval(`!document.getElementById('wfRenew')?.hidden`));
          eq('поле срока появляется при статусе «Обслужен»', String(renewVisible), 'true');
          const hint = norm((await s.eval(`document.getElementById('wfRenewHint')?.textContent ?? ''`)));
          eq('под полем стоит сценарий разговора', hint.includes('держит форму') ? 'есть' : hint, 'есть');
          const reasons = (await s.eval(`document.querySelectorAll('#wfRenewReasons input[name="renewReason"]').length`));
          eq('все пять причин на месте', String(reasons), '5');
          // «Не обсуждали» подставляет месяц и гасит ввод
          await s.eval(`document.querySelector('#wfRenewReasons input[value="not_discussed"]')?.click()`);
          await sleep(200);
          const afterNotDiscussed = (
            await s.eval(`(() => {
              const i = document.getElementById('wfRenewDays');
              return JSON.stringify([i.value, i.disabled]);
            })()`)
          );
          eq('«не обсуждали» ставит месяц и гасит поле', afterNotDiscussed, '["30",true]');
          await s.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
          await sleep(400);
          const formOverflow = (await s.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`));
          eq('360px: поле срока не выталкивает форму за экран', String(formOverflow <= 0), 'true');
          const submitVisible = (
            await s.eval(`(() => {
              const btn = document.getElementById('wfSubmit');
              if (!btn) return 'нет кнопки';
              const r = btn.getBoundingClientRect();
              return r.right <= window.innerWidth + 1 ? 'видна' : 'уехала за экран';
            })()`)
          );
          eq('кнопка сохранения остаётся в экране', submitVisible, 'видна');
          await s.send('Emulation.clearDeviceMetricsOverride');
        } else {
          eq('карточка записи открылась', openedBooking, 'открыл');
        }

        // Метрика обсуждённых сроков в «Аналитике»
        await s.eval(`document.querySelector('.app-nav-item[data-section="analytics"], label[for="pt-d"]')?.click()`);
        await sleep(500);
        for (let i = 0; i < 60 && !(await s.eval(`!!document.querySelector('#anDisc3 .stat-card')`)); i++) await sleep(200);
        const discPct = norm((await s.eval(`document.querySelector('#anDisc3 .stat-card--net .sc-value')?.textContent ?? ''`)));
        eq('доля обсуждённых сроков видна владельцу', /%/.test(discPct) ? 'процент' : discPct, 'процент');

        // Скриншоты для отчёта: то, что владелец и мастер реально увидят на экране
        await s.eval(`document.querySelector('.app-nav-item[data-section="finance"], label[for="pt-c"]')?.click()`);
        await sleep(500);
        await s.eval(`(() => {
          const card = [...document.querySelectorAll('.panel-c details.staff-card')].find((c) => c.querySelector('.name')?.textContent.includes('Недополученная'));
          if (card) { card.open = true; card.scrollIntoView({ block: 'center' }); }
        })()`);
        await sleep(700);
        await s.screenshot('/tmp/okno59-finansy.png');
        await s.eval(`document.querySelector('.app-nav-item[data-section="schedule"], label[for="pt-a"]')?.click()`);
        await sleep(500);
        await s.eval(`document.getElementById('wfRenew')?.scrollIntoView({ block: 'center' })`);
        await sleep(400);
        await s.screenshot('/tmp/okno59-srok-vizita.png');
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err);
}

summary();
if (crashed) process.exitCode = 1;
