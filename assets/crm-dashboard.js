// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). renderLiveProof - последний и самый
// связанный вынесенный кусок: не только рендер цифр дашборда (выручка/ЗП дня,
// "Выручка сегодня" администратора), но
// и ЕДИНСТВЕННЫЙ оркестратор, который одним Promise.all грузит staff/services/
// bookings/master-services/payroll-settings и на этих же данных вызывает fan-out
// всех остальных доменов (wire*/render* из других файлов) - ИМЕННО В ТОМ ЖЕ
// ПОРЯДКЕ, что и в исходном файле. Порядок вызовов НЕ менялся при переносе -
// некоторые из них (например блок "Моя зарплата" мастера) используют локальные
// переменные priceOf/pctOf из этого же Promise.all и не могут быть подняты
// выше (в initCrmAuth/reveal()) без изменения поведения. Код перенесён 1в1.
import { el, todayStr, formatMoney, bookingPrice, defaultPctFor, paidBookings, payrollBookingAmount } from './crm-shared.js';
import { renderDateSelect, renderTimeSelect, timeSelectValue } from './crm-widgets.js';
import { fetchJson, apiSend } from './crm-auth.js';
import { renderDayCalendar } from './crm-calendar.js';
import { wireScheduleViews } from './crm-schedule-views.js';
import { wirePortfolioEditors, wireRoleEditors } from './crm-staff-admin.js';
import { wireScheduleEditor, wireWeeklyScheduleEditor } from './crm-schedule-editor.js';
import { wireMasterServiceEditors } from './crm-master-services.js';
import { renderRevenuePeriods, renderStaffPayrollPeriods } from './crm-payroll.js';
import { wireMasterSelfView, wireMasterSelfDataTab } from './crm-master-self.js';
import { wireAdminSelfData } from './crm-admin-self.js';
import { wireBookingStatusRadios, wireBookingServiceEdit, wireBookingDelete, wireBookingActualPrice } from './crm-booking-status.js';
import { wireWalkIn } from './crm-walkin.js';
import { wireMasterBookingView } from './crm-master-booking.js';

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
  // 21.08.2026 - ставки больше нет только у трёх мастеров из сида (миграция 005):
  // сотрудника заводят в "Команде", строки в master_payroll_settings у него ещё нет,
  // и до этой правки он молча считался по 0%. Теперь ставка "не задана" честно
  // отделена от "задана и равна нулю": владелец и управляющий по умолчанию 100%
  // (прямая правка Влада), остальным 0 с подписью "ставка ещё не задана" в карточке -
  // придумывать за Алихана процент новому мастеру нельзя. Один и тот же дефолт идёт и
  // в поле карточки, и в расчёт, поэтому цифра на экране всегда соответствует полю.
  const pctByMaster = new Map(payrollRows.map((r) => [r.masterId, r.pct]));
  const staffById = new Map(staffList.map((s) => [s.id, s]));
  const pctOf = (masterId) => pctByMaster.get(masterId) ?? defaultPctFor(staffById.get(masterId));
  return { priceOf, pctOf, pctByMaster };
}

// Правка 08.08.2026 (вечер) - discount-settings читается тем же Promise.all, что и
// staff/services/bookings/master-services/payroll-settings ниже (refreshFinance,
// renderLiveProof), но не имеет отношения к priceOf/pctOf - отдельный
// маленький helper вместо раздувания computePricing лишним несвязанным параметром.
async function fetchPayrollFromActualPrice(fetchJsonFn) {
  try {
    const { payrollFromActualPrice } = await fetchJsonFn('/discount-settings');
    return !!payrollFromActualPrice;
  } catch {
    return false; // недоступно/ошибка сети - безопасный дефолт "как раньше", не блокирует остальную "Финансы"
  }
}

// Ставки мастеров с 17.08.2026 отдаются только владельцу и управляющему (правка
// Влада: администратору не даём данных к финансам, сотрудник не видит свой процент).
// В кабинетах администратора и мастера сервер честно отвечает 403 - и этот отказ
// НЕЛЬЗЯ пускать в общий Promise.all: он ронял бы всю загрузку кабинета целиком
// («Не удалось загрузить данные CRM»), хотя ставки там ни на что не влияют -
// денежных блоков в этих кабинетах нет. Пустой список = ставка 0 в pctOf, а весь
// расчёт зарплат живёт под elements-guard'ами владельца и до них не доходит
async function fetchPayrollSettings(fetchJsonFn) {
  try {
    return await fetchJsonFn('/payroll-settings');
  } catch {
    return [];
  }
}

