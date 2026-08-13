// Живая проверка переноса карточки записи мастера с макета #bd-1 на общую форму
// (13.08.2026, spec 2026-08-13-master-booking-card.md). Два сценария в ОДНОМ
// withBrowser (порт отладки в cdp.mjs захардкожен, два подряд гонятся за него):
//   1. мастер - открывает свою запись, видит состав/сумму/комиссию, дописывает услугу,
//      меняет статус; переноса, удаления и фактической суммы у него нет вовсе;
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
          const form = document.getElementById('walkinForm');
          if (!form) return { formFound: false };
          const checked = [...form.querySelectorAll('#wfServicePicker input[type=checkbox]')]
            .map((i) => ({ id: i.value, checked: i.checked, disabled: i.disabled }));
          return {
            formFound: true,
            hidden: form.hidden,
            bookingId: form.dataset.bookingId,
            when: document.getElementById('wfBookingWhen')?.value ?? null,
            client: document.getElementById('wfClientName')?.value ?? null,
            summary: document.getElementById('wfSummary')?.textContent ?? '',
            commission: document.getElementById('wfCommission')?.value ?? null,
            commissionNote: document.getElementById('wfCommissionNote')?.textContent ?? '',
            services: checked,
            oldCard: !!document.getElementById('bd-1'),
            statusVisible: !document.getElementById('wfEditControls')?.hidden,
          };
        })()`);
        const raw = JSON.stringify(opened);
        check('Клик по записи открывает ОБЩУЮ форму, а не старую карточку', opened.formFound && opened.hidden === false && !opened.oldCard, raw);
        check('В форме именно эта запись', opened.bookingId === bookingId, raw);
        check('Время записи показано подписью', /12:00/.test(opened.when || ''), raw);
        check('Имя клиента подставлено', opened.client === 'Клиент Проверка', raw);
        check('Состав услуг записи отмечен и заблокирован (снятие мастеру недоступно)',
          opened.services.some((s) => s.id === 'strizhka' && s.checked && s.disabled), raw);
        check('Свободная услуга остаётся доступной для добавления',
          opened.services.some((s) => s.id === 'boroda' && !s.checked && !s.disabled), raw);
        check('Сумма и длительность посчитаны по прайсу этого мастера', /40 мин/.test(opened.summary) && /2\s?000/.test(opened.summary), raw);
        check('Комиссия по РЕАЛЬНОЙ ставке 40% от 2000 = 800', /800/.test(opened.commission || ''), raw);
        check('Ставка объяснена словами', /40%/.test(opened.commissionNote), raw);
        check('Блок статуса визита виден', opened.statusVisible === true, raw);

        const forbidden = await session.eval(`(() => ({
          masterRow: !!document.getElementById('wfMasterRow'),
          dateTime: !!document.getElementById('wfDateTimeRow'),
          extras: !!document.getElementById('wfEditExtras'),
          danger: !!document.getElementById('wfDangerZone'),
          deleteRow: !!document.getElementById('bkDeleteRow'),
          actualPrice: !!document.getElementById('bkActualPrice'),
          oldServiceBlock: !!document.getElementById('bkServiceEditPicker'),
          noShowBtn: !!document.getElementById('bk-noshow-btn'),
          confirmBox: !!document.getElementById('bconfirm'),
        }))()`);
        check('Мастеру не показан ни один запрещённый бэкендом контрол',
          Object.values(forbidden).every((v) => v === false), JSON.stringify(forbidden));

        // Добавление услуги - PATCH /bookings/:id/services
        await session.eval(`(() => {
          const box = [...document.querySelectorAll('#wfServicePicker input[type=checkbox]')].find((i) => i.value === 'boroda');
          box.click();
        })()`);
        await sleep(300);
        await session.click('#wfSubmit');
        await sleep(1500);
        const afterSave = await session.eval(`(() => ({
          result: document.getElementById('wfResult')?.textContent ?? '',
          err: (document.getElementById('wfResult')?.className ?? '').includes('err'),
          beardLocked: [...document.querySelectorAll('#wfServicePicker input[type=checkbox]')]
            .some((i) => i.value === 'boroda' && i.checked && i.disabled),
        }))()`);
        check('Добавленная услуга сохранена без ошибки', !afterSave.err && /добавлен/i.test(afterSave.result), JSON.stringify(afterSave));
        const savedServices = await db.query('SELECT service_id FROM booking_services WHERE booking_id = $1 ORDER BY service_id', [bookingId]);
        check('В базе у записи теперь ОБЕ услуги', savedServices.rows.map((r) => r.service_id).join(',') === 'boroda,strizhka',
          JSON.stringify(savedServices.rows));
        check('Только что добавленная услуга тоже стала неснимаемой', afterSave.beardLocked === true, JSON.stringify(afterSave));

        // Статус визита - PATCH /bookings/:id/status (до правки радио были декоративны)
        await session.eval(`document.getElementById('st-came').click()`);
        await sleep(1200);
        const statusRow = await db.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
        check('Смена статуса реально доехала до базы (было "planned")', statusRow.rows[0].status === 'done',
          JSON.stringify(statusRow.rows[0]));

        await session.eval(`document.getElementById('walkinForm').scrollIntoView({ block: 'center' })`);
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
        check('Сумма услуг подставлена в фактическую сумму', /3500|3 500/.test(String(ownerForm.actualPrice)), ownerRaw);

        await session.eval(`document.getElementById('walkinForm').scrollIntoView({ block: 'center' })`);
        await sleep(250);
        await session.screenshot('/tmp/master-card-owner.png');
      });
    });
  });
} finally {
  summary();
}
