// Декомпозиция crm-schedule-views.js (07.08.2026) - вид "Месяц" + модалка
// редактирования дня. Код перенесён 1:1, зависимости - через ctx.
//
// Окно 44 (07.08.2026, ПРОМПТ-ОКНО-44-РАСПИСАНИЕ-НЕДЕЛЯ-МЕСЯЦ.md) - добавлен
// переключатель "Все мастера / по одному" (честная поправка к ТЗ: промпт говорит
// "как на существующем", но живым grep'ом по проекту такого переключателя нигде не
// было - строим с нуля). "Все мастера" (дефолт) - агрегат: % загрузки команды за
// день + общее число записей, БЕЗ dot-статуса (work/edit/off - смысл только для
// ОДНОГО графика, у команды дни расходятся) и без карандаша редактирования (правка
// дня требует конкретного мастера). "По одному" - прежнее поведение 1:1
// (weeklyBaselineFor/dayStatusDot/modal), просто с добавленным % загрузки в ячейке.
import {
  WEEKDAY_SHORT, isoWeekdayOf, addMonths, pad2, dayStatusDot, ruPluralBooking, holidayNameOf, escapeHtml,
  conflictListWithOpenButton, buildMasterSwitch, isDayOffShift, GLOBAL_DEFAULT_START, GLOBAL_DEFAULT_END,
  fmtRu, loadPercent, toMinutes,
} from './crm-schedule-shared.js';
import { todayStr } from './crm-calendar.js';
import { errorMessage, reportError, showError } from './crm-toast.js';
import { showLoadingLine, showSkeleton } from './crm-loading.js';

export function monthModeHintState(mode) {
  return {
    statusLegendHidden: mode === 'all',
  };
}

export function monthWeekdayHeaderHtml() {
  return WEEKDAY_SHORT
    .map((weekday) => `<div class="month-weekday">${weekday}</div>`)
    .join('');
}

