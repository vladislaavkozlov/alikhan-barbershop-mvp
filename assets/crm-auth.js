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
