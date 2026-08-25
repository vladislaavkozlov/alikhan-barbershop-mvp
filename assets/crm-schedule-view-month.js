// Вид "Месяц" + модалка редактирования дня.
//
// Окно 65 (21.08.2026) - сетка месяца переписана на общий компонент "график работы"
// (assets/crm-schedule-matrix.js): та же матрица мастера × даты, что и в Неделе, только
// окно дат - весь месяц (горизонтальный скролл). Ушли вместе с причиной существовать:
//   - календарные квадратики 7×N (месяц как настенный календарь) - заказчик показал
//     Yclients, где месяц это тот же график команды, растянутый на 30 колонок;
//   - переключатель "Все мастера / по одному" (Окно 44) - матрица показывает всех
//     сразу, режимов больше нет, и агрегатный % команды на день не нужен: в каждой
//     ячейке стоит честный % КОНКРЕТНОГО мастера;
//   - leadingEmptyCells/monthWeekdayHeaderHtml - пустые ячейки до 1-го числа нужны
//     только календарной сетке, у матрицы колонка = дата, выравнивать нечего.
// Период показывается между стрелками навигации (#monthNavLabel), как дата во вкладке
// "День" - правка Влада 21.08.2026 вместо ленты месяцев ("авг сент окт нояб дек"),
// которая заняла целую строку ради того же, что делают две стрелки.
//
// Модалка правки дня перенесена 1:1 (роуты POST/DELETE /schedule и контракт 409 не
// менялись), с одной правкой: openDayEditModal принимает masterId - раньше мастер брался
// только из общего состояния, которое выставляли пилюли-переключатель, а теперь его
// называет сама ячейка матрицы (у каждой строки свой мастер).
import {
  pad2, conflictListWithOpenButton, isDayOffShift, GLOBAL_DEFAULT_START, GLOBAL_DEFAULT_END,
  fmtRu, escapeHtml, addMonths,
} from './crm-schedule-shared.js';
import { buildMatrixModel, matrixHtml, loadMatrixData, wireMatrixClicks } from './crm-schedule-matrix.js';
import { todayStr } from './crm-calendar.js';
import { errorMessage, reportError, showError } from './crm-toast.js';
import { showLoadingLine, showSkeleton } from './crm-loading.js';
import { T, Tc, P, C } from './crm-terms.js';

