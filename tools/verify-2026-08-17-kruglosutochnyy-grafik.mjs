// Приёмка круглосуточного графика мастера (17.08.2026, Влад: «в Команде нужна
// возможность поставить график круглосуточно - время работы мастеру с любого времени
// по любое, 00:00-23:59, а не 08-20 как сейчас» + «время записи к сотрудникам должно
// учитывать и всё работать по времени записи и в CRM, и на сайте»).
//
// Всё на своей одноразовой базе и своём одноразовом сервере - боевой прод не трогается.
//
// Что доказываем:
//   1. Владелец сохраняет мастеру график 00:00-23:59, сервер это принимает и отдаёт
//      обратно именно эти часы (а не молча подменяет дефолтом 10:00-20:00)
//   2. Ночное время реально доступно для записи: /schedule-availability видит слоты,
//      запись на 02:00 создаётся
//   3. В CRM «День» шкала раздвигается на все сутки (00:00-24:00) и ночная карточка
//      физически видна внутри трека, а не уехала выше нуля
//   4. Публичный сайт предлагает ночные слоты тем же кодом, которым рисует их клиенту
//      (storage.getFreeSlots против живого API)
//   5. Регресс: как только график возвращается к 10:00-20:00, день выглядит ровно как
//      раньше - 11 подписей часов и трек 640px
//   6. Перевёрнутое окно (23:00-01:00) сервер отклоняет понятной ошибкой, а не пишет
//      в базу график, из которого мастер молча выпадает из записи
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PX_PER_MIN = 64 / 60;

