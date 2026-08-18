import {
  createStore,
  createHttpBackend,
  getMasters,
  loadPublicMasters,
  getServices,
  priceLabelForMaster,
  priceForMaster,
  isServiceBlockedByCombo,
  toggleServiceSelection,
  filterBookableMasters,
  sortByServiceOrder,
} from './storage.js';
import { rememberClientSource, currentClientSource } from './assets/client-source.js';

// Первое касание запоминается сразу при загрузке страницы, а не в момент отправки
// формы: клиент приходит по ссылке с меткой из карточки организации, потом листает
// сайт, и к моменту записи utm_source в адресе уже нет. Ничего не показывает и ничего
// не отправляет - только кладёт ключ канала в localStorage (assets/client-source.js).
rememberClientSource();

// Если на странице задан window.ALIKHAN_API_URL (см. index.html) - работаем через
// реальный бэкенд на Amvera, синхронизация между устройствами реальна. Если нет -
// откатываемся на localStorage (старое поведение демо, только для одного браузера).
const store = createStore(window.ALIKHAN_API_URL ? createHttpBackend(window.ALIKHAN_API_URL) : undefined);

// Баг Б.4 (ТЗ-готовность-к-продакшену, 01.08.2026): страница без window.ALIKHAN_API_URL
// тихо уходила в офлайн-режим на localStorage - живое доказательство: index-showcase.html
// не имела этой переменной вообще (Блок Б.2 того же ТЗ). Предупреждение для
// разработчика/Влада (в консоли и мелким баннером в углу), не для клиента - форма
// записи при этом продолжает работать (просто без синхронизации между устройствами).
if (!window.ALIKHAN_API_URL) {
  console.warn('ALIKHAN_API_URL не задан - страница работает в офлайн-демо режиме (localStorage, без синхронизации между устройствами)');
  const banner = document.createElement('div');
  banner.textContent = '⚠ офлайн-режим: нет ALIKHAN_API_URL, записи не синхронизируются с базой';
  banner.style.cssText =
    'position:fixed;bottom:8px;right:8px;z-index:9999;background:#3a1d1d;color:#f3efe4;' +
    'font:12px/1.4 monospace;padding:6px 10px;border-radius:6px;opacity:0.85;pointer-events:none;max-width:280px';
  document.body.append(banner);
}
// В боевом режиме список начинается пустым: нельзя на мгновение показать старых
// демо-мастеров, а затем молча заменить их ответом API или оставить при его ошибке
let masters = window.ALIKHAN_API_URL ? [] : getMasters();
const services = getServices();

const priceGrid = document.getElementById('price-grid');
const mastersGrid = document.getElementById('masters-grid');
const form = document.getElementById('booking-form');
const masterGrid = document.getElementById('master-grid');
const serviceGrid = document.getElementById('service-grid');
const serviceSummary = document.getElementById('service-summary');
const slotsWrap = document.getElementById('slots-wrap');
const nameInput = document.getElementById('f-name');
const phoneInput = document.getElementById('f-phone');
const submitBtn = document.getElementById('f-submit');
const formMsg = document.getElementById('form-msg');
const consentCheckbox = document.getElementById('f-consent');

const dateToggle = document.getElementById('date-toggle');
const dateToggleLabel = document.getElementById('date-toggle-label');
const datePopover = document.getElementById('date-popover');
const calPrev = document.getElementById('cal-prev');
const calNext = document.getElementById('cal-next');
const calMonthLabel = document.getElementById('cal-month-label');
const calGrid = document.getElementById('cal-grid');
const calLimitHint = document.getElementById('cal-limit-hint');
const holidayHint = document.getElementById('holiday-hint');

let selectedMaster = null;
// Окно 11 (баг найден Владом 30.07.2026): клиент должен иметь возможность выбрать
// НЕСКОЛЬКО услуг за визит - карточки выглядели чекбоксами, но вели себя как
// радиокнопки (selectedService было единичным значением). Теперь набор id.
let selectedServiceIds = new Set();
let selectedSlot = null;
let selectedDate = null;

// Окно 21 (04.08.2026): даты видимого месяца календаря, у которых РЕАЛЬНО нет
// свободного времени под текущую связку мастер+услуги (GET /schedule-availability) -
// заполняется асинхронно, поэтому календарь сначала рисуется по старым/пустым
// данным (только границы 60 дней), затем перерисовывается, когда ответ придёт.
let unavailableDates = new Set();

// Правка 03.08.2026: раньше форма всегда показывала весь каталог из storage.js
// каждому мастеру одинаково - клиент мог выбрать услугу, которую конкретный
// мастер вообще не оказывает (сервер такую бронь отклонял с unknown_master_service,
// но до этого момента виджет вёл себя как будто всё в порядке). Реальный список
// "кто что оказывает" + личная длительность/цена - master_services, читаем один
// раз при загрузке страницы (24 строки максимум, не тяжелее одного лишнего fetch).
let masterServices = [];
let masterServicesReady = false;
// Текущий список услуг ВЫБРАННОГО мастера (id/name/price/durationMin) - источник
// для renderServiceSummary/refreshSlots, чтобы не пересчитывать fallback-логику
// servicesForMaster в нескольких местах.
let currentServiceList = [];
let currentServiceButtons = new Map();

