// Реальный вход в боевую базу (правка Влада 28.07.2026) поверх визуального макета
// Окна 9. Переиспользует ровно тот же контракт токена/localStorage-ключей, что уже
// работает в проде в admin.js (Окно 8) - если человек уже был залогинен через старую
// admin.html, сессия подхватится и здесь без повторного входа.
import { getMasters, getServices, mergeServiceCombos, isServiceBlockedByCombo } from '../storage.js';
import { wireNotifications } from './crm-notifications.js';
import { renderDayCalendar } from './crm-calendar.js';
import { wireScheduleViews } from './crm-schedule-views.js';

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

// Правка 03.08.2026: время перерыва/графика раньше вписывалось вручную текстом
// (<input type="text" placeholder="13:00">) - не по теме сайта и без валидации.
// Переиспользует уже существующий кастомный дропдаун (toggleCustomSelect/
// pickCustomSelectOption, assets/mockup-crm.js), который раньше был только у
// "Закреплён за мастером" - те же классы, тот же визуальный язык, не новый виджет.
const SHOP_TIME_OPTIONS = (() => {
  const opts = [];
  for (let m = 10 * 60; m <= 20 * 60; m += 15) {
    opts.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return opts;
})();

function buildTimeSelectHtml(id, value) {
  const v = value || '13:00';
  const options = SHOP_TIME_OPTIONS.map(
    (t) => `<div class="custom-select-option${t === v ? ' selected' : ''}" onclick="pickCustomSelectOption(this)" data-value="${t}">${t}</div>`
  ).join('');
  return `<div class="custom-select" id="${id}" data-value="${v}">
    <button type="button" class="custom-select-trigger" onclick="toggleCustomSelect(this)">${v}</button>
    <div class="custom-select-list" hidden>${options}</div>
  </div>`;
}
// Рисует time-picker внутрь ПУСТОГО контейнера slotId (тот же id, что в разметке
// HTML вместо старого <input type="text">) - сам виджет .custom-select получает
// ОТДЕЛЬНЫЙ id (valueId), иначе id задвоился бы (контейнер + вложенный div с тем
// же id). Вызывающий код читает значение через timeSelectValue(valueId).
export function renderTimeSelect(slotId, valueId, value) {
  const container = el(slotId);
  if (!container) return;
  container.innerHTML = buildTimeSelectHtml(valueId, value);
}
export function timeSelectValue(id) {
  return el(id)?.dataset.value || null;
}

// Правка 03.08.2026 (Окно 16) - свой date-picker вместо нативного <input type="date">
// (см. КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md). Взаимодействие (открытие/закрытие,
// месячная сетка, клик по дню) - assets/mockup-crm.js (toggleCustomDate и рядом),
// тот же паттерн разделения, что уже есть у time-select выше. Формат value -
// "YYYY-MM-DD", как у нативного input, чтобы не менять остальной код, который его
// использует (сравнения дат строками уже работают в этом формате).
function buildDateWidgetHtml(id, value) {
  const v = value || todayStr();
  const [y, m, d] = v.split('-');
  return `<div class="custom-date" id="${id}" data-value="${v}" data-view-year="${y}" data-view-month="${m}">
    <button type="button" class="custom-date-trigger" onclick="toggleCustomDate(this)">${d}.${m}.${y}</button>
    <div class="custom-date-panel" hidden></div>
  </div>`;
}
export function renderDateSelect(slotOrId, valueId, value) {
  const container = typeof slotOrId === 'string' ? el(slotOrId) : slotOrId;
  if (!container) return;
  container.innerHTML = buildDateWidgetHtml(valueId, value);
}
export function dateSelectValue(id) {
  return el(id)?.dataset.value || null;
}

// Правка 03.08.2026 (Окно 16): "Задать период" в карточках ЗП (владелец/админ - по
// мастеру, свой "Моя зарплата" у мастера) раньше был <input type="date"> без id,
// найденный позиционно (первый/второй в панели) - renderStaffPayrollPeriods и
// wireMasterPayrollPeriod ниже (Окно 37, 06.08.2026 - заменила calcCustomPayroll
// из mockup-crm.js) так и продолжают искать позиционно, просто внутри .custom-date
// вместо input. Здесь только рендер виджетов в пустые слоты .payroll-date-slot -
// один проход на всю страницу, сколько бы панелей ни было.
function wirePayrollDateSlots() {
  document.querySelectorAll('.payroll-date-slot').forEach((slot, i) => {
    if (slot.dataset.wired) return;
    slot.dataset.wired = '1';
    renderDateSelect(slot, `payrollDate-${i}`, todayStr());
  });
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
      <p class="login-hint">Настоящий вход в тестовый контур - данные реальные, точка/мастера пока тестовые (будем переносить на боевой домен Алихана отдельно). Доступы - у Влада.</p>
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

export async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// Окно 18 (04.08.2026) - общий helper для POST/PUT/DELETE с тем же токеном, что уже
// использует fetchJson (GET) - Неделя/Месяц/Год (assets/crm-schedule-views.js) не
// дублируют логику Authorization-заголовка. Возвращает {ok, status, data} - вызывающий
// код сам решает, что делать с 409/403/etc (разные экраны показывают конфликт по-разному).
export async function apiSend(path, method, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // тело может быть пустым (например 204) - не считается ошибкой парсинга
  }
  return { ok: res.ok, status: res.status, data };
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatMoney(value) {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

// Окно 11 (найдено Владом 30.07.2026): бронь может содержать НЕСКОЛЬКО услуг -
// b.serviceIds (см. GET /bookings, server.mjs) - сумма по всем, не одной. serviceId
// (единичное значение) остаётся страховкой на случай очень старых броней без
// booking_services. priceOf передаётся снаружи - у renderLiveProof и
// renderRevenuePeriods разные замыкания с одинаковой сигнатурой (masterId, serviceId) => price.
function bookingPrice(booking, priceOf) {
  const serviceIds = booking.serviceIds?.length ? booking.serviceIds : [booking.serviceId];
  return serviceIds.reduce((sum, id) => sum + priceOf(booking.masterId, id), 0);
}

// Живое доказательство, что это не рисунок - реальный запрос к Postgres на Amvera
// при каждой загрузке страницы. /staff и /bookings уже сами фильтруют по роли на
// сервере (Окно 8) - владелец видит всех, мастер только себя, и т.д. Заодно, если на
// странице есть блоки реальной выручки/зарплаты (id ниже) - считаем и их из тех же
// данных, вместо статичного "000 ₽ пример" (правка Влада 28.07.2026).
//
// Окно 10 (30.07.2026, разд.17.2/17.3 ТЗ): раньше цена бралась из общего /services
// (один прайс на всех) и ставка была захардкожена 0.45 для всех не-владельцев -
// оба предположения не подтвердились. Цена теперь по мастеру (/master-services,
// Елизавета дешевле Алиовсада/Мамедхана), ставка тоже по мастеру (/payroll-settings,
// master_payroll_settings: 100% у Алиовсада и Мамедхана, 40% по умолчанию у Елизаветы,
// редактируется владельцем) - обе таблицы уже фильтруют выдачу по роли на сервере.
async function renderLiveProof(staff) {
  try {
    const [staffList, services, bookingsRes, masterServices, payrollRows] = await Promise.all([
      fetchJson('/staff'),
      fetchJson('/services'),
      fetchJson(`/bookings?date=${todayStr()}`),
      fetchJson('/master-services'),
      fetchJson('/payroll-settings'),
    ]);
    const bookings = bookingsRes.bookings || [];

    // Цена конкретного мастера на конкретную услугу - master-services покрывает все
    // пары (сид миграции 002/004), общий прайс /services - только страховка на
    // случай пары, которую почему-то не завели.
    const priceOf = (masterId, serviceId) =>
      masterServices.find((r) => r.masterId === masterId && r.serviceId === serviceId)?.price ??
      services.find((s) => s.id === serviceId)?.price ??
      0;
    // Ставка мастера (100/100/40, редактируется владельцем) - сервер уже выдал
    // только те строки, которые видны текущей роли (себя/свою точку/всех).
    const pctByMaster = new Map(payrollRows.map((r) => [r.masterId, r.pct]));
    const pctOf = (masterId) => pctByMaster.get(masterId) ?? 0;
    const ownerIds = new Set(staffList.filter((s) => s.role === 'owner').map((s) => s.id));

    // Владелец: "Выручка по точке → Все точки → День" - реальная сумма по всем
    // бронькам сегодня, зарплата - по ставке КАЖДОГО мастера (не общий %), без брони
    // владельца самому себе (он комиссию не получает).
    const revenueEl = el('rvAllDayRevenue');
    const payrollEl = el('rvAllDayPayroll');
    const netEl = el('rvAllDayNet');
    if (revenueEl && payrollEl && netEl) {
      const revenue = bookings.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
      const payrollBookings = bookings.filter((b) => !ownerIds.has(b.masterId));
      const payroll = payrollBookings.reduce(
        (sum, b) => sum + (bookingPrice(b, priceOf) * pctOf(b.masterId)) / 100,
        0
      );
      revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
      payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
      netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
    }

    // Владелец/админ: карточка КАЖДОГО мастера в "Сотрудники" → "Расчёт ЗП → За
    // день" - реальная сумма по его же броням сегодня, своя цена и своя ставка.
    // master-1/2/3 = порядок мастеров в /staff (Алиовсад/Мамедхан/Елизавета в макете -
    // косметические имена поверх этих id).
    ['master-1', 'master-2', 'master-3'].forEach((masterId, idx) => {
      const cardEl = el(`payrollMaster${idx + 1}Day`);
      if (!cardEl) return;
      const theirs = bookings.filter((b) => b.masterId === masterId);
      const theirRevenue = theirs.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
      cardEl.innerHTML = `${formatMoney((theirRevenue * pctOf(masterId)) / 100)} <span class="unsure">реально</span>`;
    });

    // Мастер: "Моя зарплата" (День/Неделя/Месяц) - Окно 37 (06.08.2026, Задача 2).
    // Раньше День считался локально (bookingPrice×pctOf по уже загруженным bookings
    // за сегодня), Неделя/Месяц - отдельным запросом /bookings?from&to с той же
    // формулой ещё раз. Два места, одна формула - именно то дублирование, которое
    // это окно убирает. Теперь все три - один и тот же вызов единого бэкенд-
    // резолвера (GET /payroll, computeMasterPayroll в api/server.mjs), различается
    // только диапазон дат. Владельца/админа (карточки выше, revenueEl/payrollEl)
    // не трогает - вне скоупа этого окна (см. crm-owner.html/crm-admin.html).
    const myPayrollDayEl = el('myPayrollDay');
    const myWeekEl = el('myPayrollWeek');
    const myMonthEl = el('myPayrollMonth');
    if (myPayrollDayEl || myWeekEl || myMonthEl) {
      const today = todayStr();
      const fillMyPayroll = async (targetEl, from, to) => {
        if (!targetEl) return;
        try {
          const { payroll } = await fetchJson(`/payroll?masterId=${staff.id}&from=${from}&to=${to}`);
          targetEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
        } catch {
          // "считаю…" останется как было - основная ошибка уже видна в панели выше
        }
      };
      await Promise.all([
        fillMyPayroll(myPayrollDayEl, today, today),
        fillMyPayroll(myWeekEl, periodStartStr('week'), today),
        fillMyPayroll(myMonthEl, periodStartStr('month'), today),
      ]);
    }

    // Владелец: поле "Ставка от выручки, %" в карточке Елизаветы (Окно 10,
    // разд.17.3 ТЗ) - реальное, читает и пишет master_payroll_settings. Не
    // автоматический порог 40→50%, владелец меняет число сам, когда сочтёт нужным.
    const pctInput = el('elizavetaPctInput');
    if (pctInput) {
      pctInput.value = pctOf('master-3');
      const saveBtn = el('elizavetaPctSave');
      const pctNote = el('elizavetaPctNote');
      if (saveBtn && !saveBtn.dataset.wired) {
        saveBtn.dataset.wired = '1';
        saveBtn.addEventListener('click', async () => {
          const pct = Number(pctInput.value);
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            if (pctNote) pctNote.textContent = 'Ставка должна быть числом от 0 до 100';
            return;
          }
          try {
            const res = await fetch(`${API}/payroll-settings`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ masterId: 'master-3', pct }),
            });
            if (!res.ok) throw new Error(`payroll-settings → ${res.status}`);
            if (pctNote) pctNote.textContent = `Сохранено: ${pct}%. Обновите страницу, чтобы увидеть новую сумму в "Расчёт ЗП"`;
          } catch (err) {
            if (pctNote) pctNote.textContent = `Не удалось сохранить: ${err.message}`;
          }
        });
      }
    }

    // Окно 15 (02.08.2026) - календарь "День" был статичной вёрсткой-примером, не
    // видел реальные брони (баг Влада - "запись на Екатерину не видна ни у неё, ни у
    // Али").
    await renderDayCalendar({ staff, staffList, services, priceOf, bookings, fetchJson, date: todayStr() });

    // Окно 18 (04.08.2026) - навигация "Мой день" + реальные Неделя/Месяц/Год
    // (crm-schedule-views.js получает готовые хелперы вместо собственного импорта
    // из этого файла - модули так и остаются без циклической зависимости друг на
    // друга, тот же приём, что уже применён у renderDayCalendar выше).
    wireScheduleViews({
      staff,
      staffList,
      services,
      priceOf,
      fetchJson,
      apiSend,
      renderDateSelect,
      renderTimeSelect,
      timeSelectValue,
      todayStr,
      renderDayCalendar,
    });

    wirePortfolioEditors(staffList);
    wireRoleEditors(staffList);
    wireBookingStatusRadios();
    ['master-1', 'master-2', 'master-3'].forEach((masterId) => {
      wireScheduleEditor(masterId, fetchJson);
      wireWeeklyScheduleEditor(masterId, staff.role === 'owner', fetchJson);
    });
    wireWalkIn(staff, services, masterServices);
    wireMasterSelfView(staff, pctOf);
    wireMasterSelfDataTab(staff, services, masterServices, pctOf);
    wireMasterServiceEditors(staff.role, services, masterServices);
    wirePayrollDateSlots();
    wireMasterPayrollPeriod(staff);

    await renderRevenuePeriods(priceOf, pctOf, ownerIds);
    await renderStaffPayrollPeriods(priceOf, pctOf, ownerIds);
  } catch (err) {
    console.error('Не удалось загрузить данные CRM:', err);
  }
}

