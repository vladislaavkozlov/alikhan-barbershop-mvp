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
  const height = Math.max(24, Math.round((toMinutes(endTime) - toMinutes(startTime)) * PX_PER_MIN));
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

function buildApptCard(booking, { masterName, services, priceOf }) {
  const clientName = booking.clientName || 'Без имени';
  if (booking.status === 'cancelled') return buildCancelledCard(booking, clientName);

  const { nameLabel, priceLabel } = serviceLabelFor(booking, services, priceOf);
  const planned = `${booking.startTime}–${booking.endTime}`;
  const dataStatus = STATUS_TO_DATA[booking.status] ?? 'wait';
  const cssClass = booking.status === 'done' ? 'appt--done' : 'appt--new';
  const isNoShow = booking.status === 'no_show';
  const warn = isNoShow ? '<span class="appt-warn">⚠</span>' : '';

  // Правка 03.08.2026: data-id раньше не передавался вообще - openBooking() не
  // имела способа узнать РЕАЛЬНЫЙ id брони, чтобы что-то сохранить обратно (кнопка
  // "Клиент пришёл" была декорацией именно из-за этого пробела, не только из-за
  // отсутствия fetch). data-noshow-streak/data-requires-prepayment - тот же уровень
  // видимости, что уже есть у остальных client-полей (owner/admin, не master).
  return `<div class="appt ${cssClass}" style="${positionStyle(booking.startTime, booking.endTime)}" tabindex="0" onclick="openBooking(this)"
       data-id="${escapeHtml(booking.id)}" data-client="${escapeHtml(clientName)}" data-phone="${escapeHtml(booking.clientPhone || '')}" data-master="${escapeHtml(masterName)}"
       data-service="${escapeHtml(priceLabel)}" data-planned="${escapeHtml(planned)}"
       data-status="${dataStatus}" data-real-status="${escapeHtml(booking.status)}" data-confirmed="${booking.clientConfirmed ? 'true' : 'false'}" data-noshow="${isNoShow ? 'true' : 'false'}"
       data-noshow-streak="${booking.clientNoShowStreak ?? 0}" data-requires-prepayment="${booking.requiresPrepayment ? 'true' : 'false'}">
    <span class="t">${escapeHtml(planned)}</span><span class="c">${warn}${escapeHtml(clientName)} · ${escapeHtml(nameLabel)}</span>
  </div>`;
}

function fillTrack(trackEl, masterName, { shift, bookings, services, priceOf }) {
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
}

function buildColumnHtml(master) {
  return `<div class="schedule-col">
    <div class="schedule-col-head"><div class="avatar">${escapeHtml(initialsOf(master.name))}</div><span class="name">${escapeHtml(master.name)}</span></div>
    <div class="schedule-track"></div>
  </div>`;
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
export function mastersOf(staffList) {
  return staffList.filter((s) => s.providesServices).sort((a, b) => a.id.localeCompare(b.id));
}

export async function renderDayCalendar({ staff, staffList, services, priceOf, bookings, fetchJson, date }) {
  const today = date || todayStr();
  const soloTrack = document.querySelector('.panel-sp-day .schedule-grid .schedule-col .schedule-track');
  const grid = document.querySelector('.panel-sp-day .schedule-grid');
  if (!grid) return; // страница без дневного календаря (не должно случиться, но не падаем)

  const isSolo = !!document.getElementById('walkinSoloTrigger');
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
      fillTrack(soloTrack, staff.name, {
        shift: shiftByMaster.get(staff.id),
        bookings: bookingsByMaster.get(staff.id) ?? [],
        services,
        priceOf,
      });
    }
    return;
  }

  grid.innerHTML = masters.map(buildColumnHtml).join('');
  const cols = grid.querySelectorAll(':scope > .schedule-col');
  masters.forEach((m, i) => {
    const track = cols[i]?.querySelector('.schedule-track');
    if (!track) return;
    fillTrack(track, m.name, {
      shift: shiftByMaster.get(m.id),
      bookings: bookingsByMaster.get(m.id) ?? [],
      services,
      priceOf,
    });
  });
}
