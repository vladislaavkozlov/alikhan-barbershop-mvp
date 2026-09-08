// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Периоды ЗП/выручки (Неделя/Месяц/
// Квартал/Год, "Задать период" по произвольному диапазону) + рендер виджетов дат в
// payroll-панелях. Код перенесён 1в1, поведение не менялось.
import { el, todayStr, formatMoney, bookingPrice, paidBookings, payrollBookingAmount, pad2 } from './crm-shared.js';
import { fetchJson, apiSend } from './crm-auth.js';
import { errorMessage, showError, showSuccess } from './crm-toast.js';
import { setButtonBusy } from './crm-loading.js';
import { renderPayrollCards, syncPctInputs } from './crm-payroll-cards.js';

// wirePayrollDateSlots и wireMasterPayrollPeriod удалены 21.08.2026. Первая
// нумеровала слоты дат сквозным индексом по всей странице - несовместимо с
// карточками ЗП, которые теперь появляются по составу команды (виджеты дат ставит
// сама карточка, см. wireDateSlots в assets/crm-payroll-cards.js). Вторая
// обслуживала блок "Моя зарплата → Задать период" в кабинете мастера, а сам блок
// убран 17.08.2026 ("сотрудники не должны видеть свою зарплату") - кнопки
// #myPayrollPeriodBtn на страницах не осталось, функция была мёртвой.

// wireDiscountSettings удалена 17.08.2026 вместе с блоком "Управление скидками" в
// "Финансах" владельца (правка Влада). Переключатель политики был единственным её
// потребителем. Сама настройка жива на сервере (discount_settings, миграция 040) и
// читается при расчёте зарплаты - убран только интерфейс, которым не пользовались.

function dateToStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "С начала периода по сегодня", не скользящее окно - Неделя с понедельника текущей
// недели, Месяц с 1 числа, Квартал с 1 числа текущего квартала, Год с 1 января. Тот
// же принцип, что и у "День" (= сегодняшний календарный день, не последние 24ч).
// Экспортирована - используется не только внутри этого файла, но и напрямую в
// renderLiveProof (crm-auth.js, блок "Моя зарплата" мастера: День/Неделя/Месяц).
export function periodStartStr(period) {
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
// фронте. priceOf/pctOf - те же функции по мастеру, что и в renderLiveProof
// (crm-dashboard.js, Окно 10). Разбивка по точкам убрана (Окно 13, 01.08.2026) - у
// Алихана одна точка, не две (уточнено самим Алиханом 01.08.2026), инфраструктура
// location_id в базе остаётся нетронутой на будущее (франшиза по городам, см.
// ТЗ-разработчику-корректировка).
//
// 21.08.2026 - зарплата владельца и управляющего больше НЕ вычитается из общей суммы
// (был Set ownerIds и фильтр по нему): у них теперь такая же редактируемая ставка,
// как у любого мастера (правка Влада), и их комиссия входит в "Зарплаты мастеров"
// наравне со всеми. При ставке 100% это значит, что "Чистый доход" по их собственным
// визитам равен нулю - так и есть по правилу, которое стоит в поле.
export async function renderRevenuePeriods(priceOf, pctOf, payrollFromActualPrice) {
  if (!el('rvAllWeekRevenue')) return; // элементов нет вне страницы владельца

  const today = todayStr();
  let bookings;
  try {
    const res = await fetchJson(`/bookings?from=${periodStartStr('year')}&to=${today}`);
    bookings = paidBookings(res.bookings);
  } catch {
    return; // "считаю…" останется как есть - основная ошибка уже показана в панели выше
  }

  const fill = (prefix, rows) => {
    const revenueEl = el(`${prefix}Revenue`);
    const payrollEl = el(`${prefix}Payroll`);
    const netEl = el(`${prefix}Net`);
    if (!revenueEl && !payrollEl && !netEl) return;
    // revenue - честная выручка бизнеса по прайсу, скидка её не трогает. payroll -
    // отдельная база (08.08.2026, вечер): от фактической суммы, если владелец
    // включил "Управление скидками" и она вписана конкретной записи.
    const revenue = rows.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
    const payroll = rows.reduce(
      (sum, b) => sum + (payrollBookingAmount(b, priceOf, payrollFromActualPrice) * pctOf(b.masterId)) / 100,
      0
    );
    if (revenueEl) revenueEl.textContent = formatMoney(revenue);
    if (payrollEl) payrollEl.textContent = formatMoney(payroll);
    if (netEl) netEl.textContent = formatMoney(revenue - payroll);
  };

  for (const [label, key] of [['Week', 'week'], ['Month', 'month'], ['Quarter', 'quarter'], ['Year', 'year']]) {
    const start = periodStartStr(key);
    const rows = bookings.filter((b) => b.date >= start && b.date <= today);
    fill(`rvAll${label}`, rows);
  }
}

// Блок "Зарплаты мастеров" (владелец, "Финансы"). Раньше функция знала три id
// ('master-1'/'master-2'/'master-3') и три набора статичных узлов в разметке - то
// есть новый сотрудник в неё не попадал в принципе (правка Влада 21.08.2026, п.6).
// Теперь список приходит из /staff: карточка есть у каждого, у кого включено
// "Принимает клиентов", включая владельца и управляющего. Разметку строит
// assets/crm-payroll-cards.js, здесь - только цифры и сохранение ставки.
export async function renderStaffPayrollPeriods({ staffList, priceOf, pctOf, pctByMaster, payrollFromActualPrice, onPctSaved }) {
  const host = el('payrollStaffList');
  if (!host) return; // не страница владельца

  // Порядок «сначала брони, потом карточки» появился 22.08.2026 вместе с увольнением:
  // состав блока теперь зависит от денег (уволенный попадает сюда, только если в
  // загруженном окне у него были оплаченные визиты - payrollStaff в crm-shared.js),
  // а деньги известны лишь после ответа /bookings. Рисовать раньше и дополнять
  // позже нельзя: вторая отрисовка меняла бы состав под руками и схлопывала уже
  // раскрытые карточки на каждом нажатии «Обновить данные».
  const today = todayStr();
  let bookings;
  try {
    const res = await fetchJson(`/bookings?from=${periodStartStr('year')}&to=${today}`);
    bookings = paidBookings(res.bookings);
  } catch {
    // Цифр нет - показываем действующий состав с прежним "считаю…" (основная ошибка
    // уже выведена в панели выше). Уволенных без подтверждённых сумм не выдумываем
    syncPctInputs(renderPayrollCards(host, staffList, pctByMaster), pctByMaster);
    return;
  }

  const mastersWithPaidVisits = new Set(bookings.map((b) => b.masterId));
  const rows = renderPayrollCards(host, staffList, pctByMaster, mastersWithPaidVisits);
  syncPctInputs(rows, pctByMaster);

  // Правка 08.08.2026 (вечер): payrollBookingAmount вместо чистой bookingPrice - от
  // фактической суммы, если владелец включил "Управление скидками".
  const amountFor = (masterId, visits) =>
    (visits.reduce((sum, b) => sum + payrollBookingAmount(b, priceOf, payrollFromActualPrice), 0) * pctOf(masterId)) / 100;

  for (const { staff, card } of rows) {
    const mine = bookings.filter((b) => b.masterId === staff.id);
    const put = (period, from) => {
      const target = card.querySelector(`[data-amount="${period}"]`);
      if (target) target.textContent = formatMoney(amountFor(staff.id, mine.filter((b) => b.date >= from && b.date <= today)));
    };
    const fillFixedPeriods = () => {
      put('day', today);
      put('week', periodStartStr('week'));
      put('month', periodStartStr('month'));
    };
    fillFixedPeriods();
    wireCustomPeriod(card, staff.id, mine, amountFor);
    wirePctSave(card, staff, pctByMaster, fillFixedPeriods, onPctSaved);
  }
}

// "Задать период" - произвольный диапазон по уже загруженным броням. Замыкание с
// bookings живёт ровно одно обновление данных, поэтому обработчик каждый раз ставится
// на свежую кнопку (старый уходит вместе со старым узлом), а не гейтится dataset.wired
function replaceHandler(node, handler) {
  const fresh = node.cloneNode(true);
  node.replaceWith(fresh);
  fresh.addEventListener('click', handler);
  return fresh;
}

function wireCustomPeriod(card, masterId, mine, amountFor) {
  const panel = card.querySelector('[data-period-panel="period"]');
  const btn = panel?.querySelector('[data-period-show]');
  if (!btn) return;
  replaceHandler(btn, () => {
    // Правка 03.08.2026 (Окно 16): было input[type="date"].value - теперь свой
    // date-picker (.custom-date), значение читается из data-value.
    const dates = panel.querySelectorAll('.custom-date');
    const from = dates[0]?.dataset.value;
    const to = dates[1]?.dataset.value;
    const amountEl = panel.querySelector('[data-amount="period"]');
    if (!from || !to) {
      showError('Укажите обе даты - с какого и по какое число считать');
      return;
    }
    if (from > to) {
      showError('Проверьте даты: начало должно быть раньше конца');
      return;
    }
    if (amountEl) amountEl.textContent = formatMoney(amountFor(masterId, mine.filter((b) => b.date >= from && b.date <= to)));
  });
}

// Ставка "% от выручки" - теперь у каждого, кто оказывает услуги (до 21.08.2026 поле
// было только у Елизаветы, у владельца и Мамедхана стояла неизменяемая надпись
// "Зарплата 100% от выручки"). Подсказка об ошибке идёт всплывающим сообщением, а не
// строкой под кнопкой - правка Влада 21.08.2026 ("подсказки должны быть в
// всплывающем окошке"), тот же довод, по которому 15.08.2026 появился crm-toast.js:
// строку внизу длинной карточки приходится искать глазами.
//
// pctByMaster - ТОТ ЖЕ объект, который читает pctOf (см. computePricing,
// assets/crm-dashboard.js), поэтому после записи в него суммы этой карточки
// пересчитываются сразу, без перезагрузки. Остальной раздел ("Выручка", соседние
// карточки) обновляет onPctSaved - там меняется и общая строка "Зарплаты мастеров"
function wirePctSave(card, staff, pctByMaster, fillFixedPeriods, onPctSaved) {
  const btn = card.querySelector('[data-pct-save]');
  const input = card.querySelector('[data-pct-input]');
  if (!btn || !input) return;
  replaceHandler(btn, async (event) => {
    const saveBtn = event.currentTarget;
    const pct = Number(input.value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      showError('Ставка должна быть числом от 0 до 100');
      input.focus();
      return;
    }
    setButtonBusy(saveBtn, true);
    let saved = false;
    try {
      const res = await apiSend('/payroll-settings', 'PUT', { masterId: staff.id, pct });
      if (!res.ok) throw Object.assign(new Error('payroll-settings'), { status: res.status, code: res.data?.error ?? null });
      pctByMaster.set(staff.id, pct);
      const note = card.querySelector('[data-pct-note]');
      if (note) note.textContent = '';
      fillFixedPeriods();
      showSuccess(`${staff.name}: ставка ${pct}% сохранена`);
      saved = true;
    } catch (err) {
      showError(errorMessage(err, 'Не удалось сохранить ставку'));
    } finally {
      setButtonBusy(saveBtn, false);
    }
    // Строго ПОСЛЕ снятия "занята": пересчёт раздела перевешивает обработчик на копию
    // этой же кнопки (replaceHandler), а cloneNode копирует и disabled - кнопка
    // осталась бы навсегда серой
    if (saved) await onPctSaved?.();
  });
}