// Окно 26 (04.08.2026, Задача 1-2) - "ближайшая доступная дата" КАЖДОГО мастера
// (GET /masters-next-availability), один батч-запрос при загрузке страницы - бейдж
// на карточке мастера должен быть виден ДО того, как клиент вообще выбрал мастера
// (в отличие от unavailableDates/refreshCalendarAvailability, которые зависят от
// уже выбранных мастера+услуг). masterAvailabilityReady=false, пока ответ не пришёл
// (или в офлайн-демо без ALIKHAN_API_URL) - renderMasterOptions тогда просто не
// показывает бейдж вообще, не выдумывает дату.
let masterAvailability = new Map(); // masterId -> дата ('YYYY-MM-DD') | null (недоступен в 60 днях)
let masterAvailabilityReady = false;
// Задача C промпта Окна 29 (05.08.2026) - masterId -> hasWorkingSchedule (boolean),
// тот же батч-ответ /masters-next-availability. null пока не пришёл ответ -
// filterBookableMasters тогда не фильтрует ничего (см. комментарий в storage.js).
let masterWorkingSchedule = null;

async function loadMasterNextAvailability() {
  if (!window.ALIKHAN_API_URL) return; // офлайн-демо режим - бейдж не показываем, не выдумываем данные
  try {
    const res = await fetch(`${window.ALIKHAN_API_URL}/masters-next-availability`);
    if (!res.ok) return;
    const rows = await res.json();
    if (!Array.isArray(rows)) return;
    masterAvailability = new Map(rows.map((r) => [r.masterId, r.nextAvailableDate]));
    masterWorkingSchedule = new Map(rows.map((r) => [r.masterId, r.hasWorkingSchedule]));
    masterAvailabilityReady = true;
  } catch {
    // сеть недоступна - masterAvailabilityReady остаётся false, виджет не ломается
  }
}

async function loadMasterServices() {
  if (!window.ALIKHAN_API_URL) return; // офлайн-демо режим - остаёмся на легаси-фоллбэке ниже
  try {
    const res = await fetch(`${window.ALIKHAN_API_URL}/master-services`);
    if (!res.ok) return;
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      masterServices = rows;
      masterServicesReady = true;
    }
  } catch {
    // сеть недоступна - masterServicesReady остаётся false, servicesForMaster
    // откатывается на старое поведение (весь каталог), виджет не ломается
  }
}

// masterServicesReady=false (ещё не загрузилось или сеть недоступна) - старое
// поведение: весь каталог с общей ценой/длительностью, как было до этой правки.
function servicesForMaster(masterId) {
  if (!masterServicesReady) {
    return services.map((s) => ({ id: s.id, name: s.name, price: priceForMaster(masterId, s.id), durationMin: s.durationMin }));
  }
  // Единый порядок показа услуг (storage.js SERVICE_ORDER) - строки приезжают из
  // /master-services, их порядок задаёт бэкенд, но фронт деплоится отдельно от него
  return sortByServiceOrder(
    masterServices.filter((r) => r.masterId === masterId),
    (r) => r.serviceId
  ).map((r) => ({
    id: r.serviceId,
    name: services.find((s) => s.id === r.serviceId)?.name ?? r.serviceId,
    price: r.price,
    durationMin: r.durationMin,
  }));
}

const today = new Date();
let calViewYear = today.getFullYear();
let calViewMonth = today.getMonth();

const MAX_BOOKING_DAYS_AHEAD = 60;

function maxBookingDate() {
  const d = new Date();
  d.setDate(d.getDate() + MAX_BOOKING_DAYS_AHEAD);
  return d;
}

// scroll-reveal is progressive enhancement only - reduced-motion users get the plain static page
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealObserver = REDUCE_MOTION ? null : new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      revealObserver.unobserve(entry.target);
    }
  }
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

