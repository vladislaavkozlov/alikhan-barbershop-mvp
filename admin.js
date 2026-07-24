import { createStore, getMasters, getServices } from './storage.js';

const store = createStore();
const masters = getMasters();
const services = getServices();

const masterById = (id) => masters.find((m) => m.id === id);
const serviceById = (id) => services.find((s) => s.id === id);

function formatMoney(value) {
  return `${Math.round(value).toLocaleString('ru-RU')}₽`;
}

function renderBookings(filterDate) {
  const tbody = document.getElementById('bookingsBody');
  const emptyState = document.getElementById('bookingsEmpty');
  tbody.textContent = '';

  const bookings = store
    .listBookings(filterDate ? { date: filterDate } : {})
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

function renderPayroll(filterDate) {
  const container = document.getElementById('payrollCards');
  container.textContent = '';

  for (const master of masters) {
    const range = filterDate
      ? store.calcPayrollEstimate({ masterId: master.id, from: filterDate, to: filterDate })
      : store.calcPayrollEstimate({ masterId: master.id });

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

function renderAll(filterDate) {
  renderBookings(filterDate);
  renderPayroll(filterDate);
}

function init() {
  const filterInput = document.getElementById('filterDate');
  const resetButton = document.getElementById('filterReset');

  filterInput.addEventListener('change', () => {
    renderAll(filterInput.value || undefined);
  });

  resetButton.addEventListener('click', () => {
    filterInput.value = '';
    renderAll(undefined);
  });

  renderAll(undefined);
}

document.addEventListener('DOMContentLoaded', init);
