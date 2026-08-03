import { createStore, createHttpBackend, getMasters, getServices, priceLabelForMaster, priceForMaster } from './storage.js';

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
const masters = getMasters();
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

let selectedMaster = null;
// Окно 11 (баг найден Владом 30.07.2026): клиент должен иметь возможность выбрать
// НЕСКОЛЬКО услуг за визит - карточки выглядели чекбоксами, но вели себя как
// радиокнопки (selectedService было единичным значением). Теперь набор id.
let selectedServiceIds = new Set();
let selectedSlot = null;
let selectedDate = null;

const today = new Date();
let calViewYear = today.getFullYear();
let calViewMonth = today.getMonth();

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

  calGrid.replaceChildren();
  const firstWeekday = (new Date(calViewYear, calViewMonth, 1).getDay() + 6) % 7;
  for (let i = 0; i < firstWeekday; i++) {
    const empty = document.createElement('span');
    empty.className = 'cal-day-empty';
    calGrid.append(empty);
  }

  const todayIso = todayStr();
  const total = daysInMonth(calViewYear, calViewMonth);
  for (let day = 1; day <= total; day++) {
    const iso = isoDate(calViewYear, calViewMonth, day);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = String(day);

    if (iso < todayIso) {
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
      refreshSlots();
      clearMsg();
    });
    calGrid.append(btn);
  }
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
});

calNext.addEventListener('click', () => {
  calViewMonth += 1;
  if (calViewMonth > 11) {
    calViewMonth = 0;
    calViewYear += 1;
  }
  renderCalendar();
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

function renderMasters() {
  mastersGrid.replaceChildren();
  let i = 0;
  for (const master of masters) {
    const card = document.createElement('div');
    card.className = 'master-card';

    const avatar = document.createElement('div');
    avatar.className = 'master-avatar';
    avatar.textContent = master.name
      .split(' ')
      .map((part) => part[0])
      .join('');

    const tag = document.createElement('span');
    tag.className = 'master-placeholder-tag';
    tag.textContent = master.isPlaceholder ? 'пример' : 'мастер';

    const name = document.createElement('div');
    name.className = 'master-name';
    name.textContent = master.name;

    const win = document.createElement('div');
    win.className = 'master-window';
    win.textContent = `${master.workWindow.start}-${master.workWindow.end}`;

    card.append(avatar, tag, name, win);
    mastersGrid.append(card);
    armReveal(card, i * 50);
    i += 1;
  }
}

function renderMasterOptions() {
  masterGrid.replaceChildren();
  for (const master of masters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-card';

    const name = document.createElement('span');
    name.className = 'opt-name';
    name.textContent = master.name;

    const meta = document.createElement('span');
    meta.className = 'opt-meta';
    meta.textContent = `${master.workWindow.start}-${master.workWindow.end}${master.isPlaceholder ? ' · пример' : ''}`;

    btn.append(name, meta);
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
      clearMsg();
    });
    masterGrid.append(btn);
  }
}

function renderServiceOptions() {
  selectedServiceIds = new Set();
  serviceGrid.replaceChildren();
  for (const service of services) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-card';
    btn.setAttribute('aria-pressed', 'false');

    const name = document.createElement('span');
    name.className = 'opt-name';
    name.textContent = service.name;

    // Цена ИМЕННО выбранного мастера (Окно 10, разд.17.2 ТЗ) - Елизавета дешевле
    // Алиовсад/Мамедхана на большинстве услуг, priceLabelForMaster сама возвращает
    // общую цену, если override для этого мастера не задан.
    const priceLabel = selectedMaster ? priceLabelForMaster(selectedMaster.id, service.id) : service.priceLabel;

    const meta = document.createElement('span');
    meta.className = 'opt-meta';
    meta.textContent = `${priceLabel} · ${service.durationLabel}`;

    btn.append(name, meta);
    // Окно 11: клик ДОБАВЛЯЕТ/УБИРАЕТ услугу из набора, не заменяет выбор целиком -
    // это реальный множественный выбор (чекбоксы), не радиокнопки под видом чекбоксов.
    btn.addEventListener('click', () => {
      if (selectedServiceIds.has(service.id)) {
        selectedServiceIds.delete(service.id);
      } else {
        selectedServiceIds.add(service.id);
      }
      btn.classList.toggle('selected', selectedServiceIds.has(service.id));
      btn.setAttribute('aria-pressed', String(selectedServiceIds.has(service.id)));
      renderServiceSummary();
      refreshSlots();
      clearMsg();
    });
    serviceGrid.append(btn);
  }
  renderServiceSummary();
}

// Живая сумма длительности/цены по всем отмеченным услугам ДО подтверждения записи
// (Окно 11, п.3 промпта корректировки) - обновляется при каждом клике по услуге.
function renderServiceSummary() {
  if (!serviceSummary) return;
  if (selectedServiceIds.size === 0) {
    serviceSummary.hidden = true;
    serviceSummary.textContent = '';
    return;
  }
  const chosen = services.filter((s) => selectedServiceIds.has(s.id));
  const totalDuration = chosen.reduce((sum, s) => sum + s.durationMin, 0);
  const totalPrice = chosen.reduce((sum, s) => {
    const price = selectedMaster ? priceForMaster(selectedMaster.id, s.id) : s.price;
    return sum + price;
  }, 0);
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
  const requestServiceIds = new Set(selectedServiceIds);
  const totalDuration = services
    .filter((s) => requestServiceIds.has(s.id))
    .reduce((sum, s) => sum + s.durationMin, 0);
  const requestDate = date;
  const slots = await store.getFreeSlots(requestMaster.id, requestDate, totalDuration);
  // Пока ждали ответ сети, пользователь мог переключить мастера/услуги/дату - тогда
  // этот ответ уже устарел, не перерисовываем поверх более свежего выбора.
  const sameServices =
    selectedServiceIds.size === requestServiceIds.size &&
    [...selectedServiceIds].every((id) => requestServiceIds.has(id));
  if (selectedMaster !== requestMaster || !sameServices || selectedDate !== requestDate) return;

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
  const result = await store.createBooking({
    masterId,
    serviceIds,
    date,
    startTime: selectedSlot,
    clientName,
    clientPhone,
  });

  if (!result.ok) {
    // Раньше здесь всегда был один текст про "заняли", даже когда причина - чужой
    // перерыв или уже прошедшее время (storage.js теперь передаёт реальный reason).
    const reasonMessages = {
      overlap: 'Это время только что заняли - выберите другой слот',
      schedule_blocked: 'В это время у мастера перерыв или выходной - выберите другой слот',
      past_time: 'Это время уже прошло - выберите время попозже',
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

for (const el of document.querySelectorAll('.section-head, .booking-shell, .contacts-grid > *, .philosophy-quote, .philosophy-story, .team-growth-grid > *')) {
  armReveal(el);
}

for (const [i, el] of Array.from(document.querySelectorAll('.work-photo')).entries()) {
  armReveal(el, i * 60);
}