function armReveal(el, delayMs = 0) {
  if (REDUCE_MOTION) return;
  el.classList.add('reveal');
  if (delayMs) el.style.transitionDelay = `${delayMs}ms`;
  revealObserver.observe(el);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateRu(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function isoDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function renderCalendar() {
  const label = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(
    new Date(calViewYear, calViewMonth, 1),
  );
  calMonthLabel.textContent = label;
  calPrev.disabled = calViewYear === today.getFullYear() && calViewMonth === today.getMonth();

  const maxDate = maxBookingDate();
  const atMaxMonth = calViewYear === maxDate.getFullYear() && calViewMonth === maxDate.getMonth();
  calNext.disabled = atMaxMonth;
  calLimitHint.hidden = !atMaxMonth;

  calGrid.replaceChildren();
  const firstWeekday = (new Date(calViewYear, calViewMonth, 1).getDay() + 6) % 7;
  for (let i = 0; i < firstWeekday; i++) {
    const empty = document.createElement('span');
    empty.className = 'cal-day-empty';
    calGrid.append(empty);
  }

  const todayIso = todayStr();
  const maxIso = isoDate(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate());
  const total = daysInMonth(calViewYear, calViewMonth);
  for (let day = 1; day <= total; day++) {
    const iso = isoDate(calViewYear, calViewMonth, day);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = String(day);
    btn.dataset.iso = iso;

    // Баг Влада (04.08.2026): дата раньше красилась серым только по границам
    // 60 дней - реальная занятость мастера+услуги открывалась только ПОСЛЕ клика
    // (refreshSlots) или вовсе на подтверждении записи (schedule_blocked). Второе
    // условие - тот же класс .disabled, применяется ТОЛЬКО если мастер и услуга уже
    // выбраны (unavailableDates пуст, пока выбор не сделан - см. refreshCalendarAvailability).
    if (iso < todayIso || iso > maxIso || unavailableDates.has(iso)) {
      btn.classList.add('disabled');
      btn.disabled = true;
    }
    if (iso === todayIso) btn.classList.add('today');
    if (iso === selectedDate) btn.classList.add('selected');

    btn.addEventListener('click', () => {
      selectedDate = iso;
      dateToggleLabel.textContent = formatDateRu(iso);
      dateToggleLabel.classList.remove('placeholder');
      closeDatePopover();
      renderCalendar();
      renderHolidayHint();
      refreshSlots();
      clearMsg();
    });
    calGrid.append(btn);
  }
}

// Окно 24 (05.08.2026): производственный календарь (GET /holidays). Нужен ровно для
// одной строки - напомнить клиенту, что уже выбранная им дата праздничная, чтобы он
// не забыл про свои планы на этот день. Записываться в праздник НЕ запрещено: если
// салон в этот день закрыт, дата и так недоступна в календаре (Окно 21 красит её
// серым по реальному графику мастера) - это подсказка, а не второй механизм запрета.
let holidayNames = new Map();

async function loadHolidays(year) {
  if (!window.ALIKHAN_API_URL) return;
  try {
    const res = await fetch(`${window.ALIKHAN_API_URL}/holidays?year=${year}`);
    if (!res.ok) return; // подсказка не критична - виджет записи работает и без неё
    for (const h of await res.json()) holidayNames.set(h.date, h.name);
  } catch {
    // молча: сеть подвела - клиент просто не увидит напоминания, форма цела
  }
}

function renderHolidayHint() {
  if (!holidayHint) return;
  const name = selectedDate ? holidayNames.get(selectedDate) : null;
  holidayHint.hidden = !name;
  holidayHint.textContent = name ? `${formatDateRu(selectedDate)} - ${name}` : '';
}

// Окно 21 (04.08.2026): реальная доступность видимого месяца - вызывается при
// выборе/смене мастера, выборе/снятии услуги и при пролистывании месяца вперёд/назад
// (Задача 2 промпта). Если мастер или услуга ещё не выбраны - unavailableDates
// очищается, календарь ведёт себя как раньше (только границы 60 дней).
async function refreshCalendarAvailability() {
  if (!selectedMaster || selectedServiceIds.size === 0 || !window.ALIKHAN_API_URL) {
    unavailableDates = new Set();
    renderCalendar();
    return;
  }

  const requestMaster = selectedMaster;
  const requestServiceIds = new Set(selectedServiceIds);

  // Видимый диапазон месяца, зажатый в те же границы [сегодня; +60 дней], что уже
  // красит календарь (todayStr()/maxBookingDate()) - запрос не должен уходить за
  // пределы, которые и так недоступны клику.
  const maxDate = maxBookingDate();
  const todayIso = todayStr();
  const maxIso = isoDate(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate());
  const monthStartIso = isoDate(calViewYear, calViewMonth, 1);
  const monthEndIso = isoDate(calViewYear, calViewMonth, daysInMonth(calViewYear, calViewMonth));
  const from = monthStartIso < todayIso ? todayIso : monthStartIso;
  const to = monthEndIso > maxIso ? maxIso : monthEndIso;
  if (from > to) {
    unavailableDates = new Set();
    renderCalendar();
    return;
  }

  const params = new URLSearchParams({ masterId: requestMaster.id, from, to });
  for (const id of requestServiceIds) params.append('serviceId', id);

  let days;
  try {
    const res = await fetch(`${window.ALIKHAN_API_URL}/schedule-availability?${params}`);
    if (!res.ok) return; // сеть/сервер подвели - календарь остаётся на прежних данных, не ломаем виджет
    days = await res.json();
  } catch {
    return;
  }

  // Пока ждали ответ сети, пользователь мог сменить мастера/услуги/месяц - тогда
  // этот ответ уже устарел, тот же приём защиты от гонки, что уже есть в refreshSlots.
  const sameServices =
    selectedServiceIds.size === requestServiceIds.size && [...selectedServiceIds].every((id) => requestServiceIds.has(id));
  if (selectedMaster !== requestMaster || !sameServices) return;

  unavailableDates = new Set(days.filter((d) => !d.hasSlots).map((d) => d.date));
  renderCalendar();
}

function openDatePopover() {
  datePopover.hidden = false;
  dateToggle.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', onDocClickForDate);
  document.addEventListener('keydown', onDocKeydownForDate);
}

function closeDatePopover() {
  datePopover.hidden = true;
  dateToggle.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocClickForDate);
  document.removeEventListener('keydown', onDocKeydownForDate);
}

function onDocClickForDate(event) {
  if (!datePopover.contains(event.target) && event.target !== dateToggle) closeDatePopover();
}

function onDocKeydownForDate(event) {
  if (event.key === 'Escape') closeDatePopover();
}

dateToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  if (dateToggle.disabled) return;
  if (datePopover.hidden) {
    renderCalendar();
    openDatePopover();
  } else {
    closeDatePopover();
  }
});

