// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Редактор графика мастера: разовая
// правка на дату (wireScheduleEditor) + единый недельный блок "График работы"
// (buildWeeklyDayRow и окружение, wireWeeklyScheduleEditor) + read-only просмотр
// своего графика мастером (renderWeeklySelfReadOnly, crm-master.html). Код
// перенесён 1в1, поведение не менялось.
import { el, todayStr } from './crm-shared.js';
import { renderDateSelect, renderTimeSelect, timeSelectValue, dateSelectValue } from './crm-widgets.js';
import { API, getToken, apiSend, fetchJson } from './crm-auth.js';

export const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
// Полное имя дня в заголовке раскрытой панели: над ползунком "Пн" читалось как
// подпись К ПОЛЗУНКУ ("что значит этот переключатель напротив Пн?" - Влад,
// 13.08.2026), а рядом с поясняющей строкой "Рабочий день / Выходной" это уже
// заголовок дня. Компактные круглые иконки над панелью остаются короткими.
export const WEEKDAY_LONG = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

// Окно 46 (08.08.2026) - кнопка "Обновить данные" (crm-owner.html) должна обновлять
// и карточки "Разовое изменение на дату"/"График работы" в "Команде", но
// wireScheduleEditor/wireWeeklyScheduleEditor ниже гейтят СЕБЯ целиком через
// dataset.wired (иначе saveBtn/container поймали бы повторный addEventListener на
// каждый клик кнопки) - это значит, что их собственный первый fetch (loadCurrent/
// load) тоже выполняется только один раз и не подхватит повторно. Тот же приём, что
// уже применён для "Расписания" (window.__refreshScheduleViews, crm-schedule-views.js) -
// каждый мастер регистрирует здесь СВОИ уже существующие loadCurrent/load закрытия
// (не новые обработчики, просто повторный fetch+innerHTML), кнопка вызывает всех
// разом.
const teamScheduleRefreshers = [];
function registerTeamScheduleRefresher(fn) {
  teamScheduleRefreshers.push(fn);
  window.__refreshTeamSchedules = () => Promise.all(teamScheduleRefreshers.map((f) => f()));
}