// Задача 4 (Окно 13, 01.08.2026, разд.17.15 ТЗ) - портфолио мастера (стаж/сильные
// стороны/сертификаты/фото "до-после"), самредактируемые владельцем поля в карточке
// "Сотрудники" (crm-owner.html). Читает значения из уже загруженного /staff, пишет
// через PUT /staff/:id/portfolio (owner-only на сервере). Кнопок может не быть на
// странице (crm-admin.html/crm-master.html) - функция тогда no-op.
function wirePortfolioEditors(staffList) {
  document.querySelectorAll('.portfolio-save').forEach((btn) => {
    const masterId = btn.dataset.masterId;
    const expEl = el(`portfolioExperience-${masterId}`);
    const strEl = el(`portfolioStrengths-${masterId}`);
    const certEl = el(`portfolioCertificates-${masterId}`);
    const baEl = el(`portfolioBeforeAfter-${masterId}`);
    if (!expEl || !strEl || !certEl || !baEl) return;

    if (!btn.dataset.filled) {
      const staff = staffList.find((s) => s.id === masterId);
      if (staff) {
        expEl.value = staff.experienceText ?? '';
        strEl.value = staff.strengthsText ?? '';
        certEl.value = staff.certificatesText ?? '';
        baEl.value = staff.beforeAfterUrls ?? '';
      }
      btn.dataset.filled = '1';
    }

    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const noteEl = el(`portfolioNote-${masterId}`);
    btn.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API}/staff/${masterId}/portfolio`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            experienceText: expEl.value.trim() || null,
            strengthsText: strEl.value.trim() || null,
            certificatesText: certEl.value.trim() || null,
            beforeAfterUrls: baEl.value.trim() || null,
          }),
        });
        if (!res.ok) throw new Error(`staff/${masterId}/portfolio → ${res.status}`);
        if (noteEl) noteEl.textContent = 'Сохранено';
      } catch (err) {
        if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
      }
    });
  });
}

// Окно 36 (06.08.2026) - "Роль" в карточке сотрудника была набором чекбоксов
// ("Роли комбинируются"), хотя staff.role в схеме - одно значение, ни один клик
// никуда не отправлялся (PRODUCT_AUDIT_REPORT.md, разд. "Владелец"). Роут
// PUT /staff/:id/role уже существовал с Окна 14 (owner-only) - просто не был
// вызван отсюда. Тот же паттерн, что wirePortfolioEditors выше: читает текущее
// значение из уже загруженного /staff один раз (dataset.filled), пишет на change.
const ROLE_SUMMARY_LABEL = { owner: 'Владелец', admin: 'Администратор', master: 'Мастер' };
function wireRoleEditors(staffList) {
  document.querySelectorAll('.role-select').forEach((select) => {
    const masterId = select.dataset.masterId;
    if (!select.dataset.filled) {
      const staff = staffList.find((s) => s.id === masterId);
      if (staff) select.value = staff.role;
      select.dataset.filled = '1';
    }

    if (select.dataset.wired) return;
    select.dataset.wired = '1';
    const noteEl = el(`roleNote-${masterId}`);
    const labelEl = el(`roleLabel-${masterId}`);
    select.addEventListener('change', async () => {
      const prevValue = select.dataset.lastValue ?? select.value;
      const nextValue = select.value;
      select.disabled = true;
      try {
        const res = await fetch(`${API}/staff/${masterId}/role`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ role: nextValue }),
        });
        if (!res.ok) throw new Error(`staff/${masterId}/role → ${res.status}`);
        select.dataset.lastValue = nextValue;
        if (noteEl) noteEl.textContent = 'Сохранено';
        if (labelEl) labelEl.textContent = ROLE_SUMMARY_LABEL[nextValue] ?? nextValue;
      } catch (err) {
        select.value = prevValue;
        if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        select.disabled = false;
      }
    });
    select.dataset.lastValue = select.value;
  });
}

// Влад (03.08.2026): "+ Добавить перерыв"/"+ Добавить отпуск" в карточке
// сотрудника (Окно 9) были рисунком - только дописывали DOM, ничего не сохраняли,
// поэтому перерыв "числился" в интерфейсе, но не блокировал онлайн-запись клиента
// (реальный баг - "у Екатерины перерыв 13-14, но можно записаться на это время").
// Реальная схема хранит перерыв ПО ДАТЕ (schedule_shifts на пару master_id+date,
// не как повторяющееся правило "каждый день 13-14") - значит и редактор владельца
// должен просить дату, не изображать вечное еженедельное расписание. Пишет
// напрямую в POST /schedule (owner/admin, сервер уже сам уведомит через
// notifications, если пересечётся с реальной записью клиента - schedule_conflict).
// Элементов может не быть на странице (crm-master.html/страницы без карточки этого
// мастера) - тогда для конкретного masterId просто no-op, тот же паттерн, что у
// wirePortfolioEditors выше.
function wireScheduleEditor(masterId, fetchJson) {
  const currentEl = el(`schedCurrent-${masterId}`);
  if (!currentEl) return;
  const dateFromSlot = el(`schedDateFrom-${masterId}-slot`);
  const saveBtn = el(`schedSave-${masterId}`);

  // crm-admin.html: только просмотр (график ставит владелец) - нет формы
  // редактирования на странице, просто показываем сегодняшние реальные данные.
  if (!dateFromSlot || !saveBtn) {
    if (currentEl.dataset.wired) return;
    currentEl.dataset.wired = '1';
    fetchJson(`/schedule?masterId=${masterId}&date=${todayStr()}`)
      .then((shifts) => {
        const shift = shifts.find((s) => s.date === todayStr());
        const isFullDayOff = shift?.breaks?.some((b) => b.startTime <= '10:00' && b.endTime >= '20:00');
        if (!shift || !shift.breaks?.length) {
          currentEl.innerHTML = '<span class="note">Сегодня перерывов/выходного не задано (стандартные часы 10:00-20:00)</span>';
        } else if (isFullDayOff) {
          currentEl.innerHTML = '<div class="break-row"><span class="note" style="flex:1">Выходной весь день</span></div>';
        } else {
          currentEl.innerHTML = shift.breaks
            .map((b) => `<div class="break-row"><span class="note" style="flex:1">Перерыв ${b.startTime}–${b.endTime}</span></div>`)
            .join('');
        }
      })
      .catch((err) => {
        currentEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
      });
    return;
  }

  const dayOffEl = el(`schedDayOff-${masterId}`);
  const timeFieldsEl = el(`schedTimeFields-${masterId}`);
  const noteEl = el(`schedNote-${masterId}`);
  if (saveBtn.dataset.wired) return;
  saveBtn.dataset.wired = '1';

  // Правка 03.08.2026 (Окно 16): было <input type="date"> - свой date-picker, тот же
  // паттерн slot/value id, что уже есть у time-select ниже.
  renderDateSelect(`schedDateFrom-${masterId}-slot`, `schedDateFrom-${masterId}`, todayStr());
  renderDateSelect(`schedDateTo-${masterId}-slot`, `schedDateTo-${masterId}`, todayStr());
  const dateFromEl = el(`schedDateFrom-${masterId}`);
  // Правка 03.08.2026: было <input type="text" placeholder="13:00"> - вручную
  // вписывать время не по теме сайта и без валидации. Тот же кастомный дропдаун,
  // что уже используется у "Закреплён за мастером".
  renderTimeSelect(`schedStart-${masterId}-slot`, `schedStart-${masterId}`, '13:00');
  renderTimeSelect(`schedEnd-${masterId}-slot`, `schedEnd-${masterId}`, '14:00');

  async function loadCurrent() {
    const date = dateSelectValue(`schedDateFrom-${masterId}`) || todayStr();
    currentEl.innerHTML = '<span class="note">загружаю…</span>';
    try {
      const shifts = await fetchJson(`/schedule?masterId=${masterId}&date=${date}`);
      const shift = shifts.find((s) => s.date === date);
      const isFullDayOff = shift?.breaks?.some((b) => b.startTime <= '10:00' && b.endTime >= '20:00');
      if (!shift || !shift.breaks?.length) {
        currentEl.innerHTML = '<span class="note">На эту дату перерывов/выходного не задано (стандартные часы 10:00-20:00)</span>';
      } else if (isFullDayOff) {
        currentEl.innerHTML = '<div class="break-row"><span class="note" style="flex:1">Выходной весь день</span><button class="remove-x" type="button" aria-label="Убрать" data-clear-date="' + date + '">✕</button></div>';
      } else {
        currentEl.innerHTML = shift.breaks
          .map((b) => `<div class="break-row"><span class="note" style="flex:1">Перерыв ${b.startTime}–${b.endTime}</span><button class="remove-x" type="button" aria-label="Убрать" data-clear-date="${date}">✕</button></div>`)
          .join('');
      }
      currentEl.querySelectorAll('[data-clear-date]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await fetch(`${API}/schedule`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ masterId, date: btn.dataset.clearDate, startTime: '10:00', endTime: '20:00', breaks: [] }),
            });
            loadCurrent();
          } catch (err) {
            if (noteEl) noteEl.textContent = `Не удалось убрать: ${err.message}`;
          }
        });
      });
    } catch (err) {
      currentEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }
  loadCurrent();
  dateFromEl.addEventListener('customdate:change', loadCurrent);

  const syncTimeFields = () => {
    if (timeFieldsEl) timeFieldsEl.style.display = dayOffEl?.checked ? 'none' : '';
  };
  syncTimeFields();
  dayOffEl?.addEventListener('change', syncTimeFields);

  saveBtn.addEventListener('click', async () => {
    const dateFrom = dateSelectValue(`schedDateFrom-${masterId}`) || todayStr();
    const dateTo = dateSelectValue(`schedDateTo-${masterId}`) || dateFrom;
    if (dateTo < dateFrom) {
      if (noteEl) noteEl.textContent = 'Дата "по" раньше даты "с"';
      return;
    }
    const isDayOff = dayOffEl?.checked;
    const breakStart = isDayOff ? '10:00' : timeSelectValue(`schedStart-${masterId}`);
    const breakEnd = isDayOff ? '20:00' : timeSelectValue(`schedEnd-${masterId}`);
    if (!isDayOff && (!breakStart || !breakEnd)) {
      if (noteEl) noteEl.textContent = 'Укажите время перерыва (с и до)';
      return;
    }
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = 'Сохраняю…';
    if (noteEl) noteEl.textContent = '';
    try {
      let totalConflicts = 0;
      for (let d = new Date(`${dateFrom}T00:00:00Z`); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const res = await fetch(`${API}/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId,
            date: dateStr,
            startTime: '10:00',
            endTime: '20:00',
            breaks: [{ startTime: breakStart, endTime: breakEnd }],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        totalConflicts += data.conflicts || 0;
      }
      if (noteEl) {
        noteEl.textContent = totalConflicts
          ? `Сохранено. На это время уже есть ${totalConflicts} реальных записей - в колокольчике уведомлений появилось, с кем связаться`
          : 'Сохранено';
      }
      loadCurrent();
    } catch (err) {
      if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  });
}

