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

import { avatarMarkup } from './crm-avatar.js';
import { sortByServiceOrder } from '../storage.js';

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
  const rawServiceIds = booking.serviceIds?.length ? booking.serviceIds : [booking.serviceId].filter(Boolean);
  // Единый порядок показа услуг (storage.js SERVICE_ORDER): в карточке видно только
  // первую услугу ("Стрижка +1"), значит от порядка зависит, какую мастер прочитает
  const serviceIds = sortByServiceOrder(rawServiceIds, (id) => id);
  const first = services.find((s) => s.id === serviceIds[0]);
  const firstName = first?.name ?? serviceIds[0] ?? 'Услуга';
  const totalPrice = serviceIds.reduce((sum, id) => sum + priceOf(booking.masterId, id), 0);
  const nameLabel = serviceIds.length > 1 ? `${firstName} +${serviceIds.length - 1}` : firstName;
  return { nameLabel, priceLabel: `${nameLabel} · ${totalPrice}₽` };
}

const STATUS_TO_DATA = { planned: 'wait', done: 'came', no_show: 'no' };

// Полоса слева по статусу. Правка 13.08.2026 (Влад): раньше зелёной полосой
// помечалась ОЖИДАЕМАЯ запись, а выполненная - серой, то есть цвет говорил о
// подтверждении брони, а не об исходе визита. Логика перевёрнута на ту, которую
// человек и ожидает: ожидание - нейтральное (ничего ещё не случилось), пришёл -
// зелёный, не пришёл - красный. Классы-модификаторы лежат поверх appt--done/
// appt--noshow/appt--new (фон и рамка, Окно 15 + правка 13.08.2026).
const STATUS_STRIPE_CLASS = { planned: 'appt--status-planned', done: 'appt--status-done', no_show: 'appt--status-noshow' };

