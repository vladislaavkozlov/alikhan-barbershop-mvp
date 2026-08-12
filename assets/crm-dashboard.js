// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). renderLiveProof - последний и самый
// связанный вынесенный кусок: не только рендер цифр дашборда (выручка/ЗП дня,
// "Моя зарплата" мастера, "Выручка сегодня" администратора, ставка Елизаветы), но
// и ЕДИНСТВЕННЫЙ оркестратор, который одним Promise.all грузит staff/services/
// bookings/master-services/payroll-settings и на этих же данных вызывает fan-out
// всех остальных доменов (wire*/render* из других файлов) - ИМЕННО В ТОМ ЖЕ
// ПОРЯДКЕ, что и в исходном файле. Порядок вызовов НЕ менялся при переносе -
// некоторые из них (например блок "Моя зарплата" мастера) используют локальные
// переменные priceOf/pctOf/ownerIds из этого же Promise.all и не могут быть подняты
// выше (в initCrmAuth/reveal()) без изменения поведения. Код перенесён 1в1.
import { el, todayStr, formatMoney, bookingPrice, payrollBookingAmount } from './crm-shared.js';
import { renderDateSelect, renderTimeSelect, timeSelectValue } from './crm-widgets.js';
import { API, getToken, fetchJson, apiSend } from './crm-auth.js';
import { renderDayCalendar } from './crm-calendar.js';
import { wireScheduleViews } from './crm-schedule-views.js';
import { wirePortfolioEditors, wireRoleEditors } from './crm-staff-admin.js';
import { wireScheduleEditor, wireWeeklyScheduleEditor } from './crm-schedule-editor.js';
import { wireMasterServiceEditors } from './crm-master-services.js';
import { wirePayrollDateSlots, wireMasterPayrollPeriod, renderRevenuePeriods, renderStaffPayrollPeriods, periodStartStr, wireDiscountSettings } from './crm-payroll.js';
import { wireMasterSelfView, wireMasterSelfDataTab } from './crm-master-self.js';
import { wireAdminSelfData } from './crm-admin-self.js';
import { wireBookingStatusRadios, wireBookingServiceEdit, wireBookingDelete, wireBookingActualPrice } from './crm-booking-status.js';
import { wireWalkIn } from './crm-walkin.js';

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
// Цена конкретного мастера на конкретную услугу - master-services покрывает все
// пары (сид миграции 002/004), общий прайс /services - только страховка на случай
// пары, которую почему-то не завели. Ставка мастера (100/100/40, редактируется
// владельцем) - сервер уже выдал только те строки, которые видны текущей роли
// (себя/свою точку/всех). Вынесено из renderLiveProof (Окно 46, 08.08.2026) -
// теми же тремя функциями пользуется и refreshFinance ниже, без дублирования формул.
function computePricing(staffList, services, masterServices, payrollRows) {
  const priceOf = (masterId, serviceId) =>
    masterServices.find((r) => r.masterId === masterId && r.serviceId === serviceId)?.price ??
    services.find((s) => s.id === serviceId)?.price ??
    0;
  const pctByMaster = new Map(payrollRows.map((r) => [r.masterId, r.pct]));
  const pctOf = (masterId) => pctByMaster.get(masterId) ?? 0;
  const ownerIds = new Set(staffList.filter((s) => s.role === 'owner').map((s) => s.id));
  return { priceOf, pctOf, ownerIds };
}

// Правка 08.08.2026 (вечер) - discount-settings читается тем же Promise.all, что и
// staff/services/bookings/master-services/payroll-settings ниже (refreshFinance,
// renderLiveProof), но не имеет отношения к priceOf/pctOf/ownerIds - отдельный
// маленький helper вместо раздувания computePricing лишним несвязанным параметром.
async function fetchPayrollFromActualPrice(fetchJsonFn) {
  try {
    const { payrollFromActualPrice } = await fetchJsonFn('/discount-settings');
    return !!payrollFromActualPrice;
  } catch {
    return false; // недоступно/ошибка сети - безопасный дефолт "как раньше", не блокирует остальную "Финансы"
  }
}

