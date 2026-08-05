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
const WEEKDAY_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTH_LABEL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// Родительный падеж - нужен только подписи-якорю ("5 августа"), в заголовках
// Месяца остаётся именительный MONTH_LABEL ("Август 2026"), как было до Окна 25.
const MONTH_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// Справочный производственный календарь на вкладке "Год" - статичная разметка на
// 2026 (crm-owner.html, панель panel-sp-year, см. Окно 20): он НЕ перерисовывается
// под якорную дату, поэтому подпись обязана называть именно этот год, а не год якоря.
const YEAR_PANEL_YEAR = 2026;
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
export function mondayOf(dateStr) {
  return addDays(dateStr, -(isoWeekdayOf(dateStr) - 1));
}
// Соседний месяц от якорной даты - всегда его ПЕРВОЕ число, не "то же число в
// другом месяце": 31 января через setMonth(+1) даёт 3 марта (в феврале нет 31-го),
// а листание месяцев обязано попадать ровно в соседний месяц.
export function addMonths(dateStr, delta) {
  const [y, m] = dateStr.split('-').map(Number);
  const zeroBased = (y * 12 + (m - 1)) + delta;
  return `${Math.floor(zeroBased / 12)}-${pad2((zeroBased % 12) + 1)}-01`;
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

// Окно 25 (05.08.2026) - подпись-якорь под вкладками: одна и та же выбранная дата,
// названная в плотности текущего вида. Год в подписи недели появляется только когда
// неделя реально пересекает границу года (иначе шум в 51 неделе из 52).
function weekRangeLabel(dateStr) {
  const from = mondayOf(dateStr);
  const to = addDays(from, 6);
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy !== ty) return `${fd} ${MONTH_GENITIVE[fm - 1]} ${fy} - ${td} ${MONTH_GENITIVE[tm - 1]} ${ty}`;
  if (fm !== tm) return `${fd} ${MONTH_GENITIVE[fm - 1]} - ${td} ${MONTH_GENITIVE[tm - 1]}`;
  return `${fd}-${td} ${MONTH_GENITIVE[fm - 1]}`;
}

