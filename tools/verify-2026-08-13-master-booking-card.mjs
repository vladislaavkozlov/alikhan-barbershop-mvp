// Живая проверка карточки визита в кабинете мастера (13.08.2026, вторая итерация по
// правкам Влада: мастер запись НЕ ведёт, у него только просмотр). Два сценария в
// ОДНОМ withBrowser (порт отладки в cdp.mjs захардкожен, два подряд гонятся за него):
//   1. мастер - клик по записи показывает время/клиента/услуги/сумму/комиссию,
//      карточка сворачивается, ни одного контрола редактирования на странице нет;
//   2. владелец - регресс: его форма по-прежнему умеет перенос, удаление и сумму.
import { withBrowser } from './cdp.mjs';
import { daysFromToday, hashPin, makeChecker, randomPin, withEphemeralServer, withStaticServer } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MASTER = 'qa-bcard-master';
const OWNER = 'qa-bcard-owner';
const TODAY = daysFromToday(0);

async function login(session, base, page, email, pin) {
  await session.navigate(`${base}/${page}`);
  for (let i = 0; i < 40; i += 1) {
    const ready = await session.eval(`!!document.getElementById('loginEmail')`);
    if (ready === true) break;
    await sleep(200);
  }
  await session.type('#loginEmail', email);
  await session.type('#loginPin', pin);
  await session.click('#loginForm button[type="submit"]');
  await sleep(1800);
  await session.setViewport(1440, 1100, false);
}