// Владелец: "Выручка по точке → Все точки → День" (сумма по всем броням сегодня,
// зарплата - по ставке КАЖДОГО мастера, без брони владельца самому себе) + карточка
// КАЖДОГО мастера в "Сотрудники" → "Расчёт ЗП → За день" + ставка Елизаветы. Вынесено
// из renderLiveProof в отдельную функцию (Окно 46, 08.08.2026) - чистый рендер
// (fetch уже сделан снаружи, здесь только innerHTML/value), безопасно вызывать
// повторно из кнопки "Обновить данные" (см. refreshFinance ниже). Клик по
// elizavetaPctSave уже сам себя гейтит через saveBtn.dataset.wired - повторный
// вызов не задвоит обработчик.
function renderFinanceDaySnapshot(bookings, priceOf, pctOf, ownerIds, payrollFromActualPrice) {
  const revenueEl = el('rvAllDayRevenue');
  const payrollEl = el('rvAllDayPayroll');
  const netEl = el('rvAllDayNet');
  if (revenueEl && payrollEl && netEl) {
    const revenue = bookings.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
    const payrollBookings = bookings.filter((b) => !ownerIds.has(b.masterId));
    const payroll = payrollBookings.reduce(
      (sum, b) => sum + (payrollBookingAmount(b, priceOf, payrollFromActualPrice) * pctOf(b.masterId)) / 100,
      0
    );
    revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
    payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
    netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
  }

  // master-1/2/3 = порядок мастеров в /staff (Алиовсад/Мамедхан/Елизавета в макете -
  // косметические имена поверх этих id).
  ['master-1', 'master-2', 'master-3'].forEach((masterId, idx) => {
    const cardEl = el(`payrollMaster${idx + 1}Day`);
    if (!cardEl) return;
    const theirs = bookings.filter((b) => b.masterId === masterId);
    const theirPayrollBase = theirs.reduce((sum, b) => sum + payrollBookingAmount(b, priceOf, payrollFromActualPrice), 0);
    cardEl.innerHTML = `${formatMoney((theirPayrollBase * pctOf(masterId)) / 100)} <span class="unsure">реально</span>`;
  });

  // Владелец: поле "Ставка от выручки, %" в карточке Елизаветы (Окно 10, разд.17.3
  // ТЗ) - реальное, читает и пишет master_payroll_settings. Не автоматический порог
  // 40→50%, владелец меняет число сам, когда сочтёт нужным.
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
}

// Окно 46 (08.08.2026) - кнопка "Обновить данные" (crm-owner.html) должна обновлять
// весь раздел "Финансы", а не только "Расписание"/"Уведомления"/риск-список, как
// было в Окне 45. renderLiveProof вызывать повторно нельзя (см. её комментарий ниже -
// внутри неё wireScheduleEditor/wireWeeklyScheduleEditor и другие wire*-функции
// вешают обработчики на статичные DOM-узлы один раз, повторный вызов задвоил бы
// клики) - поэтому отдельная независимая функция: свой fetch того же контракта
// (/staff, /services, /bookings, /master-services, /payroll-settings) + переиспользует
// computePricing/renderFinanceDaySnapshot/renderRevenuePeriods/renderStaffPayrollPeriods,
// ни один из которых не регистрирует новых обработчиков на persistent-узлах (только
// value/innerHTML, либо уже самогейтящиеся клики). Elements-guard (el('rvAllDayRevenue'))
// - страница не владельца эту функцию no-op.
// Правка (по вопросу Влада 08.08.2026 - "почему видно обновление только в
// Уведомлениях") - "Финансы" молча подменяли значения без единого визуального
// сигнала, пока шёл fetch, поэтому обновление было незаметно на глаз. Тот же
// приём "считаю…", что уже стоит в статичной разметке crm-owner.html для ПЕРВОЙ
// загрузки страницы (например id="rvAllDayRevenue">000 ₽ <span class="unsure">
// считаю…</span>) - переиспользован здесь для ПОВТОРНОЙ загрузки по кнопке.
const FINANCE_LOADING_IDS = [
  'rvAllDayRevenue', 'rvAllDayPayroll', 'rvAllDayNet',
  'payrollMaster1Day', 'payrollMaster2Day', 'payrollMaster3Day',
  'rvAllWeekRevenue', 'rvAllWeekPayroll', 'rvAllWeekNet',
  'rvAllMonthRevenue', 'rvAllMonthPayroll', 'rvAllMonthNet',
  'rvAllQuarterRevenue', 'rvAllQuarterPayroll', 'rvAllQuarterNet',
  'rvAllYearRevenue', 'rvAllYearPayroll', 'rvAllYearNet',
  'payrollMaster1Week', 'payrollMaster1Month',
  'payrollMaster2Week', 'payrollMaster2Month',
  'payrollMaster3Week', 'payrollMaster3Month',
];
function showFinanceLoading() {
  for (const id of FINANCE_LOADING_IDS) {
    const target = el(id);
    if (target) target.innerHTML = '000 ₽ <span class="unsure">считаю…</span>';
  }
}

export async function refreshFinance() {
  if (!el('rvAllDayRevenue')) return;
  showFinanceLoading();
  try {
    const [staffList, services, bookingsRes, masterServices, payrollRows, payrollFromActualPrice] = await Promise.all([
      fetchJson('/staff'),
      fetchJson('/services'),
      fetchJson(`/bookings?date=${todayStr()}`),
      fetchJson('/master-services'),
      fetchJson('/payroll-settings'),
      fetchPayrollFromActualPrice(fetchJson),
    ]);
    const bookings = bookingsRes.bookings || [];
    const { priceOf, pctOf, ownerIds } = computePricing(staffList, services, masterServices, payrollRows);
    renderFinanceDaySnapshot(bookings, priceOf, pctOf, ownerIds, payrollFromActualPrice);
    await renderRevenuePeriods(priceOf, pctOf, ownerIds, payrollFromActualPrice);
    await renderStaffPayrollPeriods(priceOf, pctOf, ownerIds, payrollFromActualPrice);
  } catch (err) {
    console.error('Не удалось обновить "Финансы":', err);
  }
}

