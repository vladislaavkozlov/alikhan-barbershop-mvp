// Декомпозиция crm-schedule-views.js (07.08.2026) - вид "Неделя". Код перенесён 1:1,
// зависимости - через ctx (см. crm-schedule-view-day.js про приём).
import {
  WEEKDAY_SHORT, isoWeekdayOf, mondayOf, addDays, ruPluralBooking, holidayNameOf, buildMasterSwitch,
} from './crm-schedule-shared.js';

export function wireWeekView(ctx) {
  const { masters, fetchJson, holidayMapForRange, scheduleViewState, setView } = ctx;
  let weekMasterId = masters[0]?.id ?? null;

  // Праздник и рабочий статус - две независимые метки одной ячейки: бейдж
  // добавляется РЯДОМ с "Выходной"/часами смены, а не вместо них (Окно 24).
  function weekDayCellHtml(day, count, holidayName) {
    const dayNum = Number(day.date.slice(8, 10));
    const monthNum = Number(day.date.slice(5, 7));
    const wd = WEEKDAY_SHORT[isoWeekdayOf(day.date) - 1];
    const hours = day.isDayOff ? 'Выходной' : `${day.startTime}–${day.endTime}`;
    return `<button type="button" class="month-day week-day-cell${day.isDayOff ? ' is-dayoff' : ''}${holidayName ? ' is-holiday' : ''}" data-open-day="${day.date}">
      <span class="num">${wd} ${dayNum}.${monthNum}</span>
      <span class="week-hours">${hours}</span>
      ${holidayName ? `<span class="holiday-label" data-holiday-for="${day.date}">🎉 ${holidayName}</span>` : ''}
      ${count ? `<span class="appt-count">${count} ${ruPluralBooking(count)}</span>` : ''}
    </button>`;
  }

  async function loadWeek() {
    const grid = document.getElementById('weekGrid');
    if (!grid || !weekMasterId) return;
    // Показываем НЕ "текущую календарную неделю", а ту, что содержит общий якорь -
    // поэтому weekStart здесь производная от scheduleViewState.date, не своя переменная.
    const from = mondayOf(scheduleViewState.date);
    const to = addDays(from, 6);
    // Подпись диапазона больше не живёт между стрелками: её роль взял общий якорь
    // под вкладками (Окно 25) - две одинаковые подписи на одном экране были шумом.
    grid.innerHTML = '<p class="section-hint">Загружаю…</p>';
    try {
      const [rangeDays, bookingsRes, holidayMap] = await Promise.all([
        fetchJson(`/schedule-range?masterId=${weekMasterId}&from=${from}&to=${to}`),
        fetchJson(`/bookings?masterId=${weekMasterId}&from=${from}&to=${to}`),
        holidayMapForRange(from, to),
      ]);
      const countByDate = new Map();
      for (const b of bookingsRes.bookings ?? []) {
        if (b.status === 'cancelled') continue;
        countByDate.set(b.date, (countByDate.get(b.date) || 0) + 1);
      }
      grid.innerHTML = rangeDays
        .map((day) => weekDayCellHtml(day, countByDate.get(day.date) || 0, holidayNameOf(holidayMap, day.date)))
        .join('');
      grid.querySelectorAll('[data-open-day]').forEach((cellBtn) => {
        cellBtn.addEventListener('click', () => setView('day', cellBtn.dataset.openDay));
      });
    } catch (err) {
      grid.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }

  const grid = document.getElementById('weekGrid');
  if (grid) {
    const switchRow = document.getElementById('weekMasterSwitch');
    if (switchRow) {
      buildMasterSwitch(switchRow, masters, weekMasterId, (masterId) => {
        weekMasterId = masterId;
        loadWeek();
      });
    }
    // Листание недели двигает общий якорь на понедельник соседней недели - иначе
    // возврат в Месяц/День показал бы дату из той недели, которую уже пролистали.
    document.getElementById('weekNavPrev')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), -7)));
    document.getElementById('weekNavNext')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), 7)));
    loadWeek();
  } // страница без реальной Недели - loadWeek выше уже сам не делает ничего без #weekGrid

  return { loadWeek };
}