// Владелец: "Финансы" → "Выручка" → "День" - три карточки за сегодняшний день.
// Вынесено из renderLiveProof в отдельную функцию (Окно 46, 08.08.2026) - чистый
// рендер (fetch уже сделан снаружи), безопасно вызывать повторно из кнопки
// "Обновить данные" (см. refreshFinance ниже).
//
// 21.08.2026 (правка Влада): в сумму идут только состоявшиеся визиты (paidBookings -
// status='done', зелёная карточка в расписании), а зарплата больше не вычитает
// владельца из базы - у него теперь такая же редактируемая ставка, как у мастеров.
// Отсюда же убраны блок ставки Елизаветы и цикл по трём захардкоженным id мастеров:
// и то и другое переехало в карточки, которые строятся по составу команды
// (renderStaffPayrollPeriods, assets/crm-payroll.js).
function renderFinanceDaySnapshot(bookings, priceOf, pctOf, payrollFromActualPrice) {
  const revenueEl = el('rvAllDayRevenue');
  const payrollEl = el('rvAllDayPayroll');
  const netEl = el('rvAllDayNet');
  if (!revenueEl || !payrollEl || !netEl) return;
  const paid = paidBookings(bookings);
  const revenue = paid.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
  const payroll = paid.reduce(
    (sum, b) => sum + (payrollBookingAmount(b, priceOf, payrollFromActualPrice) * pctOf(b.masterId)) / 100,
    0
  );
  revenueEl.textContent = formatMoney(revenue);
  payrollEl.textContent = formatMoney(payroll);
  netEl.textContent = formatMoney(revenue - payroll);
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
  'rvAllWeekRevenue', 'rvAllWeekPayroll', 'rvAllWeekNet',
  'rvAllMonthRevenue', 'rvAllMonthPayroll', 'rvAllMonthNet',
  'rvAllQuarterRevenue', 'rvAllQuarterPayroll', 'rvAllQuarterNet',
  'rvAllYearRevenue', 'rvAllYearPayroll', 'rvAllYearNet',
];
function showFinanceLoading() {
  for (const id of FINANCE_LOADING_IDS) {
    const target = el(id);
    if (target) target.innerHTML = '000 ₽ <span class="unsure">считаю…</span>';
  }
  // Карточки сотрудников - список, а не фиксированные id (21.08.2026): их состав
  // приходит из /staff. "Задать период" не трогаем - там стоит цифра, которую человек
  // только что сам запросил кнопкой, и подменять её на "считаю…" нечестно
  document.querySelectorAll('.payroll-card [data-amount]:not([data-amount="period"])').forEach((target) => {
    target.innerHTML = '000 ₽ <span class="unsure">считаю…</span>';
  });
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
      fetchPayrollSettings(fetchJson),
      fetchPayrollFromActualPrice(fetchJson),
    ]);
    const bookings = bookingsRes.bookings || [];
    const { priceOf, pctOf, pctByMaster } = computePricing(staffList, services, masterServices, payrollRows);
    renderFinanceDaySnapshot(bookings, priceOf, pctOf, payrollFromActualPrice);
    await renderRevenuePeriods(priceOf, pctOf, payrollFromActualPrice);
    await renderStaffPayrollPeriods({ staffList, priceOf, pctOf, pctByMaster, payrollFromActualPrice, onPctSaved: refreshFinance });
  } catch (err) {
    console.error('Не удалось обновить "Финансы":', err);
  }
}

export async function refreshRoleSnapshot(staff) {
  // Блок «Моя зарплата» мастера (myPayrollDay/Week/Month через GET /payroll) удалён
  // 17.08.2026 вместе со своей вкладкой в crm-master.html - правка Влада «сотрудники
  // не должны видеть свою зарплату, проценты и тд». Роут для роли master закрыт в тот
  // же день, поэтому оставлять здесь запрос было бы гарантированным 403 в консоли
  const revenueTodayEl = el('revenueTodayAmount');
  const unidentifiedTodayEl = el('unidentifiedTodayCount');
  if (revenueTodayEl || unidentifiedTodayEl) {
    try {
      const { revenue, unidentifiedCount } = await fetchJson('/revenue/today');
      if (revenueTodayEl) revenueTodayEl.textContent = formatMoney(revenue);
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
      fetchPayrollSettings(fetchJson),
      fetchPayrollFromActualPrice(fetchJson),
    ]);
    const bookings = bookingsRes.bookings || [];
    const { priceOf, pctOf, pctByMaster } = computePricing(staffList, services, masterServices, payrollRows);
    renderFinanceDaySnapshot(bookings, priceOf, pctOf, payrollFromActualPrice);

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
    // Кабинет мастера (13.08.2026) - read-only панель открытого визита вместо формы
    // записи, которой у него нет. pctOf нужен для комиссии за запись. На
    // owner/admin-страницах элемента панели нет, функция там тихий no-op.
    wireMasterBookingView(staff, services, masterServices, pctOf);
    // Своя запись из состава: в ней есть media с фото профиля, а в staff из сессии
    // (/auth/me) его нет - без этого кружок мастера остался бы с инициалами, хотя
    // фото загружено (правка Влада 15.08.2026)
    const selfWithMedia = staffList.find((row) => row.id === staff.id) ?? staff;
    wireMasterSelfView(selfWithMedia);
    wireMasterSelfDataTab(selfWithMedia, services, masterServices, pctOf);
    wireAdminSelfData(staff, staffList);
    wireMasterServiceEditors(staff.role, services, masterServices);
    // wirePayrollDateSlots/wireMasterPayrollPeriod убраны 21.08.2026 (виджеты дат
    // ставит сама карточка ЗП; блока «Моя зарплата» у мастера нет с 17.08.2026)

    await renderRevenuePeriods(priceOf, pctOf, payrollFromActualPrice);
    await renderStaffPayrollPeriods({ staffList, priceOf, pctOf, pctByMaster, payrollFromActualPrice, onPctSaved: refreshFinance });
  } catch (err) {
    console.error('Не удалось загрузить данные CRM:', err);
  }
}