// Окно 16 (03.08.2026) - единый блок "График работы": одна строка на каждый день
// недели (переключатель рабочий/выходной, рабочее окно, опциональный перерыв), по
// образцу Google Calendar "Working hours" (референс одобрен Владом). Заменяет
// прежние разрозненные "Рабочее время" (readonly-заглушка) + декоративный
// dayoff-picker + отдельный блок "Перерыв/выходной стандартный". Владелец правит
// НАПРЯМУЮ (PUT /master-weekly-schedule, тот же уровень доступа, что у
// wireScheduleEditor для разовых дат). canEdit=false (crm-admin.html, и с Окна 19 -
// crm-master.html тоже) - только просмотр, без формы. Мастер видит свой график
// исключительно на чтение - см. renderWeeklySelfReadOnly ниже (crm-master.html).
// Структуру теперь меняет только владелец/админ напрямую (решение Окна 17,
// реализовано Окном 19) - мастер больше не может отправить запрос на график.
//
// Окно 27 (04.08.2026) - 7 крупных вертикальных карточек занимали много места
// (обсуждено с Владом). Разметка самой карточки (canEdit=true) не изменилась - её
// теперь просто оборачивает изначально скрытая панель (см. weekly-day-panel ниже),
// раскрываемая кликом по компактной иконке дня (buildWeekdayIconStrip/
// wireWeekdayIconStrip). readonly-ветка (canEdit=false) уже была компактной (одна
// строка на день) - её не трогаем, это вне зоны этого окна.
function buildWeeklyDayRow(prefix, wd, day, canEdit) {
  const isWorking = day?.isWorking ?? true;
  const hasBreak = !!day?.breakStart;
  const workStart = day?.workStart || '10:00';
  const workEnd = day?.workEnd || '20:00';
  const breakStart = day?.breakStart || '13:00';
  const breakEnd = day?.breakEnd || '14:00';
  if (!canEdit) {
    const desc = isWorking
      ? `${workStart}–${workEnd}${hasBreak ? ` (перерыв ${breakStart}–${breakEnd})` : ''}`
      : 'выходной';
    return `<div class="break-row"><span class="note" style="flex:1">${WEEKDAY_SHORT[wd - 1]}: ${desc}</span></div>`;
  }
  return `
    <div class="weekly-day-row${isWorking ? '' : ' is-off'}" id="${prefix}-${wd}-row" data-weekday="${wd}">
      <div class="toggle-row">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="tr-label">${WEEKDAY_SHORT[wd - 1]}</div>
          <span class="day-off-badge" id="${prefix}-${wd}-offBadge" style="${isWorking ? 'display:none' : ''}">Выходной</span>
        </div>
        <label class="switch"><input type="checkbox" id="${prefix}-${wd}-working" ${isWorking ? 'checked' : ''}><span class="track"></span><span class="knob"></span></label>
      </div>
      <div class="field-grid" id="${prefix}-${wd}-fields" style="max-width:420px;${isWorking ? '' : 'display:none'}">
        <div class="field"><label>Работает с</label><div id="${prefix}-${wd}-start-slot"></div></div>
        <div class="field"><label>до</label><div id="${prefix}-${wd}-end-slot"></div></div>
      </div>
      <div class="toggle-row" id="${prefix}-${wd}-breakToggleWrap" style="${isWorking ? '' : 'display:none'}">
        <div class="tr-label">Перерыв</div>
        <label class="switch"><input type="checkbox" id="${prefix}-${wd}-breakOn" ${hasBreak ? 'checked' : ''}><span class="track"></span><span class="knob"></span></label>
      </div>
      <div class="field-grid" id="${prefix}-${wd}-breakFields" style="max-width:420px;${isWorking && hasBreak ? '' : 'display:none'}">
        <div class="field"><label>Перерыв с</label><div id="${prefix}-${wd}-breakStart-slot"></div></div>
        <div class="field"><label>до</label><div id="${prefix}-${wd}-breakEnd-slot"></div></div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm weekly-apply-all-btn" id="${prefix}-${wd}-applyAll" style="${isWorking && hasBreak ? '' : 'display:none'}">Применить ко всем дням</button>
    </div>`;
}
// Окно 27 (04.08.2026, Задача 1) - компактная строка из 7 круглых переключателей
// Пн-Вс над панелями дней. Клик раскрывает/сворачивает панель этого дня
// (toggleDayPanel) - остальные панели при этом закрываются (один открытый день за
// раз, тот же паттерн, что уже есть у details.staff-card в разметке владельца).
function buildWeekdayIconStrip(prefix, days) {
  return `<div class="weekday-icon-strip">${days
    .map((d, i) => {
      const wd = i + 1;
      const isWorking = d?.isWorking ?? true;
      return `<button type="button" class="weekday-icon${isWorking ? ' is-working' : ' is-off'}" id="${prefix}-${wd}-icon" data-weekday="${wd}" aria-expanded="false" aria-controls="${prefix}-${wd}-panel" title="${WEEKDAY_SHORT[wd - 1]}, ${isWorking ? 'рабочий день' : 'выходной'}">${WEEKDAY_SHORT[wd - 1]}</button>`;
    })
    .join('')}</div>`;
}
function toggleDayPanel(prefix, wd) {
  for (let i = 1; i <= 7; i++) {
    const panel = el(`${prefix}-${i}-panel`);
    const icon = el(`${prefix}-${i}-icon`);
    if (!panel || !icon) continue;
    const shouldOpen = i === wd ? !panel.classList.contains('is-open') : false;
    panel.classList.toggle('is-open', shouldOpen);
    icon.setAttribute('aria-expanded', String(shouldOpen));
  }
}
function wireWeekdayIconStrip(prefix) {
  for (let wd = 1; wd <= 7; wd++) {
    const icon = el(`${prefix}-${wd}-icon`);
    if (icon) icon.addEventListener('click', () => toggleDayPanel(prefix, wd));
  }
}
// Окно 27 (04.08.2026, Задача 2) - копирует перерыв (время начала/конца) дня sourceWd
// на все ОСТАЛЬНЫЕ рабочие дни недели этого мастера. Дни-выходные пропускает (для
// них перерыв не имеет смысла). Не сохраняет на сервер сама - это делает общая кнопка
// "Сохранить график" (el(`${prefix}-save`)), поэтому применённые значения можно потом
// вручную переопределить на конкретный день перед сохранением. Возвращает число дней,
// на которые реально скопировано (для короткой обратной связи в UI).
function applyBreakToAllDays(prefix, sourceWd) {
  const breakStart = timeSelectValue(`${prefix}-${sourceWd}-breakStart`);
  const breakEnd = timeSelectValue(`${prefix}-${sourceWd}-breakEnd`);
  let applied = 0;
  for (let wd = 1; wd <= 7; wd++) {
    if (wd === sourceWd) continue;
    const workingEl = el(`${prefix}-${wd}-working`);
    if (!workingEl?.checked) continue;
    const breakOnEl = el(`${prefix}-${wd}-breakOn`);
    breakOnEl.checked = true;
    el(`${prefix}-${wd}-breakFields`).style.display = '';
    const applyAllBtn = el(`${prefix}-${wd}-applyAll`);
    if (applyAllBtn) applyAllBtn.style.display = '';
    renderTimeSelect(`${prefix}-${wd}-breakStart-slot`, `${prefix}-${wd}-breakStart`, breakStart);
    renderTimeSelect(`${prefix}-${wd}-breakEnd-slot`, `${prefix}-${wd}-breakEnd`, breakEnd);
    applied += 1;
  }
  return applied;
}
function wireWeeklyDayRow(prefix, wd, day) {
  renderTimeSelect(`${prefix}-${wd}-start-slot`, `${prefix}-${wd}-start`, day?.workStart || '10:00');
  renderTimeSelect(`${prefix}-${wd}-end-slot`, `${prefix}-${wd}-end`, day?.workEnd || '20:00');
  renderTimeSelect(`${prefix}-${wd}-breakStart-slot`, `${prefix}-${wd}-breakStart`, day?.breakStart || '13:00');
  renderTimeSelect(`${prefix}-${wd}-breakEnd-slot`, `${prefix}-${wd}-breakEnd`, day?.breakEnd || '14:00');
  const workingEl = el(`${prefix}-${wd}-working`);
  const rowEl = el(`${prefix}-${wd}-row`);
  const offBadgeEl = el(`${prefix}-${wd}-offBadge`);
  const fieldsEl = el(`${prefix}-${wd}-fields`);
  const breakToggleWrap = el(`${prefix}-${wd}-breakToggleWrap`);
  const breakOnEl = el(`${prefix}-${wd}-breakOn`);
  const breakFieldsEl = el(`${prefix}-${wd}-breakFields`);
  const applyAllBtn = el(`${prefix}-${wd}-applyAll`);
  const syncWorking = () => {
    const working = workingEl.checked;
    rowEl.classList.toggle('is-off', !working);
    offBadgeEl.style.display = working ? 'none' : '';
    fieldsEl.style.display = working ? '' : 'none';
    breakToggleWrap.style.display = working ? '' : 'none';
    breakFieldsEl.style.display = working && breakOnEl.checked ? '' : 'none';
    if (applyAllBtn) applyAllBtn.style.display = working && breakOnEl.checked ? '' : 'none';
  };
  workingEl.addEventListener('change', syncWorking);
  breakOnEl.addEventListener('change', syncWorking);
  if (applyAllBtn) {
    applyAllBtn.addEventListener('click', () => {
      const n = applyBreakToAllDays(prefix, wd);
      const originalLabel = applyAllBtn.textContent;
      applyAllBtn.textContent = n > 0 ? `Скопировано на ${n} дн.` : 'Нет других рабочих дней';
      setTimeout(() => {
        if (applyAllBtn.isConnected) applyAllBtn.textContent = originalLabel;
      }, 2000);
    });
  }
}
function readWeeklyDayRow(prefix, wd) {
  const isWorking = el(`${prefix}-${wd}-working`).checked;
  const breakOn = isWorking && el(`${prefix}-${wd}-breakOn`).checked;
  return {
    weekday: wd,
    isWorking,
    workStart: isWorking ? timeSelectValue(`${prefix}-${wd}-start`) : null,
    workEnd: isWorking ? timeSelectValue(`${prefix}-${wd}-end`) : null,
    breakStart: breakOn ? timeSelectValue(`${prefix}-${wd}-breakStart`) : null,
    breakEnd: breakOn ? timeSelectValue(`${prefix}-${wd}-breakEnd`) : null,
  };
}
// Русский список конфликтующих броней - общий формат ответа 409 schedule_conflict
// (server.mjs: findScheduleConflicts/findWeeklyScheduleConflicts) что здесь, что в
// модалке дня Месяца (assets/crm-schedule-views.js) - оба места рисуют его этой же
// функцией, чтобы формат не разошёлся. conflicts - [{date, conflicts:[{start_time,
// end_time, client_name, client_phone}]}] - именно snake_case (сырые колонки SQL,
// не переименованы на сервере в camelCase, см. server.mjs).
export function formatScheduleConflicts(conflictsByDate) {
  return conflictsByDate
    .map(({ date, conflicts }) => {
      const [y, m, d] = date.split('-');
      const rows = conflicts
        .map((c) => `${c.start_time}–${c.end_time} · ${c.client_name || 'без имени'}${c.client_phone ? ' · ' + c.client_phone : ''}`)
        .join('<br>');
      return `<div class="conflict-day"><b>${d}.${m}.${y}</b><br>${rows}</div>`;
    })
    .join('');
}

