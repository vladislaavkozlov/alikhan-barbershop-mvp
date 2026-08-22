// Живой прогон окна «Увольнение сотрудника» (22.08.2026). Что доказываем в реальном
// браузере, а не в предположении:
//   1. в разделе «Сотрудники» есть отдельный блок «Уволенные» и работающих в нём нет
//   2. увольнение - названное действие с подтверждением, а не тумблер: до нажатия
//      «Да, уволить» человек остаётся в команде
//   3. после увольнения он пропадает из формы записи и из публичного виджета, а его
//      сессия обрывается (открытая вкладка перестаёт работать сразу)
//   4. САМОЕ ВАЖНОЕ: деньги за отработанные периоды не исчезают - карточка уволенного
//      остаётся в «Финансах» с той же суммой, что была до увольнения
//   5. уволенный БЕЗ визитов в «Финансы» не попадает (решение Влада: иначе блок
//      зарастёт призраками)
//   6. владельца уволить нельзя даже прямым запросом мимо интерфейса
//   7. сохранение карточки уволенного (имя, телефон) не возвращает его в команду
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = todayLocal();
// Postgres отдаёт date-колонку объектом Date в локальной зоне. toISOString() у него
// уезжает на день назад (в MSK полночь = 21:00 UTC предыдущего дня) - сравнивать надо
// локальными частями, иначе прогон ловит несуществующий баг. Сам API отдаёт дату
// правильной строкой (dateColToStr поверх настроенного парсера, api/lib/db.js)
const dbDateStr = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    const leaverPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('uv-boss', 1, 'QA Управляющий', 'manager', true, true, true, 'uv-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    // Тот, кого увольняем. Деньги у него есть - значит из «Финансов» пропасть не должен
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('uv-leaver', 1, 'QA Уходящий', 'master', true, true, true, 'uv-leaver@alikhan.test', $1)`,
      [hashPin(leaverPin)]
    );
    // Уволенный без единого визита - проверка пункта 5
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, employment_ended_at, provides_services, has_system_access, email)
       VALUES ('uv-ghost', 1, 'QA Призрак', 'master', false, DATE '2026-02-10', true, true, 'uv-ghost@alikhan.test')`
    );
    for (const id of ['uv-leaver', 'uv-ghost']) {
      await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT $1, id, price, duration_min FROM services`, [id]);
      // weekday 1=Пн..7=Вс, часы в work_start/work_end (миграция 022)
      await db.query(`INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end) SELECT $1, g, true, '09:00', '21:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`, [id]);
      await db.query(`INSERT INTO master_payroll_settings (master_id, pct) VALUES ($1, 50) ON CONFLICT (master_id) DO UPDATE SET pct = 50`, [id]);
    }
    // Две оплаченные стрижки уходящего сегодня
    for (const [id, start, end] of [['uv-b1', '11:00', '11:40'], ['uv-b2', '12:00', '12:40']]) {
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel, walkin_name)
         VALUES ($1, 1, 'uv-leaver', NULL, $2, $3, $4, 'done', 'walkin', 'QA Клиент')`,
        [id, TODAY, start, end]
      );
      await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'strizhka')`, [id]);
    }
    const priceRow = await db.query(`SELECT price FROM master_services WHERE master_id = 'uv-leaver' AND service_id = 'strizhka'`);
    const expectedPayroll = (Number(priceRow.rows[0].price) * 2 * 50) / 100;
    const money = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`.replace(/\s/g, ' ');

    const login = async (email, pin) => (await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, pin }),
    }).then((r) => r.json()));
    const bossToken = (await login('uv-boss@alikhan.test', bossPin)).token;
    // Уходящий сидит в CRM в соседней вкладке - его сессия должна оборваться
    const leaverToken = (await login('uv-leaver@alikhan.test', leaverPin)).token;
    const leaverAlive = async () => (await fetch(`${apiUrl}/auth/me`, { headers: { Authorization: `Bearer ${leaverToken}` } })).status;
    check('до увольнения сессия уходящего живая', await leaverAlive() === 200, 'ожидался 200');

    // ── 6. владельца не уволить даже мимо интерфейса ──────────────────────────
    const fireOwner = await fetch(`${apiUrl}/staff/master-1/employment`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bossToken}` },
      body: JSON.stringify({ employed: false }),
    });
    const fireOwnerBody = await fireOwner.json();
    check('владельца уволить нельзя - внятный отказ 403', fireOwner.status === 403 && fireOwnerBody.error === 'employment_locked', `${fireOwner.status} ${JSON.stringify(fireOwnerBody)}`);
    const ownerStill = await db.query(`SELECT employed FROM staff WHERE id = 'master-1'`);
    check('владелец после отказа по-прежнему в штате', ownerStill.rows[0].employed === true, JSON.stringify(ownerStill.rows));

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'uv-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // ── 4a. сумма уходящего в «Финансах» ДО увольнения ─────────────────────
        await s.eval(`document.querySelector('#pt-c, [for="pt-c"]')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#payrollStaffList .payroll-card [data-amount="day"]'))`)); i++) await sleep(200);
        for (let i = 0; i < 80 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-c .unsure'))`)); i++) await sleep(200);
        const amountBefore = norm(await s.eval(`document.querySelector('#payrollStaffList .payroll-card[data-master-id="uv-leaver"] [data-amount="day"]')?.textContent || ''`));
        check('до увольнения зарплата уходящего посчитана', amountBefore === money(expectedPayroll), `${amountBefore} vs ${money(expectedPayroll)}`);

        // ── 5. уволенный без визитов в «Финансы» не попал ──────────────────────
        const ghostInFinance = JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#payrollStaffList .payroll-card[data-master-id="uv-ghost"]'))`));
        check('уволенный без визитов в «Финансах» не показан', ghostInFinance === false, 'карточка uv-ghost найдена');

        // ── 1. блок «Уволенные» в разделе «Сотрудники» ─────────────────────────
        await s.eval(`document.querySelector('#pt-b, [for="pt-b"]')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-b .team-editor-card'))`)); i++) await sleep(200);
        // Блок архивный и свёрнут по умолчанию - это и есть задуманное поведение,
        // поэтому сначала раскрываем его, как это сделал бы человек
        check('блок «Уволенные» свёрнут по умолчанию', JSON.parse(await s.eval(`JSON.stringify(!document.querySelector('.panel-b .team-fired-toggle')?.open)`)) === true, 'блок открыт сразу');
        await s.eval(`document.querySelector('.panel-b .team-fired-toggle')?.setAttribute('open','')`);
        await sleep(300);
        const firedGroupText = norm(await s.eval(`document.querySelector('.panel-b .team-fired-group')?.innerText || ''`));
        check('блок «Уволенные» есть и в нём Призрак', /Уволенные/.test(firedGroupText) && /QA Призрак/.test(firedGroupText), firedGroupText.slice(0, 200));
        check('работающих в блоке «Уволенные» нет', !/QA Уходящий/.test(firedGroupText), firedGroupText.slice(0, 200));
        check('дата увольнения показана человеческим видом', /10\.02\.2026/.test(firedGroupText), firedGroupText.slice(0, 200));

        // ── 2. подтверждение: одного нажатия «Уволить» мало ────────────────────
        await s.eval(`document.querySelector('.panel-b .team-editor-card[data-staff-id="uv-leaver"]')?.setAttribute('open','')`);
        await sleep(300);
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="uv-leaver"] [data-fire]')?.click()`);
        await sleep(400);
        const confirmText = norm(await s.eval(`document.querySelector('.team-editor-card[data-staff-id="uv-leaver"] [data-employment-actions]')?.innerText || ''`));
        check('подтверждение объясняет, что история сохранится', /останутся на месте/.test(confirmText), confirmText.slice(0, 240));
        const stillEmployed = await db.query(`SELECT employed FROM staff WHERE id = 'uv-leaver'`);
        check('до подтверждения человек ещё в команде', stillEmployed.rows[0].employed === true, JSON.stringify(stillEmployed.rows));

        // ── подтверждаем ──────────────────────────────────────────────────────
        // Метка на текущем документе: после увольнения страница перезагружается сама,
        // и без такой метки прогон продолжил бы читать СТАРЫЙ DOM - там карточки ещё
        // нарисованы по данным до увольнения (поймано живьём 22.08.2026)
        await s.eval(`window.__beforeFire = true`);
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="uv-leaver"] [data-fire-yes]')?.click()`);
        for (let i = 0; i < 60; i++) {
          const row = await db.query(`SELECT employed FROM staff WHERE id = 'uv-leaver'`);
          if (row.rows[0].employed === false) break;
          await sleep(200);
        }
        const afterFire = await db.query(`SELECT employed, employment_ended_at FROM staff WHERE id = 'uv-leaver'`);
        check('после подтверждения человек уволен', afterFire.rows[0].employed === false, JSON.stringify(afterFire.rows));
        check('дата увольнения проставлена автоматически', dbDateStr(afterFire.rows[0].employment_ended_at) === TODAY, JSON.stringify(afterFire.rows));

        // ── 3. сессия оборвана, из записи пропал ──────────────────────────────
        check('сессия уволенного оборвана сразу', await leaverAlive() === 401, 'ожидался 401');
        const pub = await fetch(`${apiUrl}/public-masters`).then((r) => r.json());
        const pubList = Array.isArray(pub) ? pub : (pub.masters ?? []);
        check('в публичной записи уволенного нет', !pubList.some((m) => m.id === 'uv-leaver'), JSON.stringify(pubList.map((m) => m.id)));

        // Страница перезагружается сама после увольнения - дожидаемся именно НОВОГО
        // документа (метка исчезла), а потом готовности кабинета
        for (let i = 0; i < 80 && JSON.parse(await s.eval('JSON.stringify(!!window.__beforeFire)')); i++) await sleep(200);
        check('после увольнения страница перезагрузилась сама', JSON.parse(await s.eval('JSON.stringify(!window.__beforeFire)')) === true, 'метка старого документа осталась');
        for (let i = 0; i < 80 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])") || !!document.getElementById("loginEmail")')); i++) await sleep(200);
        if (JSON.parse(await s.eval('!!document.getElementById("loginEmail")'))) {
          await s.eval(`(function(){
            document.getElementById('loginEmail').value = 'uv-boss@alikhan.test';
            document.getElementById('loginPin').value = '${bossPin}';
            document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
          })()`);
          for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);
        }

        // ── 4b. деньги на месте ПОСЛЕ увольнения ──────────────────────────────
        await s.eval(`document.querySelector('#pt-c, [for="pt-c"]')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#payrollStaffList .payroll-card [data-amount="day"]'))`)); i++) await sleep(200);
        for (let i = 0; i < 80 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-c .unsure'))`)); i++) await sleep(200);
        const amountAfter = norm(await s.eval(`document.querySelector('#payrollStaffList .payroll-card[data-master-id="uv-leaver"] [data-amount="day"]')?.textContent || ''`));
        check('после увольнения зарплата за отработанный день НЕ изменилась', amountAfter === amountBefore, `${amountAfter} vs ${amountBefore}`);
        // textContent, не innerText: у скрытой панели innerText пуст, и проверка ловила
        // бы не отсутствие пометки, а собственную невнимательность
        const firedCardText = norm(await s.eval(`document.querySelector('#payrollStaffList .payroll-card[data-master-id="uv-leaver"]')?.textContent || ''`));
        check('карточка в «Финансах» помечена как уволенный', /Не работает с/.test(firedCardText), firedCardText.slice(0, 200));
        const pctDisabled = JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#payrollStaffList .payroll-card[data-master-id="uv-leaver"] [data-pct-input]')?.disabled)`));
        check('ставку уволенному не меняют - поле только для чтения', pctDisabled === true, 'поле активно');

        // ── 3b. в форме записи уволенного нет ─────────────────────────────────
        await s.eval(`document.querySelector('#pt-a, [for="pt-a"]')?.click()`);
        await sleep(1200);
        const options = norm(await s.eval(`JSON.stringify([...document.querySelectorAll('.custom-select__option, #bkMaster option, [data-master-option]')].map((o) => o.textContent))`));
        check('в форме записи уволенного НЕТ', !/QA Уходящий/.test(options), options.slice(0, 300));
      });
    });

    // ── 7. правка карточки уволенного не возвращает его в команду ─────────────
    const saveFired = await fetch(`${apiUrl}/staff/uv-leaver`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bossToken}` },
      body: JSON.stringify({ name: 'QA Уходящий Правленый', email: 'uv-leaver@alikhan.test', phone: '+79990000000', locationId: 1, providesServices: true }),
    });
    const saveBody = await saveFired.json();
    check('сохранение карточки уволенного проходит', saveFired.status === 200, `${saveFired.status} ${JSON.stringify(saveBody)}`);
    const afterSave = await db.query(`SELECT employed, employment_ended_at, name FROM staff WHERE id = 'uv-leaver'`);
    check('после правки имени человек ОСТАЛСЯ уволенным', afterSave.rows[0].employed === false, JSON.stringify(afterSave.rows));
    check('дата увольнения при правке не переписана на сегодня заново', dbDateStr(afterSave.rows[0].employment_ended_at) === TODAY, JSON.stringify(afterSave.rows));

    // ── возврат в команду ─────────────────────────────────────────────────────
    const rehire = await fetch(`${apiUrl}/staff/uv-leaver/employment`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bossToken}` },
      body: JSON.stringify({ employed: true }),
    });
    check('возврат в команду проходит', rehire.status === 200, String(rehire.status));
    const afterRehire = await db.query(`SELECT employed, employment_ended_at FROM staff WHERE id = 'uv-leaver'`);
    check('вернувшийся снова в штате, дата увольнения снята', afterRehire.rows[0].employed === true && afterRehire.rows[0].employment_ended_at === null, JSON.stringify(afterRehire.rows));
  });
} catch (error) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', error);
}
summary();
if (crashed) process.exit(1);
