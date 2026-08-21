// Живой прогон правки 21.08.2026 (задача Влада): «в пункте меню "Клиенты" по клиенту,
// чтобы в каждой записи типа "19.08.2026 15:00 / не пришёл / Стрижка · Алиовсад" была
// возможность провалиться в эту запись в расписании» + «добавить как в уведомлениях
// "Открыть запись / WhatsApp / Telegram / СМС / Позвонить" рядом с "Записать снова"».
//
// Что доказываем в реальном браузере на реальном Postgres:
//   1. строка визита в истории клиента - кнопка (курсор, роль, адрес записи)
//   2. отменённый визит кнопкой НЕ становится (в расписании его карточки нет вовсе)
//   3. клик по строке уводит в «Расписание» → «День» на дату визита и открывает
//      саму запись (та же карточка, что открылась бы кликом мышью в календаре)
//   4. так же открывается визит ПРОШЛОГО дня, не только сегодняшний
//   5. рядом с «Записать снова» стоят WhatsApp / Telegram / СМС / Позвонить
//   6. ссылки ведут на нормализованный номер, а текст - напоминание о ближайшей
//      записи, а не выдуманное приглашение
//   7. клик по «Показать целиком» внутри визита раскрывает комментарий и НЕ уводит
//      в расписание
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = daysFromToday(1); // завтра - «ожидается» обязано быть в будущем
const PAST = '2026-06-10';
const CANCELLED_DAY = '2026-06-11';
const LONG_COMMENT = 'Ц'.repeat(400);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('pv-boss', 1, 'QA Владелец', 'owner', true, false, true, 'pv-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    await db.query(`INSERT INTO clients (id, name, phone) VALUES ('pv-1', 'QA Клиент Перехода', '89185550077')`);
    // Без графика мастер не попадает в колонки «Дня» (mastersOf → hasWorkingSchedule,
    // assets/crm-calendar.js), и расписание не инициализируется вовсе - тогда прогон
    // проверял бы пустой экран, а не переход. Ставим рабочую неделю 10:00-20:00
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         VALUES ('master-2', $1, true, '10:00', '20:00')`,
        [weekday]
      );
    }
    for (const day of [PAST, CANCELLED_DAY, TODAY]) {
      await db.query(
        `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ('master-2', $1, '10:00', '20:00')`,
        [day]
      );
    }

    const rows = [
      ['pv-b-past', PAST, '11:00', '11:40', 'done'],
      ['pv-b-cancel', CANCELLED_DAY, '12:00', '12:40', 'cancelled'],
      ['pv-b-next', TODAY, '15:00', '15:40', 'planned'],
    ];
    for (const [id, date, start, end, status] of rows) {
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel)
         VALUES ($1, 1, 'master-2', 'pv-1', $2, $3, $4, $5, 'walkin')`,
        [id, date, start, end, status]
      );
      await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'strizhka')`, [id]);
    }
    // Длинный комментарий - ради проверки 7: «Показать целиком» внутри кликабельной строки
    await db.query(`UPDATE bookings SET staff_comment = $1 WHERE id = 'pv-b-past'`, [LONG_COMMENT]);
    const masterName = (await db.query(`SELECT name FROM staff WHERE id = 'master-2'`)).rows[0].name;

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const j = async (expr) => JSON.parse(await s.eval(`JSON.stringify(${expr})`));
        await s.navigate(`${siteUrl}/crm-owner.html`);
        await s.eval(`(function(){
          window.__errs = [];
          window.addEventListener('error', e => window.__errs.push(String(e.message)));
          window.addEventListener('unhandledrejection', e => window.__errs.push('rej: ' + String(e.reason && (e.reason.stack || e.reason.message || e.reason))));
          const ce = console.error.bind(console);
          console.error = (...a) => { window.__errs.push('console: ' + a.map(x => String(x && (x.stack || x.message || x))).join(' ')); ce(...a); };
        })()`);
        for (let i = 0; i < 40 && !(await j('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'pv-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !(await j('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        const openHistory = async () => {
          await s.eval(`document.querySelector('.app-nav-item[data-section="clients"]')?.click()`);
          for (let i = 0; i < 80 && !(await j(`!!document.querySelector('#clientsList .client-card[data-client-id="pv-1"]')`)); i++) await sleep(200);
          if (!(await j(`!!document.querySelector('.client-card[data-client-id="pv-1"] .client-visit')`))) {
            await s.eval(`document.querySelector('.client-card[data-client-id="pv-1"] summary')?.click()`);
          }
          for (let i = 0; i < 80 && !(await j(`!!document.querySelector('.client-card[data-client-id="pv-1"] .client-visit')`)); i++) await sleep(200);
        };
        await openHistory();

        await s.eval(`document.querySelector('.client-card[data-client-id="pv-1"]')?.scrollIntoView({ block: 'center' })`);
        await sleep(400);
        await s.screenshot('/tmp/verify-perehod-istoriya-klienta.png');

        // ── 1-2. строки истории: кто кнопка, кто нет ────────────────────────
        const visits = await j(`[...document.querySelectorAll('.client-card[data-client-id="pv-1"] .client-visit')].map(v => ({
          text: v.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60),
          id: v.dataset.visitId || '',
          date: v.dataset.visitDate || '',
          role: v.getAttribute('role') || '',
          cursor: getComputedStyle(v).cursor,
          title: v.getAttribute('title') || '',
        }))`);
        const past = visits.find((v) => v.id === 'pv-b-past');
        const next = visits.find((v) => v.id === 'pv-b-next');
        const cancelled = visits.find((v) => v.text.includes('отменена'));
        check('в истории все три визита', visits.length === 3, JSON.stringify(visits.map((v) => v.text)));
        check('строка состоявшегося визита - кнопка с адресом самой записи',
          past?.role === 'button' && past?.date === PAST && past?.cursor === 'pointer', JSON.stringify(past));
        check('строка будущей записи - тоже кнопка',
          next?.role === 'button' && next?.date === TODAY, JSON.stringify(next));
        check('отменённый визит кнопкой не притворяется (в расписании его карточки нет)',
          !!cancelled && !cancelled.id && cancelled.role === '' && cancelled.cursor !== 'pointer', JSON.stringify(cancelled));
        check('у отменённого честная подсказка почему', /Отменённой записи/.test(cancelled?.title ?? ''), cancelled?.title);

        // ── 5-6. кнопки связи рядом с «Записать снова» ──────────────────────
        const actions = await j(`[...document.querySelectorAll('.client-card[data-client-id="pv-1"] .client-card-actions > *')].map(a => ({
          label: a.innerText.trim(), href: a.getAttribute('href') || '', key: a.dataset.msgLink || '',
        }))`);
        const labels = actions.map((a) => a.label);
        check('рядом с «Записать снова» стоят все четыре кнопки связи из «Уведомлений»',
          ['Записать снова', 'WhatsApp', 'Telegram', 'СМС', 'Позвонить'].every((l) => labels.includes(l)), JSON.stringify(labels));
        const wa = actions.find((a) => a.key === 'whatsapp');
        const tg = actions.find((a) => a.key === 'telegram');
        const call = actions.find((a) => a.key === 'call');
        check('номер «89185550077» из базы нормализован в 79185550077 для всех ссылок',
          wa?.href.startsWith('https://wa.me/79185550077') && tg?.href.includes('phone=79185550077') && call?.href === 'tel:+79185550077',
          JSON.stringify([wa?.href.slice(0, 40), tg?.href, call?.href]));
        const waText = decodeURIComponent((wa?.href.split('text=')[1] ?? ''));
        check('в тексте сообщения - ближайшая запись клиента, а не выдумка',
          waText.includes('QA Клиент Перехода') && waText.includes('15:00') && waText.includes(masterName), waText);

        // ── 3. клик по будущей записи уводит в расписание и открывает её ────
        await s.eval(`document.querySelector('.client-visit[data-visit-id="pv-b-next"]')?.click()`);
        for (let i = 0; i < 80 && !(await j(`!!document.querySelector('.appt[data-id="pv-b-next"].appt--selected')`)); i++) await sleep(200);
        const afterNext = await j(`({
          section: document.querySelector('.app-nav-item.is-active .app-nav-label')?.textContent?.trim() || '',
          selected: !!document.querySelector('.appt[data-id="pv-b-next"].appt--selected'),
          dateInput: document.getElementById('bkDate')?.value || document.querySelector('[data-schedule-date]')?.dataset.scheduleDate || '',
          client: document.getElementById('wfClientName')?.value || document.getElementById('bkClientName')?.value || '',
        })`);
        check('клик по записи уводит в раздел «Расписание»', afterNext.section === 'Расписание', afterNext.section);
        check('открыта именно эта запись (карточка дня выбрана)', afterNext.selected === true, JSON.stringify(afterNext));
        check('форма записи заполнена данными клиента', afterNext.client === 'QA Клиент Перехода', afterNext.client);
        await s.screenshot('/tmp/verify-perehod-iz-istorii-next.png');

        // ── 4. то же для визита прошлого дня ────────────────────────────────
        await openHistory();
        await s.eval(`document.querySelector('.client-visit[data-visit-id="pv-b-past"]')?.click()`);
        for (let i = 0; i < 80 && !(await j(`!!document.querySelector('.appt[data-id="pv-b-past"].appt--selected')`)); i++) await sleep(200);
        const afterPast = await j(`({
          selected: !!document.querySelector('.appt[data-id="pv-b-past"].appt--selected'),
          section: document.querySelector('.app-nav-item.is-active .app-nav-label')?.textContent?.trim() || '',
        })`);
        check('запись прошлого дня открывается тем же кликом', afterPast.selected === true && afterPast.section === 'Расписание', JSON.stringify(afterPast));
        await s.screenshot('/tmp/verify-perehod-iz-istorii-past.png');

        // ── 7. «Показать целиком» не уводит в расписание ────────────────────
        await openHistory();
        await s.eval(`document.querySelector('.client-visit[data-visit-id="pv-b-past"] .client-visit-comment--long summary')?.click()`);
        await sleep(700);
        const afterComment = await j(`({
          open: !!document.querySelector('.client-visit[data-visit-id="pv-b-past"] .client-visit-comment--long[open]'),
          section: document.querySelector('.app-nav-item.is-active .app-nav-label')?.textContent?.trim() || '',
          len: document.querySelector('.client-visit[data-visit-id="pv-b-past"] [data-comment-full]')?.textContent?.length ?? 0,
        })`);
        check('клик по «Показать целиком» раскрывает комментарий и оставляет в «Клиентах»',
          afterComment.open === true && afterComment.section === 'Клиенты' && afterComment.len === 400, JSON.stringify(afterComment));
        await s.screenshot('/tmp/verify-perehod-iz-istorii-klienty.png');
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err);
}
summary();
if (crashed) process.exit(1);
