// Декомпозиция crm-schedule-views.js (07.08.2026) - вид "Мой день". Код перенесён
// 1:1 из исходного файла, зависимости от общего состояния/хелперов приходят через ctx
// (тот же приём, что уже применяет сам crm-schedule-views.js к crm-auth.js/crm-calendar.js -
// избегаем циклических импортов между модулями расписания).
import { holidayNameOf, fmtRu, addDays } from './crm-schedule-shared.js';

export function wireDayView(ctx) {
  const {
    staff, staffList, services, priceOf, fetchJson, renderDateSelect, renderDayCalendar,
    scheduleViewState, holidaysOfYear,
  } = ctx;

  // Бейдж праздника на выбранном дне. Ставится НЕЗАВИСИМО от того, работает ли
  // кто-то из мастеров в этот день: "1 января" остаётся праздником и когда мастер
  // сам решил выйти работать (сценарий 2 промпта Окна 24).
  async function renderDayHolidayNote(date) {
    const noteEl = document.getElementById('dayHolidayNote');
    if (!noteEl) return; // страница без бейджа дня - остальные виды работают как раньше
    const name = holidayNameOf(await holidaysOfYear(Number(date.slice(0, 4))), date);
    noteEl.hidden = !name;
    noteEl.textContent = name ? `🎉 ${fmtRu(date)} - ${name}` : '';
  }

  async function loadDay(date) {
    scheduleViewState.date = date;
    // Виджет даты - часть того же состояния: до Окна 25 переход из Недели/Месяца
    // менял календарь, но оставлял в пикере старое число (jumpToDay его не трогал).
    const slot = document.getElementById('dayNavDate-slot');
    if (slot) renderDateSelect(slot, 'dayNavDate', date);
    await renderDayHolidayNote(date);
    let bookings = [];
    try {
      const res = await fetchJson(`/bookings?date=${date}`);
      bookings = res.bookings || [];
    } catch {
      // renderDayCalendar сам покажет пустой день - здесь не блокируем навигацию
    }
    await renderDayCalendar({ staff, staffList, services, priceOf, bookings, fetchJson, date });
  }

  // ───────────────────────── Задача 1: "Мой день" навигация ─────────────────
  function wireDayNav() {
    const prevBtn = document.getElementById('dayNavPrev');
    const nextBtn = document.getElementById('dayNavNext');
    const slot = document.getElementById('dayNavDate-slot');
    if (!prevBtn || !nextBtn || !slot) return; // страница без навигации по датам
    renderDateSelect(slot, 'dayNavDate', scheduleViewState.date);
    slot.addEventListener('customdate:change', (e) => ctx.setView('day', e.detail.value));
    const shift = (deltaDays) => ctx.setView('day', addDays(scheduleViewState.date, deltaDays));
    prevBtn.addEventListener('click', () => shift(-1));
    nextBtn.addEventListener('click', () => shift(1));
  }

  wireDayNav();

  return { loadDay };
}