// Окно 18 (04.08.2026, Задача 4) - дыра №1 отсюда же (найдена 03.08.2026): форма
// раньше просто оставляла в полях то, что ввёл владелец, и писала "Сохранено" не
// перепроверяя. Теперь после успешного PUT форма ВСЕГДА перезапрашивает
// /master-weekly-schedule заново и перерисовывает поля этим ответом - верит только
// тому, что подтвердил сервер. При 409 (конфликт с живой бронью, см. server.mjs
// PUT-обработчик) форма не считает сохранение успешным и показывает список
// конфликтов - тот же принцип блокировки, что уже действует у разовой правки дня.
function wireWeeklyScheduleEditor(masterId, canEdit, fetchJson) {
  const container = el(`weeklyEditor-${masterId}`);
  if (!container || container.dataset.wired) return;
  container.dataset.wired = '1';
  const prefix = `weekly-${masterId}`;

  async function load() {
    let rows;
    try {
      rows = await fetchJson(`/master-weekly-schedule?masterId=${masterId}`);
    } catch (err) {
      container.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
      return;
    }
    const byWeekday = new Map(rows.map((r) => [r.weekday, r]));
    const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => byWeekday.get(wd) || null);

    if (!canEdit) {
      container.innerHTML = `<div class="breaks-list">${days.map((d, i) => buildWeeklyDayRow(prefix, i + 1, d, false)).join('')}</div>`;
      return;
    }

    container.innerHTML =
      buildWeekdayIconStrip(prefix, days) +
      `<div class="weekly-panels">${days
        .map((d, i) => `<div class="weekly-day-panel" id="${prefix}-${i + 1}-panel">${buildWeeklyDayRow(prefix, i + 1, d, true)}</div>`)
        .join('')}</div>` +
      `<button class="btn btn-ghost btn-sm" type="button" id="${prefix}-save" style="margin-top:10px">Сохранить график</button>
       <p class="payroll-note" id="${prefix}-note"></p>
       <div class="conflict-list" id="${prefix}-conflicts" hidden></div>`;
    days.forEach((d, i) => wireWeeklyDayRow(prefix, i + 1, d));
    wireWeekdayIconStrip(prefix);

    el(`${prefix}-save`).addEventListener('click', async () => {
      const weeklyChanges = [1, 2, 3, 4, 5, 6, 7].map((wd) => readWeeklyDayRow(prefix, wd));
      const btn = el(`${prefix}-save`);
      const note = el(`${prefix}-note`);
      const conflictsEl = el(`${prefix}-conflicts`);
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = 'Сохраняю…';
      conflictsEl.hidden = true;
      note.textContent = '';
      try {
        const { ok, status, data } = await apiSend('/master-weekly-schedule', 'PUT', { masterId, weeklyChanges });
        if (status === 409 && data?.error === 'schedule_conflict') {
          note.textContent = 'Нельзя сохранить, пока не разберётесь с этими записями:';
          conflictsEl.innerHTML = formatScheduleConflicts(data.conflicts);
          conflictsEl.hidden = false;
          return;
        }
        if (!ok) throw new Error(`HTTP ${status}`);
        // Дыра №1: форма НЕ доверяет тому, что ввёл владелец - перезапрашивает
        // сервер и перерисовывает поля его ответом (load() ниже), даже если сервер
        // вернул ровно то же самое - гарантия важнее одного лишнего запроса.
        await load();
        const freshNote = el(`${prefix}-note`);
        if (freshNote) freshNote.textContent = 'Сохранено и подтверждено сервером';
      } catch (err) {
        note.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      }
    });
  }

  load();
}

