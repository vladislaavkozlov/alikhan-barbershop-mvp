// Реальный вход в боевую базу (правка Влада 28.07.2026) поверх визуального макета
// Окна 9. Переиспользует ровно тот же контракт токена/localStorage-ключей, что уже
// работает в проде в admin.js (Окно 8) - если человек уже был залогинен через старую
// admin.html, сессия подхватится и здесь без повторного входа.
import { getMasters, getServices, mergeServiceCombos, isServiceBlockedByCombo } from '../storage.js';
import { wireNotifications } from './crm-notifications.js';
import { renderDayCalendar } from './crm-calendar.js';
import { wireScheduleViews } from './crm-schedule-views.js';
import { el, todayStr, formatMoney, bookingPrice, pad2 } from './crm-shared.js';
import { renderTimeSelect, timeSelectValue, renderDateSelect, dateSelectValue } from './crm-widgets.js';
import { wirePortfolioEditors, wireRoleEditors } from './crm-staff-admin.js';
import { WEEKDAY_SHORT, wireScheduleEditor, wireWeeklyScheduleEditor, renderWeeklySelfReadOnly } from './crm-schedule-editor.js';
import { wireMasterServiceEditors } from './crm-master-services.js';
import { wireScheduleRequestForm } from './crm-schedule-request-form.js';
import { wirePayrollDateSlots, wireMasterPayrollPeriod, renderRevenuePeriods, renderStaffPayrollPeriods, periodStartStr } from './crm-payroll.js';
import { wireMasterSelfView, wireMasterSelfDataTab } from './crm-master-self.js';
import { wireBookingStatusRadios } from './crm-booking-status.js';

export const API = window.ALIKHAN_API_URL;
const TOKEN_KEY = 'alikhan-crm:token';
const STAFF_KEY = 'alikhan-crm:staff';
const ROLE_LABELS = { owner: 'владелец', admin: 'администратор точки', master: 'мастер' };
const ROLE_PAGE = { owner: 'crm-owner.html', admin: 'crm-admin.html', master: 'crm-master.html' };

