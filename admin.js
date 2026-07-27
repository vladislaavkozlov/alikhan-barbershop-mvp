import { createStore, createHttpBackend, getMasters, getServices } from './storage.js';

// Окно 8: роли теперь ограничены на бэкенде (не только в интерфейсе) - без токена
// сервер отдаёт /bookings в анонимной форме (без клиента вообще), поэтому админка
// без логина больше не может показать список записей. Токен живёт в localStorage
// этого браузера, getToken() читает его каждый раз заново - так после логина не
// нужно пересоздавать store.
const TOKEN_KEY = 'alikhan-crm:token';
const STAFF_KEY = 'alikhan-crm:staff';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function getStaff() {
  try {
    return JSON.parse(localStorage.getItem(STAFF_KEY) || 'null');
  } catch {
    return null;
  }
}
function setSession(token, staff) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STAFF_KEY);
}

// Тот же переключатель бэкенда, что в app.js - без window.ALIKHAN_API_URL админка
// продолжает работать по-старому на localStorage (только этого же браузера).
const store = createStore(window.ALIKHAN_API_URL ? createHttpBackend(window.ALIKHAN_API_URL, getToken) : undefined);
const masters = getMasters();
const services = getServices();

const loginGate = document.getElementById('loginGate');
const crmMain = document.getElementById('crmMain');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const sessionInfo = document.getElementById('sessionInfo');
const logoutBtn = document.getElementById('logoutBtn');

const ROLE_LABELS = { owner: 'владелец', admin: 'администратор точки', master: 'мастер' };

function showLoggedIn(staff) {
  loginGate.hidden = true;
  crmMain.hidden = false;
  sessionInfo.textContent = `${staff.name} · роль: ${ROLE_LABELS[staff.role] ?? staff.role}`;
  renderAll(undefined);
}

function showLoginForm(message) {
  crmMain.hidden = true;
  loginGate.hidden = false;
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  } else {
    loginError.hidden = true;
  }
}

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  try {
    const res = await fetch(`${window.ALIKHAN_API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin }),
    });
    if (!res.ok) {
      showLoginForm('Неверный email или PIN');
      return;
    }
    const data = await res.json();
    setSession(data.token, data.staff);
    showLoggedIn(data.staff);
  } catch (err) {
    showLoginForm(`Не удалось связаться с сервером: ${err.message}`);
  }
});

logoutBtn?.addEventListener('click', () => {
  clearSession();
  showLoginForm();
});

const existingStaff = getStaff();
if (window.ALIKHAN_API_URL && existingStaff && getToken()) {
  showLoggedIn(existingStaff);
} else if (window.ALIKHAN_API_URL) {
  showLoginForm();
} else {
  // Нет бэкенда (демо на чистом localStorage, без window.ALIKHAN_API_URL) - логин
  // не нужен, старое поведение до Окна 7/8 сохраняется как есть.
  crmMain.hidden = false;
  loginGate.hidden = true;
}

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

    // clientPhone отсутствует в ответе для роли "мастер" (Окно 8 - сервер физически
    // не отдаёт это поле, не просто прячет в интерфейсе) - "—" вместо буквального
    // "undefined" в ячейке.
    const cells = [
      booking.clientName ?? '—',
      'clientPhone' in booking ? booking.clientPhone : '— (скрыто для роли «мастер»)',
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
  try {
    await renderBookings(filterDate);
    await renderPayroll(filterDate);
  } catch (err) {
    if (String(err.message).includes('401')) {
      clearSession();
      showLoginForm('Сессия истекла, войдите заново');
      return;
    }
    throw err;
  }
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

// Первый рендер - только после логина (showLoggedIn выше) или сразу, если бэкенда
// нет вовсе (чистое демо на localStorage, логин не нужен) - см. блок с
// existingStaff/showLoginForm выше, он же решает, когда звать renderAll впервые.