calPrev.addEventListener('click', () => {
  calViewMonth -= 1;
  if (calViewMonth < 0) {
    calViewMonth = 11;
    calViewYear -= 1;
  }
  renderCalendar();
  refreshCalendarAvailability();
});

calNext.addEventListener('click', () => {
  calViewMonth += 1;
  if (calViewMonth > 11) {
    calViewMonth = 0;
    calViewYear += 1;
  }
  renderCalendar();
  refreshCalendarAvailability();
});

function formatPhone(raw) {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length && !digits.startsWith('7')) digits = `7${digits}`;
  digits = digits.slice(0, 11);
  if (!digits) return '';
  const rest = digits.slice(1);
  let out = '+7';
  if (rest.length) out += ` ${rest.slice(0, 3)}`;
  if (rest.length > 3) out += ` ${rest.slice(3, 6)}`;
  if (rest.length > 6) out += ` ${rest.slice(6, 8)}`;
  if (rest.length > 8) out += ` ${rest.slice(8, 10)}`;
  return out;
}

phoneInput.addEventListener('input', () => {
  phoneInput.value = formatPhone(phoneInput.value);
});

function renderPrice() {
  priceGrid.replaceChildren();
  let i = 0;
  for (const service of services) {
    const card = document.createElement('div');
    card.className = 'price-card';

    const head = document.createElement('div');
    head.className = 'price-card-head';

    const name = document.createElement('h3');
    name.textContent = service.name;

    const price = document.createElement('span');
    price.className = 'price-card-price';
    price.textContent = service.priceLabel;

    head.append(name, price);

    const duration = document.createElement('div');
    duration.className = 'price-card-duration';
    duration.textContent = service.durationLabel;

    const comp = document.createElement('p');
    comp.className = 'price-card-comp';
    comp.textContent = service.composition;

    card.append(head, duration, comp);
    priceGrid.append(card);
    armReveal(card, i * 50);
    i += 1;
  }
}

// Редизайн 18.08.2026 - витрина команды. Разметка в index.html (карточки с ролью,
// описанием и инициалами) - дизайнерский фоллбэк: он виден сразу, пока идёт запрос,
// и остаётся на экране, если /public/masters не ответил. Как только данные пришли,
// карточки пересобираются из CRM (фото, стаж, портфолио), а роль и описание из
// макета подставляются по имени мастера - их в API нет.
const showcaseFallbackByName = new Map();
if (mastersGrid) {
  for (const card of mastersGrid.querySelectorAll('.master-card')) {
    const name = card.querySelector('.master-name')?.textContent?.trim();
    if (!name) continue;
    showcaseFallbackByName.set(name, {
      tag: card.querySelector('.master-placeholder-tag')?.textContent?.trim() ?? '',
      detail: card.querySelector('.master-profile-detail')?.textContent?.trim() ?? '',
    });
  }
}

function masterInitials(name) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('');
}