export function getToken() {
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

    // Администратор: единственная цифра "Выручка сегодня" (Окно 38, 06.08.2026) -
    // GET /revenue/today уже фильтрует по точке администратора на сервере, здесь
    // просто рендерим то, что вернул бэкенд. Элемент есть только на
    // crm-admin.html (Окно 40 - отдельная задача для crm-owner.html, вне скоупа
    // этого окна).
    const revenueTodayEl = el('revenueTodayAmount');
    if (revenueTodayEl) {
      try {
        const { revenue } = await fetchJson('/revenue/today');
        revenueTodayEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
      } catch {
        // "считаю…" останется как было - основная ошибка уже видна в панели выше
      }
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
  // Окно 39 (06.08.2026) - "Записать снова" (карточка клиента) открывает ту же форму
  // в режиме будущей записи: дата/время выбираются виджетами (не "прямо сейчас"), после
  // сохранения статус остаётся 'planned' (не форсируется 'done' - клиента физически ещё
  // нет в кресле). modeLabelEl/dateTimeRow - опциональны (crm-admin.html/crm-master.html
  // этот блок не получали в этом окне, getElementById безопасно вернёт null, весь режим
  // rebook просто недоступен там, обычный walk-in работает как раньше).
  const modeLabelEl = el('wfModeLabel');
  const dateTimeRow = el('wfDateTimeRow');
  const hasRebookUi = !!(modeLabelEl && dateTimeRow);
  let rebookMode = false;

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

  function openForWalkin(masterId, masterName, options = {}) {
    currentMasterId = masterId;
    nameLabel.textContent = masterName;
    rebookMode = hasRebookUi && !!options.rebook;
    resultEl.hidden = true;
    if (hasSaleForm) {
      saleForm.hidden = true;
      delete saleForm.dataset.bookingId;
      saleItemEl.value = '';
      saleAmountEl.value = '';
      saleResultEl.hidden = true;
    }
    if (hasRebookUi) {
      modeLabelEl.textContent = rebookMode ? 'Повторная запись' : 'Новая запись без предзаписи';
      dateTimeRow.hidden = !rebookMode;
      if (rebookMode) {
        // Дефолт - сегодня и ближайшее ближайшее 15-минутное время в рабочем окне
        // магазина (10:00-20:00, SHOP_TIME_OPTIONS выше) - владелец меняет на любое
        // реальное свободное, доступность проверяет сервер при сохранении.
        const now = new Date();
        const roundedMin = Math.min(20 * 60, Math.max(10 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15));
        const defaultTime = `${String(Math.floor(roundedMin / 60)).padStart(2, '0')}:${String(roundedMin % 60).padStart(2, '0')}`;
        renderDateSelect('wfDate-slot', 'wfDateValue', todayStr());
        renderTimeSelect('wfTime-slot', 'wfTimeValue', defaultTime);
      }
    }
    clientNameEl.value = options.clientName || '';
    clientPhoneEl.value = options.clientPhone || '';
    renderPicker(masterId);
    if (rebookMode && options.serviceIds?.length) {
      const available = new Set(checkboxByService.keys());
      selected = new Set(options.serviceIds.filter((id) => available.has(id)));
      selected = mergeServiceCombos(selected);
      syncCheckboxes();
      renderSummary();
    }
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
        let date;
        let startTime;
        if (rebookMode) {
          // "Записать снова" - дата/время выбраны заново виджетами (не "прямо сейчас"),
          // реальная доступность проверяется этим же POST /bookings (overlap/
          // schedule_blocked/past_time - createBookingTx, server.mjs).
          date = dateSelectValue('wfDateValue');
          startTime = timeSelectValue('wfTimeValue');
          if (!date || !startTime) throw new Error('укажите дату и время');
        } else {
          const now = new Date();
          const rounded = new Date(Math.ceil(now.getTime() / (5 * 60000)) * 5 * 60000);
          date = todayStr();
          startTime = `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}`;
        }
        const res = await fetch(`${API}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId: currentMasterId,
            serviceIds: [...selected],
            date,
            startTime,
            clientName: clientNameEl.value.trim() || null,
            clientPhone: clientPhoneEl.value.trim() || null,
            channel: 'admin',
          }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          const REASON_TEXT = {
            overlap: 'у мастера уже занято это время',
            schedule_blocked: 'у мастера в это время перерыв или выходной',
            past_time: 'нельзя записать в прошлое',
            master_not_bookable: 'у мастера ещё не настроен график',
          };
          throw new Error(REASON_TEXT[data.reason] || data.error || `HTTP ${res.status}`);
        }
        // Обычный walk-in - клиент физически уже в кресле, статус сразу "пришёл".
        // "Записать снова" (rebookMode) - это будущая запись, статус остаётся 'planned'
        // по умолчанию (createBookingTx), PATCH здесь был бы нечестным (клиента ещё нет).
        if (!rebookMode) {
          await fetch(`${API}/bookings/${encodeURIComponent(data.booking.id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ status: 'done' }),
          });
        }
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--ok';
        const whenText = rebookMode ? `${date} ${startTime}` : startTime;
        resultEl.textContent = `Готово: ${nameLabel.textContent}, ${whenText}, ${data.booking.totalDurationMin} мин, ${formatMoney(data.booking.totalPrice)}`;
        // "Добавить продажу" - только для walk-in (клиент физически в кресле сейчас).
        // Будущая запись (rebookMode) продажу добавит администратор в день визита.
        if (hasSaleForm && !rebookMode) {
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

  // Окно 39 (06.08.2026) - точка входа для "Записать снова" (карточка клиента,
  // assets/crm-clients.js). Глобальная функция (не export ES-модуля) - тот же приём,
  // что у остальных onclick-обработчиков этой страницы (openBooking и т.д. в
  // mockup-crm.js), потому что клиентская карточка рисует кнопку динамически, не
  // статичной разметкой с прямым import. hasRebookUi=false (страница без
  // wfModeLabel/wfDateTimeRow, пока только crm-owner.html) - выходим тихо, вызывающий
  // код (openClientCard) сам прячет кнопку "Записать снова", если функции нет.
  if (hasRebookUi) {
    window.openRebookBooking = (masterId, masterName, clientName, clientPhone, serviceIds) => {
      openForWalkin(masterId, masterName, { rebook: true, clientName, clientPhone, serviceIds });
    };
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
