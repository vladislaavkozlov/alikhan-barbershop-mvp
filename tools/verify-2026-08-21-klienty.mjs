// Живой прогон раздела "Клиенты" (21.08.2026, задача Влада: новый пункт меню между
// "Командой" и "Финансами" - база клиентов из записей + комментарий на 3000 знаков).
// Что доказываем в реальном браузере и на реальном Postgres, а не в предположении:
//   1. пункт "Клиенты" стоит в меню ИМЕННО между "Командой" и "Финансами"
//   2. база тянется из записей: клиент попадает в список сам, руками его не заводят
//   3. деньги считаются как в "Финансах" - только состоявшиеся визиты
//   4. "откуда и когда пришёл" - первая неотменённая бронь и её канал
//   5. клиента без телефона (walk-in) в базе нет и быть не должно
//   6. история визитов и комментарий видны в раскрытой карточке
//   7. поиск фильтрует по имени и по последним цифрам телефона
//   8. комментарий длиной 3000 знаков сохраняется целиком, 3001 - внятный отказ
//   9. администратор не получает всю базу телефонов даже прямым запросом к API
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = todayLocal();
const LONG_COMMENT = 'К'.repeat(3000);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    const adminPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('cl-boss', 1, 'QA Управляющий', 'manager', true, false, true, 'cl-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('cl-admin', 1, 'QA Администратор', 'admin', true, false, true, 'cl-admin@alikhan.test', $1)`,
      [hashPin(adminPin)]
    );

    // Двое клиентов с телефоном + один визит вообще без клиента (walk-in). Ровно та
    // картина, ради которой раздел затевался: база собирается записями, а не руками
    await db.query(`INSERT INTO clients (id, name, phone) VALUES ('cl-1', 'QA Пётр Первый', '+79995550011')`);
    await db.query(`INSERT INTO clients (id, name, phone) VALUES ('cl-2', 'QA Второй Клиент', '+79995550022')`);

    const rows = [
      // id,      client, master,     дата,        статус,   источник
      ['cl-b1', 'cl-1', 'master-2', '2026-06-01', 'done', 'yandex_maps'],
      ['cl-b2', 'cl-1', 'master-2', '2026-07-01', 'done', null],
      ['cl-b3', 'cl-1', 'master-2', TODAY, 'planned', null],       // деньгами ещё не является
      ['cl-b4', 'cl-2', 'master-3', '2026-07-15', 'no_show', '2gis'], // и уже не является
      ['cl-b5', null, 'master-2', '2026-07-20', 'done', 'walkin'],    // клиента без телефона в базе быть не должно
    ];
    for (const [id, clientId, masterId, date, status, source] of rows) {
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel, client_source, walkin_name)
         VALUES ($1, 1, $2, $3, $4, '11:00', '11:40', $5, 'walkin', $6, $7)`,
        [id, masterId, clientId, date, status, source, clientId ? null : 'QA Безымянный']
      );
      await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'strizhka')`, [id]);
    }

    // Ожидаемые деньги считаем ИЗ БАЗЫ (цена стрижки у мастера своя), а не литералом -
    // иначе прогон проверял бы мою арифметику, а не продукт
    const priceRow = await db.query(`SELECT price FROM master_services WHERE master_id = 'master-2' AND service_id = 'strizhka'`);
    const price = Number(priceRow.rows[0]?.price ?? 0);
    const expectedRevenue = price * 2; // два done у cl-1, planned не в счёт

    const login = async (email, pin) =>
      (await fetch(`${apiUrl}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      }).then((r) => r.json())).token;
    const bossToken = await login('cl-boss@alikhan.test', bossPin);
    const adminToken = await login('cl-admin@alikhan.test', adminPin);

    // ── Комментарий на 3000 знаков ────────────────────────────────────────────
    const patch = async (token, comment) =>
      fetch(`${apiUrl}/bookings/cl-b2/actual-price`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ actualPrice: null, comment }),
      });
    const ok3000 = await patch(bossToken, LONG_COMMENT);
    check('комментарий 3000 знаков сохраняется (требование заказчика)', ok3000.status === 200, `${ok3000.status}`);
    const stored = await db.query(`SELECT staff_comment FROM bookings WHERE id = 'cl-b2'`);
    check('в базе лежат все 3000 знаков, текст не обрезан', stored.rows[0].staff_comment?.length === 3000, `длина ${stored.rows[0].staff_comment?.length}`);
    const tooLong = await patch(bossToken, `${LONG_COMMENT}Х`);
    const tooLongBody = await tooLong.json();
    check('3001 знак - внятный отказ 400 comment_too_long, а не 500', tooLong.status === 400 && tooLongBody.error === 'comment_too_long', `${tooLong.status} ${JSON.stringify(tooLongBody)}`);

    // ── Права на всю базу ─────────────────────────────────────────────────────
    const all = async (token) => fetch(`${apiUrl}/clients?all=true`, { headers: { Authorization: `Bearer ${token}` } });
    const bossAll = await all(bossToken);
    const list = await bossAll.json();
    check('управляющий получает всю базу клиентов', bossAll.status === 200 && Array.isArray(list), `${bossAll.status}`);
    const adminAll = await all(adminToken);
    check('администратор не получает базу телефонов даже прямым запросом к API (403)', adminAll.status === 403, `${adminAll.status}`);

    const c1 = list.find((c) => c.id === 'cl-1');
    const c2 = list.find((c) => c.id === 'cl-2');
    check('клиент попал в базу сам, из записи (руками никого не заводили)', !!c1 && !!c2, JSON.stringify(list.map((c) => c.id)));
    check('деньги - только состоявшиеся визиты, как в "Финансах"', c1?.revenue === expectedRevenue && c1?.visitsCount === 2, `${c1?.revenue} при ожидаемых ${expectedRevenue}, визитов ${c1?.visitsCount}`);
    check('"когда пришёл" - первая неотменённая бронь', c1?.firstVisitDate === '2026-06-01', String(c1?.firstVisitDate));
    check('"откуда пришёл" - канал первой брони', c1?.source === 'yandex_maps', String(c1?.source));
    check('неявка визитом-за-деньги не считается, но клиента из базы не убирает', c2?.visitsCount === 0 && c2?.revenue === 0, JSON.stringify(c2));
    check('клиента без телефона (walk-in) в базе нет', list.every((c) => c.name !== 'QA Безымянный'), JSON.stringify(list.map((c) => c.name)));
    check('комментарий виден в списке (последний по времени)', c1?.commentsCount === 1 && c1?.lastComment?.length === 3000, `${c1?.commentsCount} / ${c1?.lastComment?.length}`);

    // ── Живой браузер ─────────────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'cl-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // 1. Место пункта в меню - именно между "Командой" и "Финансами"
        const menu = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.app-nav-item .app-nav-label')].map(e => e.textContent.trim()))`));
        const idx = (name) => menu.indexOf(name);
        check('пункт "Клиенты" стоит между "Командой" и "Финансами"',
          idx('Клиенты') === idx('Команда') + 1 && idx('Финансы') === idx('Клиенты') + 1, JSON.stringify(menu));

        // 2. Заход в раздел - список приходит с сервера
        await s.eval(`document.querySelector('.app-nav-item[data-section="clients"]')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#clientsList .client-card'))`)); i++) await sleep(200);
        const cards = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#clientsList .client-card .name')].map(e => e.textContent.trim()))`));
        check('в разделе видны оба клиента с телефоном', cards.includes('QA Пётр Первый') && cards.includes('QA Второй Клиент'), JSON.stringify(cards));
        check('безымянного walk-in клиента в разделе нет', !cards.includes('QA Безымянный'), JSON.stringify(cards));

        const firstCardText = norm(await s.eval(`document.querySelector('.client-card[data-client-id="cl-1"]')?.innerText || ''`));
        const money = `${expectedRevenue.toLocaleString('ru-RU')} ₽`.replace(/\s/g, ' ');
        check('в свёрнутой строке сразу видно телефон, число визитов и сколько принёс',
          firstCardText.includes('+79995550011') && firstCardText.includes('2 визита') && firstCardText.replace(/\s/g, ' ').includes(money),
          firstCardText.slice(0, 200));
        check('в свёрнутой строке видно, когда и откуда пришёл', firstCardText.includes('с 01.06.2026') && firstCardText.includes('Яндекс Карты'), firstCardText.slice(0, 200));

        // 3. Раскрытие карточки - история визитов и длинный комментарий
        await s.eval(`document.querySelector('.client-card[data-client-id="cl-1"] summary')?.click()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.client-card[data-client-id="cl-1"] .client-visit'))`)); i++) await sleep(200);
        const visits = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.client-card[data-client-id="cl-1"] .client-visit')].map(e => e.innerText.replace(/\\s+/g,' ').trim())).replace(/\\u00a0/g,' ')`));
        check('в карточке вся история визитов, включая будущую запись', visits.length === 3, JSON.stringify(visits.map((v) => v.slice(0, 40))));
        // Длинный комментарий приходит свёрнутым (иначе одна заметка выталкивает всю
        // историю за экран), но текст на месте весь - раскрываем и считаем знаки
        const collapsed = JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.client-card[data-client-id="cl-1"] .client-visit-comment--long:not([open])'))`));
        check('комментарий на 3000 знаков приходит свёрнутым, а не простынёй', collapsed, 'ожидали свёрнутый <details>');
        await s.eval(`document.querySelector('.client-card[data-client-id="cl-1"] .client-visit-comment--long summary')?.click()`);
        await sleep(300);
        const commentLen = JSON.parse(await s.eval(`JSON.stringify(document.querySelector('.client-card[data-client-id="cl-1"] [data-comment-full]')?.textContent?.length ?? 0)`));
        check('после "Показать целиком" виден весь текст на 3000 знаков', commentLen === 3000, `на экране ${commentLen} знаков`);

        // 4. Поиск
        await s.eval(`(function(){ const i = document.getElementById('clientsSearch'); i.value = '5550022'; i.dispatchEvent(new Event('input')); })()`);
        await sleep(200);
        const found = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#clientsList .client-card .name')].map(e => e.textContent.trim()))`));
        check('поиск по последним цифрам телефона оставляет одного нужного клиента', found.length === 1 && found[0] === 'QA Второй Клиент', JSON.stringify(found));
        await s.eval(`(function(){ const i = document.getElementById('clientsSearch'); i.value = 'пётр'; i.dispatchEvent(new Event('input')); })()`);
        await sleep(200);
        const foundByName = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#clientsList .client-card .name')].map(e => e.textContent.trim()))`));
        check('поиск по части имени работает без учёта регистра', foundByName.length === 1 && foundByName[0] === 'QA Пётр Первый', JSON.stringify(foundByName));

        // 6. ГЛАВНЫЙ ВОПРОС ВЛАДА 21.08.2026: «а если оплату в записи поставили
        // неверно, а потом переключили визит на красный (неявка) - цифры в Финансах и
        // в карточке клиента исправятся?». Проверяем не рассуждением, а деньгами на
        // экране: снимаем поисковый фильтр, запоминаем выручку за год и итоги клиента,
        // переключаем состоявшийся визит в неявку и жмём ту же кнопку обновления, что
        // жмёт владелец.
        await s.eval(`(function(){ const i = document.getElementById('clientsSearch'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
        await s.eval(`document.querySelector('.app-nav-item[data-section="finance"]')?.click()`);
        // Период «Год»: панели периодов - обычные radio-вкладки, и у невыбранной
        // innerText пустой (элемент скрыт). Читаем именно видимую цифру, а не
        // textContent скрытого узла - иначе прогон доказывал бы данные в памяти,
        // а не то, что видит владелец
        await s.eval(`document.querySelector('label[for="rvpa-year"]')?.click()`);
        for (let i = 0; i < 80 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#rvAllYearRevenue .unsure'))`)); i++) await sleep(200);
        // textContent, не innerText: у этого узла innerText приходит пустым, хотя сам
        // элемент на экране виден (проверено рядом через offsetParent) - живой квирк
        // рендера, найден замером 21.08.2026, а не обойдён вслепую
        const moneyOnScreen = async () => norm(await s.eval(`document.getElementById('rvAllYearRevenue')?.textContent || ''`)).replace(/\s/g, ' ');
        check('блок «Выручка за год» реально видим на экране, а не только в памяти',
          JSON.parse(await s.eval(`JSON.stringify(!!document.getElementById('rvAllYearRevenue')?.offsetParent)`)), 'offsetParent пуст - блок скрыт');
        const parseMoney = (t) => Number(String(t).replace(/[^0-9]/g, ''));
        const revenueBefore = parseMoney(await moneyOnScreen());
        check('выручка за год посчитана и показана', revenueBefore > 0, String(revenueBefore));

        const setStatus = async (status) =>
          fetch(`${apiUrl}/bookings/cl-b1/status`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bossToken}` },
            body: JSON.stringify({ status }),
          });
        const toNoShow = await setStatus('no_show');
        check('визит переключён в неявку (красный)', toNoShow.status === 200, `${toNoShow.status}`);

        // Ждём не «цифра изменилась», а «пересчёт закончился»: на время запроса в
        // сумме стоит «считаю…», и поспешное чтение поймало бы это промежуточное
        // состояние за ответ (ровно так прогон и соврал с первого раза)
        const waitCalm = async () => {
          for (let i = 0; i < 100; i++) {
            const busy = JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#rvAllYearRevenue .unsure'))`));
            if (!busy && parseMoney(await moneyOnScreen()) > 0) return;
            await sleep(200);
          }
        };
        await s.eval(`document.getElementById('refreshBtn')?.click()`);
        await sleep(400);
        await waitCalm();
        const revenueAfter = parseMoney(await moneyOnScreen());
        check('«Финансы»: выручка сама уменьшилась ровно на этот визит', revenueBefore - revenueAfter === price, `было ${revenueBefore}, стало ${revenueAfter}, цена визита ${price}`);

        await s.eval(`document.querySelector('.app-nav-item[data-section="clients"]')?.click()`);
        await sleep(400);
        const factsAfter = norm(await s.eval(`document.querySelector('.client-card[data-client-id="cl-1"] .client-facts')?.innerText || ''`)).replace(/\s/g, ' ');
        const oneVisitMoney = `${price.toLocaleString('ru-RU')} ₽`.replace(/\s/g, ' ');
        check('карточка клиента: визит и его деньги ушли из итогов', factsAfter.includes('1 визит') && factsAfter.includes(oneVisitMoney), factsAfter);

        // Комментарий и вписанная сумма остаются на записи - это объяснение, ПОЧЕМУ
        // так вышло, и стирать его вместе со статусом было бы потерей данных
        const kept = await db.query(`SELECT staff_comment, actual_price FROM bookings WHERE id = 'cl-b2'`);
        check('комментарий к записи при смене статуса не стёрся', kept.rows[0].staff_comment?.length === 3000, `длина ${kept.rows[0].staff_comment?.length}`);

        // И обратно: ошиблись со статусом - вернули, деньги вернулись сами
        const backToDone = await setStatus('done');
        check('визит возвращён в «обслужен»', backToDone.status === 200, `${backToDone.status}`);
        await s.eval(`document.querySelector('.app-nav-item[data-section="finance"]')?.click()`);
        await s.eval(`document.querySelector('label[for="rvpa-year"]')?.click()`);
        await s.eval(`document.getElementById('refreshBtn')?.click()`);
        await sleep(400);
        await waitCalm();
        check('исправили статус обратно - выручка вернулась к прежней цифре', parseMoney(await moneyOnScreen()) === revenueBefore, `${await moneyOnScreen()} при ожидаемых ${revenueBefore}`);

        // 5. Поле комментария в карточке записи - многострочное, лимит 3000
        const field = JSON.parse(await s.eval(`JSON.stringify((function(){ const t = document.getElementById('bkStaffComment'); return t ? { tag: t.tagName, max: t.maxLength } : null; })())`));
        check('поле комментария стало многострочным с лимитом 3000', field?.tag === 'TEXTAREA' && field?.max === 3000, JSON.stringify(field));
      });
    });
  });
} catch (e) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', e);
}
summary();
if (crashed) process.exit(1);
