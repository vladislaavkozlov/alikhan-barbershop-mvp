// Декомпозиция crm-schedule-views.js (07.08.2026) - вкладка "Год" (справочный
// производственный календарь + массовое закрытие праздников). Код перенесён 1:1.
// loadMonth/loadWeek/closeDayEditModal/wireConflictOpenButtons приходят из уже
// свежесозданных модулей Месяца/Недели через ctx - это ЕДИНСТВЕННОЕ место, где
// один вид расписания намеренно знает о других (оркестрация закрытия праздников
// должна перерисовать ту вкладку, что сейчас открыта), тот же приём, что и
// renderLiveProof в crm-dashboard.js при декомпозиции crm-auth.js (Этап 1).
import { groupHolidaysByMonth, groupDatesToRanges, ruPluralDate, escapeHtml, conflictListWithOpenButton } from './crm-schedule-shared.js';
import { reportError } from './crm-toast.js';
import { T, Tc, P, C } from './crm-terms.js';

export function wireYearView(ctx) {
  const {
    apiSend, holidaysOfYear, holidayCacheByYear, scheduleViewState, yearPanelYear,
    loadMonth, loadWeek, wireConflictOpenButtons,
  } = ctx;

  // Раньше здесь лежали 12 захардкоженных строк с праздниками - справочный текст,
  // с которым нельзя было ничего сделать. Теперь тот же список приходит из базы, а
  // рядом с каждой датой стоит галочка: отметил новогодние каникулы, нажал одну
  // кнопку - у всех мастеров эти дни стали выходными.
  function yearMonthCardHtml(monthBlock) {
    if (monthBlock.holidays.length === 0) {
      return `<div class="year-month"><div class="ym-name">${monthBlock.name}</div><span class="ym-holiday">без праздников</span></div>`;
    }
    const rows = monthBlock.holidays
      .map((h) => {
        const dayNum = Number(h.date.slice(8, 10));
        return `<label class="ym-holiday-row">
          <input type="checkbox" data-holiday-date="${h.date}">
          <span class="ym-holiday">${dayNum} - ${escapeHtml(h.name)}</span>
        </label>`;
      })
      .join('');
    return `<div class="year-month"><div class="ym-name">${monthBlock.name}</div>${rows}</div>`;
  }

  function selectedHolidayDates() {
    return [...document.querySelectorAll('#yearGrid input[data-holiday-date]:checked')].map((cb) => cb.dataset.holidayDate);
  }

  function syncYearCloseButton() {
    const btn = document.getElementById('yearCloseSelected');
    if (!btn) return;
    const count = selectedHolidayDates().length;
    btn.disabled = count === 0;
    btn.textContent = count === 0
      ? P('holidays.closeAll')
      : P('holidays.closeCount', { count, days: ruPluralDate(count) });
  }

  async function renderYear() {
    const grid = document.getElementById('yearGrid');
    if (!grid) return; // страница со статичной вкладкой "Год" (мастер/админ) - не трогаем
    // Год берётся из YEAR_PANEL_YEAR, а не из якоря: панель показывает справочный
    // календарь конкретного года и под якорную дату не перерисовывается (Окно 25).
    const holidayMap = await holidaysOfYear(yearPanelYear);
    const holidays = [...holidayMap].map(([date, name]) => ({ date, name }));
    grid.innerHTML = groupHolidaysByMonth(holidays).map(yearMonthCardHtml).join('');
    grid.querySelectorAll('input[data-holiday-date]').forEach((cb) => {
      cb.addEventListener('change', syncYearCloseButton);
    });
    syncYearCloseButton();
  }

  async function closeSelectedHolidays() {
    const btn = document.getElementById('yearCloseSelected');
    const note = document.getElementById('yearCloseNote');
    const conflictsEl = document.getElementById('yearCloseConflicts');
    const dates = selectedHolidayDates();
    if (!btn || dates.length === 0) return;
    btn.disabled = true;
    note.textContent = 'Закрываю…';
    conflictsEl.hidden = true;
    try {
      // Отмеченные даты идут пачками подряд идущих (groupDatesToRanges): каникулы
      // 1-8 января - это один запрос, а не восемь.
      const totals = { closed: 0, skipped: 0, conflicts: [] };
      for (const range of groupDatesToRanges(dates)) {
        const { ok, status, data } = await apiSend('/holidays/close', 'POST', range);
        if (!ok) throw Object.assign(new Error(`HTTP ${status}`), { status, code: data?.error ?? null });
        totals.closed += data.closed.length;
        totals.skipped += data.skipped.length;
        totals.conflicts.push(...data.conflicts);
      }
      const parts = [P('holidays.closedTotal', { count: totals.closed })];
      if (totals.skipped) parts.push(`уже были выходными: ${totals.skipped}`);
      note.textContent = parts.join(' · ');
      // Даты с живой записью не закрываются молча - показываем их владельцу тем же
      // списком с кнопкой перехода в день, что и конфликты в модалке дня (Окно 18).
      if (totals.conflicts.length) {
        note.textContent += ` · ${P('schedule.notClosedConflicts')}: ${totals.conflicts.length}`;
        conflictsEl.innerHTML = conflictListWithOpenButton(
          totals.conflicts.map((c) => ({ date: c.date, conflicts: c.conflicts }))
        );
        conflictsEl.hidden = false;
        wireConflictOpenButtons(conflictsEl);
      }
      // Свежий запрос вместо оптимистичного обновления - тот же принцип, что у
      // модалки дня: на экране должно быть то, что реально лежит в базе.
      holidayCacheByYear.clear();
      if (scheduleViewState.view === 'month') await loadMonth();
      else if (scheduleViewState.view === 'week') await loadWeek();
    } catch (err) {
      reportError(note, err, 'Не удалось закрыть день');
    } finally {
      syncYearCloseButton();
    }
  }

  if (document.getElementById('yearGrid')) {
    document.getElementById('yearCloseSelected')?.addEventListener('click', closeSelectedHolidays);
    renderYear();
  }

  return { renderYear };
}