// Задача Влада (01.08.2026): "Клиент без предварительной записи" была рисунком -
// кнопка ничего не сохраняла, список услуг был одинаковый для любого мастера, поле
// "мастер" - обычный текст, который нужно было вписывать руками. Реальная версия:
// мастер известен заранее (своя страница мастера - он сам; у владельца/админа -
// кнопка "+" в шапке колонки нужного мастера в расписании), список услуг - только
// те, что реально есть у ЭТОГО мастера в master-services (у мастеров разный прайс,
// см. миграцию 004), можно отметить несколько (Окно 11 - тот же контракт serviceIds,
// что и на публичном сайте). Сохранение - тот же POST /bookings, что использует
// сайт, статус сразу "пришёл" (PATCH /bookings/:id/status) - клиент физически уже
// в кресле, ждать подтверждения не у кого.
function wireWalkIn(staff, services, masterServices) {
  const form = el('walkinForm');
  const picker = el('wfServicePicker');
  const summary = el('wfSummary');
  const submitBtn = el('wfSubmit');
  const cancelBtn = el('wfCancel');
  const resultEl = el('wfResult');
  const nameLabel = el('wfMasterName');
  const clientNameEl = el('wfClientName');
  const clientPhoneEl = el('wfClientPhone');
  if (!form || !picker || !summary || !submitBtn || !cancelBtn || !resultEl || !nameLabel || !clientNameEl || !clientPhoneEl) {
    return; // страница без этого блока (или он ещё не дошёл до нужной страницы)
  }

  // Блок В (ТЗ-готовность-к-продакшену, 01.08.2026) - "Добавить продажу", POST /sales
  // уже готов и рабочий на бэкенде (owner/admin-only), просто не вызывался ни разу с
  // фронта. Единственное место с РЕАЛЬНЫМ booking id прямо сейчас - только что
  // созданная walk-in запись (см. ниже): статичный календарь ещё не подключён к
  // реальным данным (Блок В, "Календарь записей" - отдельная крупная задача), поэтому
  // продажу через клик по примерной карточке в календаре пока не привязать честно.
  // Элементов нет на crm-master.html (мастер не имеет доступа к /sales на сервере,
  // requireRole ['owner','admin']) - тогда всё ниже no-op.
  const saleForm = el('wfSaleForm');
  const saleItemEl = el('wfSaleItem');
  const saleAmountEl = el('wfSaleAmount');
  const saleSubmitBtn = el('wfSaleSubmit');
  const saleResultEl = el('wfSaleResult');
  const hasSaleForm = saleForm && saleItemEl && saleAmountEl && saleSubmitBtn && saleResultEl;

  let currentMasterId = null;
  let selected = new Set();
  const checkboxByService = new Map();

  const servicesFor = (masterId) =>
    masterServices
      .filter((r) => r.masterId === masterId)
      .map((r) => ({ ...r, name: services.find((s) => s.id === r.serviceId)?.name ?? r.serviceId }));

  // Правка 03.08.2026: та же логика комплекса "стрижка+борода", что теперь у
  // публичной записи (storage.js SERVICE_COMBOS) - выбор комплекса блокирует его
  // компоненты, отдельный выбор обоих компонентов сам сворачивается в комплекс.
  function syncCheckboxes() {
    for (const [serviceId, input] of checkboxByService) {
      const isSelected = selected.has(serviceId);
      input.checked = isSelected;
      input.disabled = !isSelected && isServiceBlockedByCombo(serviceId, selected);
      input.closest('.service-check')?.classList.toggle('service-check--blocked', input.disabled);
    }
  }

  function renderSummary() {
    const rows = servicesFor(currentMasterId).filter((r) => selected.has(r.serviceId));
    if (rows.length === 0) {
      summary.textContent = 'Выберите хотя бы одну услугу';
      submitBtn.disabled = true;
      return;
    }
    const totalMin = rows.reduce((s, r) => s + r.durationMin, 0);
    const totalPrice = rows.reduce((s, r) => s + r.price, 0);
    summary.textContent = `Выбрано услуг: ${rows.length} · итого ${totalMin} мин · ${formatMoney(totalPrice)}`;
    submitBtn.disabled = false;
  }

  function renderPicker(masterId) {
    picker.innerHTML = '';
    selected = new Set();
    checkboxByService.clear();
    const rows = servicesFor(masterId);
    if (rows.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'section-hint';
      hint.textContent = 'У этого мастера пока не назначено ни одной услуги в прайсе';
      picker.appendChild(hint);
    }
    for (const row of rows) {
      const label = document.createElement('label');
      label.className = 'service-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = row.serviceId;
      const span = document.createElement('span');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sc-name';
      nameSpan.textContent = row.name;
      const meta = document.createElement('span');
      meta.className = 'sc-meta';
      const priceSpan = document.createElement('span');
      priceSpan.className = 'sc-price';
      priceSpan.textContent = formatMoney(row.price);
      const dot = document.createElement('span');
      dot.className = 'sc-dot';
      dot.textContent = '·';
      const durationSpan = document.createElement('span');
      durationSpan.className = 'sc-duration';
      durationSpan.textContent = `${row.durationMin} мин`;
      meta.append(priceSpan, dot, durationSpan);
      span.append(nameSpan, meta);
      label.append(input, span);
      checkboxByService.set(row.serviceId, input);
      input.addEventListener('change', () => {
        if (isServiceBlockedByCombo(row.serviceId, selected)) {
          input.checked = false; // защита от гонки клика раньше, чем disabled применился
          return;
        }
        if (input.checked) selected.add(row.serviceId);
        else selected.delete(row.serviceId);
        selected = mergeServiceCombos(selected);
        syncCheckboxes();
        renderSummary();
      });
      picker.appendChild(label);
    }
    renderSummary();
  }

  function openForWalkin(masterId, masterName) {
    currentMasterId = masterId;
    nameLabel.textContent = masterName;
    clientNameEl.value = '';
    clientPhoneEl.value = '';
    resultEl.hidden = true;
    if (hasSaleForm) {
      saleForm.hidden = true;
      delete saleForm.dataset.bookingId;
      saleItemEl.value = '';
      saleAmountEl.value = '';
      saleResultEl.hidden = true;
    }
    renderPicker(masterId);
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // crm-master.html: единственный мастер - он и есть залогиненный сотрудник, выбирать не из чего
  const soloBtn = el('walkinSoloTrigger');
  if (soloBtn && !soloBtn.dataset.wired) {
    soloBtn.dataset.wired = '1';
    soloBtn.addEventListener('click', () => openForWalkin(staff.id, staff.name));
  }

  if (!cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', () => {
      form.hidden = true;
    });
  }

  if (!submitBtn.dataset.wired) {
    submitBtn.dataset.wired = '1';
    submitBtn.addEventListener('click', async () => {
      if (selected.size === 0 || !currentMasterId) return;
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Сохраняю…';
      try {
        const now = new Date();
        const rounded = new Date(Math.ceil(now.getTime() / (5 * 60000)) * 5 * 60000);
        const startTime = `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}`;
        const res = await fetch(`${API}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId: currentMasterId,
            serviceIds: [...selected],
            date: todayStr(),
            startTime,
            clientName: clientNameEl.value.trim() || null,
            clientPhone: clientPhoneEl.value.trim() || null,
            channel: 'admin',
          }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          throw new Error(data.reason === 'overlap' ? 'у мастера уже занято это время' : data.error || `HTTP ${res.status}`);
        }
        await fetch(`${API}/bookings/${encodeURIComponent(data.booking.id)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ status: 'done' }),
        });
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--ok';
        resultEl.textContent = `Готово: ${nameLabel.textContent}, ${startTime}, ${data.booking.totalDurationMin} мин, ${formatMoney(data.booking.totalPrice)}`;
        if (hasSaleForm) {
          saleForm.dataset.bookingId = data.booking.id;
          saleForm.hidden = false;
        }
        renderLiveProof(staff);
      } catch (err) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        submitBtn.disabled = selected.size === 0;
        submitBtn.textContent = originalLabel;
      }
    });
  }

  if (hasSaleForm && !saleSubmitBtn.dataset.wired) {
    saleSubmitBtn.dataset.wired = '1';
    saleSubmitBtn.addEventListener('click', async () => {
      const bookingId = saleForm.dataset.bookingId;
      const itemName = saleItemEl.value.trim();
      const amount = Number(saleAmountEl.value);
      if (!bookingId || !itemName || !Number.isFinite(amount) || amount <= 0) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        saleResultEl.textContent = 'Укажите название товара и сумму больше нуля';
        return;
      }
      const originalLabel = saleSubmitBtn.textContent;
      saleSubmitBtn.disabled = true;
      saleSubmitBtn.textContent = 'Сохраняю…';
      try {
        const res = await fetch(`${API}/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ bookingId, itemName, amount }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--ok';
        saleResultEl.textContent = `Продажа добавлена: ${itemName}, ${formatMoney(amount)}`;
        saleItemEl.value = '';
        saleAmountEl.value = '';
      } catch (err) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        saleResultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        saleSubmitBtn.disabled = false;
        saleSubmitBtn.textContent = originalLabel;
      }
    });
  }
}

// Правка 03.08.2026: карточка сотрудника "Сотрудники" (владелец/админ) держала
// чекбоксы услуг мастера и поле длительности как чистую декорацию - ни одного
// fetch, "включено"/"выключено" не переживало перезагрузку страницы, хотя
// master_services в базе уже поддерживала это с самого Окна 8 (см. отчёт сессии
// 03.08.2026). Контейнер должен быть <div class="service-picker" data-master-id="…">
// (пустой, без статичных чекбоксов - их рисует эта функция). Только владелец
// реально включает/выключает услугу и меняет длительность (`canEdit`) -
// администратор/просмотр видят то же самое read-only, тот же уровень доступа, что
// уже есть у wireMasterSelfDataTab для самого мастера.
function wireMasterServiceEditors(staffRole, services, masterServices) {
  const canEdit = staffRole === 'owner';
  document.querySelectorAll('.service-picker[data-master-id]').forEach((container) => {
    renderMasterServiceEditor(container, container.dataset.masterId, canEdit, services, masterServices);
  });
}

function renderMasterServiceEditor(container, masterId, canEdit, services, masterServices) {
  container.innerHTML = '';
  container.classList.toggle('readonly', !canEdit);
  const assigned = new Map(masterServices.filter((r) => r.masterId === masterId).map((r) => [r.serviceId, r]));
  const note = document.createElement('p');
  note.className = 'section-hint';
  note.hidden = true;

  for (const service of services) {
    const row = assigned.get(service.id);
    const label = document.createElement('label');
    label.className = 'service-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(row);
    input.disabled = !canEdit;

    const span = document.createElement('span');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'sc-name';
    nameSpan.textContent = service.name;
    const meta = document.createElement('span');
    meta.className = 'sc-meta';
    const priceSpan = document.createElement('span');
    priceSpan.className = 'sc-price';
    priceSpan.textContent = formatMoney(row ? row.price : service.price);
    const dot = document.createElement('span');
    dot.className = 'sc-dot';
    dot.textContent = '·';
    const durationSpan = document.createElement('span');
    durationSpan.className = 'sc-duration';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '5';
    durationInput.step = '5';
    durationInput.className = 'sc-duration-input';
    durationInput.value = row ? row.durationMin : service.durationMin;
    durationInput.disabled = !canEdit || !row;
    durationInput.addEventListener('click', (e) => e.stopPropagation());
    const durationUnit = document.createElement('span');
    durationUnit.className = 'sc-duration-unit';
    durationUnit.textContent = 'мин';
    durationSpan.append(durationInput, durationUnit);
    meta.append(priceSpan, dot, durationSpan);
    span.append(nameSpan, meta);
    label.append(input, span);
    container.appendChild(label);

    if (!canEdit) continue;

    async function save(enabled) {
      const body = enabled ? { enabled: true, durationMin: Number(durationInput.value) || service.durationMin } : { enabled: false };
      try {
        const res = await fetch(`${API}/master-services/${encodeURIComponent(masterId)}/${encodeURIComponent(service.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`master-services → ${res.status}`);
        note.hidden = true;
      } catch (err) {
        input.checked = !enabled; // откат чекбокса, если сервер/сеть отказали
        durationInput.disabled = !canEdit || !input.checked;
        note.hidden = false;
        note.textContent = `Не удалось сохранить «${service.name}»: ${err.message}`;
      }
    }

    input.addEventListener('change', () => {
      durationInput.disabled = !input.checked;
      save(input.checked);
    });
    durationInput.addEventListener('change', () => {
      if (input.checked) save(true);
    });
  }
  container.appendChild(note);
}

// Задача Б.1 (ТЗ-готовность-к-продакшену, 01.08.2026): crm-master.html хардкодил
// "Алиовсад" в location-badge / шапке колонки календаря / скрытом bk-master / тексте
// комиссии - ломалось для Мамедхана и Екатерины, если они реально зайдут в свой
// кабинет. Элементов может не быть на странице (crm-owner.html/crm-admin.html) -
// функция тогда no-op, тот же паттерн, что у wirePortfolioEditors выше. Клик по
// конкретной appt-карточке в календаре ниже всё ещё статичный макет (openBooking
// в mockup-crm.js читает data-master из HTML) - календарь целиком не подключён к
// реальным данным (отдельная крупная задача, см. ТЗ-готовность-к-продакшену, Блок В),
// эта функция чинит только то, что видно ДО открытия любой записи.
function wireMasterSelfView(staff, pctOf) {
  const badge = el('selfNameBadge');
  if (badge) badge.textContent = staff.name;

  const avatarEl = el('selfAvatar');
  if (avatarEl) avatarEl.textContent = staff.name.split(' ').map((p) => p[0]).join('').toUpperCase();

  const nameHeadEl = el('selfNameHead');
  if (nameHeadEl) nameHeadEl.textContent = `${staff.name} (вы)`;

  const bkMaster = el('bk-master');
  if (bkMaster) bkMaster.value = staff.name;

  // На crm-master.html весь календарь - это ТОЛЬКО записи залогиненного (у мастера
  // нет вкладок с другими сотрудниками) - все appt-карточки в статичном примере были
  // написаны под "Алиовсад" буквально. Подменяем data-master на реальное имя, иначе
  // клик по любой карточке (openBooking → updateCommission в mockup-crm.js) снова
  // покажет "Алиовсад - владелец" Мамедхану или Екатерине. Не затрагивает
  // crm-owner.html/crm-admin.html - там несколько мастеров в одном календаре по
  // назначению, .appt[data-master] там обязаны остаться разными.
  if (el('walkinSoloTrigger')) {
    document.querySelectorAll('.appt[data-master]').forEach((node) => {
      node.dataset.master = staff.name;
    });
  }

  const noteEl = el('bk-commission-note');
  if (noteEl) {
    if (staff.role === 'owner') {
      noteEl.textContent = `${staff.name} - владелец, комиссию самому себе не платит, вся сумма услуги и так остаётся в бизнесе`;
    } else {
      const pct = pctOf(staff.id);
      noteEl.textContent = `${pct}% от суммы услуги (ваша ставка) - показано для примера-записи выше, у реальной записи сумма своя`;
    }
  }
}

// Задача 2 (Окно 14, 02.08.2026) - вкладка "Личные данные" на crm-master.html:
// своя карточка сотрудника (портфолио редактируемо, услуги/ставка/график - только
// чтение, роль вообще не показываем). Элементов нет на crm-owner.html/crm-admin.html
// - тогда no-op.
function wireMasterSelfDataTab(staff, services, masterServices, pctOf) {
  const picker = el('selfServicePicker');
  if (!picker) return;

  const avatarEl = el('selfCardAvatar');
  if (avatarEl) avatarEl.textContent = staff.name.split(' ').map((p) => p[0]).join('').toUpperCase();
  const nameEl = el('selfCardName');
  if (nameEl) nameEl.textContent = staff.name;

  // Портфолио - переиспользуем wirePortfolioEditors как есть: переносим id-суффикс
  // "-self" на реальный staff.id, чтобы el(`portfolioExperience-${masterId}`) внутри
  // неё нашла именно эти поля.
  const saveBtn = el('selfPortfolioSaveBtn');
  if (saveBtn && saveBtn.dataset.masterId === 'self') {
    saveBtn.dataset.masterId = staff.id;
    ['portfolioExperience', 'portfolioStrengths', 'portfolioCertificates', 'portfolioBeforeAfter', 'portfolioNote'].forEach((prefix) => {
      const node = document.getElementById(`${prefix}-self`);
      if (node) node.id = `${prefix}-${staff.id}`;
    });
  }

  // Услуги - read-only список всех 8, отмечены те, что реально есть у ЭТОГО мастера
  // в master_services (назначает владелец в своей карточке "Сотрудники").
  const mine = new Map(masterServices.filter((r) => r.masterId === staff.id).map((r) => [r.serviceId, r]));
  picker.innerHTML = services
    .map((s) => {
      const row = mine.get(s.id);
      const checked = row ? 'checked' : '';
      const price = row ? `${row.price}₽` : s.priceLabel;
      const duration = row ? row.durationMin : s.durationMin;
      return `<label class="service-check"><input type="checkbox" ${checked} disabled><span><span class="sc-name">${s.name}</span><span class="sc-meta"><span class="sc-price">${price}</span><span class="sc-dot">·</span><span>${duration} мин</span></span></span></label>`;
    })
    .join('');

  // Ставка ЗП - владелец её не платит себе, у остальных - реальный % из
  // master_payroll_settings (тот же источник, что renderLiveProof уже читает).
  const rateEl = el('selfRateInput');
  if (rateEl) {
    rateEl.value = staff.role === 'owner' ? 'Не начисляется - вы владелец' : `${pctOf(staff.id)}%`;
  }

  renderWeeklySelfReadOnly(staff);
  wireScheduleRequestForm(staff);
}

// "Моя зарплата → Задать период" (мастер, crm-master.html) - Окно 37 (06.08.2026,
// Задача 2). Заменяет calcCustomPayroll (была в mockup-crm.js, глобальная
// onclick-функция без доступа к сессии/fetchJson - реально работать не могла,
// оставляла "000 ₽ пример"). Кнопка/поле дат уникальны для этой страницы (только
// crm-master.html их использовал), поэтому no-op на crm-owner.html/crm-admin.html -
// там свой отдельный обработчик в renderStaffPayrollPeriods выше, не трогается.
function wireMasterPayrollPeriod(staff) {
  const btn = el('myPayrollPeriodBtn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    const panel = btn.closest('.seg-panel');
    const dates = panel ? panel.querySelectorAll('.custom-date') : [];
    const from = dates[0]?.dataset.value;
    const to = dates[1]?.dataset.value;
    const amountEl = el('myPayrollPeriodAmount');
    if (!from || !to) {
      if (amountEl) amountEl.innerHTML = `— <span class="unsure">укажите обе даты (с и по)</span>`;
      return;
    }
    if (!amountEl) return;
    amountEl.innerHTML = `— <span class="unsure">считаю…</span>`;
    try {
      const { payroll } = await fetchJson(`/payroll?masterId=${staff.id}&from=${from}&to=${to}`);
      amountEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально, период ${from}–${to}</span>`;
    } catch (err) {
      amountEl.innerHTML = `— <span class="unsure">не удалось посчитать: ${err.message}</span>`;
    }
  });
}

// Форма "Разовое изменение на дату" (Задача 3, Окно 14, заголовок переименован
// Окно 16 03.08.2026 - было "Запросить перерыв/выходной") - POST /schedule-requests,
// владелец подтверждает/отклоняет отдельно (PATCH .../decision), время реально
// блокируется от онлайн-записи только после подтверждения. Только otgul/otpusk -
// механика не менялась (Окно 16, разд.31 промпта); постоянный график по дням
// недели теперь read-only, см. renderWeeklySelfReadOnly выше (Окно 19).
const SCHEDULE_CATEGORY_LABEL = {
  otgul: 'Отгул разовый',
  otpusk: 'Отпуск',
};
const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// "Мои запросы" - общая история для обеих форм (разовое изменение otgul/otpusk И
// постоянный график grafik_standard) - один и тот же список #reqHistory на
// странице, обе формы после отправки перезагружают его этой функцией.
async function loadScheduleRequestHistory(staffId) {
  const historyEl = el('reqHistory');
  if (!historyEl) return;
  try {
    const rows = await fetchJson(`/schedule-requests?masterId=${staffId}`);
    if (!rows.length) {
      historyEl.innerHTML = '<span class="note">Запросов пока нет</span>';
      return;
    }
    // cancelled добавлен Окном 23 (04.08.2026) - владелец может отменить уже одобренный
    // отгул/отпуск целиком (PATCH /schedule-requests/:id/cancel). Без этой строки фолбэк
    // `?? r.status` показывал бы мастеру сырое "cancelled" латиницей в русском интерфейсе.
    const statusLabel = { pending: 'На рассмотрении', approved: 'Одобрено', rejected: 'Отклонено', cancelled: 'Одобрение отменено' };
    historyEl.innerHTML = rows
      .map((r) => {
        if (r.category === 'grafik_standard') {
          return `<div class="break-row"><span class="note">Новый график · ${formatWeeklyChangesSummary(r.weeklyChanges || [])} · ${statusLabel[r.status] ?? r.status}${r.ownerComment ? ' · ' + r.ownerComment : ''}</span></div>`;
        }
        const period = r.requestType === 'day_off' ? `${r.dateFrom}–${r.dateTo}` : `${r.dateFrom} ${r.startTime}–${r.endTime}`;
        const label = SCHEDULE_CATEGORY_LABEL[r.category] ?? (r.requestType === 'day_off' ? 'Выходной' : 'Перерыв');
        return `<div class="break-row"><span class="note">${label} · ${period} · ${statusLabel[r.status] ?? r.status}${r.ownerComment ? ' · ' + r.ownerComment : ''}</span></div>`;
      })
      .join('');
  } catch (err) {
    historyEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
  }
}
function formatWeeklyChangesSummary(rows) {
  return [...rows]
    .sort((a, b) => a.weekday - b.weekday)
    .map((r) => {
      if (!r.isWorking) return `${WEEKDAY_SHORT[r.weekday - 1]} выходной`;
      const brk = r.breakStart ? ` (перерыв ${r.breakStart}–${r.breakEnd})` : '';
      return `${WEEKDAY_SHORT[r.weekday - 1]} ${r.workStart}–${r.workEnd}${brk}`;
    })
    .join(', ');
}

function wireScheduleRequestForm(staff) {
  const submitBtn = el('reqSubmitBtn');
  const categoryEl = el('reqCategory');
  const dateToWrap = el('reqDateToWrap');
  const fullDayWrap = el('reqFullDayWrap');
  const fullDayEl = el('reqFullDay');
  const timeFields = el('reqTimeFields');
  const commentEl = el('reqComment');
  const resultEl = el('reqResult');
  if (!submitBtn || !categoryEl || !commentEl || !resultEl) return;

  renderDateSelect('reqDateFrom-slot', 'reqDateFrom', todayStr());
  renderDateSelect('reqDateTo-slot', 'reqDateTo', todayStr());
  renderTimeSelect('reqStartTime-slot', 'reqStartTime', '13:00');
  renderTimeSelect('reqEndTime-slot', 'reqEndTime', '14:00');

  const syncFields = () => {
    const isOtgul = categoryEl.value === 'otgul';
    const isOtpusk = categoryEl.value === 'otpusk';
    const fullDayOff = isOtgul && fullDayEl?.checked;
    if (fullDayWrap) fullDayWrap.style.display = isOtgul ? '' : 'none';
    if (dateToWrap) dateToWrap.style.display = fullDayOff ? 'none' : '';
    // Отпуск - структурно всегда day_off (см. requestType ниже), поля времени
    // для него не должны показываться никогда, не только когда включён "На весь
    // день" (баг Окна 19: раньше показывались всегда, category==='otgul' в условии
    // требования короткого замыкания давал isOtgul=false для otpusk).
    if (timeFields) timeFields.style.display = fullDayOff || isOtpusk ? 'none' : '';
  };
  syncFields();
  categoryEl.addEventListener('change', syncFields);
  fullDayEl?.addEventListener('change', syncFields);

  loadScheduleRequestHistory(staff.id);

  if (submitBtn.dataset.wired) return;
  submitBtn.dataset.wired = '1';
  submitBtn.addEventListener('click', async () => {
    const category = categoryEl.value;
    const dateFrom = dateSelectValue('reqDateFrom');
    if (!dateFrom) {
      resultEl.textContent = 'Укажите дату';
      return;
    }
    // Баг Окна 19 (найден 04.08.2026): было `category === 'otgul' && fullDayEl?.checked` -
    // короткое замыкание на 'otgul' делало это условие ВСЕГДА ложным для 'otpusk',
    // отпуск уходил на сервер как requestType:'break' с конкретным временем (13:00-14:00
    // по умолчанию) вместо day_off на весь диапазон дат. Отпуск структурно не может
    // быть "на два часа" - всегда day_off, независимо от чекбокса "На весь день"
    // (который вообще не показывается для этой категории, см. syncFields выше).
    const requestType = category === 'otpusk' || (category === 'otgul' && fullDayEl?.checked) ? 'day_off' : 'break';
    const startTime = requestType === 'break' ? timeSelectValue('reqStartTime') : null;
    const endTime = requestType === 'break' ? timeSelectValue('reqEndTime') : null;
    if (requestType === 'break' && (!startTime || !endTime)) {
      resultEl.textContent = 'Укажите время (с и до)';
      return;
    }
    try {
      const res = await fetch(`${API}/schedule-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
          category,
          requestType,
          dateFrom,
          dateTo: dateSelectValue('reqDateTo') || dateFrom,
          startTime,
          endTime,
          masterComment: commentEl.value.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(`schedule-requests → ${res.status}`);
      resultEl.textContent = 'Запрос отправлен, владелец увидит уведомление';
      commentEl.value = '';
      loadScheduleRequestHistory(staff.id);
    } catch (err) {
      resultEl.textContent = `Не удалось отправить: ${err.message}`;
    }
  });
}