// Влад (03.08.2026): "+ Добавить перерыв"/"+ Добавить отпуск" в карточке
// сотрудника (Окно 9) были рисунком - только дописывали DOM, ничего не сохраняли,
// поэтому перерыв "числился" в интерфейсе, но не блокировал онлайн-запись клиента
// (реальный баг - "у Екатерины перерыв 13-14, но можно записаться на это время").
// Реальная схема хранит перерыв ПО ДАТЕ (schedule_shifts на пару master_id+date,
// не как повторяющееся правило "каждый день 13-14") - значит и редактор владельца
// должен просить дату, не изображать вечное еженедельное расписание. Пишет
// напрямую в POST /schedule (owner/admin, сервер уже сам уведомит через
// notifications, если пересечётся с реальной записью клиента - schedule_conflict).
// Элементов может не быть на странице (crm-master.html/страницы без карточки этого
// мастера) - тогда для конкретного masterId просто no-op, тот же паттерн, что у
// wirePortfolioEditors (crm-staff-admin.js).
export function wireScheduleEditor(masterId, fetchJson) {
  const currentEl = el(`schedCurrent-${masterId}`);
  if (!currentEl) return;
  const dateFromSlot = el(`schedDateFrom-${masterId}-slot`);
  const saveBtn = el(`schedSave-${masterId}`);

  // crm-admin.html: только просмотр (график ставит владелец) - нет формы
  // редактирования на странице, просто показываем сегодняшние реальные данные.
  if (!dateFromSlot || !saveBtn) {
    if (currentEl.dataset.wired) return;
    currentEl.dataset.wired = '1';
    const loadReadOnlyToday = () => {
      currentEl.innerHTML = '<span class="note">загружаю…</span>';
      return fetchJson(`/schedule?masterId=${masterId}&date=${todayStr()}`)
        .then((shifts) => {
          const shift = shifts.find((s) => s.date === todayStr());
          const isFullDayOff = shift?.breaks?.some((b) => b.startTime <= '10:00' && b.endTime >= '20:00');
          if (!shift || !shift.breaks?.length) {
            currentEl.innerHTML = '<span class="note">Сегодня перерывов/выходного не задано (стандартные часы 10:00-20:00)</span>';
          } else if (isFullDayOff) {
            currentEl.innerHTML = '<div class="break-row"><span class="note" style="flex:1">Выходной весь день</span></div>';
          } else {
            currentEl.innerHTML = shift.breaks
              .map((b) => `<div class="break-row"><span class="note" style="flex:1">Перерыв ${b.startTime}–${b.endTime}</span></div>`)
              .join('');
          }
        })
        .catch((err) => {
          currentEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
        });
    };
    loadReadOnlyToday();
    registerTeamScheduleRefresher(loadReadOnlyToday);
    return;
  }

  const dayOffEl = el(`schedDayOff-${masterId}`);
  const timeFieldsEl = el(`schedTimeFields-${masterId}`);
  const noteEl = el(`schedNote-${masterId}`);
  if (saveBtn.dataset.wired) return;
  saveBtn.dataset.wired = '1';

  // Правка 03.08.2026 (Окно 16): было <input type="date"> - свой date-picker, тот же
  // паттерн slot/value id, что уже есть у time-select ниже.
  renderDateSelect(`schedDateFrom-${masterId}-slot`, `schedDateFrom-${masterId}`, todayStr());
  renderDateSelect(`schedDateTo-${masterId}-slot`, `schedDateTo-${masterId}`, todayStr());
  const dateFromEl = el(`schedDateFrom-${masterId}`);
  // Правка 03.08.2026: было <input type="text" placeholder="13:00"> - вручную
  // вписывать время не по теме сайта и без валидации. Тот же кастомный дропдаун,
  // что уже используется у "Закреплён за мастером".
  renderTimeSelect(`schedStart-${masterId}-slot`, `schedStart-${masterId}`, '13:00');
  renderTimeSelect(`schedEnd-${masterId}-slot`, `schedEnd-${masterId}`, '14:00');

  async function loadCurrent() {
    const date = dateSelectValue(`schedDateFrom-${masterId}`) || todayStr();
    currentEl.innerHTML = '<span class="note">загружаю…</span>';
    try {
      const shifts = await fetchJson(`/schedule?masterId=${masterId}&date=${date}`);
      const shift = shifts.find((s) => s.date === date);
      const isFullDayOff = shift?.breaks?.some((b) => b.startTime <= '10:00' && b.endTime >= '20:00');
      if (!shift || !shift.breaks?.length) {
        currentEl.innerHTML = '<span class="note">На эту дату перерывов/выходного не задано (стандартные часы 10:00-20:00)</span>';
      } else if (isFullDayOff) {
        currentEl.innerHTML = '<div class="break-row"><span class="note" style="flex:1">Выходной весь день</span><button class="remove-x" type="button" aria-label="Убрать" data-clear-date="' + date + '">✕</button></div>';
      } else {
        currentEl.innerHTML = shift.breaks
          .map((b) => `<div class="break-row"><span class="note" style="flex:1">Перерыв ${b.startTime}–${b.endTime}</span><button class="remove-x" type="button" aria-label="Убрать" data-clear-date="${date}">✕</button></div>`)
          .join('');
      }
      currentEl.querySelectorAll('[data-clear-date]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await fetch(`${API}/schedule`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ masterId, date: btn.dataset.clearDate, startTime: '10:00', endTime: '20:00', breaks: [] }),
            });
            loadCurrent();
          } catch (err) {
            if (noteEl) noteEl.textContent = `Не удалось убрать: ${err.message}`;
          }
        });
      });
    } catch (err) {
      currentEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }
  loadCurrent();
  registerTeamScheduleRefresher(loadCurrent);
  dateFromEl.addEventListener('customdate:change', loadCurrent);

  const syncTimeFields = () => {
    if (timeFieldsEl) timeFieldsEl.style.display = dayOffEl?.checked ? 'none' : '';
  };
  syncTimeFields();
  dayOffEl?.addEventListener('change', syncTimeFields);

  saveBtn.addEventListener('click', async () => {
    const dateFrom = dateSelectValue(`schedDateFrom-${masterId}`) || todayStr();
    const dateTo = dateSelectValue(`schedDateTo-${masterId}`) || dateFrom;
    if (dateTo < dateFrom) {
      if (noteEl) noteEl.textContent = 'Дата "по" раньше даты "с"';
      return;
    }
    const isDayOff = dayOffEl?.checked;
    const breakStart = isDayOff ? '10:00' : timeSelectValue(`schedStart-${masterId}`);
    const breakEnd = isDayOff ? '20:00' : timeSelectValue(`schedEnd-${masterId}`);
    if (!isDayOff && (!breakStart || !breakEnd)) {
      if (noteEl) noteEl.textContent = 'Укажите время перерыва (с и до)';
      return;
    }
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = 'Сохраняю…';
    if (noteEl) noteEl.textContent = '';
    try {
      let totalConflicts = 0;
      for (let d = new Date(`${dateFrom}T00:00:00Z`); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const res = await fetch(`${API}/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId,
            date: dateStr,
            startTime: '10:00',
            endTime: '20:00',
            breaks: [{ startTime: breakStart, endTime: breakEnd }],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        totalConflicts += data.conflicts || 0;
      }
      if (noteEl) {
        noteEl.textContent = totalConflicts
          ? `Сохранено. На это время уже есть ${totalConflicts} реальных записей - в колокольчике уведомлений появилось, с кем связаться`
          : 'Сохранено';
      }
      loadCurrent();
    } catch (err) {
      if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  });
}

// Окно 16 (03.08.2026) - единый блок "График работы": одна строка на каждый день
// недели (переключатель рабочий/выходной, рабочее окно, опциональный перерыв), по
// образцу Google Calendar "Working hours" (референс одобрен Владом). Заменяет
// прежние разрозненные "Рабочее время" (readonly-заглушка) + декоративный
// dayoff-picker + отдельный блок "Перерыв/выходной стандартный". Владелец правит
// НАПРЯМУЮ (PUT /master-weekly-schedule, тот же уровень доступа, что у
// wireScheduleEditor для разовых дат). canEdit=false (crm-admin.html, и с Окна 19 -
// crm-master.html тоже) - только просмотр, без формы. Мастер видит свой график
// исключительно на чтение - см. renderWeeklySelfReadOnly ниже (crm-master.html).
// Структуру теперь меняет только владелец/админ напрямую (решение Окна 17,
// реализовано Окном 19) - мастер больше не может отправить запрос на график.
//
// Окно 27 (04.08.2026) - 7 крупных вертикальных карточек занимали много места
// (обсуждено с Владом). Разметка самой карточки (canEdit=true) не изменилась - её
// теперь просто оборачивает изначально скрытая панель (см. weekly-day-panel ниже),
// раскрываемая кликом по компактной иконке дня (buildWeekdayIconStrip/
// wireWeekdayIconStrip). readonly-ветка (canEdit=false) уже была компактной (одна
// строка на день) - её не трогаем, это вне зоны этого окна.
function buildWeeklyDayRow(prefix, wd, day, canEdit) {
  const isWorking = day?.isWorking ?? true;
  const hasBreak = !!day?.breakStart;
  const workStart = day?.workStart || '10:00';
  const workEnd = day?.workEnd || '20:00';
  const breakStart = day?.breakStart || '13:00';
  const breakEnd = day?.breakEnd || '14:00';
  if (!canEdit) {
    const desc = isWorking
      ? `${workStart}–${workEnd}${hasBreak ? ` (перерыв ${breakStart}–${breakEnd})` : ''}`
      : 'выходной';
    return `<div class="break-row"><span class="note" style="flex:1">${WEEKDAY_SHORT[wd - 1]}: ${desc}</span></div>`;
  }
  return `
    <div class="weekly-day-row${isWorking ? '' : ' is-off'}" id="${prefix}-${wd}-row" data-weekday="${wd}">
      <div class="toggle-row">
        <div class="weekly-day-title">
          <span class="tr-label">${WEEKDAY_LONG[wd - 1]}</span>
          <span class="tr-sub" id="${prefix}-${wd}-offBadge">${isWorking ? 'Рабочий день' : 'Выходной, записи не будет'}</span>
        </div>
        <label class="switch" title="Рабочий день или выходной"><input type="checkbox" id="${prefix}-${wd}-working" ${isWorking ? 'checked' : ''} aria-label="${WEEKDAY_LONG[wd - 1]}: рабочий день"><span class="track"></span><span class="knob"></span></label>
      </div>
      <div class="field-grid weekly-time-grid" id="${prefix}-${wd}-fields" style="${isWorking ? '' : 'display:none'}">
        <div class="field"><label>Работает с</label><div id="${prefix}-${wd}-start-slot"></div></div>
        <div class="field"><label>до</label><div id="${prefix}-${wd}-end-slot"></div></div>
      </div>
      <div class="toggle-row" id="${prefix}-${wd}-breakToggleWrap" style="${isWorking ? '' : 'display:none'}">
        <div class="weekly-day-title">
          <span class="tr-label">Перерыв</span>
          <span class="tr-sub" id="${prefix}-${wd}-breakHint">${hasBreak ? 'В это время записи не будет' : 'Пока не задан, день без перерыва'}</span>
        </div>
        <label class="switch" title="Перерыв в середине дня"><input type="checkbox" id="${prefix}-${wd}-breakOn" ${hasBreak ? 'checked' : ''} aria-label="Перерыв в середине дня"><span class="track"></span><span class="knob"></span></label>
      </div>
      <div class="field-grid weekly-time-grid" id="${prefix}-${wd}-breakFields" style="${isWorking && hasBreak ? '' : 'display:none'}">
        <div class="field"><label>Перерыв с</label><div id="${prefix}-${wd}-breakStart-slot"></div></div>
        <div class="field"><label>до</label><div id="${prefix}-${wd}-breakEnd-slot"></div></div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm weekly-apply-all-btn" id="${prefix}-${wd}-applyAll" style="${isWorking && hasBreak ? '' : 'display:none'}">Применить ко всем дням</button>
    </div>`;
}
// Окно 27 (04.08.2026, Задача 1) - компактная строка из 7 круглых переключателей
// Пн-Вс над панелями дней. Клик раскрывает/сворачивает панель этого дня
// (toggleDayPanel) - остальные панели при этом закрываются (один открытый день за
// раз, тот же паттерн, что уже есть у details.staff-card в разметке владельца).
function buildWeekdayIconStrip(prefix, days) {
  return `<div class="weekday-icon-strip">${days
    .map((d, i) => {
      const wd = i + 1;
      const isWorking = d?.isWorking ?? true;
      return `<button type="button" class="weekday-icon${isWorking ? ' is-working' : ' is-off'}" id="${prefix}-${wd}-icon" data-weekday="${wd}" aria-expanded="false" aria-controls="${prefix}-${wd}-panel" title="${WEEKDAY_SHORT[wd - 1]}, ${isWorking ? 'рабочий день' : 'выходной'}">${WEEKDAY_SHORT[wd - 1]}</button>`;
    })
    .join('')}</div>`;
}
function toggleDayPanel(prefix, wd) {
  for (let i = 1; i <= 7; i++) {
    const panel = el(`${prefix}-${i}-panel`);
    const icon = el(`${prefix}-${i}-icon`);
    if (!panel || !icon) continue;
    const shouldOpen = i === wd ? !panel.classList.contains('is-open') : false;
    panel.classList.toggle('is-open', shouldOpen);
    icon.setAttribute('aria-expanded', String(shouldOpen));
  }
}
function wireWeekdayIconStrip(prefix) {
  for (let wd = 1; wd <= 7; wd++) {
    const icon = el(`${prefix}-${wd}-icon`);
    if (icon) icon.addEventListener('click', () => toggleDayPanel(prefix, wd));
  }
}
// Окно 27 (04.08.2026, Задача 2) - копирует перерыв (время начала/конца) дня sourceWd
// на все ОСТАЛЬНЫЕ рабочие дни недели этого мастера. Дни-выходные пропускает (для
// них перерыв не имеет смысла). Не сохраняет на сервер сама - это делает общая кнопка
// "Сохранить график" (el(`${prefix}-save`)), поэтому применённые значения можно потом
// вручную переопределить на конкретный день перед сохранением. Возвращает число дней,
// на которые реально скопировано (для короткой обратной связи в UI).
function applyBreakToAllDays(prefix, sourceWd) {
  const breakStart = timeSelectValue(`${prefix}-${sourceWd}-breakStart`);
  const breakEnd = timeSelectValue(`${prefix}-${sourceWd}-breakEnd`);
  let applied = 0;
  for (let wd = 1; wd <= 7; wd++) {
    if (wd === sourceWd) continue;
    const workingEl = el(`${prefix}-${wd}-working`);
    if (!workingEl?.checked) continue;
    const breakOnEl = el(`${prefix}-${wd}-breakOn`);
    breakOnEl.checked = true;
    el(`${prefix}-${wd}-breakFields`).style.display = '';
    const applyAllBtn = el(`${prefix}-${wd}-applyAll`);
    if (applyAllBtn) applyAllBtn.style.display = '';
    renderTimeSelect(`${prefix}-${wd}-breakStart-slot`, `${prefix}-${wd}-breakStart`, breakStart);
    renderTimeSelect(`${prefix}-${wd}-breakEnd-slot`, `${prefix}-${wd}-breakEnd`, breakEnd);
    applied += 1;
  }
  return applied;
}
function wireWeeklyDayRow(prefix, wd, day) {
  renderTimeSelect(`${prefix}-${wd}-start-slot`, `${prefix}-${wd}-start`, day?.workStart || '10:00');
  renderTimeSelect(`${prefix}-${wd}-end-slot`, `${prefix}-${wd}-end`, day?.workEnd || '20:00');
  renderTimeSelect(`${prefix}-${wd}-breakStart-slot`, `${prefix}-${wd}-breakStart`, day?.breakStart || '13:00');
  renderTimeSelect(`${prefix}-${wd}-breakEnd-slot`, `${prefix}-${wd}-breakEnd`, day?.breakEnd || '14:00');
  const workingEl = el(`${prefix}-${wd}-working`);
  const rowEl = el(`${prefix}-${wd}-row`);
  const offBadgeEl = el(`${prefix}-${wd}-offBadge`);
  const fieldsEl = el(`${prefix}-${wd}-fields`);
  const breakToggleWrap = el(`${prefix}-${wd}-breakToggleWrap`);
  const breakOnEl = el(`${prefix}-${wd}-breakOn`);
  const breakFieldsEl = el(`${prefix}-${wd}-breakFields`);
  const applyAllBtn = el(`${prefix}-${wd}-applyAll`);
  const syncWorking = () => {
    const working = workingEl.checked;
    rowEl.classList.toggle('is-off', !working);
    // Подписи под днём и перерывом объясняют состояние ползунков словами, а не только их видом
    offBadgeEl.textContent = working ? 'Рабочий день' : 'Выходной, записи не будет';
    const breakHintEl = el(`${prefix}-${wd}-breakHint`);
    if (breakHintEl) breakHintEl.textContent = breakOnEl.checked ? 'В это время записи не будет' : 'Пока не задан, день без перерыва';
    fieldsEl.style.display = working ? '' : 'none';
    breakToggleWrap.style.display = working ? '' : 'none';
    breakFieldsEl.style.display = working && breakOnEl.checked ? '' : 'none';
    if (applyAllBtn) applyAllBtn.style.display = working && breakOnEl.checked ? '' : 'none';
  };
  workingEl.addEventListener('change', syncWorking);
  breakOnEl.addEventListener('change', syncWorking);
  if (applyAllBtn) {
    applyAllBtn.addEventListener('click', () => {
      const n = applyBreakToAllDays(prefix, wd);
      const originalLabel = applyAllBtn.textContent;
      applyAllBtn.textContent = n > 0 ? `Скопировано на ${n} дн.` : 'Нет других рабочих дней';
      setTimeout(() => {
        if (applyAllBtn.isConnected) applyAllBtn.textContent = originalLabel;
      }, 2000);
    });
  }
}
function readWeeklyDayRow(prefix, wd) {
  const isWorking = el(`${prefix}-${wd}-working`).checked;
  const breakOn = isWorking && el(`${prefix}-${wd}-breakOn`).checked;
  return {
    weekday: wd,
    isWorking,
    workStart: isWorking ? timeSelectValue(`${prefix}-${wd}-start`) : null,
    workEnd: isWorking ? timeSelectValue(`${prefix}-${wd}-end`) : null,
    breakStart: breakOn ? timeSelectValue(`${prefix}-${wd}-breakStart`) : null,
    breakEnd: breakOn ? timeSelectValue(`${prefix}-${wd}-breakEnd`) : null,
  };
}
// Русский список конфликтующих броней - общий формат ответа 409 schedule_conflict
// (server.mjs: findScheduleConflicts/findWeeklyScheduleConflicts) что здесь, что в
// модалке дня Месяца (assets/crm-schedule-views.js) - оба места рисуют его этой же
// функцией, чтобы формат не разошёлся. conflicts - [{date, conflicts:[{start_time,
// end_time, client_name, client_phone}]}] - именно snake_case (сырые колонки SQL,
// не переименованы на сервере в camelCase, см. server.mjs).
export function formatScheduleConflicts(conflictsByDate) {
  return conflictsByDate
    .map(({ date, conflicts }) => {
      const [y, m, d] = date.split('-');
      const rows = conflicts
        .map((c) => `${c.start_time}–${c.end_time} · ${c.client_name || 'без имени'}${c.client_phone ? ' · ' + c.client_phone : ''}`)
        .join('<br>');
      return `<div class="conflict-day"><b>${d}.${m}.${y}</b><br>${rows}</div>`;
    })
    .join('');
}

// Окно 18 (04.08.2026, Задача 4) - дыра №1 отсюда же (найдена 03.08.2026): форма
// раньше просто оставляла в полях то, что ввёл владелец, и писала "Сохранено" не
// перепроверяя. Теперь после успешного PUT форма ВСЕГДА перезапрашивает
// /master-weekly-schedule заново и перерисовывает поля этим ответом - верит только
// тому, что подтвердил сервер. При 409 (конфликт с живой бронью, см. server.mjs
// PUT-обработчик) форма не считает сохранение успешным и показывает список
// конфликтов - тот же принцип блокировки, что уже действует у разовой правки дня.
export function wireWeeklyScheduleEditor(masterId, canEdit, fetchJson) {
  const container = el(`weeklyEditor-${masterId}`);
  if (!container || container.dataset.wired) return;
  container.dataset.wired = '1';
  const prefix = `weekly-${masterId}`;

  async function load() {
    // Правка (по вопросу Влада 08.08.2026 - "почему видно обновление только в
    // Уведомлениях") - тот же приём "загружаю…", что уже стоял у loadCurrent выше
    // в этом файле, чтобы кнопка "Обновить данные" (crm-owner.html) давала видимый
    // сигнал и здесь, не только в "Заявках на изменение графика". На первой загрузке
    // страницы container и так пуст - показать здесь текст вместо пустоты не хуже.
    container.innerHTML = '<span class="note">загружаю…</span>';
    let rows;
    try {
      rows = await fetchJson(`/master-weekly-schedule?masterId=${masterId}`);
    } catch (err) {
      container.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
      return;
    }
    const byWeekday = new Map(rows.map((r) => [r.weekday, r]));
    const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => byWeekday.get(wd) || null);

    if (!canEdit) {
      container.innerHTML = `<div class="breaks-list">${days.map((d, i) => buildWeeklyDayRow(prefix, i + 1, d, false)).join('')}</div>`;
      return;
    }

    container.innerHTML =
      buildWeekdayIconStrip(prefix, days) +
      `<div class="weekly-panels">${days
        .map((d, i) => `<div class="weekly-day-panel" id="${prefix}-${i + 1}-panel">${buildWeeklyDayRow(prefix, i + 1, d, true)}</div>`)
        .join('')}</div>` +
      `<button class="btn btn-ghost btn-sm" type="button" id="${prefix}-save" style="margin-top:10px">Сохранить график</button>
       <p class="payroll-note" id="${prefix}-note"></p>
       <div class="conflict-list" id="${prefix}-conflicts" hidden></div>`;
    days.forEach((d, i) => wireWeeklyDayRow(prefix, i + 1, d));
    wireWeekdayIconStrip(prefix);

    el(`${prefix}-save`).addEventListener('click', async () => {
      const weeklyChanges = [1, 2, 3, 4, 5, 6, 7].map((wd) => readWeeklyDayRow(prefix, wd));
      const btn = el(`${prefix}-save`);
      const note = el(`${prefix}-note`);
      const conflictsEl = el(`${prefix}-conflicts`);
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = 'Сохраняю…';
      conflictsEl.hidden = true;
      note.textContent = '';
      try {
        const { ok, status, data } = await apiSend('/master-weekly-schedule', 'PUT', { masterId, weeklyChanges });
        if (status === 409 && data?.error === 'schedule_conflict') {
          note.textContent = 'Нельзя сохранить, пока не разберётесь с этими записями:';
          conflictsEl.innerHTML = formatScheduleConflicts(data.conflicts);
          conflictsEl.hidden = false;
          return;
        }
        if (!ok) throw new Error(`HTTP ${status}`);
        // Дыра №1: форма НЕ доверяет тому, что ввёл владелец - перезапрашивает
        // сервер и перерисовывает поля его ответом (load() ниже), даже если сервер
        // вернул ровно то же самое - гарантия важнее одного лишнего запроса.
        await load();
        const freshNote = el(`${prefix}-note`);
        if (freshNote) freshNote.textContent = 'Сохранено и подтверждено сервером';
      } catch (err) {
        note.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      }
    });
  }

  load();
  registerTeamScheduleRefresher(load);
}

// Окно 16 (03.08.2026) отдавало мастеру форму со своей кнопкой "Отправить запрос
// на график" (POST /schedule-requests, category=grafik_standard) - владелец решил
// (см. промпт Окна 17), что структуру недельного графика меняет только он/админ
// напрямую (wireWeeklyScheduleEditor выше, тот же паттерн для чужой карточки на
// crm-owner.html). Окно 19 (04.08.2026) убирает у мастера саму возможность
// отправить правку - остаётся только просмотр той же строки buildWeeklyDayRow,
// что владелец уже использует для read-only карточки другого сотрудника
// (canEdit=false, см. crm-owner.html buildWeeklyDayRow(prefix, i+1, d, false)).
export function renderWeeklySelfReadOnly(staff) {
  const container = el('weeklyEditor-self');
  if (!container || container.dataset.wired) return;
  container.dataset.wired = '1';
  const prefix = 'weekly-self';

  fetchJson(`/master-weekly-schedule?masterId=${staff.id}`)
    .then((rows) => {
      const byWeekday = new Map(rows.map((r) => [r.weekday, r]));
      const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => byWeekday.get(wd) || null);
      container.innerHTML = `<div class="breaks-list">${days.map((d, i) => buildWeeklyDayRow(prefix, i + 1, d, false)).join('')}</div>`;
    })
    .catch((err) => {
      container.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    });
}
