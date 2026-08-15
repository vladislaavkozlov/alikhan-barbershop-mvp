// Декомпозиция crm-schedule-views.js (07.08.2026) - вид "Неделя". Код перенесён 1:1,
// зависимости - через ctx (см. crm-schedule-view-day.js про приём).
//
// Окно 44 (07.08.2026, ПРОМПТ-ОКНО-44-РАСПИСАНИЕ-НЕДЕЛЯ-МЕСЯЦ.md) - вид остаётся ЗА
// одного мастера (переключатель сужает список, не меняет общий вид - буквально из
// ТЗ), добавлены % загрузки в заголовке колонки и сами записи дня, сгруппированные
// по времени (раньше - только число "N записей", ни одной реальной записи не было
// видно без перехода в День).
import {
  WEEKDAY_SHORT, isoWeekdayOf, mondayOf, addDays, holidayNameOf, buildMasterSwitch, loadPercent, escapeHtml,
} from './crm-schedule-shared.js';
import { todayStr } from './crm-calendar.js';
import { errorMessage, showError } from './crm-toast.js';
import { showSkeleton } from './crm-loading.js';

// Компактный список - Неделя показывает 7 узких колонок одновременно, не резиновую
// высоту на весь экран (это была бы уже замена Дня, не своя плотность). Дальше
// "+N ещё" текстом - клик по любому месту ячейки всё равно ведёт в День со всеми
// записями (data-open-day на самой кнопке-ячейке, тот же приём, что и раньше).
const MAX_VISIBLE_APPTS = 4;

export function wireWeekView(ctx) {
  const { masters, fetchJson, holidayMapForRange, scheduleViewState, setView } = ctx;
  // Задача I (Окно 53) - выбор мастера читается/пишется через ОБЩИЙ scheduleViewState,
  // не свою локальную переменную (тем же принципом, что и дата, Окно 25) - см. полный
  // разбор причины в crm-schedule-views.js, у объявления scheduleViewState.

  // Праздник и рабочий статус - две независимые метки одной ячейки: бейдж
  // добавляется РЯДОМ с "Выходной"/часами смены, а не вместо них (Окно 24).
  function weekDayCellHtml(day, dayBookings, holidayName) {
    const dayNum = day.date.slice(8, 10);
    const monthNum = day.date.slice(5, 7);
    const wd = WEEKDAY_SHORT[isoWeekdayOf(day.date) - 1];
    const hours = day.isDayOff ? 'Выходной' : `${day.startTime}–${day.endTime}`;
    const pct = loadPercent(day, dayBookings);
    const visible = dayBookings.slice(0, MAX_VISIBLE_APPTS);
    const overflow = dayBookings.length - visible.length;
    const apptsHtml = day.isDayOff
      ? ''
      : dayBookings.length === 0
        ? '<span class="week-appt-empty">Нет записей</span>'
        : `<span class="week-appt-list">${visible
            .map((b) => `<span class="week-appt-chip">${escapeHtml(b.startTime)} ${escapeHtml(b.clientName || 'Без имени')}</span>`)
            .join('')}${overflow > 0 ? `<span class="week-appt-more">+${overflow} ещё</span>` : ''}</span>`;
    return `<button type="button" class="month-day week-day-cell${day.isDayOff ? ' is-dayoff' : ''}${holidayName ? ' is-holiday' : ''}${day.date === todayStr() ? ' is-today' : ''}" data-open-day="${day.date}">
      <span class="num">${wd} ${dayNum}.${monthNum}</span>
      <span class="week-hours">${hours}${!day.isDayOff ? ` · <span class="week-load-pct">${pct}%</span>` : ''}</span>
      ${holidayName ? `<span class="holiday-label" data-holiday-for="${day.date}">🎉 ${holidayName}</span>` : ''}
      ${apptsHtml}
    </button>`;
  }

  // Задача I (продолжение) - переключатель-пилюли не перерисовывается сам по себе
  // при кросс-обновлении из Месяца (buildMasterSwitch раньше звался ровно один раз,
  // при открытии карточки) - без этого % загрузки уже совпадали бы (общий masterId),
  // но активная пилюля в Неделе визуально отставала бы от реального выбора, пока
  // владелец не кликнет по ней сам. Перерисовываем на каждую загрузку - и локальную,
  // и вызванную кросс-обновлением с соседнего вида.
  function renderWeekMasterSwitch() {
    const switchRow = document.getElementById('weekMasterSwitch');
    if (!switchRow) return;
    buildMasterSwitch(switchRow, masters, scheduleViewState.masterId, (masterId) => {
      scheduleViewState.masterId = masterId;
      loadWeek();
      // Месяц может быть открыт одновременно (Окно 45 - несколько карточек сразу) -
      // если так, обновляем его тоже, чтобы не показывал устаревшего мастера, пока
      // сам не перерисуется по другому поводу.
      if (document.getElementById('scheduleCard-month')?.open) ctx.getMonthApi?.()?.loadMonth();
    });
  }

  async function loadWeek() {
    const grid = document.getElementById('weekGrid');
    if (!grid || !scheduleViewState.masterId) return;
    renderWeekMasterSwitch();
    // Показываем НЕ "текущую календарную неделю", а ту, что содержит общий якорь -
    // поэтому weekStart здесь производная от scheduleViewState.date, не своя переменная.
    const from = mondayOf(scheduleViewState.date);
    const to = addDays(from, 6);
    // Подпись диапазона больше не живёт между стрелками: её роль взял общий якорь
    // под вкладками (Окно 25) - две одинаковые подписи на одном экране были шумом.
    showSkeleton(grid, 5, { tall: true });
    try {
      const [rangeDays, bookingsRes, holidayMap] = await Promise.all([
        fetchJson(`/schedule-range?masterId=${scheduleViewState.masterId}&from=${from}&to=${to}`),
        fetchJson(`/bookings?masterId=${scheduleViewState.masterId}&from=${from}&to=${to}`),
        holidayMapForRange(from, to),
      ]);
      const bookingsByDate = new Map();
      for (const b of bookingsRes.bookings ?? []) {
        if (b.status === 'cancelled') continue;
        if (!bookingsByDate.has(b.date)) bookingsByDate.set(b.date, []);
        bookingsByDate.get(b.date).push(b);
      }
      grid.innerHTML = rangeDays
        .map((day) => weekDayCellHtml(day, bookingsByDate.get(day.date) ?? [], holidayNameOf(holidayMap, day.date)))
        .join('');
      grid.querySelectorAll('[data-open-day]').forEach((cellBtn) => {
        cellBtn.addEventListener('click', () => setView('day', cellBtn.dataset.openDay));
      });
    } catch (err) {
      grid.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить неделю'))}</span>`;
      showError(errorMessage(err, 'Не удалось загрузить неделю'));
    }
  }

  const grid = document.getElementById('weekGrid');
  if (grid) {
    // Листание недели двигает общий якорь на понедельник соседней недели - иначе
    // возврат в Месяц/День показал бы дату из той недели, которую уже пролистали.
    document.getElementById('weekNavPrev')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), -7)));
    document.getElementById('weekNavNext')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), 7)));
    loadWeek();
  } // страница без реальной Недели - loadWeek выше уже сам не делает ничего без #weekGrid

  return { loadWeek };
}