// Окно 16 (03.08.2026) отдавало мастеру форму со своей кнопкой "Отправить запрос
// на график" (POST /schedule-requests, category=grafik_standard) - владелец решил
// (см. промпт Окна 17), что структуру недельного графика меняет только он/админ
// напрямую (wireWeeklyScheduleEditor выше, тот же паттерн для чужой карточки на
// crm-owner.html). Окно 19 (04.08.2026) убирает у мастера саму возможность
// отправить правку - остаётся только просмотр той же строки buildWeeklyDayRow,
// что владелец уже использует для read-only карточки другого сотрудника
// (canEdit=false, см. crm-owner.html buildWeeklyDayRow(prefix, i+1, d, false)).
function renderWeeklySelfReadOnly(staff) {
  const container = el('weeklyEditor-self');
  if (!container || container.dataset.wired) return;
  container.dataset.wired = '1';
  const prefix = 'weekly-self';

  fetchJson(`/master-weekly-schedule?masterId=${staff.id}`)
    .then((rows) => {
      const byWeekday = new Map(rows.map((r) => [r.weekday, r]));
      const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => byWeekday.get(wd) || null);
      container.innerHTML = `<div class="breaks-list">${days.map((d, i) => buildWeeklyDayRow(prefix, i + 1, d, false)).join('')}</div>`;
    })
    .catch((err) => {
      container.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    });
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