function renderMasters() {
  // Пустой список - это либо "ещё грузим", либо ошибка сети (её отдельно показывает
  // блок записи ниже). В обоих случаях витрина остаётся на разметке из index.html,
  // без мигания текстом-заглушкой.
  if (!mastersGrid || !masters.length) return;
  mastersGrid.replaceChildren();
  let i = 0;
  for (const master of masters) {
    const design = showcaseFallbackByName.get(master.name) ?? {};
    const card = document.createElement('article');
    card.className = 'master-card';

    const avatar = document.createElement('div');
    avatar.className = 'master-avatar';
    if (master.photoUrl) {
      const photo = document.createElement('img');
      photo.src = master.photoUrl;
      photo.alt = `Фотография мастера ${master.name}`;
      photo.loading = 'lazy';
      // фото могло быть удалено из CRM или не отдаться - показываем инициалы
      photo.addEventListener('error', () => {
        photo.remove();
        avatar.classList.add('master-fallback');
        avatar.textContent = masterInitials(master.name);
      });
      avatar.append(photo);
    } else {
      avatar.classList.add('master-fallback');
      avatar.textContent = masterInitials(master.name);
    }

    const tag = document.createElement('span');
    tag.className = 'master-placeholder-tag';
    tag.textContent = master.isPlaceholder ? 'пример' : (design.tag || 'мастер');

    const name = document.createElement('div');
    name.className = 'master-name';
    name.textContent = master.name;

    const win = document.createElement('div');
    win.className = 'master-window';
    win.textContent = `${master.workWindow.start}-${master.workWindow.end}`;

    card.append(avatar, tag, name, win);

    let hasOwnDetails = false;
    for (const [field, label] of [['experienceText', 'Стаж'], ['strengthsText', 'Сильные стороны'], ['certificatesText', 'Курсы и сертификаты']]) {
      if (!master[field]) continue;
      const detail = document.createElement('p');
      detail.className = 'master-profile-detail';
      detail.textContent = `${label}: ${master[field]}`;
      card.append(detail);
      hasOwnDetails = true;
    }
    // мастер без заполненного профиля в CRM не остаётся с голой карточкой -
    // подставляем описание из макета, если оно для него написано
    if (!hasOwnDetails && design.detail) {
      const detail = document.createElement('p');
      detail.className = 'master-profile-detail';
      detail.textContent = design.detail;
      card.append(detail);
    }

    if (master.portfolio?.length) {
      const portfolio = document.createElement('div');
      portfolio.className = 'master-portfolio';
      for (const item of master.portfolio) {
        const image = document.createElement('img');
        image.src = item.url;
        image.alt = `Работа мастера ${master.name}`;
        portfolio.append(image);
      }
      card.append(portfolio);
    }

    // ссылку "Выбрать мастера" дорисовывает CRO-скрипт index.html - он же
    // связывает карточку с выбором этого мастера в форме записи
    mastersGrid.append(card);
    armReveal(card, i * 50);
    i += 1;
  }
}

function renderMasterOptions() {
  masterGrid.replaceChildren();
  // Задача C промпта Окна 29 - мастер без стандартного графика не появляется в
  // списке выбора вообще (см. filterBookableMasters в storage.js).
  for (const master of filterBookableMasters(masters, masterWorkingSchedule)) {
    // Окно 26 (04.08.2026, Задача 2) - карточка обёрнута в wrap, чтобы кнопка выбора
    // мастера (.option-card) и отдельная ссылка "Позвонить администратору" были
    // соседями, не вложены друг в друга - вложенный <a> внутри <button> невалиден
    // и ломает клик.
    const wrap = document.createElement('div');
    wrap.className = 'master-option';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-card';
    // renderMasterOptions() перевызывается повторно, когда приходит ответ
    // /masters-next-availability (см. вызов ниже в конце файла) - без этой строки
    // уже сделанный клиентом выбор мастера визуально сбрасывался бы на каждый такой перерендер.
    if (selectedMaster === master) btn.classList.add('selected');

    const name = document.createElement('span');
    name.className = 'opt-name';
    name.textContent = master.name;

    const meta = document.createElement('span');
    meta.className = 'opt-meta';
    meta.textContent = `${master.workWindow.start}-${master.workWindow.end}${master.isPlaceholder ? ' · пример' : ''}`;

    btn.append(name, meta);

    // Проблема Влада (04.08.2026): клиент выбирал мастера ДО того, как видел его
    // реальную доступность - узнавал о занятости только в глубине календаря. Бейдж
    // показывается только когда ответ сети реально пришёл (masterAvailabilityReady) -
    // до этого момента карточка выглядит как раньше, без бейджа.
    if (masterAvailabilityReady) {
      const nextDate = masterAvailability.get(master.id);
      const badge = document.createElement('span');
      if (nextDate) {
        badge.className = 'opt-availability';
        badge.textContent = `ближайшая запись - ${formatDateRu(nextDate)}`;
      } else {
        badge.className = 'opt-availability opt-availability--none';
        badge.textContent = 'сейчас нет свободных мест';
      }
      btn.append(badge);
    }

    btn.addEventListener('click', () => {
      selectedMaster = master;
      for (const el of masterGrid.querySelectorAll('.option-card')) {
        el.classList.toggle('selected', el === btn);
      }
      serviceGrid.removeAttribute('aria-disabled');
      dateToggle.disabled = false;
      if (dateToggleLabel.classList.contains('placeholder')) {
        dateToggleLabel.textContent = 'Выберите дату';
      }
      renderServiceOptions();
      resetSlots('Выберите услугу и дату');
      refreshCalendarAvailability();
      clearMsg();
    });
    wrap.append(btn);

    // Полноценный лист ожидания - не в масштабе этого окна (см. промпт Окна 26),
    // только прямая связь с администратором, если у мастера совсем нет мест в
    // ближайшие 60 дней. Реальный телефон салона, тот же номер, что уже в разделе
    // "Контакты" ниже на странице - не выдумываем отдельный канал связи.
    if (masterAvailabilityReady && masterAvailability.has(master.id) && !masterAvailability.get(master.id)) {
      const callLink = document.createElement('a');
      callLink.className = 'opt-admin-call';
      callLink.href = 'tel:+79899977070';
      callLink.textContent = 'Позвонить администратору';
      wrap.append(callLink);
    }

    masterGrid.append(wrap);
  }
}

