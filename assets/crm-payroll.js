// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Периоды ЗП/выручки (Неделя/Месяц/
// Квартал/Год, "Задать период" по произвольному диапазону) + рендер виджетов дат в
// payroll-панелях. Код перенесён 1в1, поведение не менялось.
import { el, todayStr, formatMoney, bookingPrice, pad2 } from './crm-shared.js';
import { renderDateSelect } from './crm-widgets.js';
import { fetchJson } from './crm-auth.js';

// Правка 03.08.2026 (Окно 16): "Задать период" в карточках ЗП (владелец/админ - по
// мастеру, свой "Моя зарплата" у мастера) раньше был <input type="date"> без id,
// найденный позиционно (первый/второй в панели) - renderStaffPayrollPeriods и
// wireMasterPayrollPeriod ниже (Окно 37, 06.08.2026 - заменила calcCustomPayroll
// из mockup-crm.js) так и продолжают искать позиционно, просто внутри .custom-date
// вместо input. Здесь только рендер виджетов в пустые слоты .payroll-date-slot -
// один проход на всю страницу, сколько бы панелей ни было.
export function wirePayrollDateSlots() {
  document.querySelectorAll('.payroll-date-slot').forEach((slot, i) => {
    if (slot.dataset.wired) return;
    slot.dataset.wired = '1';
    renderDateSelect(slot, `payrollDate-${i}`, todayStr());
  });
}

// "Моя зарплата → Задать период" (мастер, crm-master.html) - Окно 37 (06.08.2026,
// Задача 2). Заменяет calcCustomPayroll (была в mockup-crm.js, глобальная
// onclick-функция без доступа к сессии/fetchJson - реально работать не могла,
// оставляла "000 ₽ пример"). Кнопка/поле дат уникальны для этой страницы (только
// crm-master.html их использовал), поэтому no-op на crm-owner.html/crm-admin.html -
// там свой отдельный обработчик в renderStaffPayrollPeriods ниже, не трогается.
export function wireMasterPayrollPeriod(staff) {
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
export async function renderRevenuePeriods(priceOf, pctOf, ownerIds) {
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
// (myWeekEl/myMonthEl в renderLiveProof, crm-dashboard.js) - здесь тот же принцип
// bookingPrice+pctOf, но по каждой карточке сотрудника отдельно. Свой отдельный
// fetch годовых броней (не переиспользует renderRevenuePeriods) - та функция рано
// выходит на crm-admin.html (там нет вкладки "Выручка" вообще), а карточки
// сотрудников с ЗП есть и у owner, и у admin.
export async function renderStaffPayrollPeriods(priceOf, pctOf, ownerIds) {
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
  // wireMasterPayrollPeriod выше (личная "Моя зарплата" мастера, crm-master.html,
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
