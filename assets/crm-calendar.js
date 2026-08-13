// Окно 15 (02.08.2026) - календарь "День" был 100% статичной вёрсткой-примером
// (карточки .appt с data-client="Клиент А (пример)" прямо в HTML, никакого fetch) -
// баг Влада (найден живьём 02.08.2026): реальная бронь ("Гэндальф", Екатерина, 15:00)
// сохранялась на сервере (проверено напрямую через GET /bookings), но нигде не была
// видна ни Екатерине, ни Алиовсаду, потому что календарь эти данные вообще не читал.
// Контракт data-атрибутов ниже - строго тот же, что уже понимает openBooking()/
// updateCommission()/updateDuration() (assets/mockup-crm.js) - та логика не трогается.
const DAY_START_MIN = 600; // 10:00 - совпадает с шкалой .hour-marks во всех 3 файлах
const DAY_END_MIN = 1200; // 20:00
const PX_PER_MIN = 64 / 60; // 64px = 1 час

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function positionStyle(startTime, endTime) {
  const top = Math.round((toMinutes(startTime) - DAY_START_MIN) * PX_PER_MIN);
  // Задача G (Окно 53) - старый пол Math.max(24, ...) был произвольным числом без
  // расчёта (не привязан к реальным длительностям услуг) и сам вызывал наложение:
  // "Воск" 15 мин физически занимает 16px (15×64/60), но рисовался ВЫСОТОЙ 24px -
  // вплотную к следующей записи это те же лишние 8px наезда, что и у min-height в
  // mockup-crm.css (тот же баг, два независимых источника). 16px - тот же расчёт от
  // самой короткой активной услуги в прайсе Алихана (services, migration 002),
  // что и в CSS - карточка никогда не рисуется длиннее своего реального слота.
  const height = Math.max(16, Math.round((toMinutes(endTime) - toMinutes(startTime)) * PX_PER_MIN));
  return `top:${top}px;height:${height}px`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function initialsOf(name) {
  return String(name || '')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
}

// day_off по факту живой схемы (api/server.mjs: applyScheduleDay/getEffectiveSchedule) -
// НЕ "нет строки смены вообще" (это стандартные часы 10:00-20:00 без выходного), а
// перерыв, покрывающий весь рабочий день целиком (owner одобряет запрос на выходной,
// либо в master_weekly_schedule этот день недели отмечен нерабочим → сервер отдаёт
// ровно такой перерыв 10:00-20:00, см. getEffectiveSchedule). Проверено перед
// реализацией, не предположение из промпта.
function isDayOff(shift) {
  if (!shift?.breaks?.length) return false;
  return shift.breaks.some((b) => toMinutes(b.startTime) <= DAY_START_MIN && toMinutes(b.endTime) >= DAY_END_MIN);
}

function buildBreakCard(br) {
  return `<div class="appt appt--break" style="${positionStyle(br.startTime, br.endTime)}">Перерыв ${escapeHtml(br.startTime)}–${escapeHtml(br.endTime)}</div>`;
}

// Отменённые брони реально приходят от GET /bookings (сервер их не фильтрует -
// проверено живым запросом перед реализацией, не выдумано) - показываем приглушённым
// цветом, некликабельно (как перерыв), а не как обычную запись без соответствующей
// радио-кнопки статуса в bd-1 (там только Ожидание/Пришёл/Не пришёл, "Отменено" нет).
function buildCancelledCard(booking, label) {
  return `<div class="appt appt--cancelled" style="${positionStyle(booking.startTime, booking.endTime)}">
    <span class="t">${escapeHtml(booking.startTime)}–${escapeHtml(booking.endTime)}</span><span class="c">${escapeHtml(label)} · отменено</span>
  </div>`;
}

function serviceLabelFor(booking, services, priceOf) {
  const serviceIds = booking.serviceIds?.length ? booking.serviceIds : [booking.serviceId].filter(Boolean);
  const first = services.find((s) => s.id === serviceIds[0]);
  const firstName = first?.name ?? serviceIds[0] ?? 'Услуга';
  const totalPrice = serviceIds.reduce((sum, id) => sum + priceOf(booking.masterId, id), 0);
  const nameLabel = serviceIds.length > 1 ? `${firstName} +${serviceIds.length - 1}` : firstName;
  return { nameLabel, priceLabel: `${nameLabel} · ${totalPrice}₽` };
}

const STATUS_TO_DATA = { planned: 'wait', done: 'came', no_show: 'no' };

// Окно 43 (07.08.2026) - полоса слева по статусу (DoD промпта): зелёная = подтверждена
// (planned - активная бронь, ждём клиента), серая = завершена (done), красная = не
// пришёл (no_show). Отдельная модификатор-класс поверх существующих appt--done/
// appt--new (задают фон/полный бордер, Окно 15) - границы слева переопределяются ПОСЛЕ
// них в mockup-crm.css, сам фон/остальные стороны рамки не трогаем.
const STATUS_STRIPE_CLASS = { planned: 'appt--status-planned', done: 'appt--status-done', no_show: 'appt--status-noshow' };

function buildApptCard(booking, { masterName, services, priceOf }) {
  const clientName = booking.clientName || 'Без имени';
  if (booking.status === 'cancelled') return buildCancelledCard(booking, clientName);

  const { nameLabel, priceLabel } = serviceLabelFor(booking, services, priceOf);
  const planned = `${booking.startTime}–${booking.endTime}`;
  const dataStatus = STATUS_TO_DATA[booking.status] ?? 'wait';
  const cssClass = booking.status === 'done' ? 'appt--done' : 'appt--new';
  const stripeClass = STATUS_STRIPE_CLASS[booking.status] ?? '';
  const isNoShow = booking.status === 'no_show';
  const warn = isNoShow ? '<span class="appt-warn">⚠</span>' : '';
  // Задача G (Окно 53) - ниже этого порога 2 строки (.t + .c) физически не влезают
  // в min-height 34px (тот расчёт, которым это число и было выбрано) - на коротких
  // услугах (напр. "Воск" 15 мин) карточка теперь честно занимает свою реальную
  // высоту (min-height снижен в mockup-crm.css), .c скрывается, чтобы не обрезаться
  // криво, полная строка "клиент · услуга" возвращается на hover (.appt--compact:hover).
  const durationMin = toMinutes(booking.endTime) - toMinutes(booking.startTime);
  const compactClass = durationMin < 32 ? ' appt--compact' : '';

  // Правка 03.08.2026: data-id раньше не передавался вообще - openBooking() не
  // имела способа узнать РЕАЛЬНЫЙ id брони, чтобы что-то сохранить обратно (кнопка
  // "Клиент пришёл" была декорацией именно из-за этого пробела, не только из-за
  // отсутствия fetch). data-noshow-streak/data-requires-prepayment - тот же уровень
  // видимости, что уже есть у остальных client-полей (owner/admin, не master).
  // data-master-id/data-service-ids (08.08.2026, "Добавить услугу к записи",
  // assets/crm-booking-status.js wireBookingServiceEdit) - booking.masterId и полный
  // список booking.serviceIds уже приходят с /bookings (listBookingsForRequest),
  // кладём их прямо на карточку тем же приёмом, что уже есть у data-id - без этого
  // openBooking() пришлось бы делать отдельный fetch за той же самой брони.
  // Окно 55, Задача C (10.08.2026) - клик по записи открывает ОБЩУЮ форму в режиме
  // редактирования (window.openBookingEdit, assets/crm-walkin.js) вместо старой
  // карточки-просмотра #bd-1 (window.openBooking, assets/mockup-crm.js). Фолбэк на
  // openBooking нужен для crm-master.html: там формы записи нет вообще (мастер записи
  // не создаёт и не переносит - решение Влада 08.08.2026, подтверждено бэкендом:
  // requireRole owner/admin у /reschedule), поэтому старая карточка остаётся его
  // рабочим интерфейсом просмотра и смены статуса.
  // data-date/data-start-time (в дополнение к прежнему data-planned "10:00–10:40",
  // который остаётся ради openBooking/updateNoShowUi и заголовка карточки) - режиму
  // edit нужны РАЗДЕЛЬНЫЕ машинные значения: дата уходит в PATCH /reschedule как есть,
  // а разбирать её обратно из человеческой строки с en-dash было бы лишним шагом.
  return `<div class="appt ${cssClass} ${stripeClass}${compactClass}" style="${positionStyle(booking.startTime, booking.endTime)}" tabindex="0" onclick="(window.openBookingEdit||window.openBooking)(this)"
       data-id="${escapeHtml(booking.id)}" data-client="${escapeHtml(clientName)}" data-phone="${escapeHtml(booking.clientPhone || '')}" data-master="${escapeHtml(masterName)}"
       data-master-id="${escapeHtml(booking.masterId || '')}" data-service-ids="${escapeHtml((booking.serviceIds || []).join(','))}"
       data-service="${escapeHtml(priceLabel)}" data-planned="${escapeHtml(planned)}"
       data-date="${escapeHtml(booking.date || '')}" data-start-time="${escapeHtml(booking.startTime)}"
       data-status="${dataStatus}" data-real-status="${escapeHtml(booking.status)}" data-confirmed="${booking.clientConfirmed ? 'true' : 'false'}" data-noshow="${isNoShow ? 'true' : 'false'}"
       data-noshow-streak="${booking.clientNoShowStreak ?? 0}" data-requires-prepayment="${booking.requiresPrepayment ? 'true' : 'false'}"
       data-actual-price="${booking.actualPrice ?? ''}" data-staff-comment="${escapeHtml(booking.staffComment || '')}">
    <span class="t">${escapeHtml(planned)}</span><span class="c">${warn}${escapeHtml(clientName)} · ${escapeHtml(nameLabel)}</span>
  </div>`;
}

// Окно 43 (07.08.2026) - минуты → "HH:MM", обратная функция к toMinutes выше (клик
// по пустому месту трека переводит пиксель клика в реальное время слота).
function minutesToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Шаг слота при клике - тот же 15-минутный шаг, что уже использует SHOP_TIME_OPTIONS
// (assets/crm-widgets.js) для ручного выбора времени - клик по календарю не должен
// предлагать время, которого нет в самом виджете времени формы записи.
const SLOT_STEP_MIN = 15;
// Замечание Влада 09.08.2026 - пунктирный превью-слот на скриншоте показался слишком
// маленьким. Внутри превью нет текста (см. комментарий .appt--slot-preview в CSS) и
// клик по нему открывает обычную форму записи, где время/длительность выбираются
// заново виджетами - высота превью НЕ обязана буквально совпадать с 15-минутным шагом
// снаппинга (это только шаг привязки стартовой позиции по Y), можно сделать чисто
// декоративно крупнее без риска наложения на соседние реальные записи (в отличие от
// .appt, где высота = реальная длительность брони, см. Задачу G).
const SLOT_PREVIEW_HEIGHT_PX = 28;

function snapToSlot(min) {
  const snapped = Math.round(min / SLOT_STEP_MIN) * SLOT_STEP_MIN;
  return Math.min(DAY_END_MIN - SLOT_STEP_MIN, Math.max(DAY_START_MIN, snapped));
}

function minutesFromClientY(trackEl, clientY) {
  const rect = trackEl.getBoundingClientRect();
  const offsetMin = (clientY - rect.top) / PX_PER_MIN;
  return DAY_START_MIN + offsetMin;
}

// Окно 43 - "пунктирный слот на свободном месте": один превью-элемент на трек,
// следует за курсором (mousemove), скрыт вне трека (mouseleave) и над реальными
// appt-карточками (клик/ховер внутри .appt их не задевает - обработчики ниже
// проверяют e.target.closest('.appt') ДО показа/клика по превью). Клик открывает
// существующую форму записи (window.openSlotBooking, assets/crm-walkin.js) с
// предзаполненными датой/временем/мастером - "как есть", просто с предзаполнением
// (промпт, "Что НЕ входит": боковая панель записи - Окно 45, не этот функционал.
// Неактивно, если на странице нет формы записи в режиме будущей брони (crm-admin.html/
// crm-master.html пока без wfDateTimeRow, см. assets/crm-walkin.js) - optional chaining
// как и у остальных cross-module мостов проекта (window.updateNotifBadge?.() и т.п.).
function wireEmptySlotInteraction(trackEl, master, date) {
  // Задача F (Окно 53, 09.08.2026) - правка 08.08.2026 ниже (`if (date < todayStr())
  // return`) блокировала именно то, что Влад в тот же вечер разворачивал в другом
  // месте (crm-walkin.js: убран minDate у date-picker'а, "зачем тумблер, если можно
  // просто дать записать как обычно") - эта строка осталась незамеченным хвостом
  // того же запрета, найдена живым grep'ом по todayStr()/"date <" при работе над
  // Задачей F. Убрана: бэкенд уже разрешает прошедшее время для персонала
  // (createBookingTx - `if (isPast && !isStaff)`, api/routes/bookings.js) - клиент
  // не должен запрещать то, что сервер уже пропускает.
  const preview = document.createElement('div');
  preview.className = 'appt appt--slot-preview';
  preview.hidden = true;
  trackEl.appendChild(preview);

  function slotAt(clientY) {
    return snapToSlot(Math.round(minutesFromClientY(trackEl, clientY)));
  }

  trackEl.addEventListener('mousemove', (e) => {
    if (typeof window.openSlotBooking !== 'function') return;
    if (e.target.closest('.appt:not(.appt--slot-preview)')) {
      preview.hidden = true;
      return;
    }
    const startMin = slotAt(e.clientY);
    const top = Math.round((startMin - DAY_START_MIN) * PX_PER_MIN);
    preview.style.cssText = `top:${top}px;height:${SLOT_PREVIEW_HEIGHT_PX}px`;
    preview.hidden = false;
  });
  trackEl.addEventListener('mouseleave', () => {
    preview.hidden = true;
  });
  trackEl.addEventListener('click', (e) => {
    if (typeof window.openSlotBooking !== 'function') return;
    if (e.target.closest('.appt:not(.appt--slot-preview)')) return; // реальная запись/перерыв - свой обработчик (openBooking)
    const startMin = slotAt(e.clientY);
    window.openSlotBooking(master.id, master.name, date, minutesToHHMM(startMin));
  });
}

function fillTrack(trackEl, master, { shift, bookings, services, priceOf, date }) {
  const masterName = master.name;

  // Окно 43 (07.08.2026) - "мастер без графика" (GET /staff hasWorkingSchedule=false,
  // owner видит масте­ров без единой строки в master_weekly_schedule - Окно 22) - без
  // этой ветки getEffectiveSchedule молча подставляет глобальный дефолт 10:00-20:00
  // (см. api/lib/schedule-core.js), и календарь ЛОЖНО показывал бы такого мастера
  // полностью свободным весь день, хотя реально записать его нельзя (createBookingTx
  // отклонит 409 master_not_bookable). Строго === false (не просто falsy) - для ролей,
  // где сервер это поле вообще не считает (admin/master/solo), поведение не меняется.
  if (master.hasWorkingSchedule === false) {
    trackEl.classList.remove('day-off');
    trackEl.classList.add('no-schedule');
    trackEl.innerHTML = '<span class="day-off-label">Нет графика - клиенты не могут записаться</span>';
    return;
  }
  trackEl.classList.remove('no-schedule');

  if (isDayOff(shift)) {
    trackEl.classList.add('day-off');
    trackEl.innerHTML = '<span class="day-off-label">Выходной</span>';
    return;
  }
  trackEl.classList.remove('day-off');
  const parts = [];
  (shift?.breaks ?? []).forEach((b) => parts.push(buildBreakCard(b)));
  bookings.forEach((b) => parts.push(buildApptCard(b, { masterName, services, priceOf })));
  trackEl.innerHTML = parts.join('');
  wireEmptySlotInteraction(trackEl, master, date);
}

function buildColumnHtml(master) {
  return `<div class="schedule-col">
    <div class="schedule-col-head"><div class="avatar">${escapeHtml(initialsOf(master.name))}</div><span class="name">${escapeHtml(master.name)}</span></div>
    <div class="schedule-track"></div>
  </div>`;
}

// Окно 43 - горизонтальная линия "сейчас": видна только когда открыт РЕАЛЬНО
// сегодняшний день и текущее время внутри рабочего окна разметки (10:00-20:00,
// DAY_START_MIN/DAY_END_MIN выше - та же шкала, что и у .hour-marks во всех 3 файлах).
// Один элемент на всю строку (.schedule-row-with-gutter - общий родитель hour-gutter +
// schedule-grid, см. crm-owner.html/crm-admin.html/crm-master.html - разметка
// идентична на всех трёх), не по одному на колонку - так проще держать её ровно на
// одной высоте относительно часовой шкалы слева.
let nowLineTimer = null;
function renderNowLine(date) {
  const row = document.querySelector('.panel-sp-day .schedule-row-with-gutter');
  if (!row) return;
  let line = row.querySelector(':scope > .now-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'now-line';
    row.appendChild(line);
  }
  const isToday = date === todayStr();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const inRange = isToday && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN;
  line.hidden = !inRange;
  if (inRange) {
    // Правка 08.08.2026 (жалоба Влада - красная линия перечёркивала имена мастеров):
    // top считался от верхнего края .schedule-row-with-gutter, а этот родитель
    // включает и шапку колонки (аватар+имя), не только сам часовой трек - top:0
    // физически попадал на шапку, а не на отметку 10:00. Трек начинается ниже шапки
    // на её реальную высоту - меряем её живьём через тот же приём, что уже использует
    // minutesFromClientY(trackEl, clientY) выше для клика по треку, не хардкодим px
    // (высота шапки зависит от .avatar/.name, трогать которые могут другие правки).
    const track = row.querySelector('.schedule-track');
    const headerOffset = track ? Math.round(track.getBoundingClientRect().top - row.getBoundingClientRect().top) : 0;
    line.style.top = `${headerOffset + Math.round((nowMin - DAY_START_MIN) * PX_PER_MIN)}px`;
  }

  // Пересчёт раз в минуту, пока открыт вид "День" - без этого линия застывает на
  // времени первого рендера, если владелец просто оставил вкладку открытой. Один
  // общий таймер (не по одному на каждый renderDayCalendar) - повторный вызов сначала
  // чистит предыдущий.
  clearInterval(nowLineTimer);
  nowLineTimer = setInterval(() => renderNowLine(date), 60 * 1000);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// staff/staffList/services/masterServices/bookings/priceOf уже загружены и посчитаны
// в renderLiveProof (assets/crm-auth.js) на момент вызова - переиспользуем, чтобы не
// дублировать fetch. /schedule renderLiveProof не запрашивает - тянем сами здесь.
// Правка 03.08.2026 (Окно 16): раньше один broad-запрос /schedule (без даты) видел
// ТОЛЬКО явные разовые правки (schedule_shifts) - мастер с нестандартным недельным
// графиком (master_weekly_schedule) без явной правки на сегодня показывался как
// полностью свободный весь день 10:00-20:00, хотя реально работает в другом окне
// или сегодня у него выходной. Узкий запрос /schedule?masterId=&date= уже отдаёт
// эффективный график (getEffectiveSchedule на сервере) даже без явной правки - тот
// же контракт, что уже использует публичный виджет записи - берём его по каждому
// мастеру отдельно (запросов мало, мастеров 2-3).
//
// Окно 18 (04.08.2026, Задача 1) - date теперь параметр, не константа todayStr():
// навигация по датам (стрелки/date-picker, assets/crm-schedule-views.js) вызывает
// эту же функцию с bookings, уже загруженными вызывающим кодом за НУЖНУЮ дату -
// сама функция по-прежнему ничего не знает о навигации, только рисует готовые данные.
// Ранее статичная разметка на crm-admin.html держала только 2 из 3 колонок
// (Екатерины не было вовсе) - проверено живым запросом /staff под ролью admin перед
// реализацией: Мамедхан реально видит всех троих, поэтому колонки/панели везде
// строим по факту ответа /staff, а не по количеству узлов, которые были в макете.
// Экспортирована (Окно 18) - Неделя/Месяц (assets/crm-schedule-views.js) строят
// переключатель мастера по тому же списку, что и "Мой день", а не своему.
// Порядок колонок дня (и переключателя мастера в Неделе/Месяце) = порядок, в котором
// сотрудники пришли с сервера, то есть по времени появления в салоне: слева самые
// давние, справа новые (Влад, 13.08.2026). Раньше здесь стояла сортировка по id -
// она была осмысленной, пока id проставлялись руками (master-1, master-2, master-3),
// но аккаунты из интерфейса получают случайный staff-<hex>, и такой порядок стал
// произвольным. Сортировка теперь одна на всё приложение и живёт в SQL (GET /staff,
// ORDER BY created_at, id) - фильтр её сохраняет.
export function mastersOf(staffList) {
  return staffList.filter((s) => s.providesServices && s.hasWorkingSchedule !== false);
}

export async function renderDayCalendar({ staff, staffList, services, priceOf, bookings, fetchJson, date }) {
  const today = date || todayStr();
  const soloTrack = document.querySelector('.panel-sp-day .schedule-grid .schedule-col .schedule-track');
  const grid = document.querySelector('.panel-sp-day .schedule-grid');
  if (!grid) return; // страница без дневного календаря (не должно случиться, но не падаем)

  const isSolo = staff.role === 'master';
  // crm-owner.html/crm-admin.html - несколько колонок, одна на каждого реального
  // мастера, видимого этой роли (staffList уже отфильтрован сервером по роли).
  const masters = isSolo ? [staff] : mastersOf(staffList);

  const shiftByMaster = new Map();
  await Promise.all(
    masters.map(async (m) => {
      try {
        const shifts = await fetchJson(`/schedule?masterId=${m.id}&date=${today}`);
        const shift = shifts.find((s) => s.date === today);
        if (shift) shiftByMaster.set(m.id, shift);
      } catch {
        // нет графика - трек считается свободным весь стандартный день, как раньше
      }
    })
  );

  const bookingsByMaster = new Map();
  for (const b of bookings ?? []) {
    if (!bookingsByMaster.has(b.masterId)) bookingsByMaster.set(b.masterId, []);
    bookingsByMaster.get(b.masterId).push(b);
  }

  if (isSolo) {
    // crm-master.html - единственная колонка, всегда сам залогиненный
    if (soloTrack) {
      fillTrack(soloTrack, staff, {
        shift: shiftByMaster.get(staff.id),
        bookings: bookingsByMaster.get(staff.id) ?? [],
        services,
        priceOf,
        date: today,
      });
    }
    renderNowLine(today);
    return;
  }

  grid.innerHTML = masters.map(buildColumnHtml).join('');
  const cols = grid.querySelectorAll(':scope > .schedule-col');
  masters.forEach((m, i) => {
    const track = cols[i]?.querySelector('.schedule-track');
    if (!track) return;
    fillTrack(track, m, {
      shift: shiftByMaster.get(m.id),
      bookings: bookingsByMaster.get(m.id) ?? [],
      services,
      priceOf,
      date: today,
    });
  });
  renderNowLine(today);
}