await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  const ownerEmail = 'night-owner@alikhan.test';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ('vt-owner-night', 1, 'Владелец ночной смены', 'owner', true, false, true, $1, $2)`,
    [ownerEmail, hashPin(ownerPin)]
  );
  const masterId = 'vt-master-night';
  const masterPin = randomPin();
  const masterEmail = 'night-master@alikhan.test';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Мастер ночной смены', 'master', true, true, true, $2, $3)`,
    [masterId, masterEmail, hashPin(masterPin)]
  );
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     VALUES ($1, 'strizhka', 1000, 60) ON CONFLICT DO NOTHING`,
    [masterId]
  );
  // Второй мастер с обычным графиком 10:00-20:00 - на общей суточной шкале его
  // нерабочие часы обязаны быть видны заливкой, иначе колонка читается как рабочая
  // круглые сутки (найдено снимком экрана 17.08.2026)
  const dayMasterId = 'vt-master-day';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Мастер дневной смены', 'master', true, true, true, 'day-master@alikhan.test', $2)`,
    [dayMasterId, hashPin(randomPin())]
  );
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     VALUES ($1, 'strizhka', 1000, 60) ON CONFLICT DO NOTHING`,
    [dayMasterId]
  );
  for (let weekday = 1; weekday <= 7; weekday++) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [dayMasterId, weekday]
    );
  }
  // Сеяные мастера (Алиовсад/Мамедхан/Елизавета) остаются без графика - они выпадают
  // из «Дня» как «нет графика» и на шкалу не влияют (memory reference_barbershop-crm-tech)

  const DATE = todayStr();
  const login = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, pin: ownerPin }),
  });
  const { token } = await login.json();
  check('владелец вошёл по API', Boolean(token));
  const authed = (path, method, body) => fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const roundTheClock = Array.from({ length: 7 }, (_, i) => ({
    weekday: i + 1, isWorking: true, workStart: '00:00', workEnd: '23:59',
  }));

  // ── 1. Владелец ставит круглосуточный график ────────────────────────────────
  const putRes = await authed('/master-weekly-schedule', 'PUT', { masterId, weeklyChanges: roundTheClock });
  const putBody = await putRes.json();
  check('ГЛАВНОЕ: график 00:00-23:59 сохраняется', putRes.status === 200, `${putRes.status} ${JSON.stringify(putBody).slice(0, 160)}`);

  const weekly = await (await authed(`/master-weekly-schedule?masterId=${masterId}`, 'GET')).json();
  const monday = (weekly.weekly ?? weekly).find?.((r) => r.weekday === 1) ?? (weekly.weekly ?? weekly)[0];
  check('сервер отдаёт обратно именно 00:00-23:59', monday?.workStart === '00:00' && monday?.workEnd === '23:59', JSON.stringify(monday));

  const shifts = await (await authed(`/schedule?masterId=${masterId}&date=${DATE}`, 'GET')).json();
  const shift = shifts.find?.((s) => s.date === DATE);
  check('эффективный график на сегодня - круглосуточный', shift?.startTime === '00:00' && shift?.endTime === '23:59', JSON.stringify(shift));

  // ── 2. Ночное время доступно для записи ─────────────────────────────────────
  const avail = await (await fetch(`${apiUrl}/schedule-availability?masterId=${masterId}&serviceId=strizhka&from=${DATE}&to=${DATE}`)).json();
  check('на этот день есть свободные слоты', avail?.[0]?.hasSlots === true, JSON.stringify(avail).slice(0, 160));

  const nightBooking = await authed('/bookings', 'POST', {
    masterId, serviceIds: ['strizhka'], date: DATE, startTime: '02:00',
    clientName: 'Ночной клиент', clientPhone: '+79990000042',
  });
  const nightBody = await nightBooking.json();
  const nightId = nightBody.booking?.id;
  check('ГЛАВНОЕ: запись на 02:00 создаётся', nightBooking.status === 200 && Boolean(nightId), `${nightBooking.status} ${JSON.stringify(nightBody).slice(0, 160)}`);

  // ── 6. Перевёрнутое окно отклоняется понятной ошибкой ───────────────────────
  const badRes = await authed('/master-weekly-schedule', 'PUT', {
    masterId,
    weeklyChanges: [{ weekday: 1, isWorking: true, workStart: '23:00', workEnd: '01:00' }],
  });
  const badBody = await badRes.json();
  check('график «конец раньше начала» отклонён', badRes.status === 400, `${badRes.status} ${JSON.stringify(badBody)}`);
  // Код уточнён вечером 17.08.2026 (замечание Влада «в чём здесь конкретно ошибка»):
  // вместо общего invalid_weekly_changes сервер называет саму причину и день недели
  check('и отклонён понятным кодом в поле error, а не общим missing_fields', badBody?.error === 'work_end_before_start' && badBody?.weekday === 1 && badBody?.workEnd === '01:00', JSON.stringify(badBody));
  const stillNight = (await (await authed(`/schedule?masterId=${masterId}&date=${DATE}`, 'GET')).json()).find?.((s) => s.date === DATE);
  check('после отказа в базе остался прежний рабочий график', stillNight?.startTime === '00:00', JSON.stringify(stillNight));

  await withStaticServer(apiUrl, async (siteUrl) => {
    // Один withBrowser на весь прогон: tools/cdp.mjs хардкодит порт отладки, два
    // подряд гонятся за него (memory reference_barbershop-crm-tech)
    await withBrowser(async (s) => {
      // ── 4. Публичный сайт: слоты тем же кодом, что рисует их клиенту ─────────
      await s.navigate(`${siteUrl}/index.html`);
      await sleep(1500);
      const publicSlots = await s.eval(`(async () => {
        const { createStore, createHttpBackend } = await import('./storage.js');
        const store = createStore(createHttpBackend(window.ALIKHAN_API_URL));
        const slots = await store.getFreeSlots('${masterId}', '${DATE}', 60);
        return { count: slots.length, first: slots[0] ?? null, hasNight: slots.some((t) => t < '06:00'), sample: slots.slice(0, 4) };
      })()`, true);
      // Сегодня уже идёт - прошедшие ночные слоты виджет законно скрывает (getFreeSlots
      // отсекает время до «сейчас»), поэтому ночь проверяем на завтрашней дате
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const TOMORROW = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
      const tomorrowSlots = await s.eval(`(async () => {
        const { createStore, createHttpBackend } = await import('./storage.js');
        const store = createStore(createHttpBackend(window.ALIKHAN_API_URL));
        const slots = await store.getFreeSlots('${masterId}', '${TOMORROW}', 60);
        return { count: slots.length, first: slots[0] ?? null, last: slots.at(-1) ?? null, hasNight: slots.includes('02:00') };
      })()`, true);
      check('ГЛАВНОЕ: сайт предлагает ночные слоты по круглосуточному графику', tomorrowSlots?.hasNight === true, JSON.stringify(tomorrowSlots));
      check('первый слот суток - 00:00, последний - до полуночи', tomorrowSlots?.first === '00:00' && tomorrowSlots?.last === '22:45', JSON.stringify(tomorrowSlots));
      check('на сегодня сайт показывает только будущее время', publicSlots?.count > 0 && publicSlots?.first > '00:00', JSON.stringify(publicSlots));

      // ── 3. CRM «День»: шкала на все сутки, ночная карточка видна ─────────────
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await sleep(600);
      await s.type('#loginEmail', ownerEmail);
      await s.type('#loginPin', ownerPin);
      await s.click('#loginForm button[type=submit]');
      await sleep(9000); // первичная отрисовка кабинета целиком

      const dayOpen = await s.eval(`(() => {
        const d = document.getElementById('scheduleCard-day');
        if (d && !d.open) d.open = true;
        return Boolean(document.querySelector('.panel-sp-day .schedule-grid'));
      })()`);
      check('кабинет открыт, календарь «День» на месте', dayOpen === true, String(dayOpen));
      await sleep(1500);

      const scale = await s.eval(`(() => {
        const marks = [...document.querySelectorAll('.panel-sp-day .hour-marks span')].map((el) => el.textContent);
        const track = document.querySelector('.panel-sp-day .schedule-col[data-master-id="${masterId}"] .schedule-track');
        const appt = document.querySelector('.appt[data-id="${nightId}"]');
        const trackRect = track?.getBoundingClientRect();
        const apptRect = appt?.getBoundingClientRect();
        return {
          marks, first: marks[0], last: marks.at(-1),
          trackHeight: track ? Math.round(track.getBoundingClientRect().height) : null,
          colHeight: track ? Math.round(track.closest('.schedule-col').getBoundingClientRect().height) : null,
          apptTop: appt ? Math.round(parseFloat(appt.style.top)) : null,
          apptInsideTrack: Boolean(trackRect && apptRect && apptRect.top >= trackRect.top - 1 && apptRect.bottom <= trackRect.bottom + 1),
          apptVisible: Boolean(apptRect && apptRect.height > 0 && apptRect.width > 0),
        };
      })()`);
      check('ГЛАВНОЕ: шкала дня раздвинулась на все сутки (00:00…24:00)', scale?.first === '00:00' && scale?.last === '24:00', JSON.stringify(scale).slice(0, 220));
      check('подписей часов ровно 25 - ни один час не пропал', scale?.marks?.length === 25, String(scale?.marks?.length));
      check('высота трека = 24 часа по 64px', scale?.trackHeight === Math.round(1440 * PX_PER_MIN), String(scale?.trackHeight));
      check('ГЛАВНОЕ: ночная запись стоит на своём месте, а не выше нуля', scale?.apptTop === Math.round(120 * PX_PER_MIN), String(scale?.apptTop));
      check('ночная запись физически видна внутри трека', scale?.apptInsideTrack === true && scale?.apptVisible === true, JSON.stringify(scale).slice(0, 220));

      const offHours = await s.eval(`(() => {
        const cell = (id) => {
          const track = document.querySelector('.panel-sp-day .schedule-col[data-master-id="' + id + '"] .schedule-track');
          const blocks = [...(track?.querySelectorAll('.appt--offhours') ?? [])].map((b) => ({ top: Math.round(parseFloat(b.style.top)), height: Math.round(parseFloat(b.style.height)) }));
          return { blocks, count: blocks.length };
        };
        return { day: cell('${dayMasterId}'), night: cell('${masterId}') };
      })()`);
      // Дневной мастер: 00:00-10:00 (640px) сверху и 20:00-24:00 (256px) снизу
      check('ГЛАВНОЕ: у дневного мастера нерабочие часы залиты, а не выглядят рабочими', offHours?.day?.count === 2, JSON.stringify(offHours));
      check('заливка нерабочих часов совпадает с его сменой 10:00-20:00', offHours?.day?.blocks?.[0]?.top === 0 && offHours?.day?.blocks?.[0]?.height === 640 && offHours?.day?.blocks?.[1]?.top === 1280 && offHours?.day?.blocks?.[1]?.height === 256, JSON.stringify(offHours?.day));
      check('у круглосуточного мастера нерабочих часов нет вовсе', offHours?.night?.count === 0, JSON.stringify(offHours?.night));

      // ── 3a. Кабинет самого мастера: он и работает ночью, ему день важнее всех ──
      await s.navigate(`${siteUrl}/crm-master.html`);
      await sleep(600);
      await s.type('#loginEmail', masterEmail);
      await s.type('#loginPin', masterPin);
      await s.click('#loginForm button[type=submit]');
      await sleep(9000);
      const soloDay = await s.eval(`(() => {
        const d = document.getElementById('scheduleCard-day');
        if (d && !d.open) d.open = true;
        const marks = [...document.querySelectorAll('.panel-sp-day .hour-marks span')].map((el) => el.textContent);
        const track = document.querySelector('.panel-sp-day .schedule-track');
        const appt = document.querySelector('.appt[data-id="${nightId}"]');
        return {
          first: marks[0], last: marks.at(-1), count: marks.length,
          trackHeight: track ? Math.round(track.getBoundingClientRect().height) : null,
          apptTop: appt ? Math.round(parseFloat(appt.style.top)) : null,
        };
      })()`);
      await sleep(1500);
      const soloDayReady = await s.eval(`(() => {
        const marks = [...document.querySelectorAll('.panel-sp-day .hour-marks span')].map((el) => el.textContent);
        const track = document.querySelector('.panel-sp-day .schedule-track');
        const appt = document.querySelector('.appt[data-id="${nightId}"]');
        return {
          first: marks[0], last: marks.at(-1), count: marks.length,
          trackHeight: track ? Math.round(track.getBoundingClientRect().height) : null,
          apptTop: appt ? Math.round(parseFloat(appt.style.top)) : null,
        };
      })()`);
      check('ГЛАВНОЕ: мастер видит свои сутки в кабинете (00:00…24:00)', soloDayReady?.first === '00:00' && soloDayReady?.last === '24:00', JSON.stringify({ soloDay, soloDayReady }));
      check('и свою ночную запись на её месте', soloDayReady?.apptTop === Math.round(120 * PX_PER_MIN), JSON.stringify(soloDayReady));

      // ── 3b. Раздел «Команда»: сам запрос Влада - выбрать сутки руками в UI ───
      // Прежде чем проверять UI, возвращаем мастеру обычный график: иначе поля уже
      // показывали бы 00:00-23:59, выставленные по API, и клик ничего не доказывал бы
      await authed('/master-weekly-schedule', 'PUT', {
        masterId,
        weeklyChanges: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, isWorking: true, workStart: '10:00', workEnd: '20:00' })),
      });
      // Кабинет мастера остался залогиненным - его сессию надо снять, иначе владелец
      // не сможет войти на своей странице
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.eval(`localStorage.clear(); sessionStorage.clear(); true`);
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await sleep(800);
      await s.type('#loginEmail', ownerEmail);
      await s.type('#loginPin', ownerPin);
      await s.click('#loginForm button[type=submit]');
      await sleep(9000);
      const teamOpen = await s.eval(`(() => {
        document.querySelector('[data-nav-target="team"], [data-panel="team"], #navTeam')?.click();
        const card = document.querySelector('.staff-card[data-staff-id="${masterId}"]');
        if (card && !card.open) card.open = true;
        return Boolean(card);
      })()`);
      check('карточка мастера в «Команде» открыта', teamOpen === true, String(teamOpen));
      await sleep(2500);

      const options = await s.eval(`(() => {
        const wrap = document.getElementById('weekly-${masterId}-1-start');
        const opts = wrap ? [...wrap.querySelectorAll('.custom-select-option')].map((o) => o.dataset.value) : [];
        return { count: opts.length, first: opts[0], last: opts.at(-1), hasMidnight: opts.includes('00:00'), hasNight: opts.includes('03:30'), current: wrap?.dataset.value };
      })()`);
      check('ГЛАВНОЕ: в графике «Команды» время выбирается с 00:00 по 23:59', options?.first === '00:00' && options?.last === '23:59', JSON.stringify(options));
      check('доступны все четверти суток, включая ночные', options?.count === 97 && options?.hasNight === true, JSON.stringify(options));

      // Выставляем понедельнику круглосуточно РУКАМИ, как это делает Влад: открыть
      // список, ткнуть значение, нажать общую кнопку «Сохранить изменения» карточки
      const picked = await s.eval(`(() => {
        const pick = (id, value) => {
          const wrap = document.getElementById(id);
          const trigger = wrap?.querySelector('.custom-select-trigger');
          trigger?.click();
          const opt = [...wrap.querySelectorAll('.custom-select-option')].find((o) => o.dataset.value === value);
          opt?.click();
          return wrap?.dataset.value;
        };
        return { start: pick('weekly-${masterId}-1-start', '00:00'), end: pick('weekly-${masterId}-1-end', '23:59') };
      })()`);
      check('владелец выбрал 00:00 и 23:59 кликами в списке', picked?.start === '00:00' && picked?.end === '23:59', JSON.stringify(picked));

      const scrolled = await s.eval(`(() => {
        const wrap = document.getElementById('weekly-${masterId}-1-end');
        wrap.querySelector('.custom-select-trigger').click();
        const list = wrap.querySelector('.custom-select-list');
        const selected = list.querySelector('.custom-select-option.selected');
        const res = { scrollTop: Math.round(list.scrollTop), selectedTop: Math.round(selected.offsetTop), visible: selected.offsetTop >= list.scrollTop && selected.offsetTop <= list.scrollTop + list.clientHeight };
        wrap.querySelector('.custom-select-trigger').click();
        return res;
      })()`);
      check('список из 97 значений открывается на выбранном времени', scrolled?.visible === true, JSON.stringify(scrolled));

      await s.eval(`document.querySelector('.staff-card[data-staff-id="${masterId}"] [data-save]')?.click(); true`);
      await sleep(3000);
      const savedWeekly = await (await authed(`/master-weekly-schedule?masterId=${masterId}`, 'GET')).json();
      const savedMonday = (savedWeekly.weekly ?? savedWeekly).find?.((r) => r.weekday === 1);
      check('ГЛАВНОЕ: сохранение из «Команды» уехало на сервер как 00:00-23:59', savedMonday?.workStart === '00:00' && savedMonday?.workEnd === '23:59', JSON.stringify(savedMonday));

      // ── 5. Регресс: обычный график 10:00-20:00 = прежний вид дня ─────────────
      await authed('/bookings/' + nightId, 'PATCH', { status: 'cancelled' }).catch(() => {});
      await db.query('DELETE FROM booking_services WHERE booking_id = $1', [nightId]);
      await db.query('DELETE FROM bookings WHERE id = $1', [nightId]);
      await authed('/master-weekly-schedule', 'PUT', {
        masterId,
        weeklyChanges: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, isWorking: true, workStart: '10:00', workEnd: '20:00' })),
      });
      await s.eval(`document.querySelector('#refreshNow, [data-refresh-now]')?.click(); true`);
      await sleep(1200);
      await s.eval(`window.__reloadDay?.(); true`);
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await sleep(9000);
      await s.eval(`(() => { const d = document.getElementById('scheduleCard-day'); if (d && !d.open) d.open = true; return true; })()`);
      await sleep(1500);
      const usual = await s.eval(`(() => {
        const marks = [...document.querySelectorAll('.panel-sp-day .hour-marks span')].map((el) => el.textContent);
        const track = document.querySelector('.panel-sp-day .schedule-col[data-master-id="${masterId}"] .schedule-track');
        return {
          marks, first: marks[0], last: marks.at(-1),
          trackHeight: track ? Math.round(track.getBoundingClientRect().height) : null,
          colHeight: track ? Math.round(track.closest('.schedule-col').getBoundingClientRect().height) : null,
        };
      })()`);
      check('РЕГРЕСС: обычный график снова даёт шкалу 10:00-20:00', usual?.first === '10:00' && usual?.last === '20:00', JSON.stringify(usual).slice(0, 200));
      check('РЕГРЕСС: 11 подписей часов и трек 640px, как до правки', usual?.marks?.length === 11 && usual?.trackHeight === 640, JSON.stringify(usual).slice(0, 200));
      check('РЕГРЕСС: колонка снова 748px', usual?.colHeight === 748, String(usual?.colHeight));
      const usualOffHours = await s.eval(`document.querySelectorAll('.panel-sp-day .appt--offhours').length`);
      check('РЕГРЕСС: в обычном дне заливки нерабочих часов нет - вид как раньше', usualOffHours === 0, String(usualOffHours));

      // ── 7. Правило Влада: шкалу двигает ТОЛЬКО график, не записи ──────────────
      // Оба мастера уже вернулись на 10:00-20:00. Владелец записывает клиента на 02:00
      // (сервер персоналу это разрешает) - шкала обязана остаться 10:00-20:00, а сама
      // запись не потеряться: прижата к краю трека и помечена «вне графика»
      // Через API так записать нельзя - сервер сам отклоняет время вне смены
      // (createBookingTx, schedule_blocked), и это правильно. Но данные и график всё
      // равно могут разойтись: запись создана, пока мастер работал ночью, а график
      // потом изменили. Моделируем ровно это состояние прямой строкой в базе
      const blockedByServer = await authed('/bookings', 'POST', {
        masterId, serviceIds: ['strizhka'], date: DATE, startTime: '02:00',
        clientName: 'Клиент вне графика', clientPhone: '+79990000043',
      });
      const blockedBody = await blockedByServer.json();
      check('сервер сам не даёт записать клиента вне смены мастера', blockedBody?.ok === false || blockedByServer.status >= 400, `${blockedByServer.status} ${JSON.stringify(blockedBody).slice(0, 120)}`);

      const outsideId = 'vt-booking-outside';
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, service_id, date, start_time, end_time, status, channel)
         VALUES ($1, 1, $2, 'strizhka', $3, '02:00', '03:00', 'planned', 'crm')`,
        [outsideId, masterId, DATE]
      );
      await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'strizhka')`, [outsideId]);
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await sleep(9000);
      await s.eval(`(() => { const d = document.getElementById('scheduleCard-day'); if (d && !d.open) d.open = true; return true; })()`);
      await sleep(1500);
      const afterOutside = await s.eval(`(() => {
        const marks = [...document.querySelectorAll('.panel-sp-day .hour-marks span')].map((el) => el.textContent);
        const appt = document.querySelector('.appt[data-id="${outsideId}"]');
        const track = appt?.closest('.schedule-track');
        const trackRect = track?.getBoundingClientRect();
        const apptRect = appt?.getBoundingClientRect();
        return {
          first: marks[0], last: marks.at(-1), count: marks.length,
          exists: Boolean(appt),
          marked: Boolean(appt?.classList.contains('appt--outside')),
          top: appt ? Math.round(parseFloat(appt.style.top)) : null,
          inside: Boolean(trackRect && apptRect && apptRect.top >= trackRect.top - 1 && apptRect.bottom <= trackRect.bottom + 1),
        };
      })()`);
      check('ГЛАВНОЕ: запись вне графика НЕ раздвигает шкалу дня', afterOutside?.first === '10:00' && afterOutside?.last === '20:00' && afterOutside?.count === 11, JSON.stringify(afterOutside));
      check('и при этом не пропадает - прижата к краю трека', afterOutside?.exists === true && afterOutside?.top === 0 && afterOutside?.inside === true, JSON.stringify(afterOutside));
      check('и помечена как «вне графика», чтобы её не прочитали как запись на 10:00', afterOutside?.marked === true, JSON.stringify(afterOutside));
    });
  });
});

process.exit(summary() ? 0 : 1);