export function viewAnchorLabel(view, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (view === 'day') return `День · ${WEEKDAY_FULL[isoWeekdayOf(dateStr) - 1]}, ${d} ${MONTH_GENITIVE[m - 1]}`;
  if (view === 'week') return `Неделя · ${weekRangeLabel(dateStr)}`;
  if (view === 'month') return `Месяц · ${MONTH_LABEL[m - 1]} ${y}`;
  if (view === 'year') return `Год · ${YEAR_PANEL_YEAR} (справочный)`;
  return '';
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

// Окно 19 (04.08.2026) - crm-master.html подключает этот же модуль для Недели/
// Месяца, но в режиме "только просмотр своих данных" (тот же isSolo-приём, что уже
// определяет "Мой день" в assets/crm-calendar.js): без переключателя между
// сотрудниками (мастер видит только себя) и без иконки/модалки редактирования дня
// (структуру графика теперь меняет только владелец/админ, см. crm-auth.js
// renderWeeklySelfReadOnly). Сервер и так возвращает 403 мастеру на чужой masterId
// (api/server.mjs, GET /schedule-range) - masters=[staff] здесь дополнительная
// защита на уровне UI, чтобы переключатель физически не могло появиться.
export function wireScheduleViews(ctx) {
  const { staff, staffList, services, priceOf, fetchJson, apiSend, renderDateSelect, renderTimeSelect, timeSelectValue, todayStr, renderDayCalendar } = ctx;
  const isSolo = !!document.getElementById('walkinSoloTrigger');
  const masters = isSolo ? [staff] : mastersOf(staffList);
  if (masters.length === 0) return; // роль без доступа к расписанию (не должно случиться, но не падаем)

  // Окно 25 (05.08.2026) - ОДНО состояние выбранной даты на все четыре вкладки.
  // Раньше каждый вид держал свою: "Мой день" - currentDayDate, Неделя - weekStart,
  // Месяц - monthViewYear/monthViewMonth, и они не знали друг о друге: клик по дню
  // из Месяца открывал День (jumpToDay), но обратный клик по вкладке "Неделя"/"Месяц"
  // показывал текущую календарную неделю/месяц, а не ту, откуда пришли. Теперь дата -
  // общая, вид - способ её показать (день/неделя/месяц), поэтому переключение вкладки
  // это смена ПЛОТНОСТИ той же даты, а не переход на новую страницу.
  const scheduleViewState = { date: todayStr(), view: 'day' };
  const RADIO_ID_BY_VIEW = { day: 'sp-day', week: 'sp-week', month: 'sp-month', year: 'sp-year' };
  const PANEL_SELECTOR_BY_VIEW = { day: '.panel-sp-day', week: '.panel-sp-week', month: '.panel-sp-month', year: '.panel-sp-year' };

  function renderViewAnchor() {
    const anchorEl = el('scheduleViewAnchor');
    if (!anchorEl) return; // страница без подписи-якоря - навигация всё равно работает
    anchorEl.textContent = viewAnchorLabel(scheduleViewState.view, scheduleViewState.date);
  }

  // Crossfade содержимого при смене вкладки (150ms, ease-out). Класс сначала
  // снимается, затем читается offsetWidth: без принудительного reflow повторное
  // добавление того же класса не перезапускает CSS-анимацию.
  function crossfadeActivePanel() {
    const panel = document.querySelector(PANEL_SELECTOR_BY_VIEW[scheduleViewState.view]);
    if (!panel) return;
    panel.classList.remove('view-fade-in');
    void panel.offsetWidth;
    panel.classList.add('view-fade-in');
  }

  // Единая точка смены вида и/или даты: и клик по вкладке, и клик по дню из
  // Недели/Месяца, и стрелки навигации проходят здесь - поэтому подпись-якорь,
  // отмеченная вкладка и содержимое панели физически не могут разойтись.
  async function setView(view, date) {
    if (date) scheduleViewState.date = date;
    scheduleViewState.view = view;
    const radio = el(RADIO_ID_BY_VIEW[view]);
    if (radio && !radio.checked) radio.checked = true; // программная установка .checked события change не даёт - обновляем всё сами
    renderViewAnchor();
    crossfadeActivePanel();
    if (view === 'day') await loadDay(scheduleViewState.date);
    else if (view === 'week') await loadWeek();
    else if (view === 'month') await loadMonth();
    // year - статичный справочный календарь, перерисовывать нечего
  }

  function wireViewTabs() {
    Object.entries(RADIO_ID_BY_VIEW).forEach(([view, radioId]) => {
      el(radioId)?.addEventListener('change', (e) => {
        if (e.target.checked) setView(view);
      });
    });
    renderViewAnchor();
  }

  async function loadDay(date) {
    scheduleViewState.date = date;
    // Виджет даты - часть того же состояния: до Окна 25 переход из Недели/Месяца
    // менял календарь, но оставлял в пикере старое число (jumpToDay его не трогал).
    const slot = el('dayNavDate-slot');
    if (slot) renderDateSelect(slot, 'dayNavDate', date);
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
    await setView('day', date);
  }

  // ───────────────────────── Задача 1: "Мой день" навигация ─────────────────
  function wireDayNav() {
    const prevBtn = el('dayNavPrev');
    const nextBtn = el('dayNavNext');
    const slot = el('dayNavDate-slot');
    if (!prevBtn || !nextBtn || !slot) return; // страница без навигации по датам
    renderDateSelect(slot, 'dayNavDate', scheduleViewState.date);
    slot.addEventListener('customdate:change', (e) => setView('day', e.detail.value));
    const shift = (deltaDays) => setView('day', addDays(scheduleViewState.date, deltaDays));
    prevBtn.addEventListener('click', () => shift(-1));
    nextBtn.addEventListener('click', () => shift(1));
  }

  // ───────────────────────── Задача 2: "Неделя" ──────────────────────────────
  let weekMasterId = masters[0]?.id ?? null;

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
    // Показываем НЕ "текущую календарную неделю", а ту, что содержит общий якорь -
    // поэтому weekStart здесь производная от scheduleViewState.date, не своя переменная.
    const from = mondayOf(scheduleViewState.date);
    const to = addDays(from, 6);
    // Подпись диапазона больше не живёт между стрелками: её роль взял общий якорь
    // под вкладками (Окно 25) - две одинаковые подписи на одном экране были шумом.
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
    if (!grid) return; // страница без реальной Недели
    const switchRow = el('weekMasterSwitch');
    if (switchRow) {
      buildMasterSwitch(switchRow, masters, weekMasterId, (masterId) => {
        weekMasterId = masterId;
        loadWeek();
      });
    }
    // Листание недели двигает общий якорь на понедельник соседней недели - иначе
    // возврат в Месяц/День показал бы дату из той недели, которую уже пролистали.
    el('weekNavPrev')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), -7)));
    el('weekNavNext')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), 7)));
    loadWeek();
  }

  // ───────────────────────── Задача 3: "Месяц" + модалка дня ────────────────
  let monthMasterId = masters[0]?.id ?? null;
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
    // Тот же принцип, что у Недели: месяц берётся из общего якоря, своей пары
    // monthViewYear/monthViewMonth больше нет.
    const [year, month] = scheduleViewState.date.split('-').map(Number);
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
          ${isSolo ? '' : `<button type="button" class="month-day-edit" data-edit-date="${day.date}" aria-label="Редактировать день">✎</button>`}
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
    if (!grid) return; // страница без реального Месяца
    const switchRow = el('monthMasterSwitch');
    if (switchRow) {
      buildMasterSwitch(switchRow, masters, monthMasterId, (masterId) => {
        monthMasterId = masterId;
        loadMonth();
      });
    }
    // Листание месяца ставит якорь на первое число соседнего месяца (addMonths) -
    // возврат в День/Неделю после этого попадает именно в тот месяц, что смотрели.
    el('monthNavPrev')?.addEventListener('click', () => setView('month', addMonths(scheduleViewState.date, -1)));
    el('monthNavNext')?.addEventListener('click', () => setView('month', addMonths(scheduleViewState.date, 1)));
    wireDayEditModal();
    loadMonth();
  }

  wireViewTabs();
  wireDayNav();
  wireWeekView();
  wireMonthView();
}