// Владелец: вкладка "Выручка" - Неделя/Месяц/Квартал/Год (правка 28.07.2026). Один
// запрос на весь год вместо отдельного на каждый день - дальше бакетируем на
// фронте. priceOf/pctOf - те же функции по мастеру, что и в renderLiveProof (Окно 10).
// Разбивка по точкам убрана (Окно 13, 01.08.2026) - у Алихана одна точка, не две
// (уточнено самим Алиханом 01.08.2026), инфраструктура location_id в базе остаётся
// нетронутой на будущее (франшиза по городам, см. ТЗ-разработчику-корректировка).
async function renderRevenuePeriods(priceOf, pctOf, ownerIds) {
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
    const revenue = rows.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
    const payroll = rows
      .filter((b) => !ownerIds.has(b.masterId))
      .reduce((sum, b) => sum + (bookingPrice(b, priceOf) * pctOf(b.masterId)) / 100, 0);
    if (revenueEl) revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
    if (payrollEl) payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
    if (netEl) netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
  };

  for (const [label, key] of [['Week', 'week'], ['Month', 'month'], ['Quarter', 'quarter'], ['Year', 'year']]) {
    const start = periodStartStr(key);
    const rows = bookings.filter((b) => b.date >= start && b.date <= today);
    fill(`rvAll${label}`, rows);
  }
}

