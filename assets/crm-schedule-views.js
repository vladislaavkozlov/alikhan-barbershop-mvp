// Окно 18 (04.08.2026) - вкладки Расписание → Неделя/Месяц владельца и админа были
// статичной вёрсткой-примером Окна 9 (фейковые "Клиент К (пример)", захардкоженные
// "Выходной" по дням недели, month-grid с числами "N записей пример") - ничего не
// читало из базы. "Мой день" была живой (Окно 15), но жёстко привязана к todayStr(),
// без навигации вперёд/назад. Этот модуль получает готовые хелперы параметром
// (fetchJson/apiSend/renderDateSelect/...), а не импортирует их из crm-auth.js -
// crm-auth.js уже импортирует renderDayCalendar из crm-calendar.js, обратный импорт
// отсюда создал бы циклическую зависимость модулей без необходимости.
import { mastersOf } from './crm-calendar.js';

const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTH_LABEL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// Тот же глобальный дефолт, что и на сервере (api/server.mjs: GLOBAL_DEFAULT_START/END) -
// нужен здесь только чтобы понять, отличается ли конкретный день от "стандартного"
// недельного графика (🟡 в Месяце), сам источник истины - всегда ответ сервера.
const GLOBAL_DEFAULT_START = '10:00';
const GLOBAL_DEFAULT_END = '20:00';