export async function refreshRoleSnapshot(staff) {
  const myPayrollDayEl = el('myPayrollDay');
  const myWeekEl = el('myPayrollWeek');
  const myMonthEl = el('myPayrollMonth');
  if (myPayrollDayEl || myWeekEl || myMonthEl) {
    const today = todayStr();
    const fillMyPayroll = async (targetEl, from, to) => {
      if (!targetEl) return;
      const { payroll } = await fetchJson(`/payroll?masterId=${staff.id}&from=${from}&to=${to}`);
      targetEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
    };
    await Promise.allSettled([
      fillMyPayroll(myPayrollDayEl, today, today),
      fillMyPayroll(myWeekEl, periodStartStr('week'), today),
      fillMyPayroll(myMonthEl, periodStartStr('month'), today),
    ]);
  }

  const revenueTodayEl = el('revenueTodayAmount');
  const unidentifiedTodayEl = el('unidentifiedTodayCount');
  if (revenueTodayEl || unidentifiedTodayEl) {
    try {
      const { revenue, unidentifiedCount } = await fetchJson('/revenue/today');
      if (revenueTodayEl) revenueTodayEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
      if (unidentifiedTodayEl) unidentifiedTodayEl.textContent = String(unidentifiedCount);
    } catch {
      // Сохраняем последнее успешно показанное значение при временной ошибке сети
    }
  }
}

export async function renderLiveProof(staff) {
  try {
    const [staffList, services, bookingsRes, masterServices, payrollRows, payrollFromActualPrice] = await Promise.all([
      fetchJson('/staff'),
      fetchJson('/services'),
      fetchJson(`/bookings?date=${todayStr()}`),
      fetchJson('/master-services'),
      fetchJson('/payroll-settings'),
      fetchPayrollFromActualPrice(fetchJson),
    ]);
    const bookings = bookingsRes.bookings || [];
    const { priceOf, pctOf, ownerIds } = computePricing(staffList, services, masterServices, payrollRows);
    renderFinanceDaySnapshot(bookings, priceOf, pctOf, ownerIds, payrollFromActualPrice);

    // Мастер: "Моя зарплата" (День/Неделя/Месяц) - Окно 37 (06.08.2026, Задача 2).
    // Раньше День считался локально (bookingPrice×pctOf по уже загруженным bookings
    // за сегодня), Неделя/Месяц - отдельным запросом /bookings?from&to с той же
    // формулой ещё раз. Два места, одна формула - именно то дублирование, которое
    // это окно убирает. Теперь все три - один и тот же вызов единого бэкенд-
    // резолвера (GET /payroll, computeMasterPayroll в api/server.mjs), различается
    // только диапазон дат. Владельца/админа (карточки выше, revenueEl/payrollEl)
    // не трогает - вне скоупа этого окна (см. crm-owner.html/crm-admin.html).
    await refreshRoleSnapshot(staff);

    // Администратор: единственная цифра "Выручка сегодня" (Окно 38, 06.08.2026) -
    // GET /revenue/today уже фильтрует по точке администратора на сервере, здесь
    // просто рендерим то, что вернул бэкенд. Элемент есть только на
    // crm-admin.html (Окно 40 - отдельная задача для crm-owner.html, вне скоупа
    // этого окна).
    //
    // "Неопознанных визитов сегодня" (09.08.2026) - тот же ответ GET /revenue/today
    // теперь заодно содержит unidentifiedCount (countUnidentifiedToday, api/routes/
    // payroll.js) - решение Алихана по найденному багу потери имени walk-in без
    // телефона. Один запрос на обе карточки, не дублируем fetch.
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
    wireBookingServiceEdit(services, masterServices);
    wireBookingDelete();
    wireBookingActualPrice();
    ['master-1', 'master-2', 'master-3'].forEach((masterId) => {
      wireScheduleEditor(masterId, fetchJson);
      wireWeeklyScheduleEditor(masterId, staff.role === 'owner', fetchJson);
    });
    wireWalkIn(staff, services, masterServices, staffList);
    wireMasterSelfView(staff, pctOf);
    wireMasterSelfDataTab(staff, services, masterServices, pctOf);
    wireAdminSelfData(staff, staffList);
    wireMasterServiceEditors(staff.role, services, masterServices);
    wirePayrollDateSlots();
    wireDiscountSettings();
    wireMasterPayrollPeriod(staff);

    await renderRevenuePeriods(priceOf, pctOf, ownerIds, payrollFromActualPrice);
    await renderStaffPayrollPeriods(priceOf, pctOf, ownerIds, payrollFromActualPrice);
  } catch (err) {
    console.error('Не удалось загрузить данные CRM:', err);
  }
}