export function wireMonthView(ctx) {
  const {
    masters, isSolo, fetchJson, apiSend, holidayMapForRange, renderTimeSelect, timeSelectValue,
    scheduleViewState, setView,
  } = ctx;

  let editingDate = null;

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

  // masterId - Окно 65: ячейка матрицы сама называет мастера своей строки. Без него
  // модалка правила бы график того, кто остался в общем состоянии от прошлого действия.
  function openDayEditModal(date, masterId) {
    const modal = document.getElementById('dayEditModal');
    if (!modal) return;
    if (masterId) scheduleViewState.masterId = masterId;
    editingDate = date;
    const master = masters.find((m) => m.id === scheduleViewState.masterId);
    document.getElementById('dayEditTitle').textContent = master ? `${fmtRu(date)} · ${master.name}` : fmtRu(date);
    showLoadingLine(document.getElementById('dayEditNote'), 'Загружаю текущий график…');
    // Окно 28: пока график этого дня не приехал, тело модалки скрыто. Раньше в
    // разметке стоял статичный checked, и в это окно владелец видел включённый
    // "Рабочий день" на дне, который на самом деле выходной - заглушка, а не факт.
    modal.querySelector('.day-edit-card')?.classList.add('is-loading');
    const conflictsEl = document.getElementById('dayEditConflicts');
    conflictsEl.hidden = true;
    conflictsEl.innerHTML = '';
    modal.hidden = false;

    fetchJson(`/schedule?masterId=${scheduleViewState.masterId}&date=${date}`)
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
        reportError(document.getElementById('dayEditNote'), err, 'Не удалось загрузить текущий график');
      });
  }

  // График дня изменился - устарели ОБА вида, они рисуют одни и те же данные разной
  // ширины окна (Окно 65). Перечитываем открытые: месяц всегда (мы в нём), неделю -
  // если её карточка раскрыта (на crm-owner.html их можно держать открытыми обе).
  async function reloadAfterScheduleChange() {
    const jobs = [loadMonth()];
    const weekOpen = document.getElementById('scheduleCard-week')?.open ?? (scheduleViewState.view === 'week');
    if (weekOpen) jobs.push(ctx.getWeekApi?.()?.loadWeek?.());
    await Promise.all(jobs);
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
      const { ok, status, data } = await apiSend('/schedule', 'POST', { masterId: scheduleViewState.masterId, date: editingDate, startTime, endTime, breaks });
      if (status === 409 && data?.error === 'schedule_conflict') {
        reportError(note, P('schedule.conflictSaveDay'));
        conflictsEl.innerHTML = conflictListWithOpenButton(data.conflicts);
        conflictsEl.hidden = false;
        wireConflictOpenButtons(conflictsEl);
        return;
      }
      if (!ok) throw Object.assign(new Error(`HTTP ${status}`), { status, code: data?.error ?? null });
      closeDayEditModal();
      await reloadAfterScheduleChange(); // перерисовать СВЕЖИМ запросом, не оптимистичным обновлением (Окно 18, Задача 3)
    } catch (err) {
      reportError(note, err, 'Не удалось сохранить день');
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
      const { ok, status } = await apiSend(`/schedule?masterId=${scheduleViewState.masterId}&date=${editingDate}`, 'DELETE');
      if (!ok && status !== 404) throw Object.assign(new Error(`HTTP ${status}`), { status });
      closeDayEditModal();
      await reloadAfterScheduleChange();
    } catch (err) {
      reportError(note, err, 'Не удалось сбросить день к обычному графику');
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
        // Окно 55, Задача C - та же пара "новая форма с фолбэком на старую", что в
        // buildApptCard (assets/crm-calendar.js): эта кнопка - третья точка входа в
        // карточку записи.
        const open = window.openBookingEdit || window.openBooking;
        if (card && typeof open === 'function') open(card);
      });
    });
  }

  function wireDayEditModal() {
    const modal = document.getElementById('dayEditModal');
    if (!modal) return; // страница без модалки (crm-master.html - мастер график не правит)
    document.getElementById('dayEditClose')?.addEventListener('click', closeDayEditModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDayEditModal(); // клик по подложке закрывает, по карточке - нет
    });
    document.getElementById('dayEditWorking').addEventListener('change', syncDayEditVisibility);
    document.getElementById('dayEditBreakOn').addEventListener('change', syncDayEditVisibility);
    document.getElementById('dayEditSave').addEventListener('click', saveDayEdit);
    document.getElementById('dayEditReset').addEventListener('click', resetDayEdit);
  }

  function monthRange() {
    // Тот же принцип, что у Недели: месяц берётся из общего якоря (Окно 25), своей пары
    // monthViewYear/monthViewMonth больше нет.
    const [year, month] = scheduleViewState.date.split('-').map(Number);
    const firstOfMonth = `${year}-${pad2(month)}-01`;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastOfMonth = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
    return { firstOfMonth, lastOfMonth };
  }

  async function loadMonth() {
    const grid = document.getElementById('monthGrid');
    if (!grid) return;
    const { firstOfMonth, lastOfMonth } = monthRange();
    showSkeleton(grid, 4, { tall: true });
    try {
      const data = await loadMatrixData({ masters, from: firstOfMonth, to: lastOfMonth, fetchJson, holidayMapForRange });
      const model = buildMatrixModel({ masters, from: firstOfMonth, to: lastOfMonth, ...data });
      grid.innerHTML = matrixHtml(model, { editable: !isSolo });
      wireMatrixClicks(grid, {
        editable: !isSolo,
        onOpenDay: (date) => setView('day', date),
        onEditCell: (date, masterId) => openDayEditModal(date, masterId),
      });
      // Месяц шире экрана всегда - открываем его на сегодняшнем дне, если он в этом
      // месяце (иначе человек каждый раз сам скроллит от 1-го числа к текущему).
      grid.querySelector('.sm-head.is-today')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    } catch (err) {
      grid.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить месяц'))}</span>`;
      showError(errorMessage(err, 'Не удалось загрузить месяц'));
    }
  }

  const grid = document.getElementById('monthGrid');
  if (grid) {
    document.getElementById('monthNavPrev')?.addEventListener('click', () => setView('month', addMonths(scheduleViewState.date, -1)));
    document.getElementById('monthNavNext')?.addEventListener('click', () => setView('month', addMonths(scheduleViewState.date, 1)));
    wireDayEditModal();
    loadMonth();
  } // страница без реального Месяца - loadMonth выше уже сам не делает ничего без #monthGrid

  return { loadMonth, openDayEditModal, wireConflictOpenButtons };
}
