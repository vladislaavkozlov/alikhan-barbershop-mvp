import { createStore, getMasters, getServices } from './storage.js';

const store = createStore();
const masters = getMasters();
const services = getServices();

const priceGrid = document.getElementById('price-grid');
const mastersGrid = document.getElementById('masters-grid');
const form = document.getElementById('booking-form');
const masterGrid = document.getElementById('master-grid');
const serviceGrid = document.getElementById('service-grid');
const slotsWrap = document.getElementById('slots-wrap');
const nameInput = document.getElementById('f-name');
const phoneInput = document.getElementById('f-phone');
const submitBtn = document.getElementById('f-submit');
const formMsg = document.getElementById('form-msg');

const dateToggle = document.getElementById('date-toggle');
const dateToggleLabel = document.getElementById('date-toggle-label');
const datePopover = document.getElementById('date-popover');
const calPrev = document.getElementById('cal-prev');
const calNext = document.getElementById('cal-next');
const calMonthLabel = document.getElementById('cal-month-label');
const calGrid = document.getElementById('cal-grid');

let selectedMaster = null;
let selectedService = null;
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
  selectedService = null;
  serviceGrid.replaceChildren();
  for (const service of services) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-card';

    const name = document.createElement('span');
    name.className = 'opt-name';
    name.textContent = service.name;

    const meta = document.createElement('span');
    meta.className = 'opt-meta';
    meta.textContent = `${service.priceLabel} · ${service.durationLabel}`;

    btn.append(name, meta);
    btn.addEventListener('click', () => {
      selectedService = service;
      for (const el of serviceGrid.querySelectorAll('.option-card')) {
        el.classList.toggle('selected', el === btn);
      }
      refreshSlots();
      clearMsg();
    });
    serviceGrid.append(btn);
  }
}

function showMsg(text, type) {
  formMsg.textContent = text;
  formMsg.className = `form-msg show ${type}`;
}

function clearMsg() {
  formMsg.textContent = '';
  formMsg.className = 'form-msg';
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

function refreshSlots() {
  const date = selectedDate;

  if (!selectedMaster || !selectedService || !date) {
    resetSlots('Сначала выберите мастера, услугу и дату');
    return;
  }

  const slots = store.getFreeSlots(selectedMaster.id, date, selectedService.durationMin);

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
      submitBtn.disabled = false;
      clearMsg();
    });
    grid.append(btn);
  }
  slotsWrap.append(grid);
}

function renderReceipt(booking, master, service) {
  formMsg.replaceChildren();
  formMsg.className = 'form-msg show ok';

  const title = document.createElement('p');
  title.className = 'receipt-title';
  title.textContent = 'Готово! Запись подтверждена';
  formMsg.append(title);

  const rows = [
    ['Мастер', master.name],
    ['Услуга', service.name],
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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMsg();

  const masterId = selectedMaster ? selectedMaster.id : null;
  const serviceId = selectedService ? selectedService.id : null;
  const date = selectedDate;
  const clientName = nameInput.value.trim();
  const clientPhone = phoneInput.value.trim();

  if (!masterId || !serviceId || !date || !selectedSlot) {
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

  const result = store.createBooking({
    masterId,
    serviceId,
    date,
    startTime: selectedSlot,
    clientName,
    clientPhone,
  });

  if (!result.ok) {
    showMsg('Это время только что заняли - выберите другой слот', 'error');
    refreshSlots();
    return;
  }

  renderReceipt(result.booking, selectedMaster, selectedService);
  nameInput.value = '';
  phoneInput.value = '';
  refreshSlots();
});

renderPrice();
renderMasters();
renderMasterOptions();

for (const el of document.querySelectorAll('.section-head, .booking-shell, .contacts-grid > *')) {
  armReveal(el);
}

for (const [i, el] of Array.from(document.querySelectorAll('.work-photo')).entries()) {
  armReveal(el, i * 60);
}