function el(id) {
  return document.getElementById(id);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoWeekdayOf(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
function mondayOf(dateStr) {
  return addDays(dateStr, -(isoWeekdayOf(dateStr) - 1));
}
function ruPluralBooking(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запись';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'записи';
  return 'записей';
}
function fmtRu(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

// Модалка редактирования дня (Задача 3) - конфликт всегда об ОДНОЙ дате (POST
// /schedule принимает одну дату за раз), но conflictsByDate остаётся массивом
// (тот же контракт 409, что и PUT /master-weekly-schedule) - на всякий случай не
// предполагаем длину 1 жёстко.
function conflictListWithOpenButton(conflictsByDate) {
  return conflictsByDate
    .map(({ date, conflicts }) =>
      conflicts
        .map(
          (c) => `<div class="conflict-row">
            <span>${fmtRu(date)} · ${escapeHtml(c.start_time)}–${escapeHtml(c.end_time)} · ${escapeHtml(c.client_name || 'без имени')}${c.client_phone ? ' · ' + escapeHtml(c.client_phone) : ''}</span>
            <button type="button" class="btn btn-ghost btn-sm conflict-open-btn" data-conflict-date="${date}" data-conflict-start="${escapeHtml(c.start_time)}" data-conflict-end="${escapeHtml(c.end_time)}">Открыть запись</button>
          </div>`
        )
        .join('')
    )
    .join('');
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

// Переключатель мастера (Неделя/Месяц) - кнопки, не radio+CSS sibling-selector как
// у старой статичной вёрстки (#wk-ivan1:checked ~ .panel-wk-ivan1): та схема требует
// одно CSS-правило НА КАЖДЫЙ id, захардкоженное в <style> HTML-файла - несовместимо
// с "строим по факту ответа /staff, не по количеству узлов в макете" (см. правку
// crm-calendar.js). Кнопки с .active классом дают тот же внешний вид (.seg-bar) без
// привязки количества мастеров к разметке.
function buildMasterSwitch(container, masters, selectedId, onChange) {
  if (!container) return;
  container.innerHTML = `<div class="seg-bar master-pill-row">${masters
    .map((m) => `<button type="button" class="master-pill${m.id === selectedId ? ' active' : ''}" data-master-id="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button>`)
    .join('')}</div>`;
  container.querySelectorAll('.master-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      container.querySelectorAll('.master-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.masterId);
    });
  });
}

export function wireScheduleViews(ctx) {
  const { staff, staffList, services, priceOf, fetchJson, apiSend, renderDateSelect, renderTimeSelect, timeSelectValue, todayStr, renderDayCalendar } = ctx;
  const masters = mastersOf(staffList);
  if (masters.length === 0) return; // роль без доступа к расписанию (не должно случиться, но не падаем)

  let currentDayDate = todayStr();

  async function loadDay(date) {
    currentDayDate = date;
    let bookings = [];
    try {
      const res = await fetchJson(`/bookings?date=${date}`);
      bookings = res.bookings || [];
    } catch {
      // renderDayCalendar сам покажет пустой день - здесь не блокируем навигацию
    }
    await renderDayCalendar({ staff, staffList, services, priceOf, bookings, fetchJson, date });
  }

  // Клик по дню в Неделе/Месяце - переключает верхнюю вкладку "Мой день" на эту
  // дату, переиспользуя loadDay/renderDayCalendar выше, не рисуя брони заново.
  async function jumpToDay(date) {
    const dayRadio = el('sp-day');
    if (dayRadio) dayRadio.checked = true;
    await loadDay(date);
  }

  // ───────────────────────── Задача 1: "Мой день" навигация ─────────────────
  function wireDayNav() {
    const prevBtn = el('dayNavPrev');
    const nextBtn = el('dayNavNext');
    const slot = el('dayNavDate-slot');
    if (!prevBtn || !nextBtn || !slot) return; // страница без навигации по датам
    renderDateSelect(slot, 'dayNavDate', currentDayDate);
    slot.addEventListener('customdate:change', (e) => loadDay(e.detail.value));
    const shift = (deltaDays) => {
      const next = addDays(currentDayDate, deltaDays);
      renderDateSelect(slot, 'dayNavDate', next);
      loadDay(next);
    };
    prevBtn.addEventListener('click', () => shift(-1));
    nextBtn.addEventListener('click', () => shift(1));
  }

  // ───────────────────────── Задача 2: "Неделя" ──────────────────────────────
  let weekMasterId = masters[0]?.id ?? null;
  let weekStart = mondayOf(currentDayDate);

  function weekDayCellHtml(day, count) {
    const dayNum = Number(day.date.slice(8, 10));
    const monthNum = Number(day.date.slice(5, 7));
    const wd = WEEKDAY_SHORT[isoWeekdayOf(day.date) - 1];
    const hours = day.isDayOff ? 'Выходной' : `${day.startTime}–${day.endTime}`;
    return `<button type="button" class="month-day week-day-cell${day.isDayOff ? ' is-dayoff' : ''}" data-open-day="${day.date}">
      <span class="num">${wd} ${dayNum}.${monthNum}</span>
      <span class="week-hours">${hours}</span>
      ${count ? `<span class="appt-count">${count} ${ruPluralBooking(count)}</span>` : ''}
    </button>`;
  }

  async function loadWeek() {
    const grid = el('weekGrid');
    if (!grid || !weekMasterId) return;
    const from = weekStart;
    const to = addDays(weekStart, 6);
    const label = el('weekNavLabel');
    if (label) label.textContent = `${fmtRu(from)} – ${fmtRu(to)}`;
    grid.innerHTML = '<p class="section-hint">Загружаю…</p>';
    try {
      const [rangeDays, bookingsRes] = await Promise.all([
        fetchJson(`/schedule-range?masterId=${weekMasterId}&from=${from}&to=${to}`),
        fetchJson(`/bookings?masterId=${weekMasterId}&from=${from}&to=${to}`),
      ]);
      const countByDate = new Map();
      for (const b of bookingsRes.bookings ?? []) {
        if (b.status === 'cancelled') continue;
        countByDate.set(b.date, (countByDate.get(b.date) || 0) + 1);
      }
      grid.innerHTML = rangeDays.map((day) => weekDayCellHtml(day, countByDate.get(day.date) || 0)).join('');
      grid.querySelectorAll('[data-open-day]').forEach((cellBtn) => {
        cellBtn.addEventListener('click', () => jumpToDay(cellBtn.dataset.openDay));
      });
    } catch (err) {
      grid.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }

  function wireWeekView() {
    const grid = el('weekGrid');
    const switchRow = el('weekMasterSwitch');
    if (!grid || !switchRow) return; // страница без реальной Недели
    buildMasterSwitch(switchRow, masters, weekMasterId, (masterId) => {
      weekMasterId = masterId;
      loadWeek();
    });
    el('weekNavPrev')?.addEventListener('click', () => {
      weekStart = addDays(weekStart, -7);
      loadWeek();
    });
    el('weekNavNext')?.addEventListener('click', () => {
      weekStart = addDays(weekStart, 7);
      loadWeek();
    });
    loadWeek();
  }

  // ───────────────────────── Задача 3: "Месяц" + модалка дня ────────────────
  let monthMasterId = masters[0]?.id ?? null;
  const todayParts = currentDayDate.split('-').map(Number);
  let monthViewYear = todayParts[0];
  let monthViewMonth = todayParts[1]; // 1-12
  let editingDate = null;

  function syncDayEditVisibility() {
    const working = el('dayEditWorking').checked;
    el('dayEditFields').style.display = working ? '' : 'none';
    el('dayEditBreakToggleWrap').style.display = working ? '' : 'none';
    el('dayEditBreakFields').style.display = working && el('dayEditBreakOn').checked ? '' : 'none';
  }

  function closeDayEditModal() {
    const modal = el('dayEditModal');
    if (modal) modal.hidden = true;
  }

  function openDayEditModal(date) {
    const modal = el('dayEditModal');
    if (!modal) return;
    editingDate = date;
    el('dayEditTitle').textContent = fmtRu(date);
    el('dayEditNote').textContent = 'Загружаю текущий график…';
    const conflictsEl = el('dayEditConflicts');
    conflictsEl.hidden = true;
    conflictsEl.innerHTML = '';
    modal.hidden = false;

    fetchJson(`/schedule?masterId=${monthMasterId}&date=${date}`)
      .then((shifts) => {
        const shift = shifts.find((s) => s.date === date);
        const isDayOff = !!shift?.breaks?.some((b) => b.startTime <= GLOBAL_DEFAULT_START && b.endTime >= GLOBAL_DEFAULT_END);
        el('dayEditWorking').checked = !isDayOff;
        renderTimeSelect('dayEditStart-slot', 'dayEditStart', shift?.startTime || GLOBAL_DEFAULT_START);
        renderTimeSelect('dayEditEnd-slot', 'dayEditEnd', shift?.endTime || GLOBAL_DEFAULT_END);
        const realBreak = !isDayOff ? shift?.breaks?.[0] : null;
        el('dayEditBreakOn').checked = !!realBreak;
        renderTimeSelect('dayEditBreakStart-slot', 'dayEditBreakStart', realBreak?.startTime || '13:00');
        renderTimeSelect('dayEditBreakEnd-slot', 'dayEditBreakEnd', realBreak?.endTime || '14:00');
        el('dayEditNote').textContent = '';
        syncDayEditVisibility();
      })
      .catch((err) => {
        el('dayEditNote').textContent = `Не удалось загрузить текущий график: ${err.message}`;
      });
  }

  async function saveDayEdit() {
    const working = el('dayEditWorking').checked;
    const startTime = working ? timeSelectValue('dayEditStart') : GLOBAL_DEFAULT_START;
    const endTime = working ? timeSelectValue('dayEditEnd') : GLOBAL_DEFAULT_END;
    const breaks = !working
      ? [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }]
      : el('dayEditBreakOn').checked
        ? [{ startTime: timeSelectValue('dayEditBreakStart'), endTime: timeSelectValue('dayEditBreakEnd') }]
        : [];
    const btn = el('dayEditSave');
    const note = el('dayEditNote');
    const conflictsEl = el('dayEditConflicts');
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
    const btn = el('dayEditReset');
    const note = el('dayEditNote');
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

  function wireConflictOpenButtons(scopeEl) {
    scopeEl.querySelectorAll('.conflict-open-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const date = b.dataset.conflictDate;
        const planned = `${b.dataset.conflictStart}–${b.dataset.conflictEnd}`;
        closeDayEditModal();
        await jumpToDay(date);
        const card = document.querySelector(`.appt[data-planned="${planned}"]`);
        if (card && typeof window.openBooking === 'function') window.openBooking(card);
      });
    });
  }

  function wireDayEditModal() {
    const modal = el('dayEditModal');
    if (!modal) return; // страница без модалки (не должно случиться на owner/admin)
    el('dayEditClose')?.addEventListener('click', closeDayEditModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDayEditModal(); // клик по подложке закрывает, по карточке - нет
    });
    el('dayEditWorking').addEventListener('change', syncDayEditVisibility);
    el('dayEditBreakOn').addEventListener('change', syncDayEditVisibility);
    el('dayEditSave').addEventListener('click', saveDayEdit);
    el('dayEditReset').addEventListener('click', resetDayEdit);
  }

  async function loadMonth() {
    const grid = el('monthGrid');
    if (!grid || !monthMasterId) return;
    const year = monthViewYear;
    const month = monthViewMonth;
    const label = el('monthNavLabel');
    if (label) label.textContent = `${MONTH_LABEL[month - 1]} ${year}`;
    const firstOfMonth = `${year}-${pad2(month)}-01`;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastOfMonth = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
    grid.innerHTML = '<p class="section-hint">Загружаю…</p>';
    try {
      const [rangeDays, weeklyRows, bookingsRes] = await Promise.all([
        fetchJson(`/schedule-range?masterId=${monthMasterId}&from=${firstOfMonth}&to=${lastOfMonth}`),
        fetchJson(`/master-weekly-schedule?masterId=${monthMasterId}`),
        fetchJson(`/bookings?masterId=${monthMasterId}&from=${firstOfMonth}&to=${lastOfMonth}`),
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
        const status = day.isDayOff ? '🔴' : overridden ? '🟡' : '🟢';
        const count = countByDate.get(day.date) || 0;
        const dayNum = Number(day.date.slice(8, 10));
        cells += `<div class="month-day month-day--real" data-date="${day.date}">
          <span class="num">${status} ${dayNum}</span>
          ${count ? `<span class="appt-count">${count} ${ruPluralBooking(count)}</span>` : ''}
          <button type="button" class="month-day-edit" data-edit-date="${day.date}" aria-label="Редактировать день">✎</button>
        </div>`;
      }
      grid.innerHTML = cells;
      grid.querySelectorAll('.month-day--real').forEach((cellEl) => {
        cellEl.addEventListener('click', (e) => {
          if (e.target.closest('.month-day-edit')) return;
          jumpToDay(cellEl.dataset.date);
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

  function wireMonthView() {
    const grid = el('monthGrid');
    const switchRow = el('monthMasterSwitch');
    if (!grid || !switchRow) return; // страница без реального Месяца
    buildMasterSwitch(switchRow, masters, monthMasterId, (masterId) => {
      monthMasterId = masterId;
      loadMonth();
    });
    el('monthNavPrev')?.addEventListener('click', () => {
      monthViewMonth -= 1;
      if (monthViewMonth < 1) {
        monthViewMonth = 12;
        monthViewYear -= 1;
      }
      loadMonth();
    });
    el('monthNavNext')?.addEventListener('click', () => {
      monthViewMonth += 1;
      if (monthViewMonth > 12) {
        monthViewMonth = 1;
        monthViewYear += 1;
      }
      loadMonth();
    });
    wireDayEditModal();
    loadMonth();
  }

  wireDayNav();
  wireWeekView();
  wireMonthView();
}
