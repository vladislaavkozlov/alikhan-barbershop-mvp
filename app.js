import { createStore, getMasters, getServices } from './storage.js';

const store = createStore();
const masters = getMasters();
const services = getServices();

const priceGrid = document.getElementById('price-grid');
const mastersGrid = document.getElementById('masters-grid');
const form = document.getElementById('booking-form');
const masterSelect = document.getElementById('f-master');
const serviceSelect = document.getElementById('f-service');
const dateInput = document.getElementById('f-date');
const slotsWrap = document.getElementById('slots-wrap');
const nameInput = document.getElementById('f-name');
const phoneInput = document.getElementById('f-phone');
const submitBtn = document.getElementById('f-submit');
const formMsg = document.getElementById('form-msg');

let selectedSlot = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderPrice() {
  priceGrid.replaceChildren();
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
  }
}

function renderMasters() {
  mastersGrid.replaceChildren();
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
  }
}

function populateMasterSelect() {
  for (const master of masters) {
    const opt = document.createElement('option');
    opt.value = master.id;
    opt.textContent = `${master.name} (пример)`;
    masterSelect.append(opt);
  }
}

function populateServiceSelect() {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = 'Выберите услугу';
  serviceSelect.replaceChildren(placeholder);

  for (const service of services) {
    const opt = document.createElement('option');
    opt.value = service.id;
    opt.textContent = `${service.name} · ${service.priceLabel} · ${service.durationLabel}`;
    serviceSelect.append(opt);
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

function currentService() {
  return services.find((s) => s.id === serviceSelect.value);
}

function refreshSlots() {
  const masterId = masterSelect.value;
  const serviceId = serviceSelect.value;
  const date = dateInput.value;

  if (!masterId || !serviceId || !date) {
    resetSlots('Сначала выберите мастера, услугу и дату');
    return;
  }

  const service = currentService();
  const slots = store.getFreeSlots(masterId, date, service.durationMin);

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

masterSelect.addEventListener('change', () => {
  serviceSelect.disabled = false;
  dateInput.disabled = false;
  populateServiceSelect();
  resetSlots('Выберите услугу и дату');
  clearMsg();
});

serviceSelect.addEventListener('change', () => {
  refreshSlots();
  clearMsg();
});

dateInput.addEventListener('change', () => {
  refreshSlots();
  clearMsg();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMsg();

  const masterId = masterSelect.value;
  const serviceId = serviceSelect.value;
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
populateMasterSelect();
dateInput.min = todayStr();