// Блок В (ТЗ-готовность-к-продакшену, 01.08.2026) - "ЗП по неделе/месяцу/периоду в
// карточках сотрудников" (не своя, у владельца/админа) была "000 ₽ пример" нерабочим
// текстом, даже с реально выбранными датами сумма не считалась. Та же логика уже
// работает во "Выручке" (renderRevenuePeriods выше) и в "Моей зарплате" мастера
// (myWeekEl/myMonthEl в renderLiveProof) - здесь тот же принцип bookingPrice+pctOf,
// но по каждой карточке сотрудника отдельно. Свой отдельный fetch годовых броней (не
// переиспользует renderRevenuePeriods) - та функция рано выходит на crm-admin.html
// (там нет вкладки "Выручка" вообще), а карточки сотрудников с ЗП есть и у owner, и у admin.
async function renderStaffPayrollPeriods(priceOf, pctOf, ownerIds) {
  const masterIds = ['master-1', 'master-2', 'master-3'];
  const hasAnyTarget = masterIds.some((id, idx) => el(`payrollMaster${idx + 1}Week`) || el(`payrollMaster${idx + 1}Month`));
  if (!hasAnyTarget) return;

  const today = todayStr();
  let bookings;
  try {
    const res = await fetchJson(`/bookings?from=${periodStartStr('year')}&to=${today}`);
    bookings = res.bookings || [];
  } catch {
    return; // "считаю…" останется как было - основная ошибка уже показана в панели выше
  }

  const amountFor = (masterId, rows) => {
    if (ownerIds.has(masterId)) return null; // владелец комиссию себе не начисляет
    const revenue = rows.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
    return (revenue * pctOf(masterId)) / 100;
  };
  const renderInto = (targetEl, masterId, rows) => {
    if (!targetEl) return;
    const amount = amountFor(masterId, rows);
    targetEl.innerHTML =
      amount === null
        ? `Не начисляется <span class="unsure">реально</span>`
        : `${formatMoney(amount)} <span class="unsure">реально</span>`;
  };

  masterIds.forEach((masterId, idx) => {
    const n = idx + 1;
    const weekEl = el(`payrollMaster${n}Week`);
    const monthEl = el(`payrollMaster${n}Month`);
    if (!weekEl && !monthEl) return;
    const rowsFor = (period) => {
      const start = periodStartStr(period);
      return bookings.filter((b) => b.masterId === masterId && b.date >= start && b.date <= today);
    };
    renderInto(weekEl, masterId, rowsFor('week'));
    renderInto(monthEl, masterId, rowsFor('month'));
  });

  // "Задать период" (владелец/админ, по мастеру) - реальный расчёт по произвольному
  // диапазону (data-master-id на кнопке, см. HTML). Свой отдельный обработчик от
  // wireMasterPayrollPeriod ниже (личная "Моя зарплата" мастера, crm-master.html,
  // Окно 37) - этот блок вне скоупа Окна 37, не тронут.
  document.querySelectorAll('.payroll-period-picker button[data-master-id]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const masterId = btn.dataset.masterId;
    btn.addEventListener('click', () => {
      const panel = btn.closest('.seg-panel');
      // Правка 03.08.2026 (Окно 16): было input[type="date"].value - теперь свой
      // date-picker (.custom-date), значение читается из data-value.
      const dates = panel.querySelectorAll('.custom-date');
      const from = dates[0]?.dataset.value;
      const to = dates[1]?.dataset.value;
      const amountEl = panel.querySelector('.payroll-sum .amount');
      const noteEl = panel.querySelector('.payroll-note');
      if (!from || !to) {
        if (noteEl) noteEl.textContent = 'Укажите обе даты (с и по), чтобы задать период';
        return;
      }
      const rows = bookings.filter((b) => b.masterId === masterId && b.date >= from && b.date <= to);
      if (amountEl) {
        const amount = amountFor(masterId, rows);
        amountEl.innerHTML =
          amount === null ? `Не начисляется <span class="unsure">реально</span>` : `${formatMoney(amount)} <span class="unsure">реально</span>`;
      }
      if (noteEl) noteEl.textContent = `Период ${from}–${to}: посчитано по реальным броням за этот диапазон`;
    });
  });
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
    wireNotifications(staff);
  }

  // Баг (найден Владом 02.08.2026): заход на crm-master.html с уже сохранённой в
  // браузере сессией владельца молча показывал владельца вместо формы входа -
  // "перекидывает в окно владельца" при попытке зайти в аккаунт мастера. Причина -
  // staff.role !== 'owner' ниже пропускал владельца мимо проверки роли страницы.
  // Различаем два случая: свежий логин (fromLogin=true, сразу после сабмита формы)
  // уводит на СВОЮ страницу по роли - это рабочий путь входа мастера/админа через
  // единственную публичную ссылку "Вход для сотрудников" (ведёт на crm-owner.html),
  // не трогаем. Восстановление СТАРОЙ сессии другой роли на чужой странице
  // (fromLogin не передан) больше не подставляет чужие данные и не молчит - чистит
  // сессию и показывает форму входа прямо на этой странице, чтобы можно было
  // сразу ввести данные нужной роли.
  function handleStaff(staff, fromLogin) {
    if (staff.role !== requiredRole) {
      if (fromLogin) {
        location.href = ROLE_PAGE[staff.role] || 'crm-owner.html';
      } else {
        clearSession();
        gate.hidden = false;
      }
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
      handleStaff(data.staff, true);
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

// Окно 36 (06.08.2026) - crm-owner.html СПЕЦИФИЧНО (промпт окна: "другие роли это
// окно не касается"). ВАЖНО: crm-admin.html и crm-master.html имеют СВОИ собственные
// радио с теми же id (bstatus/st-wait/st-came/st-no) и СВОЮ кнопку "Клиент не пришёл"
// (toggleNoShow ниже) - этот код их не касается и не должен. Owner-only гейт - через
// #bk-status-note, элемент существует ТОЛЬКО в crm-owner.html (добавлен этим же
// окном); без него функция no-op, тот же паттерн, что у wireMasterSelfView выше.
//
// Аудит (PRODUCT_AUDIT_REPORT.md, разд. "Владелец") нашёл, что на owner-странице
// радио "Ожидание/Пришёл/Не пришёл" и кнопка toggleNoShow делали одно и то же (один
// и тот же PATCH /bookings/:id/status) через два визуально похожих, но разных
// контрола - владелец не мог на глаз отличить рабочий от декоративного. Радио и
// раньше честно ОТОБРАЖАЛО реальный статус (assets/crm-calendar.js, STATUS_TO_DATA),
// просто клик по нему никуда не отправлялся. На owner-странице радио теперь
// единственный контрол статуса (кнопка убрана из crm-owner.html), и он полнее
// прежней кнопки (все 3 статуса из схемы, не только planned/no_show).
// mockup-crm.js - классический (не module) скрипт, но браузер делит один и тот же
// глобальный объект между ним и этим модулем, поэтому updateNoShowUi() (объявлена
// там) видна здесь как обычная глобальная функция без явного window.-префикса.
const RADIO_ID_TO_STATUS = { 'st-wait': 'planned', 'st-came': 'done', 'st-no': 'no_show' };
function wireBookingStatusRadios() {
  if (!document.getElementById('bk-status-note')) return; // не owner-страница - no-op
  const radios = document.querySelectorAll('input[name="bstatus"]');
  radios.forEach((radio) => {
    if (radio.dataset.wired) return;
    radio.dataset.wired = '1';
    radio.addEventListener('change', async () => {
      const panel = document.getElementById('bd-1');
      const bookingId = panel?.dataset.bookingId;
      const note = document.getElementById('bk-status-note');
      if (note) note.hidden = true;
      const prevStatus = panel?.dataset.realStatus || 'planned';
      const nextStatus = RADIO_ID_TO_STATUS[radio.id];
      if (!panel || !bookingId) return; // пример-заглушка без реальной брони, см. openBooking

      document.querySelectorAll('input[name="bstatus"]').forEach((r) => (r.disabled = true));
      try {
        const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ status: nextStatus }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        panel.dataset.realStatus = nextStatus;
        // Сервер уже применил счётчик неявок (see server.mjs, /bookings/:id/status) -
        // зеркалим ТОЧНО ТУ ЖЕ if/else-if очерёдность локально, чтобы баннер обновился
        // без перезагрузки страницы (несовпадающий порядок дал бы неверную цифру на
        // переходах вроде no_show → done).
        const prevStreak = parseInt(panel.dataset.noshowStreak, 10) || 0;
        let streak = prevStreak;
        if (nextStatus === 'no_show' && prevStatus !== 'no_show') {
          streak = prevStreak + 1;
        } else if (nextStatus === 'planned' && prevStatus === 'no_show') {
          streak = Math.max(prevStreak - 1, 0);
        } else if (nextStatus === 'done') {
          streak = 0;
        }
        panel.dataset.noshowStreak = String(streak);
        if (typeof updateNoShowUi === 'function') updateNoShowUi();
      } catch (err) {
        const prevRadioId = Object.keys(RADIO_ID_TO_STATUS).find((id) => RADIO_ID_TO_STATUS[id] === prevStatus);
        const prevRadio = prevRadioId && document.getElementById(prevRadioId);
        if (prevRadio) prevRadio.checked = true;
        if (note) {
          note.hidden = false;
          note.textContent = `Не удалось сохранить: ${err.message}`;
        }
      } finally {
        document.querySelectorAll('input[name="bstatus"]').forEach((r) => (r.disabled = false));
      }
    });
  });
}

// Правка 03.08.2026: кнопка "Клиент не пришёл" в bd-1 (assets/mockup-crm.js,
// onclick="toggleNoShow(this)") - раньше это была декоративная "Фактическое время
// прихода", ничего не сохранявшая. Реально переключает статус брони через уже
// существующий PATCH /bookings/:id/status ('no_show' инкрементирует
// clients.no_show_streak на сервере, обратный клик - откатывает, см. server.mjs).
// ВАЖНО (Окно 36, 06.08.2026): эта кнопка убрана из crm-owner.html (заменена
// радио выше), но живёт в crm-admin.html/crm-master.html - окно 36 их не касалось,
// функция здесь остаётся нетронутой ради этих двух страниц.
window.toggleNoShow = async function toggleNoShow(btn) {
  const panel = document.getElementById('bd-1');
  const bookingId = panel?.dataset.bookingId;
  const note = document.getElementById('bk-noshow-note');
  if (note) note.hidden = true;
  if (!panel || !bookingId) return;

  const wasNoShow = panel.dataset.realStatus === 'no_show';
  const nextStatus = wasNoShow ? 'planned' : 'no_show';
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    panel.dataset.realStatus = nextStatus;
    // Сервер уже применил инкремент/декремент no_show_streak - отражаем ту же
    // арифметику локально, чтобы баннер обновился без перезагрузки страницы.
    const prevStreak = parseInt(panel.dataset.noshowStreak, 10) || 0;
    panel.dataset.noshowStreak = String(wasNoShow ? Math.max(prevStreak - 1, 0) : prevStreak + 1);
    if (typeof updateNoShowUi === 'function') updateNoShowUi();
  } catch (err) {
    if (note) {
      note.hidden = false;
      note.textContent = `Не удалось сохранить: ${err.message}`;
    }
  } finally {
    btn.disabled = false;
  }
};
