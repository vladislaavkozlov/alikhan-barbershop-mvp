import { createStore, getMasters, getServices } from './storage.js';

const store = createStore();
const masters = getMasters();
const services = getServices();

const priceGrid = document.getElementById('price-grid');
const mastersGrid = document.getElementById('masters-grid');
const form = document.getElementById('booking-form');
const masterGrid = document.getElementById('master-grid');
const serviceGrid = document.getElementById('service-grid');
const dateInput = document.getElementById('f-date');
const slotsWrap = document.getElementById('slots-wrap');
const nameInput = document.getElementById('f-name');
const phoneInput = document.getElementById('f-phone');
const submitBtn = document.getElementById('f-submit');
const formMsg = document.getElementById('form-msg');

let selectedMaster = null;
let selectedService = null;
let selectedSlot = null;

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
      dateInput.disabled = false;
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
  const date = dateInput.value;

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

dateInput.addEventListener('change', () => {
  refreshSlots();
  clearMsg();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMsg();

  const masterId = selectedMaster ? selectedMaster.id : null;
  const serviceId = selectedService ? selectedService.id : null;
  const date = dateInput.value;
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

  showMsg(`Готово, ${result.booking.clientName} - запись на ${result.booking.date} в ${result.booking.startTime} сохранена`, 'ok');
  nameInput.value = '';
  phoneInput.value = '';
  refreshSlots();
});

renderPrice();
renderMasters();
renderMasterOptions();
dateInput.min = todayStr();

for (const el of document.querySelectorAll('.section-head, .booking-shell, .contacts-grid > *')) {
  armReveal(el);
}