function renderServiceOptions() {
  selectedServiceIds = new Set();
  serviceGrid.replaceChildren();
  currentServiceButtons = new Map();
  currentServiceList = selectedMaster ? servicesForMaster(selectedMaster.id) : [];

  if (selectedMaster && currentServiceList.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'section-hint';
    hint.textContent = 'У этого мастера пока не назначено ни одной услуги - выберите другого мастера';
    serviceGrid.append(hint);
    renderServiceSummary();
    return;
  }

  for (const service of currentServiceList) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-card';
    btn.setAttribute('aria-pressed', 'false');

    const name = document.createElement('span');
    name.className = 'opt-name';
    name.textContent = service.name;

    const meta = document.createElement('span');
    meta.className = 'opt-meta';
    meta.textContent = `${service.price.toLocaleString('ru-RU')}₽ · ${service.durationMin} мин`;

    btn.append(name, meta);
    // Окно 11: клик ДОБАВЛЯЕТ/УБИРАЕТ услугу из набора, не заменяет выбор целиком -
    // это реальный множественный выбор (чекбоксы), не радиокнопки под видом чекбоксов.
    // Правка 03.08.2026: комплекс "стрижка+борода" и его 4 компонента (см.
    // storage.js SERVICE_COMBOS) теперь взаимоисключающие в обе стороны - выбор
    // комплекса блокирует компоненты, а отдельный выбор обоих компонентов сам
    // сворачивается в комплекс.
    btn.addEventListener('click', () => {
      // Одно правило выбора на сайт и CRM (storage.js toggleServiceSelection):
      // блокировка составляющих при комплексе, поглощение их комплексом и слияние
      // двух составляющих в комплекс - раньше эта последовательность была написана
      // здесь и в форме CRM по отдельности и разъезжалась
      selectedServiceIds = toggleServiceSelection(service.id, selectedServiceIds);
      syncServiceButtons();
      renderServiceSummary();
      refreshSlots();
      refreshCalendarAvailability();
      clearMsg();
    });
    currentServiceButtons.set(service.id, btn);
    serviceGrid.append(btn);
  }
  renderServiceSummary();
}

// Перерисовывает selected/disabled состояние ВСЕХ карточек услуг сразу, не только
// той, по которой кликнули - выбор комплекса должен визуально заблокировать его
// компоненты, автослияние должно снять выделение с обоих компонентов и подсветить
// комплекс, который сам не был кликнут напрямую.
function syncServiceButtons() {
  for (const [id, btn] of currentServiceButtons) {
    const selected = selectedServiceIds.has(id);
    const blocked = !selected && isServiceBlockedByCombo(id, selectedServiceIds);
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-pressed', String(selected));
    btn.disabled = blocked;
    btn.classList.toggle('option-card--blocked', blocked);
  }
}

// Живая сумма длительности/цены по всем отмеченным услугам ДО подтверждения записи
// (Окно 11, п.3 промпта корректировки) - обновляется при каждом клике по услуге.
// Правка 03.08.2026: цена/длительность берутся из currentServiceList (реальные
// данные ВЫБРАННОГО мастера), не из общего каталога storage.js.
function renderServiceSummary() {
  if (!serviceSummary) return;
  if (selectedServiceIds.size === 0) {
    serviceSummary.hidden = true;
    serviceSummary.textContent = '';
    return;
  }
  const chosen = currentServiceList.filter((s) => selectedServiceIds.has(s.id));
  const totalDuration = chosen.reduce((sum, s) => sum + s.durationMin, 0);
  const totalPrice = chosen.reduce((sum, s) => sum + s.price, 0);
  serviceSummary.hidden = false;
  serviceSummary.textContent = `Выбрано услуг: ${chosen.length} · итого ${totalDuration} мин · ${totalPrice.toLocaleString('ru-RU')}₽`;
}

function showMsg(text, type) {
  formMsg.textContent = text;
  formMsg.className = `form-msg show ${type}`;
}

function clearMsg() {
  formMsg.textContent = '';
  formMsg.className = 'form-msg';
}