export function wireMonthView(ctx) {
  const {
    masters, isSolo, fetchJson, apiSend, holidayMapForRange, renderTimeSelect, timeSelectValue,
    scheduleViewState, setView,
  } = ctx;

  // Задача I (Окно 53) - выбор мастера читается/пишется через ОБЩИЙ scheduleViewState,
  // не свою локальную переменную (тем же принципом, что и дата, Окно 25) - см. полный
  // разбор причины в crm-schedule-views.js, у объявления scheduleViewState.
  let editingDate = null;
  // Переключатель только имеет смысл, когда реально есть команда (не solo-мастер на
  // crm-master.html и не единственный мастер в системе) - иначе "Все/по одному" были
  // бы двумя одинаковыми экранами.
  const hasTeamToggle = !isSolo && masters.length > 1;
  let monthMode = hasTeamToggle ? 'all' : 'single';

  function syncMonthModeHints() {
    const state = monthModeHintState(monthMode);
    const statusLegend = document.getElementById('monthStatusLegend');
    if (statusLegend) statusLegend.hidden = state.statusLegendHidden;
  }

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
        reportError(note, 'Нельзя сохранить день: на это время уже есть записи, они перечислены ниже');
        conflictsEl.innerHTML = conflictListWithOpenButton(data.conflicts);
        conflictsEl.hidden = false;
        wireConflictOpenButtons(conflictsEl);
        return;
      }
      if (!ok) throw Object.assign(new Error(`HTTP ${status}`), { status, code: data?.error ?? null });
      closeDayEditModal();
      await loadMonth(); // перерисовать ячейку СВЕЖИМ запросом, не оптимистичным обновлением (см. промпт Окна 18, Задача 3)
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
      if (!ok && status !== 404) throw Object.assign(new Error(`HTTP ${status}`), { status, code: data?.error ?? null });
      closeDayEditModal();
      await loadMonth();
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
        // карточку записи, аудит Задачи A нашёл её сверх двух, перечисленных в промпте.
        // Без правки она после удаления старой формы открывала бы ничего.
        const open = window.openBookingEdit || window.openBooking;
        if (card && typeof open === 'function') open(card);
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

  function monthRange() {
    // Тот же принцип, что у Недели: месяц берётся из общего якоря, своей пары
    // monthViewYear/monthViewMonth больше нет.
    const [year, month] = scheduleViewState.date.split('-').map(Number);
    const firstOfMonth = `${year}-${pad2(month)}-01`;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastOfMonth = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
    return { firstOfMonth, lastOfMonth };
  }
  function leadingEmptyCells(firstOfMonth) {
    const firstWeekday = isoWeekdayOf(firstOfMonth); // 1..7, Пн=1
    let cells = '';
    for (let i = 1; i < firstWeekday; i++) cells += '<div class="month-day is-empty"></div>';
    return cells;
  }

  // Задача I (продолжение, Окно 53) - см. полное объяснение у renderWeekMasterSwitch
  // (crm-schedule-view-week.js) - тот же приём здесь: переключатель перерисовывается
  // на каждую загрузку "По одному", а не один раз при открытии карточки, иначе
  // активная пилюля отставала бы от реального scheduleViewState.masterId при
  // кросс-обновлении с Недели.
  function renderMonthMasterSwitch() {
    const switchRow = document.getElementById('monthMasterSwitch');
    if (!switchRow) return;
    buildMasterSwitch(switchRow, masters, scheduleViewState.masterId, (masterId) => {
      scheduleViewState.masterId = masterId;
      loadMonth();
      // Неделя может быть открыта одновременно (Окно 45) - обновляем и её, чтобы не
      // показывала устаревшего мастера, пока сама не перерисуется по другому поводу.
      if (document.getElementById('scheduleCard-week')?.open) ctx.getWeekApi?.()?.loadWeek();
    });
    switchRow.hidden = monthMode === 'all';
  }

  async function loadMonthSingle() {
    const grid = document.getElementById('monthGrid');
    if (!grid || !scheduleViewState.masterId) return;
    renderMonthMasterSwitch();
    const { firstOfMonth, lastOfMonth } = monthRange();
    showSkeleton(grid, 5, { tall: true });
    try {
      const [rangeDays, weeklyRows, bookingsRes, holidayMap] = await Promise.all([
        fetchJson(`/schedule-range?masterId=${scheduleViewState.masterId}&from=${firstOfMonth}&to=${lastOfMonth}`),
        fetchJson(`/master-weekly-schedule?masterId=${scheduleViewState.masterId}`),
        fetchJson(`/bookings?masterId=${scheduleViewState.masterId}&from=${firstOfMonth}&to=${lastOfMonth}`),
        holidayMapForRange(firstOfMonth, lastOfMonth),
      ]);
      const weeklyByWeekday = new Map(weeklyRows.map((r) => [r.weekday, r]));
      const bookingsByDate = new Map();
      for (const b of bookingsRes.bookings ?? []) {
        if (b.status === 'cancelled') continue;
        if (!bookingsByDate.has(b.date)) bookingsByDate.set(b.date, []);
        bookingsByDate.get(b.date).push(b);
      }
      let cells = monthWeekdayHeaderHtml() + leadingEmptyCells(firstOfMonth);
      for (const day of rangeDays) {
        const baseline = weeklyBaselineFor(weeklyByWeekday, isoWeekdayOf(day.date));
        const current = { startTime: day.startTime, endTime: day.endTime, breaks: day.breaks };
        const overridden = !schedulesEqual(current, baseline);
        const status = day.isDayOff ? 'off' : overridden ? 'edit' : 'work';
        const dayBookings = bookingsByDate.get(day.date) ?? [];
        const count = dayBookings.length;
        const pct = loadPercent(day, dayBookings);
        const dayNum = day.date.slice(8, 10);
        // Праздничная метка - ВТОРОЙ независимый признак ячейки: статус (выходной/
        // правка/обычный) продолжает отвечать за рабочий день, бейдж - за красный
        // день календаря.
        const holidayName = holidayNameOf(holidayMap, day.date);
        cells += `<div class="month-day month-day--real${holidayName ? ' is-holiday' : ''}${day.date === todayStr() ? ' is-today' : ''}" data-date="${day.date}" data-status="${status}">
          <span class="num">${dayStatusDot(status)}${dayNum}${!day.isDayOff ? ` <span class="month-load-pct">${pct}%</span>` : ''}</span>
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
      grid.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить месяц'))}</span>`;
      showError(errorMessage(err, 'Не удалось загрузить месяц'));
    }
  }

  // "Все мастера" - агрегат по команде: % загрузки = суммарные занятые минуты всех
  // мастеров в этот день / суммарные доступные минуты всех мастеров в этот день.
  // Мастера без настроенного графика (hasWorkingSchedule===false, GET /staff, Окно
  // 22) исключены из знаменателя целиком - иначе getEffectiveSchedule молча
  // подставил бы им глобальный дефолт 10:00-20:00 (тот же класс бага, что чинило
  // Окно 43 для Дня) и завысил бы доступность команды мастером, которого физически
  // нельзя забронировать. dataStatus/dot и карандаш редактирования здесь не
  // показываем - "рабочий/правка/выходной" осмысленно только для ОДНОГО графика, у
  // команды в один день кто-то работает, а кто-то нет одновременно.
  async function loadMonthAggregate() {
    const grid = document.getElementById('monthGrid');
    if (!grid) return;
    const { firstOfMonth, lastOfMonth } = monthRange();
    const bookableMasters = masters.filter((m) => m.hasWorkingSchedule !== false);
    if (bookableMasters.length === 0) {
      // Крайний случай - у ВСЕХ мастеров пуст график (не должно случаться на живом
      // проекте, но теоретически возможно на свежей базе до первой настройки) -
      // считать агрегат не по чему, честное сообщение вместо пустой/сломанной сетки.
      grid.innerHTML = '<p class="section-hint">Ни у одного мастера ещё не настроен рабочий график - переключитесь на «По одному» или настройте график в разделе «Команда»</p>';
      return;
    }
    showSkeleton(grid, 5, { tall: true });
    try {
      const [schedulesByMaster, bookingsRes, holidayMap] = await Promise.all([
        Promise.all(bookableMasters.map((m) => fetchJson(`/schedule-range?masterId=${m.id}&from=${firstOfMonth}&to=${lastOfMonth}`))),
        fetchJson(`/bookings?from=${firstOfMonth}&to=${lastOfMonth}`),
        holidayMapForRange(firstOfMonth, lastOfMonth),
      ]);
      const bookingsByMasterDate = new Map();
      for (const b of bookingsRes.bookings ?? []) {
        if (b.status === 'cancelled') continue;
        const key = `${b.masterId}|${b.date}`;
        if (!bookingsByMasterDate.has(key)) bookingsByMasterDate.set(key, []);
        bookingsByMasterDate.get(key).push(b);
      }
      // date → { availableMin, bookedMin, count } суммарно по всем bookableMasters.
      const byDate = new Map();
      bookableMasters.forEach((m, i) => {
        for (const day of schedulesByMaster[i]) {
          const rec = byDate.get(day.date) ?? { availableMin: 0, bookedMin: 0, count: 0 };
          if (!day.isDayOff) {
            const breakMin = (day.breaks ?? []).reduce((s, b) => s + (toMinutes(b.endTime) - toMinutes(b.startTime)), 0);
            rec.availableMin += Math.max(0, toMinutes(day.endTime) - toMinutes(day.startTime) - breakMin);
          }
          const dayBookings = bookingsByMasterDate.get(`${m.id}|${day.date}`) ?? [];
          rec.bookedMin += dayBookings.reduce((s, b) => s + (toMinutes(b.endTime) - toMinutes(b.startTime)), 0);
          rec.count += dayBookings.length;
          byDate.set(day.date, rec);
        }
      });
      let cells = monthWeekdayHeaderHtml() + leadingEmptyCells(firstOfMonth);
      // Дни месяца берём из byDate.keys() (не из ответа одного мастера) - каждый
      // bookableMaster запрошен на тот же диапазон firstOfMonth..lastOfMonth, значит
      // объединение их дат покрывает весь месяц целиком (bookableMasters.length > 0
      // здесь гарантировано - пустой случай отсечён ранним return выше).
      const daysInRange = [...byDate.keys()].sort();
      for (const date of daysInRange) {
        const rec = byDate.get(date) ?? { availableMin: 0, bookedMin: 0, count: 0 };
        const pct = rec.availableMin <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((rec.bookedMin / rec.availableMin) * 100)));
        const dayNum = date.slice(8, 10);
        const holidayName = holidayNameOf(holidayMap, date);
        cells += `<div class="month-day month-day--real${holidayName ? ' is-holiday' : ''}${date === todayStr() ? ' is-today' : ''}" data-date="${date}">
          <span class="num">${dayNum} <span class="month-load-pct">${pct}%</span></span>
          ${holidayName ? `<span class="holiday-label" data-holiday-for="${date}">🎉 ${escapeHtml(holidayName)}</span>` : ''}
          <span class="appt-count">${rec.count ? `${rec.count} ${ruPluralBooking(rec.count)}` : 'Нет записей'}</span>
        </div>`;
      }
      grid.innerHTML = cells;
      grid.querySelectorAll('.month-day--real').forEach((cellEl) => {
        cellEl.addEventListener('click', () => setView('day', cellEl.dataset.date));
      });
    } catch (err) {
      grid.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить месяц'))}</span>`;
      showError(errorMessage(err, 'Не удалось загрузить месяц'));
    }
  }

  async function loadMonth() {
    if (monthMode === 'all') await loadMonthAggregate();
    else await loadMonthSingle();
  }

  const grid = document.getElementById('monthGrid');
  if (grid) {
    // Само построение/показ переключателя теперь внутри renderMonthMasterSwitch(),
    // вызывается из loadMonthSingle() - здесь только начальная видимость ДО первой
    // загрузки (дефолт 'all' - loadMonthAggregate() не заходит в loadMonthSingle()
    // вообще, buildMasterSwitch не позвался бы ни разу без этой строки).
    const switchRow = document.getElementById('monthMasterSwitch');
    if (switchRow) switchRow.hidden = monthMode === 'all';
    syncMonthModeHints();
    if (hasTeamToggle) {
      const modeRow = document.createElement('div');
      modeRow.className = 'master-switch-row';
      modeRow.id = 'monthModeToggle';
      modeRow.innerHTML = `<div class="seg-bar master-pill-row">
        <button type="button" class="master-pill${monthMode === 'all' ? ' active' : ''}" data-mode="all">Все мастера</button>
        <button type="button" class="master-pill${monthMode === 'single' ? ' active' : ''}" data-mode="single">По одному</button>
      </div>`;
      switchRow?.insertAdjacentElement('beforebegin', modeRow);
      modeRow.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.classList.contains('active')) return;
          monthMode = btn.dataset.mode;
          modeRow.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
          if (switchRow) switchRow.hidden = monthMode === 'all';
          syncMonthModeHints();
          loadMonth();
        });
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