function buildApptCard(booking, { masterName, services, priceOf }) {
  const clientName = booking.clientName || 'Без имени';
  if (booking.status === 'cancelled') return buildCancelledCard(booking, clientName);

  const { nameLabel, priceLabel } = serviceLabelFor(booking, services, priceOf);
  const planned = `${booking.startTime}–${booking.endTime}`;
  const dataStatus = STATUS_TO_DATA[booking.status] ?? 'wait';
  // Правка 13.08.2026 (Влад: "если не пришёл - запись в календаре красная") - до
  // этого неявка красилась КАК ОЖИДАНИЕ (в else попадали и planned, и no_show), и
  // отличалась только полоской в 4px слева да значком ⚠: в дне на глаз неявку было
  // не отличить от обычной записи.
  const cssClass = booking.status === 'done' ? 'appt--done'
    : booking.status === 'no_show' ? 'appt--noshow'
    : 'appt--new';
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
// Правка Влада 15.08.2026 («увеличить пунктирное окно, сделать выше»): 28px читались
// узкой полоской. 44px - тот же минимальный размер цели, что и у кнопок CRM
const SLOT_PREVIEW_HEIGHT_PX = 44;

// Округление ВНИЗ, а не к ближайшему делению - вторая половина той же правки
// («сделать так, чтобы она была под курсором и не уплывала от него»). При округлении
// к ближайшему время под курсором 10:08 превращалось в 10:15, рамка вставала на 8px
// НИЖЕ курсора и выглядела оторвавшейся - Влад прислал рисунок со стрелкой над
// рамкой. Вниз: начало слота - ближайшее деление не позже курсора, поэтому верхний
// край рамки всегда на уровне курсора или выше, а сам курсор внутри рамки (шаг 15
// минут это 16px по шкале 64px/час, высота рамки 44px - курсор попадает внутрь при
// любом положении). Клик берёт время той же функцией, значит выбирается ровно то
// время, которое человек видит в рамке
function snapToSlot(min) {
  const snapped = Math.floor(min / SLOT_STEP_MIN) * SLOT_STEP_MIN;
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
  // Подпись времени внутри рамки (16.08.2026). Нужна ТОЛЬКО на касании: на компьютере
  // рамка ходит за курсором непрерывно и время читается по часовой шкале слева, а
  // палец рамку собой закрывает - к моменту, когда её видно, палец уже поднят, и без
  // подписи непонятно, на какое время ты попал. Жалоба Влада: "вообще не понятно, как
  // это использовать на телефоне".
  const previewLabel = document.createElement('span');
  previewLabel.className = 'slot-preview-time';
  preview.appendChild(previewLabel);
  trackEl.appendChild(preview);

  function slotAt(clientY) {
    return snapToSlot(Math.round(minutesFromClientY(trackEl, clientY)));
  }

  // Общая для мыши и пальца отрисовка рамки. Возвращает время слота, чтобы вызывающий
  // не считал его второй раз (иначе легко получить рамку на одном слоте и запись на
  // другом, если между вызовами что-то сдвинулось).
  function showPreview(clientY, withLabel) {
    const startMin = slotAt(clientY);
    // Рамка стала выше, поэтому у самого низа дня она вылезала бы за конец колонки -
    // на последних слотах прижимаем её к нижнему краю трека
    const trackHeight = trackEl.clientHeight || Math.round((DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN);
    const rawTop = Math.round((startMin - DAY_START_MIN) * PX_PER_MIN);
    const top = Math.max(0, Math.min(rawTop, trackHeight - SLOT_PREVIEW_HEIGHT_PX));
    preview.style.cssText = `top:${top}px;height:${SLOT_PREVIEW_HEIGHT_PX}px`;
    previewLabel.textContent = withLabel ? minutesToHHMM(startMin) : '';
    preview.classList.toggle('appt--slot-preview-touch', Boolean(withLabel));
    preview.hidden = false;
    return startMin;
  }

  trackEl.addEventListener('mousemove', (e) => {
    if (typeof window.openSlotBooking !== 'function') return;
    if (e.target.closest('.appt:not(.appt--slot-preview)')) {
      preview.hidden = true;
      return;
    }
    showPreview(e.clientY, false);
  });
  trackEl.addEventListener('mouseleave', () => {
    preview.hidden = true;
  });

  // Касание: рамка со временем появляется в момент нажатия, ДО открытия формы -
  // палец видит, куда попал, и это же объясняет сам механизм ("по пустому месту можно
  // нажать"). Форму открывает обычный click ниже, он приходит следом за этим
  // событием - отдельного открытия здесь нет, иначе форма открывалась бы дважды.
  //
  // Отличаем палец от мыши по НАЛИЧИЮ КУРСОРА У УСТРОЙСТВА, а не по e.pointerType.
  // Первая версия проверяла именно pointerType, и живой прогон показал, почему так
  // нельзя: синтетический клик из CDP приходит как pointerType="mouse" даже при
  // включённой эмуляции касаний (замерено - `pointerdown pointerType=mouse` на
  // мобильном вьюпорте), то есть поведение на телефоне в принципе не проверяемо
  // тестом, и любой будущий регресс здесь прошёл бы мимо. matchMedia('(hover: hover)')
  // при этом честно даёт false в мобильной эмуляции и true на десктопе.
  // По смыслу так тоже правильнее: рамка-под-курсором нужна ровно тем, у кого есть
  // курсор, а не тем, у кого конкретное событие пришло с определённым типом.
  const hasHoverPointer = () => window.matchMedia?.('(hover: hover)')?.matches === true;
  trackEl.addEventListener('pointerdown', (e) => {
    if (hasHoverPointer()) return; // у мыши своя непрерывная рамка на mousemove
    if (typeof window.openSlotBooking !== 'function') return;
    if (e.target.closest('.appt:not(.appt--slot-preview)')) return;
    showPreview(e.clientY, true);
  });

  trackEl.addEventListener('click', (e) => {
    if (typeof window.openSlotBooking !== 'function') return;
    if (e.target.closest('.appt:not(.appt--slot-preview)')) return; // реальная запись/перерыв - свой обработчик (openBooking)
    const startMin = slotAt(e.clientY);
    // Рамка гасится сразу при открытии формы: иначе на телефоне она осталась бы
    // висеть под формой и после её закрытия выглядела бы как уже созданная запись.
    preview.hidden = true;
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

// data-master-id на колонке (17.08.2026) - раньше колонку можно было найти только по
// её порядковому номеру в гриде (renderDayCalendar знает индекс, потому что сам их и
// построил). Для точечной вставки одной записи (upsertDayBooking ниже) этого мало:
// туда приходит booking.masterId и никакого индекса, а порядок колонок задаёт сервер.
function buildColumnHtml(master) {
  return `<div class="schedule-col" data-master-id="${escapeHtml(master.id)}">
    <div class="schedule-col-head">${avatarMarkup(master, { initials: initialsOf(master.name) })}<span class="name">${escapeHtml(master.name)}</span></div>
    <div class="schedule-track"></div>
  </div>`;
}

// ── Точечное появление одной записи в «Дне» ──────────────────────────────────
// 17.08.2026, задача Влада: «нужно мгновенное появление новой записи в календаре»,
// «не нужно, чтобы ВЕСЬ кабинет обновлялся».
//
// renderDayCalendar перестраивает грид целиком (grid.innerHTML = ...) и по дороге
// делает 2+N сетевых запросов: /staff, /bookings и /schedule на каждого мастера. Для
// одной новой записи это и медленно, и заметно глазу - день моргает, а всё, что
// человек в нём успел раскрыть или проскроллить, сбрасывается. Здесь вставляется
// ровно одна карточка в трек своего мастера, остальной DOM не трогается вообще.
//
// Возвращает true, только если карточка реально оказалась в календаре - вызывающий
// (assets/crm-live.js) по false понимает, что точечным путём не обошлось, и делает
// обычную полную перерисовку. Ложное true здесь опаснее ошибки: оно означало бы, что
// запись создана, полная перерисовка пропущена, а в календаре пусто.
export function upsertDayBooking(booking, { staff, staffList, services, priceOf, date }) {
  if (!booking?.id || !booking.masterId || !booking.startTime || !booking.endTime) return false;
  // Открыт другой день - вставлять некуда, и это нормальный, а не ошибочный исход
  if (booking.date && date && booking.date !== date) return false;

  const isSolo = staff.role === 'master';
  // Мастер видит только свою колонку: чужая запись в его «Дне» не рисуется вовсе
  if (isSolo && booking.masterId !== staff.id) return false;

  const track = isSolo
    ? document.querySelector('.panel-sp-day .schedule-grid .schedule-col .schedule-track')
    : document.querySelector(`.panel-sp-day .schedule-grid .schedule-col[data-master-id="${CSS.escape(booking.masterId)}"] .schedule-track`);
  if (!track) return false;

  // «Выходной»/«Нет графика» - трек держит не карточки, а одну подпись-заглушку.
  // Запись на такой день физически возможна (владелец закрыл день уже после того,
  // как клиент записался), но дорисовывать её к заглушке нельзя - геометрия трека
  // считается от рабочих часов. Отдаём false, дальше сработает полная перерисовка.
  if (track.classList.contains('day-off') || track.classList.contains('no-schedule')) return false;

  const masterName = isSolo
    ? staff.name
    : (staffList.find((m) => m.id === booking.masterId)?.name ?? '');
  const html = buildApptCard(booking, { masterName, services, priceOf });

  // Та же запись уже нарисована - значит это не новая, а изменившаяся (перенос,
  // статус, состав услуг): заменяем карточку на месте, не плодим вторую
  const existing = track.querySelector(`.appt[data-id="${CSS.escape(booking.id)}"]`);
  if (existing) {
    existing.outerHTML = html;
    return true;
  }

  // Рамка-превью пустого слота (wireEmptySlotInteraction) живёт последним ребёнком
  // трека и должна им остаться - вставляем перед ней, а не в конец
  const preview = track.querySelector('.appt--slot-preview');
  if (preview) preview.insertAdjacentHTML('beforebegin', html);
  else track.insertAdjacentHTML('beforeend', html);

  // Короткая подсветка - человек нажал «Сохранить» и должен увидеть, ЧТО именно
  // появилось, особенно когда запись создал не он, а клиент с сайта
  const added = track.querySelector(`.appt[data-id="${CSS.escape(booking.id)}"]`);
  added?.classList.add('appt--just-added');
  return Boolean(added);
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

// Состав сотрудников для расписания снимается ОДИН раз при входе (замыкание
// wireScheduleViews, assets/crm-schedule-views.js) - поэтому загруженное фото профиля
// не появлялось в колонках «Дня» ни само, ни по кнопке «Обновить»: перечитывались
// брони и график, а карточка сотрудника оставалась той, что приехала при входе
// (Влад, 15.08.2026 - «загруженная фотка не обновилась во вкладке День»). Перед
// отрисовкой перечитываем состав и берём из него имя и фото. КТО показан в дне
// по-прежнему решает переданный staffList - список колонок не меняем
async function freshStaffById(fetchJson) {
  try {
    const rows = await fetchJson('/staff');
    return new Map(rows.map((row) => [row.id, row]));
  } catch {
    // сеть отвалилась - рисуем тем, что уже есть, день важнее свежести аватара
    return new Map();
  }
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

  const fresh = await freshStaffById(fetchJson);
  const shownMasters = masters.map((m) => fresh.get(m.id) ?? m);
  grid.innerHTML = shownMasters.map(buildColumnHtml).join('');
  const cols = grid.querySelectorAll(':scope > .schedule-col');
  shownMasters.forEach((m, i) => {
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
