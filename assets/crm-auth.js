// Реальный вход в боевую базу (правка Влада 28.07.2026) поверх визуального макета
// Окна 9. Переиспользует ровно тот же контракт токена/localStorage-ключей, что уже
// работает в проде в admin.js (Окно 8) - если человек уже был залогинен через старую
// admin.html, сессия подхватится и здесь без повторного входа.
import { getMasters, getServices } from '../storage.js';

const API = window.ALIKHAN_API_URL;
const TOKEN_KEY = 'alikhan-crm:token';
const STAFF_KEY = 'alikhan-crm:staff';
const ROLE_LABELS = { owner: 'владелец', admin: 'администратор точки', master: 'мастер' };
const ROLE_PAGE = { owner: 'crm-owner.html', admin: 'crm-admin.html', master: 'crm-master.html' };

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function getStoredStaff() {
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

function el(id) {
  return document.getElementById(id);
}

function buildLoginGate() {
  const div = document.createElement('div');
  div.id = 'loginGate';
  div.className = 'login-gate';
  div.innerHTML = `
    <div class="login-card">
      <div class="login-brand">АЛИХАН</div>
      <p class="login-tag">CRM · вход в боевую базу</p>
      <form id="loginForm" novalidate>
        <div class="field"><label>Email</label><input id="loginEmail" type="email" required autocomplete="username"></div>
        <div class="field"><label>PIN</label><input id="loginPin" type="password" inputmode="numeric" required autocomplete="current-password"></div>
        <p id="loginError" class="login-error" hidden></p>
        <button class="btn btn-primary" type="submit">Войти</button>
      </form>
      <p class="login-hint">Настоящий вход в тестовый контур на Amvera - данные реальные, точка/мастера пока тестовые (будем переносить на боевой домен Алихана отдельно). Доступы - у Влада.</p>
    </div>`;
  document.body.prepend(div);
  return div;
}

async function apiLogin(email, pin) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error('Неверный email или PIN');
  return res.json();
}

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatMoney(value) {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

// Живое доказательство, что это не рисунок - реальный запрос к Postgres на Amvera
// при каждой загрузке страницы. /staff и /bookings уже сами фильтруют по роли на
// сервере (Окно 8) - владелец видит всех, мастер только себя, и т.д. Заодно, если на
// странице есть блоки реальной выручки/зарплаты (id ниже) - считаем и их из тех же
// данных, вместо статичного "000 ₽ пример" (правка Влада 28.07.2026).
async function renderLiveProof(staff) {
  const panel = el('liveProof');
  if (!panel) return;
  try {
    const [staffList, services, bookingsRes] = await Promise.all([
      fetchJson('/staff'),
      fetchJson('/services'),
      fetchJson(`/bookings?date=${todayStr()}`),
    ]);
    const bookings = bookingsRes.bookings || [];
    const bookingsNote =
      bookings.length === 0
        ? ' (тестовый контур, реальных клиентских записей ещё не вносили - это не баг)'
        : '';
    panel.innerHTML =
      `<span class="lp-dot"></span><strong>Живая боевая база (Amvera)</strong>` +
      `<span>сотрудников видно вам: ${staffList.length} · услуг в прайсе: ${services.length} · записей на сегодня в базе: ${bookings.length}${bookingsNote}</span>`;

    const priceOf = (serviceId) => services.find((s) => s.id === serviceId)?.price ?? 0;
    const ownerIds = new Set(staffList.filter((s) => s.role === 'owner').map((s) => s.id));

    // Владелец: "Выручка по точке → Все точки → День" - реальная сумма по всем бронькам
    // сегодня, зарплата - 45% от неё (пример-ставка, как и раньше), без брони владельца
    // самому себе (он комиссию не получает).
    const revenueEl = el('rvAllDayRevenue');
    const payrollEl = el('rvAllDayPayroll');
    const netEl = el('rvAllDayNet');
    if (revenueEl && payrollEl && netEl) {
      const revenue = bookings.reduce((sum, b) => sum + priceOf(b.serviceId), 0);
      const payrollBookings = bookings.filter((b) => !ownerIds.has(b.masterId));
      const payroll = payrollBookings.reduce((sum, b) => sum + priceOf(b.serviceId), 0) * 0.45;
      revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
      payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
      netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
    }

    // Мастер: "Моя зарплата → За день" - только его брони сегодня.
    const myPayrollEl = el('myPayrollDay');
    if (myPayrollEl) {
      const mine = bookings.filter((b) => b.masterId === staff.id);
      const myRevenue = mine.reduce((sum, b) => sum + priceOf(b.serviceId), 0);
      myPayrollEl.innerHTML = `${formatMoney(myRevenue * 0.45)} <span class="unsure">реально</span>`;
    }

    // Владелец/админ: карточка КАЖДОГО мастера в "Сотрудники" → "Расчёт ЗП → За
    // день" (правка 28.07.2026) - раньше показывала либо один общий плейсхолдер
    // (Али), либо "не установлена схема" (Мамед/Иван 3), теперь у каждого своя
    // реальная сумма по его же броням сегодня. master-1/2/3 = порядок мастеров в
    // /staff (Али/Мамед/Иван 3 в макете - косметические имена поверх этих id).
    ['master-1', 'master-2', 'master-3'].forEach((masterId, idx) => {
      const cardEl = el(`payrollMaster${idx + 1}Day`);
      if (!cardEl) return;
      const theirs = bookings.filter((b) => b.masterId === masterId);
      const theirRevenue = theirs.reduce((sum, b) => sum + priceOf(b.serviceId), 0);
      cardEl.innerHTML = `${formatMoney(theirRevenue * 0.45)} <span class="unsure">реально</span>`;
    });

    // Мастер: та же "Моя зарплата", но Неделя/Месяц (раньше "000 ₽ пример") -
    // переиспользуем годовой диапазон, который уже тянет renderRevenuePeriods для
    // владельца; для роли "мастер" его там нет, поэтому свой отдельный, но лёгкий
    // (masterId сужает выборку на сервере - см. GET /bookings) запрос за год.
    const myWeekEl = el('myPayrollWeek');
    const myMonthEl = el('myPayrollMonth');
    if (myWeekEl || myMonthEl) {
      try {
        const today = todayStr();
        const yearRes = await fetchJson(`/bookings?masterId=${staff.id}&from=${periodStartStr('year')}&to=${today}`);
        const mine = yearRes.bookings || [];
        const fillMine = (targetEl, start) => {
          if (!targetEl) return;
          const rows = mine.filter((b) => b.date >= start && b.date <= today);
          const sum = rows.reduce((s, b) => s + priceOf(b.serviceId), 0);
          targetEl.innerHTML = `${formatMoney(sum * 0.45)} <span class="unsure">реально</span>`;
        };
        fillMine(myWeekEl, periodStartStr('week'));
        fillMine(myMonthEl, periodStartStr('month'));
      } catch {
        // "000 ₽ пример" останется как было - основная ошибка уже видна в панели выше
      }
    }

    await renderRevenuePeriods(staffList, services, priceOf, ownerIds);
  } catch (err) {
    panel.classList.add('lp-error');
    panel.innerHTML = `<span class="lp-dot"></span><strong>Не удалось получить живые данные</strong><span>${err.message}</span>`;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function dateToStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "С начала периода по сегодня", не скользящее окно - Неделя с понедельника текущей
// недели, Месяц с 1 числа, Квартал с 1 числа текущего квартала, Год с 1 января. Тот
// же принцип, что и у "День" (= сегодняшний календарный день, не последние 24ч).
function periodStartStr(period) {
  const d = new Date();
  if (period === 'week') {
    const dow = (d.getDay() + 6) % 7; // 0 = понедельник
    d.setDate(d.getDate() - dow);
  } else if (period === 'month') {
    d.setDate(1);
  } else if (period === 'quarter') {
    d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1);
  } else if (period === 'year') {
    d.setMonth(0, 1);
  }
  return dateToStr(d);
}

// Владелец: вкладка "Выручка по точке" - Неделя/Месяц/Квартал/Год и разбивка по
// Точке 1/Точке 2 (правка 28.07.2026, см. miграция 003_staff_locations.sql - до неё
// у всех мастеров locationId был null, разбивка была честным плейсхолдером). Один
// запрос на весь год вместо отдельного на каждый день - дальше бакетируем на фронте.
async function renderRevenuePeriods(staffList, services, priceOf, ownerIds) {
  if (!el('rvAllWeekRevenue')) return; // элементов нет вне страницы владельца

  const today = todayStr();
  let bookings;
  try {
    const res = await fetchJson(`/bookings?from=${periodStartStr('year')}&to=${today}`);
    bookings = res.bookings || [];
  } catch {
    return; // "считаю…" останется как есть - основная ошибка уже показана в панели выше
  }

  const fill = (prefix, rows) => {
    const revenueEl = el(`${prefix}Revenue`);
    const payrollEl = el(`${prefix}Payroll`);
    const netEl = el(`${prefix}Net`);
    if (!revenueEl && !payrollEl && !netEl) return;
    const revenue = rows.reduce((sum, b) => sum + priceOf(b.serviceId), 0);
    const payroll = rows.filter((b) => !ownerIds.has(b.masterId)).reduce((sum, b) => sum + priceOf(b.serviceId), 0) * 0.45;
    if (revenueEl) revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
    if (payrollEl) payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
    if (netEl) netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
  };

  const todayRows = bookings.filter((b) => b.date === today);
  fill('rvLoc1Day', todayRows.filter((b) => b.locationId === 1));
  fill('rvLoc2Day', todayRows.filter((b) => b.locationId === 2));

  for (const [label, key] of [['Week', 'week'], ['Month', 'month'], ['Quarter', 'quarter'], ['Year', 'year']]) {
    const start = periodStartStr(key);
    const rows = bookings.filter((b) => b.date >= start && b.date <= today);
    fill(`rvAll${label}`, rows);
    fill(`rvLoc1${label}`, rows.filter((b) => b.locationId === 1));
    fill(`rvLoc2${label}`, rows.filter((b) => b.locationId === 2));
  }
}

export function initCrmAuth(requiredRole) {
  const gate = buildLoginGate();
  const main = el('crmMain');
  const sessionInfo = el('sessionInfo');
  const logoutBtn = el('logoutBtn');

  function reveal(staff) {
    gate.hidden = true;
    if (main) main.hidden = false;
    if (sessionInfo) sessionInfo.textContent = `${staff.name} · ${ROLE_LABELS[staff.role] ?? staff.role}`;
    if (logoutBtn) logoutBtn.hidden = false;
    // Влад 28.07.2026: у сотрудника в базе ровно одна роль (staff.role, без комбинирования) -
    // вкладки других ролей ведут в 404 или в чужой доступ, поэтому показываем только свою,
    // не весь переключатель. Раньше здесь были ссылки на все три роли всегда.
    document.querySelectorAll('#roleSwitch a[data-role]').forEach((a) => {
      a.hidden = a.dataset.role !== staff.role;
    });
    renderLiveProof(staff);
  }

  function handleStaff(staff) {
    if (staff.role !== requiredRole && staff.role !== 'owner') {
      location.href = ROLE_PAGE[staff.role] || 'crm-owner.html';
      return;
    }
    reveal(staff);
  }

  el('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = el('loginEmail').value.trim();
    const pin = el('loginPin').value.trim();
    const errEl = el('loginError');
    errEl.hidden = true;
    try {
      const data = await apiLogin(email, pin);
      setSession(data.token, data.staff);
      handleStaff(data.staff);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  logoutBtn?.addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  if (main) main.hidden = true;
  const existing = getStoredStaff();
  if (existing && getToken()) {
    handleStaff(existing);
  } else {
    gate.hidden = false;
  }
}

// Реэкспорт для отладки в консоли из макета, если понадобится (не используется UI).
window.__crmAuthDebug = { getMasters, getServices };