// Кнопка "Подтвердить запись" разблокируется только когда выбран слот И отмечено
// согласие на обработку персональных данных (152-ФЗ, ст.18.1 - согласие обязательно
// ДО сбора данных, чекбокс не может быть предустановлен). Отдельно эта же проверка
// продублирована в обработчике submit ниже - на случай если чекбокс сняли после выбора слота.
function updateSubmitState() {
  submitBtn.disabled = !(selectedSlot && consentCheckbox && consentCheckbox.checked);
}
if (consentCheckbox) {
  consentCheckbox.addEventListener('change', () => { updateSubmitState(); clearMsg(); });
}

function resetSlots(hintText) {
  selectedSlot = null;
  submitBtn.disabled = true;
  slotsWrap.replaceChildren();
  const hint = document.createElement('p');
  hint.className = 'slots-hint';
  hint.textContent = hintText;
  slotsWrap.append(hint);
}

async function refreshSlots() {
  const date = selectedDate;

  if (!selectedMaster || selectedServiceIds.size === 0 || !date) {
    resetSlots('Сначала выберите мастера, услугу и дату');
    return;
  }

  const requestMaster = selectedMaster;
  // Окно 11: слот считается от СУММЫ длительностей всех выбранных услуг, не одной.
  // Правка 03.08.2026: раньше здесь брался общий каталог storage.js (одна и та же
  // длительность для всех мастеров) - реальный поиск свободного времени должен
  // использовать личную длительность ИМЕННО этого мастера (currentServiceList),
  // иначе виджет мог предложить слот, который сервер потом отклонит как overlap.
  const requestServiceIds = new Set(selectedServiceIds);
  const totalDuration = currentServiceList
    .filter((s) => requestServiceIds.has(s.id))
    .reduce((sum, s) => sum + s.durationMin, 0);
  const requestDate = date;

  // Пока ждали ответ сети (успех или ошибку), пользователь мог переключить
  // мастера/услуги/дату - тогда этот ответ уже устарел, не перерисовываем поверх
  // более свежего выбора. Общий для обеих веток ниже (success и catch).
  const isStaleRequest = () => {
    const sameServices =
      selectedServiceIds.size === requestServiceIds.size &&
      [...selectedServiceIds].every((id) => requestServiceIds.has(id));
    return selectedMaster !== requestMaster || !sameServices || selectedDate !== requestDate;
  };

  // Окно 34: раньше сетевая ошибка здесь (бэкенд недоступен) вылетала необработанным
  // исключением из storage.js (fetch/`res.ok` throw) - слоты молча не обновлялись,
  // клиент не понимал, что происходит.
  let slots;
  try {
    slots = await store.getFreeSlots(requestMaster.id, requestDate, totalDuration);
  } catch (err) {
    console.error('refreshSlots: сетевая ошибка', err);
    if (isStaleRequest()) return;
    resetSlots('Не удалось загрузить свободное время - проверьте подключение и выберите дату ещё раз');
    return;
  }
  if (isStaleRequest()) return;

  selectedSlot = null;
  submitBtn.disabled = true;
  slotsWrap.replaceChildren();

  if (slots.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'slots-hint';
    hint.textContent = 'На эту дату у мастера нет свободного времени на выбранную услугу - выберите другую дату';
    slotsWrap.append(hint);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'slots-grid';
  for (const slot of slots) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn';
    btn.textContent = slot;
    btn.addEventListener('click', () => {
      selectedSlot = slot;
      for (const el of grid.querySelectorAll('.slot-btn')) {
        el.classList.toggle('selected', el === btn);
      }
      updateSubmitState();
      clearMsg();
    });
    grid.append(btn);
  }
  slotsWrap.append(grid);
}

