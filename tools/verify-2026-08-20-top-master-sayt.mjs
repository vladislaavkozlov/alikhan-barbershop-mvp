// Живой прогон публичной формы записи (20.08.2026, Фаза 4 плана
// plans/2026-08-20-top-master-tarif.md). Сценарий Влада целиком: «клиент выбирает
// услугу, и ему открывается выбор - у обычного мастера за стандартную оплату или у
// топ-мастера за +».
//
// Что доказываем в реальном браузере:
//   1. первый шаг формы - услуги, они видны сразу, мастера ждут выбора услуг
//   2. выбрал услугу - появился выбор тарифа с честными ценами «от» и надбавкой
//   3. тариф сужает список мастеров, топ помечен меткой и своей ценой визита
//   4. по услуге, где топ-мастеров нет, блока тарифа нет вовсе (выбор из одного - не выбор)
//   5. мастер, который оказывает не весь набор услуг, в списке не появляется
//   6. запись доходит до конца и приезжает в базу с тарифом top
import { withEphemeralServer, withStaticServer, makeChecker, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATE = daysFromToday(1);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    // Топ Мастер - стрижка дороже и помечена топом. Обычный - тот же набор по каталогу.
    // Узкий - только борода: он проверяет, что набор услуг реально сужает список людей.
    for (const [id, name] of [['tm-top', 'Тимур Топов'], ['tm-usual', 'Улугбек Обычнов'], ['tm-narrow', 'Никита Узков']]) {
      await db.query(
        `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email)
         VALUES ($1, 1, $2, 'master', true, true, false, $1 || '@alikhan.test')`,
        [id, name]
      );
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`,
        [id]
      );
    }
    // Сидовые мастера миграции 002 не должны мешать точным сравнениям списков -
    // услуг у них нет, и в публичный список они не попадают (EXISTS master_services)
    await db.query(`DELETE FROM master_services WHERE master_id IN ('master-1','master-2','master-3')`);
    for (const id of ['tm-top', 'tm-usual']) {
      await db.query(
        `INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT $1, id, price, duration_min FROM services`,
        [id]
      );
    }
    await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT 'tm-narrow', id, price, duration_min FROM services WHERE id = 'boroda'`);
    await db.query(`UPDATE master_services SET is_top = true, price = 3000 WHERE master_id = 'tm-top' AND service_id = 'strizhka'`);

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 950);
        await s.navigate(`${siteUrl}/index.html`);
        // Ждём, пока приедут и мастера, и их услуги (форма рисуется до сети, потом
        // перерисовывается - проверять надо конечное состояние)
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(document.body.innerText.includes('Тимур Топов'))`)); i++) await sleep(200);
        await sleep(600);

        // toLocaleString('ru-RU') разделяет тысячи неразрывным пробелом (U+00A0) -
        // сравнивать с обычным пробелом бесполезно, приводим к одному виду
        const plain = (text) => String(text ?? '').replace(/\u00a0/g, ' ');
        const readGrid = async (selector) => JSON.parse(await s.eval(
          `JSON.stringify([...document.querySelectorAll('${selector} .option-card')].map(b => ({
            name: b.querySelector('.opt-name')?.innerText.trim(), meta: b.querySelector('.opt-meta')?.innerText.trim(),
            selected: b.classList.contains('selected'), top: !!b.querySelector('.opt-top-tag'), tier: b.dataset.tier || null
          })))`
        ));
        const tierVisible = async () => JSON.parse(await s.eval(`JSON.stringify(!document.getElementById('tier-field').hidden)`));
        const clickCard = async (selector, text) => s.eval(`(function(){
          const card = [...document.querySelectorAll('${selector} .option-card')].find(b => b.innerText.includes(${JSON.stringify(text)}));
          if (!card) return 'NOT_FOUND';
          card.click(); return 'OK';
        })()`);

        // ── 1. первый шаг - услуги ────────────────────────────────────────
        console.log('DEBUG master-grid:', await s.eval(`document.getElementById('master-grid').innerText.slice(0,200)`));
        const servicesShown = await readGrid('#service-grid');
        const masterHint = await s.eval(`document.querySelector('#master-grid .option-hint')?.innerText ?? ''`);
        check('услуги показаны сразу, без выбора мастера', servicesShown.length >= 8, `карточек: ${servicesShown.length}`);
        check('порядок шагов: мастера ждут услуг', /Сначала выберите услуги/.test(masterHint), masterHint);
        check('тарифа до выбора услуг нет', (await tierVisible()) === false);
        const strizhka = servicesShown.find((c) => c.name === 'Стрижка');
        check('в каталоге цена «от», раз мастера берут по-разному', /^от 2 000₽/.test(plain(strizhka?.meta)), plain(strizhka?.meta));

        const stepLabels = async () => JSON.parse(await s.eval(
          `JSON.stringify([...document.querySelectorAll('.booking-shell label[data-step]')].filter(l => !l.closest('.field').hidden).map(l => l.innerText.trim()))`
        ));
        // Нумерация без пропусков: блок тарифа скрыт, значит шаги обязаны идти 1-2-3-4,
        // а не 1-3-4-5 (на живом сайте после первого деплоя было именно так)
        const stepsNoTier = (await stepLabels()).join(' | ').toLowerCase();
        check('без тарифа шаги пронумерованы подряд', stepsNoTier === '1. услуги - можно несколько | 2. мастер | 3. дата | 4. свободное время', stepsNoTier);

        // ── 1б. клики реально доходят до карточек ─────────────────────────
        // Баг Влада 21.08.2026: декоративная окружность .booking::before лежала поверх
        // правого верхнего угла формы и съедала клики - услуга под ней не выбиралась и
        // не снималась. Проверяем ровно в том положении страницы, куда попадает клиент
        // по кнопке «Выбрать услугу и время» (якорь #booking), а не после прокрутки к
        // конкретной карточке: прокрутка уводит её из-под круга и баг прячется.
        // scrollIntoView, а не location.hash: если hash уже равен #booking, повторное
        // присвоение не прокручивает страницу вовсе, и проверка мерила не то положение
        await s.eval(`document.getElementById('booking').scrollIntoView({ block: 'start' })`);
        await sleep(1500);
        const covered = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#service-grid .option-card')].map(b => {
          const r = b.getBoundingClientRect();
          if (r.top < 0 || r.bottom > innerHeight) return null;
          const hit = document.elementFromPoint(Math.round(r.x + r.width/2), Math.round(r.y + r.height/2));
          return hit && (b === hit || b.contains(hit)) ? null : b.querySelector('.opt-name').innerText.trim();
        }).filter(Boolean))`));
        check('клики доходят до всех карточек услуг, ничем не перекрыты', covered.length === 0, covered.join(', '));

        // ── 2. выбрали услугу - появился выбор тарифа ─────────────────────
        check('клик по услуге', (await clickCard('#service-grid', 'Стрижка')) === 'OK');
        await sleep(400);
        check('после выбора услуги появился выбор тарифа', (await tierVisible()) === true);
        const tiers = await readGrid('#tier-grid');
        const standard = tiers.find((t) => t.tier === 'standard');
        const top = tiers.find((t) => t.tier === 'top');
        check('карточка обычного мастера с ценой', /от 2 000₽/.test(plain(standard?.meta)) && /стандартная цена/.test(plain(standard?.meta)), plain(standard?.meta));
        check('карточка топ-мастера показывает надбавку', /от 3 000₽/.test(plain(top?.meta)) && /\+1 000₽/.test(plain(top?.meta)), plain(top?.meta));

        // ── 3. до выбора тарифа видны все, кто оказывает услугу ───────────
        const stepsWithTier = (await stepLabels()).join(' | ').toLowerCase();
        check('с тарифом шаги тоже подряд', stepsWithTier === '1. услуги - можно несколько | 2. у какого мастера | 3. мастер | 4. дата | 5. свободное время', stepsWithTier);

        const allMasters = await readGrid('#master-grid');
        check('узкий мастер без этой услуги в списке не появился', !allMasters.some((m) => m.name.includes('Никита')), JSON.stringify(allMasters.map((m) => m.name)));
        check('топ-мастер помечен меткой «топ»', allMasters.find((m) => m.name.includes('Тимур'))?.top === true, JSON.stringify(allMasters));
        check('на карточке мастера его собственная цена визита', /3 000₽/.test(plain(allMasters.find((m) => m.name.includes('Тимур'))?.meta)), plain(allMasters.find((m) => m.name.includes('Тимур'))?.meta));

        // ── 4. тариф сужает список ────────────────────────────────────────
        check('клик по тарифу «Топ-мастер»', (await clickCard('#tier-grid', 'Топ-мастер')) === 'OK');
        await sleep(400);
        const topOnly = await readGrid('#master-grid');
        check('под топ-тарифом остался только топ-мастер', topOnly.length === 1 && topOnly[0].name.includes('Тимур'), JSON.stringify(topOnly.map((m) => m.name)));
        check('клик по тарифу «Обычный мастер»', (await clickCard('#tier-grid', 'Обычный мастер')) === 'OK');
        await sleep(400);
        const usualOnly = await readGrid('#master-grid');
        check('под обычным тарифом остался только обычный мастер', usualOnly.length === 1 && usualOnly[0].name.includes('Улугбек'), JSON.stringify(usualOnly.map((m) => m.name)));
        check('на его карточке стандартная цена', /^2 000₽/.test(plain(usualOnly[0]?.meta)), plain(usualOnly[0]?.meta));
        // Секция формы приезжает с scroll-reveal (opacity 0 до пересечения) - без паузы
        // снимок ловит пустой тёмный экран, а не форму
        await s.eval(`document.getElementById('booking').scrollIntoView({ block: 'start' })`);
        await sleep(1600);
        await s.screenshot('/tmp/verify-top-master-sayt.png');

        // Мобильный вид - основной для клиента барбершопа: два тарифа рядом на узком
        // экране должны оставаться читаемыми, а не схлопываться в кашу
        await s.setViewport(390, 844, true);
        await sleep(600);
        await s.eval(`document.getElementById('tier-field').scrollIntoView({ block: 'center' })`);
        await sleep(900);
        const tierWidths = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('#tier-grid .option-card')].map(b => ({ w: Math.round(b.getBoundingClientRect().width), overflow: b.scrollWidth > b.clientWidth + 1 })))`));
        check('на телефоне обе карточки тарифа помещаются в ряд без обрезки', tierWidths.length === 2 && tierWidths.every((t) => t.w > 120 && !t.overflow), JSON.stringify(tierWidths));
        await s.screenshot('/tmp/verify-top-master-sayt-mobile.png');
        await s.setViewport(1440, 950, false);
        await sleep(400);

        // ── 5. услуга без топ-мастеров - выбора тарифа нет ────────────────
        check('снимаем стрижку', (await clickCard('#service-grid', 'Стрижка')) === 'OK');
        await sleep(300);
        check('выбираем бороду', (await clickCard('#service-grid', 'Борода')) === 'OK');
        await sleep(400);
        check('по бороде топ-мастеров нет - блок тарифа скрыт', (await tierVisible()) === false);
        const borodaMasters = await readGrid('#master-grid');
        check('по бороде доступны все трое', borodaMasters.length === 3, JSON.stringify(borodaMasters.map((m) => m.name)));

        // ── 6. набор услуг сужает список людей ───────────────────────────
        check('добавляем к бороде тонировку', (await clickCard('#service-grid', 'Тонировка')) === 'OK');
        await sleep(400);
        const pairMasters = await readGrid('#master-grid');
        check('узкий мастер отсеян на паре услуг', !pairMasters.some((m) => m.name.includes('Никита')), JSON.stringify(pairMasters.map((m) => m.name)));

        // ── 7. сквозная запись к топ-мастеру ─────────────────────────────
        check('снимаем бороду', (await clickCard('#service-grid', 'Борода')) === 'OK');
        await sleep(200);
        check('снимаем тонировку', (await clickCard('#service-grid', 'Тонировка')) === 'OK');
        await sleep(200);
        check('выбираем стрижку заново', (await clickCard('#service-grid', 'Стрижка')) === 'OK');
        await sleep(400);
        check('выбираем топ-тариф', (await clickCard('#tier-grid', 'Топ-мастер')) === 'OK');
        await sleep(400);
        check('выбираем мастера', (await clickCard('#master-grid', 'Тимур')) === 'OK');
        await sleep(800);
        const summaryText = await s.eval(`document.getElementById('service-summary')?.innerText ?? ''`);
        check('в сводке точная цена выбранного мастера, без «от»', /3 000₽/.test(plain(summaryText)) && !/от /.test(plain(summaryText)), plain(summaryText));

        // дата и время
        await s.eval(`document.getElementById('date-toggle').click()`);
        await sleep(400);
        await s.eval(`(function(){
          const day = [...document.querySelectorAll('#cal-grid .cal-day:not(.disabled)')].find(d => d.dataset.date === ${JSON.stringify(DATE)});
          (day || [...document.querySelectorAll('#cal-grid .cal-day:not(.disabled)')][1])?.click();
        })()`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.slot-btn'))`)); i++) await sleep(200);
        await s.eval(`document.querySelector('.slot-btn')?.click()`);
        await s.eval(`(function(){
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const name = document.getElementById('f-name'); set.call(name, 'Клиент Проверкин'); name.dispatchEvent(new Event('input', {bubbles:true}));
          const phone = document.getElementById('f-phone'); set.call(phone, '+7 900 111-22-33'); phone.dispatchEvent(new Event('input', {bubbles:true}));
          const consent = document.getElementById('f-consent'); consent.checked = true; consent.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await sleep(300);
        await s.eval(`document.getElementById('f-submit').click()`);
        await sleep(2500);
        const receipt = await s.eval(`document.getElementById('form-msg')?.innerText ?? ''`);
        check('запись подтверждена на сайте', /подтвержд/i.test(receipt), receipt.replace(/\s+/g, ' ').slice(0, 160));
        const saved = await db.query(`SELECT master_id, master_tier, client_source FROM bookings ORDER BY created_at DESC LIMIT 1`);
        check('запись ушла к топ-мастеру с тарифом top', saved.rows[0]?.master_id === 'tm-top' && saved.rows[0]?.master_tier === 'top', JSON.stringify(saved.rows[0]));
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message ?? err);
}

summary();
if (crashed) process.exitCode = 1;
