// Декомпозиция crm-schedule-views.js (07.08.2026) - вид "Месяц" + модалка
// редактирования дня. Код перенесён 1:1, зависимости - через ctx.
import {
  isoWeekdayOf, addMonths, pad2, dayStatusDot, ruPluralBooking, holidayNameOf, escapeHtml,
  conflictListWithOpenButton, buildMasterSwitch, isDayOffShift, GLOBAL_DEFAULT_START, GLOBAL_DEFAULT_END,
  fmtRu,
} from './crm-schedule-shared.js';

export function wireMonthView(ctx) {
  const {
    masters, isSolo, fetchJson, apiSend, holidayMapForRange, renderTimeSelect, timeSelectValue,
    scheduleViewState, setView,
  } = ctx;

  let monthMasterId = masters[0]?.id ?? null;
  let editingDate = null;

  // Ожидаемый график ЭТОГО дня недели по "Стандартному графику" (master_weekly_schedule) -
  // та же логика приоритета, что у getEffectiveSchedule на сервере (api/server.mjs),
  // нужна здесь ТОЛЬКО чтобы понять, разошёлся ли конкретный день с недельным шаблоном
  // (🟡 в Месяце) - реальные данные дня всегда берутся из /schedule-range, не отсюда.
  function weeklyBaselineFor(weeklyByWeekday, weekday) {
    const row = weeklyByWeekday.get(weekday);
    if (!row) return { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [] };
    if (!row.isWorking) {
      return { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }] };
    }
    return {
      startTime: row.workStart,
      endTime: row.workEnd,
      breaks: row.breakStart ? [{ startTime: row.breakStart, endTime: row.breakEnd }] : [],
    };
  }
  function schedulesEqual(a, b) {
    if (a.startTime !== b.startTime || a.endTime !== b.endTime) return false;
    if (a.breaks.length !== b.breaks.length) return false;
    return a.breaks.every((br, i) => br.startTime === b.breaks[i]?.startTime && br.endTime === b.breaks[i]?.endTime);
  }

  function syncDayEditVisibility() {
    const working = document.getElementById('dayEditWorking').checked;
    document.getElementById('dayEditFields').style.display = working ? '' : 'none';
    document.getElementById('dayEditBreakToggleWrap').style.display = working ? '' : 'none';
    document.getElementById('dayEditBreakFields').style.display = working && document.getElementById('dayEditBreakOn').checked ? '' : 'none';
    // Окно 28: подпись под переключателем называет состояние дня СЛОВОМ. Сам по себе
    // выключенный тумблер рядом с надписью "Рабочий день" читается неоднозначно -
    // владелец не понимает, это уже выходной или он ещё не нажал.
    const stateEl = document.getElementById('dayEditState');
    if (stateEl) {
      stateEl.textContent = working
        ? `Сейчас: рабочий, ${timeSelectValue('dayEditStart') ?? GLOBAL_DEFAULT_START}–${timeSelectValue('dayEditEnd') ?? GLOBAL_DEFAULT_END}`
        : 'Сейчас: выходной';
      stateEl.classList.toggle('is-off', !working);
    }
  }

  function closeDayEditModal() {
    const modal = document.getElementById('dayEditModal');
    if (modal) modal.hidden = true;
  }

  function openDayEditModal(date) {
    const modal = document.getElementById('dayEditModal');
    if (!modal) return;
    editingDate = date;
    document.getElementById('dayEditTitle').textContent = fmtRu(date);
    document.getElementById('dayEditNote').textContent = 'Загружаю текущий график…';
    // Окно 28: пока график этого дня не приехал, тело модалки скрыто. Раньше в
    // разметке стоял статичный checked, и в это окно владелец видел включённый
    // "Рабочий день" на дне, который на самом деле выходной - заглушка, а не факт.
    modal.querySelector('.day-edit-card')?.classList.add('is-loading');
    const conflictsEl = document.getElementById('dayEditConflicts');
    conflictsEl.hidden = true;
    conflictsEl.innerHTML = '';
    modal.hidden = false;

    fetchJson(`/schedule?masterId=${monthMasterId}&date=${date}`)
      .then((shifts) => {
        const shift = shifts.find((s) => s.date === date);
        // Окно 28: границы берутся из смены самого дня (isDayOffShift), а не из
        // литералов 10:00-20:00 - иначе у мастера со сменой 09:00-18:00 закрытый
        // день открывался как рабочий.
        const isDayOff = isDayOffShift(shift);
        document.getElementById('dayEditWorking').checked = !isDayOff;
        renderTimeSelect('dayEditStart-slot', 'dayEditStart', shift?.startTime || GLOBAL_DEFAULT_START);
        renderTimeSelect('dayEditEnd-slot', 'dayEditEnd', shift?.endTime || GLOBAL_DEFAULT_END);
        const realBreak = !isDayOff ? shift?.breaks?.[0] : null;
        document.getElementById('dayEditBreakOn').checked = !!realBreak;
        renderTimeSelect('dayEditBreakStart-slot', 'dayEditBreakStart', realBreak?.startTime || '13:00');
        renderTimeSelect('dayEditBreakEnd-slot', 'dayEditBreakEnd', realBreak?.endTime || '14:00');
        document.getElementById('dayEditNote').textContent = '';
        modal.querySelector('.day-edit-card')?.classList.remove('is-loading');
        syncDayEditVisibility();
      })
      .catch((err) => {
        // Тело так и остаётся скрытым: не зная реального графика дня, форму показывать
        // нельзя - сохранение из неё молча перезаписало бы день значениями заглушки.
        document.getElementById('dayEditNote').textContent = `Не удалось загрузить текущий график: ${err.message}`;
      });
  }

  async function saveDayEdit() {
    const working = document.getElementById('dayEditWorking').checked;
    const startTime = working ? timeSelectValue('dayEditStart') : GLOBAL_DEFAULT_START;
    const endTime = working ? timeSelectValue('dayEditEnd') : GLOBAL_DEFAULT_END;
    const breaks = !working
      ? [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }]
      : document.getElementById('dayEditBreakOn').checked
        ? [{ startTime: timeSelectValue('dayEditBreakStart'), endTime: timeSelectValue('dayEditBreakEnd') }]
        : [];
    const btn = document.getElementById('dayEditSave');
    const note = document.getElementById('dayEditNote');
    const conflictsEl = document.getElementById('dayEditConflicts');
    btn.disabled = true;
    note.textContent = '';
    conflictsEl.hidden = true;
    try {
      const { ok, status, data } = await apiSend('/schedule', 'POST', { masterId: monthMasterId, date: editingDate, startTime, endTime, breaks });
      if (status === 409 && data?.error === 'schedule_conflict') {
        note.textContent = 'Нельзя сохранить, пока не разберётесь с этими записями:';
        conflictsEl.innerHTML = conflictListWithOpenButton(data.conflicts);
        conflictsEl.hidden = false;
        wireConflictOpenButtons(conflictsEl);
        return;
      }
      if (!ok) throw new Error(`HTTP ${status}`);
      closeDayEditModal();
      await loadMonth(); // перерисовать ячейку СВЕЖИМ запросом, не оптимистичным обновлением (см. промпт Окна 18, Задача 3)
    } catch (err) {
      note.textContent = `Не удалось сохранить: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  async function resetDayEdit() {
    const btn = document.getElementById('dayEditReset');
    const note = document.getElementById('dayEditNote');
    btn.disabled = true;
    note.textContent = '';
    try {
      const { ok, status } = await apiSend(`/schedule?masterId=${monthMasterId}&date=${editingDate}`, 'DELETE');
      if (!ok && status !== 404) throw new Error(`HTTP ${status}`);
      closeDayEditModal();
      await loadMonth();
    } catch (err) {
      note.textContent = `Не удалось сбросить: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // Общий рендер конфликтов (conflictListWithOpenButton) используется и модалкой дня
  // здесь, и массовым закрытием праздников в crm-schedule-view-year.js - именно
  // поэтому wireConflictOpenButtons экспортируется, а не остаётся приватной.
  function wireConflictOpenButtons(scopeEl) {
    scopeEl.querySelectorAll('.conflict-open-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const date = b.dataset.conflictDate;
        const planned = `${b.dataset.conflictStart}–${b.dataset.conflictEnd}`;
        closeDayEditModal();
        await setView('day', date);
        const card = document.querySelector(`.appt[data-planned="${planned}"]`);
        if (card && typeof window.openBooking === 'function') window.openBooking(card);
      });
    });
  }

  function wireDayEditModal() {
    const modal = document.getElementById('dayEditModal');
    if (!modal) return; // страница без модалки (не должно случиться на owner/admin)
    document.getElementById('dayEditClose')?.addEventListener('click', closeDayEditModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDayEditModal(); // клик по подложке закрывает, по карточке - нет
    });
    document.getElementById('dayEditWorking').addEventListener('change', syncDayEditVisibility);
    document.getElementById('dayEditBreakOn').addEventListener('change', syncDayEditVisibility);
    document.getElementById('dayEditSave').addEventListener('click', saveDayEdit);
    document.getElementById('dayEditReset').addEventListener('click', resetDayEdit);
  }

  async function loadMonth() {
    const grid = document.getElementById('monthGrid');
    if (!grid || !monthMasterId) return;
    // Тот же принцип, что у Недели: месяц берётся из общего якоря, своей пары
    // monthViewYear/monthViewMonth больше нет.
    const [year, month] = scheduleViewState.date.split('-').map(Number);
    const firstOfMonth = `${year}-${pad2(month)}-01`;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastOfMonth = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
    grid.innerHTML = '<p class="section-hint">Загружаю…</p>';
    try {
      const [rangeDays, weeklyRows, bookingsRes, holidayMap] = await Promise.all([
        fetchJson(`/schedule-range?masterId=${monthMasterId}&from=${firstOfMonth}&to=${lastOfMonth}`),
        fetchJson(`/master-weekly-schedule?masterId=${monthMasterId}`),
        fetchJson(`/bookings?masterId=${monthMasterId}&from=${firstOfMonth}&to=${lastOfMonth}`),
        holidayMapForRange(firstOfMonth, lastOfMonth),
      ]);
      const weeklyByWeekday = new Map(weeklyRows.map((r) => [r.weekday, r]));
      const countByDate = new Map();
      for (const b of bookingsRes.bookings ?? []) {
        if (b.status === 'cancelled') continue;
        countByDate.set(b.date, (countByDate.get(b.date) || 0) + 1);
      }
      const firstWeekday = isoWeekdayOf(firstOfMonth); // 1..7, Пн=1
      let cells = '';
      for (let i = 1; i < firstWeekday; i++) cells += '<div class="month-day is-empty"></div>';
      for (const day of rangeDays) {
        const baseline = weeklyBaselineFor(weeklyByWeekday, isoWeekdayOf(day.date));
        const current = { startTime: day.startTime, endTime: day.endTime, breaks: day.breaks };
        const overridden = !schedulesEqual(current, baseline);
        const status = day.isDayOff ? 'off' : overridden ? 'edit' : 'work';
        const count = countByDate.get(day.date) || 0;
        const dayNum = Number(day.date.slice(8, 10));
        // Праздничная метка - ВТОРОЙ независимый признак ячейки: статус (выходной/
        // правка/обычный) продолжает отвечать за рабочий день, бейдж - за красный
        // день календаря.
        const holidayName = holidayNameOf(holidayMap, day.date);
        cells += `<div class="month-day month-day--real${holidayName ? ' is-holiday' : ''}" data-date="${day.date}" data-status="${status}">
          <span class="num">${dayStatusDot(status)}${dayNum}</span>
          ${holidayName ? `<span class="holiday-label" data-holiday-for="${day.date}">🎉 ${escapeHtml(holidayName)}</span>` : ''}
          ${count ? `<span class="appt-count">${count} ${ruPluralBooking(count)}</span>` : ''}
          ${isSolo ? '' : `<button type="button" class="month-day-edit" data-edit-date="${day.date}" aria-label="Редактировать день">✎</button>`}
        </div>`;
      }
      grid.innerHTML = cells;
      grid.querySelectorAll('.month-day--real').forEach((cellEl) => {
        cellEl.addEventListener('click', (e) => {
          if (e.target.closest('.month-day-edit')) return;
          setView('day', cellEl.dataset.date);
        });
      });
      grid.querySelectorAll('.month-day-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openDayEditModal(btn.dataset.editDate);
        });
      });
    } catch (err) {
      grid.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }

  const grid = document.getElementById('monthGrid');
  if (grid) {
    const switchRow = document.getElementById('monthMasterSwitch');
    if (switchRow) {
      buildMasterSwitch(switchRow, masters, monthMasterId, (masterId) => {
        monthMasterId = masterId;
        loadMonth();
      });
    }
    // Листание месяца ставит якорь на первое число соседнего месяца (addMonths) -
    // возврат в День/Неделю после этого попадает именно в тот месяц, что смотрели.
    document.getElementById('monthNavPrev')?.addEventListener('click', () => setView('month', addMonths(scheduleViewState.date, -1)));
    document.getElementById('monthNavNext')?.addEventListener('click', () => setView('month', addMonths(scheduleViewState.date, 1)));
    wireDayEditModal();
    loadMonth();
  } // страница без реального Месяца - loadMonth выше уже сам не делает ничего без #monthGrid

  return { loadMonth, closeDayEditModal, wireConflictOpenButtons };
}
