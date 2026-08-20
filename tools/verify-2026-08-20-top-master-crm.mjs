// Живой прогон CRM (20.08.2026, Фазы 2-3 плана plans/2026-08-20-top-master-tarif.md).
// Что доказываем в реальном браузере, а не в предположении:
//   1. в карточке сотрудника («Команда» владельца) у каждой услуги есть поле цены и
//      галка «топ», и они не декорация - правка переживает сохранение и перезагрузку
//   2. негодная цена не сохраняется молча: поле подсвечено, в базе прежняя цифра
//   3. снятая услуга гасит и цену, и галку - тарифа без услуги не бывает
//   4. администратор те же поля видит, но не правит (read-only, как было с длительностью)
//   5. карточка записи в «Дне» помечает топ-визит, обычный не помечает
//   6. форма записи показывает условия визита строкой «канал · запись к топ-мастеру»
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = daysFromToday(0);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    const adminPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('tm-owner', 1, 'QA Владелец', 'owner', true, false, true, 'tm-owner@alikhan.test', $1),
              ('tm-admin', 1, 'QA Администратор', 'admin', true, false, true, 'tm-admin@alikhan.test', $2)`,
      [hashPin(ownerPin), hashPin(adminPin)]
    );
    for (const [id, name] of [['tm-top', 'Топ Мастер'], ['tm-usual', 'Обычный Мастер']]) {
      await db.query(
        `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email)
         VALUES ($1, 1, $2, 'master', true, true, false, $1 || '@alikhan.test')`,
        [id, name]
      );
      await db.query(
        `INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT $1, id, price, duration_min FROM services`,
        [id]
      );
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`,
        [id]
      );
    }
    // Топ-услуга заводится прямо в базе - это состояние, которое CRM обязана показать,
    // а не результат клика (клик проверяем отдельно, шагом 1)
    await db.query(`UPDATE master_services SET is_top = true, price = 3000 WHERE master_id = 'tm-top' AND service_id = 'strizhka'`);

    // Записи - прямым INSERT на СЕГОДНЯ: «День» открывается на текущей дате, а через
    // публичный POST /bookings сегодняшнее утро уже в прошлом и отклоняется. Тариф тут
    // проставлен так, как его пишет сервер (это доказано отдельно, в
    // verify-2026-08-20-top-master-api.mjs) - здесь проверяется показ, а не запись.
    await db.query(
      `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel, walkin_name, client_source, master_tier) VALUES
        ('tm-b-top', 1, 'tm-top', NULL, $1, '11:00', '12:00', 'planned', 'client', 'Клиент Топ', 'yandex_maps', 'top'),
        ('tm-b-usual', 1, 'tm-usual', NULL, $1, '12:00', '13:00', 'planned', 'client', 'Клиент Обычный', '2gis', 'standard')`,
      [TODAY]
    );
    await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ('tm-b-top', 'strizhka'), ('tm-b-usual', 'strizhka')`);
    const fixture = await db.query('SELECT count(*)::int AS n FROM bookings WHERE date = $1', [TODAY]);
    check('фикстурные записи созданы', fixture.rows[0].n === 2, String(fixture.rows[0].n));

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const login = async (page, email, pin) => {
          await s.navigate(`${siteUrl}/${page}`);
          for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
          await s.eval(`(function(){
            document.getElementById('loginEmail').value = ${JSON.stringify(email)};
            document.getElementById('loginPin').value = '${pin}';
            document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
          })()`);
          for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);
        };
        const openTeam = async () => {
          await s.eval(`document.querySelector('#pt-b, [for="pt-b"]')?.click()`);
          for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.service-picker .service-check'))`)); i++) await sleep(200);
        };
        const rowState = async (masterId, serviceId) => JSON.parse(await s.eval(`(function(){
          const label = document.querySelector('.service-picker[data-master-id="${masterId}"] .service-check[data-service-id="${serviceId}"]');
          if (!label) return JSON.stringify(null);
          const price = label.querySelector('.sc-price-input');
          const top = label.querySelector('.sc-top-input');
          const dur = label.querySelector('.sc-duration-input');
          return JSON.stringify({
            price: price?.value ?? null, priceDisabled: !!price?.disabled, priceInvalid: !!price?.classList.contains('is-invalid'),
            top: !!top?.checked, topDisabled: !!top?.disabled, duration: dur?.value ?? null,
          });
        })()`));

        await login('crm-owner.html', 'tm-owner@alikhan.test', ownerPin);
        await openTeam();

        // ── 1. поля на месте и показывают состояние базы ───────────────────
        const topRow = await rowState('tm-top', 'strizhka');
        const usualRow = await rowState('tm-usual', 'strizhka');
        check('в строке услуги есть поле цены', topRow?.price === '3000', JSON.stringify(topRow));
        check('галка «топ» показывает состояние базы', topRow?.top === true && usualRow?.top === false, `${JSON.stringify(topRow)} / ${JSON.stringify(usualRow)}`);
        check('владельцу поля доступны', topRow?.priceDisabled === false && topRow?.topDisabled === false, JSON.stringify(topRow));
        await s.eval(`document.querySelector('.service-picker[data-master-id="tm-top"]')?.closest('details')?.setAttribute('open','')`);
        await sleep(500);
        await s.eval(`document.querySelector('.service-picker[data-master-id="tm-top"] .service-check')?.scrollIntoView({ block: 'center' })`);
        await sleep(300);
        await s.screenshot('/tmp/verify-top-master-team.png');

        // ── 2. владелец делает обычного мастера топовым и поднимает цену ───
        await s.eval(`(function(){
          const label = document.querySelector('.service-picker[data-master-id="tm-usual"] .service-check[data-service-id="strizhka"]');
          const price = label.querySelector('.sc-price-input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(price, '2 500');
          price.dispatchEvent(new Event('input', { bubbles: true }));
          const top = label.querySelector('.sc-top-input');
          top.checked = true;
          top.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const saveEnabled = JSON.parse(await s.eval(`JSON.stringify(!document.querySelector('.team-editor-card[data-staff-id="tm-usual"] [data-save]').disabled)`));
        check('правка цены и галки будит кнопку «Сохранить изменения»', saveEnabled === true);
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="tm-usual"] [data-save]').click()`);
        await sleep(2500);
        const saved = await db.query(`SELECT price, is_top FROM master_services WHERE master_id = 'tm-usual' AND service_id = 'strizhka'`);
        check('цена «2 500» с пробелом сохранена как 2500', saved.rows[0].price === 2500, String(saved.rows[0].price));
        check('галка «топ» сохранена', saved.rows[0].is_top === true, String(saved.rows[0].is_top));

        // ── 3. правка переживает перезагрузку страницы ─────────────────────
        await login('crm-owner.html', 'tm-owner@alikhan.test', ownerPin);
        await openTeam();
        const afterReload = await rowState('tm-usual', 'strizhka');
        check('после F5 цена и галка на месте', afterReload?.price === '2500' && afterReload?.top === true, JSON.stringify(afterReload));

        // ── 4. негодная цена не сохраняется молча ──────────────────────────
        // Правка и клик - одним вызовом: карточки команды перерисовываются из ответа
        // сервера (renderTeam), и между двумя отдельными eval набранное в поле успевает
        // исчезнуть вместе со старым host - гонка прогона, не продукта
        await sleep(1200);
        await s.eval(`(function(){
          const price = document.querySelector('.service-picker[data-master-id="tm-usual"] .service-check[data-service-id="strizhka"] .sc-price-input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(price, '0');
          price.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.team-editor-card[data-staff-id="tm-usual"] [data-save]').click();
        })()`);
        await sleep(400);
        const badState = await rowState('tm-usual', 'strizhka');
        const stillSaved = await db.query(`SELECT price FROM master_services WHERE master_id = 'tm-usual' AND service_id = 'strizhka'`);
        check('нулевая цена подсвечена как ошибка', badState?.priceInvalid === true, JSON.stringify(badState));
        check('нулевая цена в базу не уехала', stillSaved.rows[0].price === 2500, String(stillSaved.rows[0].price));
        const errText = await s.eval(`(function(){
          const card = document.querySelector('.team-editor-card[data-staff-id="tm-usual"]');
          return [card?.querySelector('[data-card-note]')?.innerText, document.querySelector('.crm-toast')?.innerText].filter(Boolean).join(' | ');
        })()`);
        check('человеку названа причина, а не «не получилось»', /[Цц]ена/.test(errText), errText.slice(0, 120));

        // ── 5. снятая услуга гасит цену и галку ────────────────────────────
        await s.eval(`(function(){
          const label = document.querySelector('.service-picker[data-master-id="tm-usual"] .service-check[data-service-id="strizhka"]');
          const box = label.querySelector('input[type="checkbox"]');
          box.checked = false;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const offState = await rowState('tm-usual', 'strizhka');
        check('снятая услуга гасит поле цены', offState?.priceDisabled === true, JSON.stringify(offState));
        check('снятая услуга гасит и снимает галку «топ»', offState?.topDisabled === true && offState?.top === false, JSON.stringify(offState));

        // ── 6. карточки записей в «Дне» ───────────────────────────────────
        await login('crm-owner.html', 'tm-owner@alikhan.test', ownerPin);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.appt[data-id]'))`)); i++) await sleep(200);
        const cards = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.appt[data-id]')].map(c => ({
          master: c.dataset.masterId, tier: c.dataset.masterTier, badge: !!c.querySelector('.appt-top-tier'), text: c.innerText.replace(/\\s+/g,' ').trim()
        })))`));
        const topCard = cards.find((c) => c.master === 'tm-top');
        const usualCard = cards.find((c) => c.master === 'tm-usual');
        check('визит к топ-мастеру помечен на карточке дня', topCard?.badge === true && topCard?.tier === 'top', JSON.stringify(topCard));
        check('обычный визит меткой не засоряется', usualCard?.badge === false && usualCard?.tier === 'standard', JSON.stringify(usualCard));

        // ── 7. форма записи показывает условия визита ─────────────────────
        await s.eval(`(function(){ const c = document.querySelector('.appt[data-master-id="tm-top"]'); (window.openBookingEdit||window.openBooking)(c); })()`);
        await sleep(1500);
        const terms = await s.eval(`(function(){ const el = document.getElementById('bkTerms'); return el && !el.hidden ? el.innerText : ''; })()`);
        check('условия визита показаны строкой', /топ-мастер/.test(terms) && /Яндекс/.test(terms), terms);
        await s.eval(`document.getElementById('bkTerms')?.scrollIntoView({ block: 'center' })`);
        await sleep(400);
        await s.screenshot('/tmp/verify-top-master-terms.png');

        // ── 8. администратор видит, но не правит ──────────────────────────
        await login('crm-admin.html', 'tm-admin@alikhan.test', adminPin);
        await openTeam();
        await s.eval(`document.querySelector('.service-picker[data-master-id="tm-top"]')?.closest('details')?.setAttribute('open','')`);
        await sleep(500);
        await s.eval(`document.querySelector('.service-picker[data-master-id="tm-top"] .service-check')?.scrollIntoView({ block: 'center' })`);
        await sleep(300);
        const adminRow = await rowState('tm-top', 'strizhka');
        check('администратор видит цену и топ-статус', adminRow?.price === '3000' && adminRow?.top === true, JSON.stringify(adminRow));
        check('администратор не может их править', adminRow?.priceDisabled === true && adminRow?.topDisabled === true, JSON.stringify(adminRow));
        await s.screenshot('/tmp/verify-top-master-admin.png');
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exitCode = 1;