function renderReceipt(booking, master, chosenServices) {
  formMsg.replaceChildren();
  formMsg.className = 'form-msg show ok';

  const title = document.createElement('p');
  title.className = 'receipt-title';
  title.textContent = 'Готово! Запись подтверждена';
  formMsg.append(title);

  // Окно 11: несколько услуг в чеке - список через запятую, не одна строка.
  const rows = [
    ['Мастер', master.name],
    ['Услуги', chosenServices.map((s) => s.name).join(', ')],
    ['Когда', `${formatDateRu(booking.date)} в ${booking.startTime}`],
    ['Клиент', `${booking.clientName}, ${booking.clientPhone}`],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'receipt-row';
    const kEl = document.createElement('span');
    kEl.textContent = k;
    const vEl = document.createElement('b');
    vEl.textContent = v;
    row.append(kEl, vEl);
    formMsg.append(row);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMsg();

  const masterId = selectedMaster ? selectedMaster.id : null;
  const serviceIds = [...selectedServiceIds];
  const date = selectedDate;
  const clientName = nameInput.value.trim();
  const clientPhone = phoneInput.value.trim();

  if (!masterId || serviceIds.length === 0 || !date || !selectedSlot) {
    showMsg('Выберите мастера, услугу, дату и время', 'error');
    return;
  }
  if (!clientName || !clientPhone) {
    showMsg('Укажите имя и телефон', 'error');
    return;
  }
  const phoneDigits = clientPhone.replace(/\D/g, '');
  if (phoneDigits.length < 11) {
    showMsg('Введите полный номер телефона', 'error');
    return;
  }
  if (!consentCheckbox || !consentCheckbox.checked) {
    showMsg('Подтвердите согласие на обработку персональных данных', 'error');
    return;
  }

  submitBtn.disabled = true;
  // Окно 34: раньше сетевая ошибка здесь (бэкенд недоступен в момент нажатия) вылетала
  // необработанным исключением - кнопка оставалась disabled навсегда, без сообщения,
  // клиент не мог повторить попытку без перезагрузки страницы.
  let result;
  try {
    result = await store.createBooking({
      masterId,
      serviceIds,
      date,
      startTime: selectedSlot,
      clientName,
      clientPhone,
      // Откуда клиент пришёл (17.08.2026) - определено в момент первого захода на
      // сайт (rememberClientSource ниже), клиента ни о чём не спрашиваем: форма
      // записи и так самое узкое место, лишний вопрос в ней стоил бы записей
      source: currentClientSource(),
    });
  } catch (err) {
    console.error('createBooking: сетевая ошибка', err);
    showMsg('Не получилось отправить запись - проверьте подключение и нажмите «Подтвердить запись» ещё раз', 'error');
    updateSubmitState();
    return;
  }

  if (!result.ok) {
    // Раньше здесь всегда был один текст про "заняли", даже когда причина - чужой
    // перерыв или уже прошедшее время (storage.js теперь передаёт реальный reason).
    const reasonMessages = {
      overlap: 'Это время только что заняли - выберите другой слот',
      schedule_blocked: 'В это время у мастера перерыв или выходной - выберите другой слот',
      past_time: 'Это время уже прошло - выберите время попозже',
      // Мастера сняли с приёма, пока клиент выбирал слот - страница об этом ещё не знает
      master_not_accepting: 'Этот мастер сейчас не принимает записи - выберите другого',
      master_not_bookable: 'Этот мастер сейчас не принимает записи - выберите другого',
    };
    showMsg(reasonMessages[result.reason] || 'Не удалось записаться на это время - выберите другой слот', 'error');
    await refreshSlots();
    return;
  }

  const chosenServices = services.filter((s) => serviceIds.includes(s.id));
  renderReceipt(result.booking, selectedMaster, chosenServices);
  nameInput.value = '';
  phoneInput.value = '';
  await refreshSlots();
});

renderPrice();
renderMasters();
renderMasterOptions();

if (window.ALIKHAN_API_URL) {
  loadPublicMasters(window.ALIKHAN_API_URL).then((rows) => {
    masters = rows.map((m) => ({ ...m, workWindow: { start: '10:00', end: '20:00' }, isPlaceholder: false }));
    renderMasters(); renderMasterOptions();
  }).catch(() => {
    // витрина команды остаётся на разметке-фоллбэке из index.html (см. renderMasters),
    // а форма записи честно говорит, что мастеров не удалось загрузить
    masterGrid.replaceChildren();
    const message = document.createElement('p');
    message.className = 'form-msg error';
    message.textContent = 'Не удалось загрузить мастеров для записи. Обновите страницу или попробуйте позже';
    masterGrid.append(message);
  });
}

// Правка 03.08.2026: подгружаем реальные master_services после первой отрисовки
// (мастера/цены общего прайса не зависят от этого запроса) - если пользователь
// уже успел выбрать мастера, пока шёл fetch, перерисовываем список услуг заново
// с реальными данными вместо legacy-фоллбэка.
loadMasterServices().then(() => {
  if (selectedMaster) renderServiceOptions();
});

// Окно 26 (04.08.2026, Задача 2) - тот же приём, что и loadMasterServices выше:
// первая отрисовка карточек мастеров не ждёт сеть, бейдж доступности появляется
// перерисовкой, когда batch-ответ реально пришёл. renderMasterOptions() безопасно
// перевызывать повторно - сохраняет выбор мастера (selectedMaster === master выше).
loadMasterNextAvailability().then(() => {
  renderMasterOptions();
});

// Окно 24: производственный календарь на годы, до которых вообще можно дотянуться
// в форме. Окно записи (60 дней) в конце декабря заезжает в следующий год - тогда
// это два года, в остальные 10 месяцев запрос ровно один.
{
  const maxDate = maxBookingDate();
  const years = new Set([new Date().getFullYear(), maxDate.getFullYear()]);
  Promise.all([...years].map(loadHolidays)).then(renderHolidayHint);
}

for (const el of document.querySelectorAll('.section-head, .booking-shell, .contacts-grid > *, .philosophy-quote, .philosophy-story, .team-growth-grid > *')) {
  armReveal(el);
}

for (const [i, el] of Array.from(document.querySelectorAll('.work-photo')).entries()) {
  armReveal(el, i * 60);
}
