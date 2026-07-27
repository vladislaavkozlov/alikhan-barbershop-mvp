import { createStore, createHttpBackend, getMasters, getServices } from './storage.js';

// Тот же переключатель бэкенда, что в app.js - без window.ALIKHAN_API_URL админка
// продолжает работать по-старому на localStorage (только этого же браузера).
const store = createStore(window.ALIKHAN_API_URL ? createHttpBackend(window.ALIKHAN_API_URL) : undefined);
const masters = getMasters();
const services = getServices();

const masterById = (id) => masters.find((m) => m.id === id);
const serviceById = (id) => services.find((s) => s.id === id);

function formatMoney(value) {
  return `${Math.round(value).toLocaleString('ru-RU')}₽`;
}

async function renderBookings(filterDate) {
  const tbody = document.getElementById('bookingsBody');
  const emptyState = document.getElementById('bookingsEmpty');
  tbody.textContent = '';

  const raw = await store.listBookings(filterDate ? { date: filterDate } : {});
  const bookings = raw
    .slice()
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  if (bookings.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  for (const booking of bookings) {
    const master = masterById(booking.masterId);
    const service = serviceById(booking.serviceId);

    const tr = document.createElement('tr');

    const cells = [
      booking.clientName,
      booking.clientPhone,
      master ? master.name : booking.masterId,
      service ? service.name : booking.serviceId,
      booking.date,
      `${booking.startTime}–${booking.endTime}`,
    ];

    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

async function renderPayroll(filterDate) {
  const container = document.getElementById('payrollCards');
  container.textContent = '';

  for (const master of masters) {
    const range = filterDate
      ? await store.calcPayrollEstimate({ masterId: master.id, from: filterDate, to: filterDate })
      : await store.calcPayrollEstimate({ masterId: master.id });

    const card = document.createElement('article');
    card.className = 'payroll-card';

    const name = document.createElement('h3');
    name.textContent = master.name;
    if (master.isPlaceholder) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'пример';
      name.appendChild(badge);
    }
    card.appendChild(name);

    const total = document.createElement('p');
    total.className = 'payroll-total';
    total.textContent = `Оборот: ${formatMoney(range.total)}`;
    card.appendChild(total);

    const rangeLine = document.createElement('p');
    rangeLine.className = 'payroll-range';
    rangeLine.textContent = `Заработок: ${formatMoney(range.low)} – ${formatMoney(range.high)}`;
    card.appendChild(rangeLine);

    const note = document.createElement('p');
    note.className = 'payroll-note';
    note.textContent = 'ориентировочно, до уточнения реальных условий';
    card.appendChild(note);

    container.appendChild(card);
  }
}

async function renderAll(filterDate) {
  await renderBookings(filterDate);
  await renderPayroll(filterDate);
}

/* ---------- custom date picker (same component as index.html booking form) ----------
   Difference from the booking-form calendar: no past-date disabling - the owner needs
   to look up history, not just book ahead. */
const dateToggle = document.getElementById('date-toggle');
const dateToggleLabel = document.getElementById('date-toggle-label');
const datePopover = document.getElementById('date-popover');
const calPrev = document.getElementById('cal-prev');
const calNext = document.getElementById('cal-next');
const calMonthLabel = document.getElementById('cal-month-label');
const calGrid = document.getElementById('cal-grid');
const filterResetBtn = document.getElementById('filterReset');

const today = new Date();
let calViewYear = today.getFullYear();
let calViewMonth = today.getMonth();
let selectedFilterDate = null;

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

    if (iso === todayIso) btn.classList.add('today');
    if (iso === selectedFilterDate) btn.classList.add('selected');

    btn.addEventListener('click', () => {
      selectedFilterDate = iso;
      dateToggleLabel.textContent = formatDateRu(iso);
      dateToggleLabel.classList.remove('placeholder');
      closeDatePopover();
      renderCalendar();
      renderAll(selectedFilterDate);
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

filterResetBtn.addEventListener('click', () => {
  selectedFilterDate = null;
  dateToggleLabel.textContent = 'Все даты';
  dateToggleLabel.classList.add('placeholder');
  calViewYear = today.getFullYear();
  calViewMonth = today.getMonth();
  renderCalendar();
  renderAll(undefined);
});

renderAll(undefined);