// Ждём, пока календарь дня перерисуется РЕАЛЬНЫМИ данными: статичная разметка-пример
// в crm-master.html живёт до первого рендера, и клик по ней ничего не доказал бы.
async function waitForBooking(session, bookingId) {
  for (let i = 0; i < 60; i += 1) {
    const found = await session.eval(`!!document.querySelector('.appt[data-id="${bookingId}"]')`);
    if (found === true) return true;
    await sleep(300);
  }
  return false;
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const masterPin = randomPin();
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, phone, pin_hash) VALUES
       ('${OWNER}', 1, 'QA Владелец Карточка', 'owner', true, false, true, 'qa-bcard-owner@test.local', '89001112233', $1),
       ('${MASTER}', 1, 'QA Мастер Карточка', 'master', true, true, true, 'qa-bcard-master@test.local', '89001234567', $2)`,
      [hashPin(ownerPin), hashPin(masterPin)],
    );
    // Услуги мастера со СВОИМИ ценами (master_services) - комиссию считаем от них
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('${MASTER}', 'strizhka', 2000, 40), ('${MASTER}', 'boroda', 1500, 30)`,
    );
    await db.query(`INSERT INTO master_payroll_settings (master_id, pct) VALUES ('${MASTER}', 40)
                    ON CONFLICT (master_id) DO UPDATE SET pct = 40`);
    // Рабочий график, иначе календарь покажет "нет графика" вместо колонки с записями
    for (let wd = 1; wd <= 7; wd += 1) {
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         VALUES ($1, $2, true, '10:00', '20:00') ON CONFLICT (master_id, weekday) DO NOTHING`,
        [MASTER, wd],
      );
    }
    const booking = await db.query(
      `INSERT INTO bookings (id, master_id, location_id, date, start_time, end_time, status, channel, walkin_name)
       VALUES ('qa-bcard-booking', $1, 1, $2, '12:00', '12:40', 'planned', 'admin', 'Клиент Проверка')
       RETURNING id`,
      [MASTER, TODAY],
    );
    const bookingId = booking.rows[0].id;
    await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'strizhka')`, [bookingId]);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await session.setViewport(1440, 1100, false);

        // ── Сценарий 1: кабинет мастера ──────────────────────────────────────
        await login(session, base, 'crm-master.html', 'qa-bcard-master@test.local', masterPin);
        check('Мастер вошёл в свой кабинет', (await session.eval(`!document.getElementById('crmMain').hidden`)) === true);
        check('Реальная запись появилась в календаре мастера', await waitForBooking(session, bookingId), bookingId);

        // Клик программный (el.click), как и во всех прогонах по этому календарю.
        // Координатный clickAt здесь ничего бы не доказал: на этом стенде
        // elementFromPoint в центре карточки записи не попадает в неё НИ у мастера, НИ
        // у владельца (замерено 13.08.2026 обеими ролями подряд в одном браузере:
        // master → MAIN.wrap.page, owner → STRONG) - то есть это свойство headless-
        // стенда, а не вёрстки страницы мастера. Отдельная находка прогона окна 59
        // (центр записи перекрыт телом всегда открытой #bd-1) при этом закрыта самим
        // удалением #bd-1: перекрывать больше нечем, форма скрыта до клика.
        await session.eval(`document.querySelector('.appt[data-id="${bookingId}"]').click()`);
        await sleep(700);

        const opened = await session.eval(`(() => {
          const view = document.getElementById('masterBookingView');
          const card = document.getElementById('scheduleCard-booking-view');
          if (!view) return { viewFound: false };
          return {
            viewFound: true,
            hidden: view.hidden,
            cardOpen: !!card?.open,
            when: document.getElementById('mbWhen')?.textContent ?? '',
            client: document.getElementById('mbClient')?.textContent ?? '',
            status: document.getElementById('mbStatus')?.textContent ?? '',
            services: [...document.querySelectorAll('#mbServices li')].map((li) => li.textContent.trim()),
            total: document.getElementById('mbTotal')?.textContent ?? '',
            commission: document.getElementById('mbCommission')?.textContent ?? '',
            commissionNote: document.getElementById('mbCommissionNote')?.textContent ?? '',
            oldCard: !!document.getElementById('bd-1'),
          };
        })()`);
        const raw = JSON.stringify(opened);
        check('Клик по записи открывает карточку визита, старой #bd-1 нет', opened.viewFound && opened.hidden === false && !opened.oldCard, raw);
        check('Карточка развёрнута сама, без лишнего клика', opened.cardOpen === true, raw);
        check('Время записи показано', /12:00/.test(opened.when), raw);
        check('Клиент показан', opened.client === 'Клиент Проверка', raw);
        check('Статус визита виден словом', /Ожидание/.test(opened.status), raw);
        check('Услуга записи показана с ценой и длительностью',
          opened.services.length === 1 && /Стрижка/.test(opened.services[0]) && /2\s?000/.test(opened.services[0]) && /40 мин/.test(opened.services[0]), raw);
        check('Итог по записи посчитан по прайсу этого мастера', /40 мин/.test(opened.total) && /2\s?000/.test(opened.total), raw);
        check('Комиссия по РЕАЛЬНОЙ ставке 40% от 2000 = 800', /800/.test(opened.commission), raw);
        check('Комиссия честно помечена предварительной, пока администратор не провёл сумму',
          /предварительно/i.test(opened.commissionNote), raw);

        // Ни одного контрола редактирования: всё это делает администратор
        const forbidden = await session.eval(`(() => ({
          form: !!document.getElementById('walkinForm'),
          servicePicker: !!document.getElementById('wfServicePicker'),
          submit: !!document.getElementById('wfSubmit'),
          statusRadios: document.querySelectorAll('input[name="bstatus"]').length,
          masterRow: !!document.getElementById('wfMasterRow'),
          dateTime: !!document.getElementById('wfDateTimeRow'),
          deleteRow: !!document.getElementById('bkDeleteRow'),
          actualPrice: !!document.getElementById('bkActualPrice'),
          oldServiceBlock: !!document.getElementById('bkServiceEditPicker'),
          noShowBtn: !!document.getElementById('bk-noshow-btn'),
          phoneField: !!document.getElementById('wfClientPhone'),
          anyCheckbox: document.querySelectorAll('#masterBookingView input, #masterBookingView button').length,
        }))()`);
        check('В кабинете мастера не осталось ни одного контрола записи',
          Object.values(forbidden).every((v) => v === false || v === 0), JSON.stringify(forbidden));

        // Карточка сворачивается - правка Влада (раньше панель висела всегда открытой)
        await session.eval(`document.querySelector('#scheduleCard-booking-view > summary').click()`);
        await sleep(400);
        const collapsed = await session.eval(`!!document.getElementById('scheduleCard-booking-view')?.open`);
        check('Карточку записи можно свернуть', collapsed === false, `open=${collapsed}`);
        await session.eval(`document.querySelector('#scheduleCard-booking-view > summary').click()`);
        await sleep(400);

        // Отступ до соседней карточки "Месяц" - тот же, что между остальными карточками
        const gaps = await session.eval(`(() => {
          const cards = [...document.querySelectorAll('.panel-a .schedule-view-cards > details.staff-card')];
          const tops = cards.map((c) => c.getBoundingClientRect());
          const gapList = tops.slice(1).map((r, i) => Math.round(r.top - tops[i].bottom));
          return { count: cards.length, ids: cards.map((c) => c.id), gaps: gapList };
        })()`);
        check('Карточка визита стоит в одном ряду с День/Неделя/Месяц',
          gaps.ids.includes('scheduleCard-booking-view') && gaps.count >= 4, JSON.stringify(gaps));
        check('Отступы между всеми карточками одинаковые, вплотную ничего не прижато',
          gaps.gaps.length > 0 && gaps.gaps.every((g) => g > 0 && g === gaps.gaps[0]), JSON.stringify(gaps));

        await session.eval(`document.getElementById('masterBookingView').scrollIntoView({ block: 'center' })`);
        await sleep(300);
        await session.screenshot('/tmp/master-card-master.png');

        // ── Сценарий 2: владелец, регресс ────────────────────────────────────
        await login(session, base, 'crm-owner.html', 'qa-bcard-owner@test.local', ownerPin);
        check('Владелец вошёл', (await session.eval(`!document.getElementById('crmMain').hidden`)) === true);
        check('Запись видна и в кабинете владельца', await waitForBooking(session, bookingId), bookingId);
        await session.eval(`document.querySelector('.appt[data-id="${bookingId}"]').click()`);
        await sleep(800);
        const ownerForm = await session.eval(`(() => {
          const form = document.getElementById('walkinForm');
          const boxes = [...document.querySelectorAll('#wfServicePicker input[type=checkbox]')];
          return {
            hidden: form?.hidden,
            bookingId: form?.dataset.bookingId,
            masterRow: !document.getElementById('wfMasterRow')?.hidden,
            dateTime: !document.getElementById('wfDateTimeRow')?.hidden,
            extras: !document.getElementById('wfEditExtras')?.hidden,
            danger: !document.getElementById('wfDangerZone')?.hidden,
            actualPrice: document.getElementById('bkActualPrice')?.value ?? null,
            anyLocked: boxes.some((i) => i.disabled && i.checked),
          };
        })()`);
        const ownerRaw = JSON.stringify(ownerForm);
        check('У владельца форма открылась на той же записи', ownerForm.hidden === false && ownerForm.bookingId === bookingId, ownerRaw);
        check('Владельцу по-прежнему доступны перенос (мастер + дата/время)', ownerForm.masterRow && ownerForm.dateTime, ownerRaw);
        check('Фактическая сумма и зона удаления на месте', ownerForm.extras && ownerForm.danger, ownerRaw);
        check('Владельцу услуги НЕ блокируются (у него PUT со снятием)', ownerForm.anyLocked === false, ownerRaw);
        // 2000 - стрижка по прайсу этого мастера: состав записи мастер больше не
        // меняет, дописывать услуги может только администратор этой же формой.
        check('Сумма услуг подставлена в фактическую сумму', /2000|2 000/.test(String(ownerForm.actualPrice)), ownerRaw);

        await session.eval(`document.getElementById('walkinForm').scrollIntoView({ block: 'center' })`);
        await sleep(250);
        await session.screenshot('/tmp/master-card-owner.png');
      });
    });
  });
} finally {
  summary();
}
