// Окно 65 (21.08.2026) - общий компонент "график работы": матрица мастера × даты.
// Пришёл на смену ДВУМ разным сеткам (Неделя - 7 карточек-колонок за одного мастера,
// Месяц - календарные квадратики 7×N): заказчик (Али) показал Yclients, где Недели и
// Месяца как двух РАЗНЫХ экранов нет вовсе - есть один график команды, у которого
// меняется только ширина окна дат (7 дней либо весь месяц), и полоска дат для прыжка
// по дням внутри "Дня" (assets/crm-schedule-daystrip.js).
//
// Почему это ОДИН модуль на оба вида, а не два похожих: разница между Неделей и
// Месяцем здесь ровно в паре {from,to} и в подписи. Любое расхождение вёрстки/логики
// между ними было бы не фичей, а расхождением, за которым надо следить руками -
// ровно тем, чем болели старые два файла (% загрузки считался в трёх местах по-разному).
import {
  WEEKDAY_SHORT, isoWeekdayOf, holidayNameOf, loadPercent, escapeHtml, ruPluralBooking,
  GLOBAL_DEFAULT_START, GLOBAL_DEFAULT_END,
} from './crm-schedule-shared.js';
import { todayStr } from './crm-calendar.js';
import { avatarMarkup } from './crm-avatar.js';

// Ожидаемый график этого дня недели по "Стандартному графику" (master_weekly_schedule).
// Перенесено 1:1 из crm-schedule-view-month.js (там жило как weeklyBaselineFor): нужно
// ТОЛЬКО чтобы понять, разошёлся ли конкретный день с недельным шаблоном (статус
// 'edit'), реальные данные дня всегда из /schedule-range.
export function weeklyBaselineFor(weeklyByWeekday, weekday) {
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

export function schedulesEqual(a, b) {
  if (a.startTime !== b.startTime || a.endTime !== b.endTime) return false;
  if ((a.breaks ?? []).length !== (b.breaks ?? []).length) return false;
  return (a.breaks ?? []).every((br, i) => br.startTime === b.breaks[i]?.startTime && br.endTime === b.breaks[i]?.endTime);
}

export function dayStatusOf(day, weeklyByWeekday) {
  if (day.isDayOff) return 'off';
  const baseline = weeklyBaselineFor(weeklyByWeekday, isoWeekdayOf(day.date));
  const current = { startTime: day.startTime, endTime: day.endTime, breaks: day.breaks ?? [] };
  return schedulesEqual(current, baseline) ? 'work' : 'edit';
}

// Список дат from..to включительно. Датой оперируем строкой YYYY-MM-DD (та же
// конвенция, что во всём расписании) - никаких Date-объектов в модели, чтобы часовой
// пояс браузера не мог сдвинуть колонку на день.
export function datesBetween(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  for (let guard = 0; guard < 400; guard += 1) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso > to) break;
    out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// Чистая функция: данные с сервера → модель матрицы. Вынесена отдельно от рендера,
// чтобы её можно было проверить офлайн-тестом без DOM (tests/schedule-matrix.model.test.js).
export function buildMatrixModel({ masters, from, to, schedulesByMasterId, bookings, weeklyByMasterId, holidayMap, today = todayStr() }) {
  const dates = datesBetween(from, to);
  const bookingsByKey = new Map();
  for (const b of bookings ?? []) {
    if (b.status === 'cancelled') continue;
    const key = `${b.masterId}|${b.date}`;
    if (!bookingsByKey.has(key)) bookingsByKey.set(key, []);
    bookingsByKey.get(key).push(b);
  }
  const days = dates.map((date) => {
    const weekday = isoWeekdayOf(date);
    return {
      date,
      dayNum: Number(date.slice(8, 10)),
      weekdayShort: WEEKDAY_SHORT[weekday - 1],
      isWeekend: weekday >= 6,
      isToday: date === today,
      holidayName: holidayNameOf(holidayMap, date),
    };
  });
  const rows = masters.map((master) => {
    const scheduleByDate = new Map((schedulesByMasterId?.get(master.id) ?? []).map((day) => [day.date, day]));
    const weeklyByWeekday = new Map((weeklyByMasterId?.get(master.id) ?? []).map((r) => [r.weekday, r]));
    const cells = dates.map((date) => {
      const day = scheduleByDate.get(date);
      // Дня нет в ответе /schedule-range (мастер принят на работу позже, диапазон шире
      // его истории) - это не выходной и не рабочий день, это "нет данных": рисуем
      // пустую ячейку, а не выдуманные 10:00-20:00.
      if (!day) return { date, masterId: master.id, missing: true, status: 'none', bookingCount: 0, loadPct: 0 };
      const dayBookings = bookingsByKey.get(`${master.id}|${date}`) ?? [];
      return {
        date,
        masterId: master.id,
        missing: false,
        status: dayStatusOf(day, weeklyByWeekday),
        isDayOff: Boolean(day.isDayOff),
        startTime: day.startTime,
        endTime: day.endTime,
        breaks: day.breaks ?? [],
        bookingCount: dayBookings.length,
        loadPct: loadPercent(day, dayBookings),
      };
    });
    return { master, cells };
  });
  return { days, rows };
}

function cellInnerHtml(cell) {
  // В ячейке ровно два носителя смысла - часы смены и занятость. Правка Влада
  // 21.08.2026 («колонки набиты кучей инфы»): убраны строка перерыва, которая всё
  // равно не помещалась и обрывалась многоточием («перерыв 13:00…»), и «0%» у дней
  // без записей - ноль повторялся в каждой второй ячейке и создавал шум ровно там,
  // где смотреть не на что. Полные данные дня никуда не делись: они в подсказке
  // (title, cellTitle ниже) и в редакторе дня, который открывается кликом.
  if (cell.missing) return '<span class="sm-cell-off">нет графика</span>';
  if (cell.isDayOff) return '<span class="sm-cell-off">Выходной</span>';
  const load = cell.bookingCount > 0
    ? `<span class="sm-cell-load sm-cell-load--busy"><span class="sm-cell-pct">${cell.loadPct}%</span> · ${cell.bookingCount} ${ruPluralBooking(cell.bookingCount).slice(0, 3)}.</span>`
    : '';
  return `<span class="sm-cell-hours">${escapeHtml(cell.startTime)}–${escapeHtml(cell.endTime)}</span>${load}`;
}

function cellTitle(cell, masterName) {
  if (cell.missing) return `${masterName}: нет данных за этот день`;
  if (cell.isDayOff) return `${masterName}: выходной`;
  // Перерыв виден только здесь и в редакторе дня - в самой ячейке для него нет места
  const breakPart = cell.breaks.length ? `, перерыв ${cell.breaks[0].startTime}–${cell.breaks[0].endTime}` : '';
  return `${masterName}: ${cell.startTime}–${cell.endTime}${breakPart}, загрузка ${cell.loadPct}%, ${cell.bookingCount} ${ruPluralBooking(cell.bookingCount)}`;
}

// editable=false (мастер на crm-master.html) - ячейка не открывает редактор графика,
// клик по ней ведёт в "День", как и клик по шапке даты: мастер свой график не меняет
// (тот же принцип, что и renderWeeklySelfReadOnly в crm-auth.js).
export function matrixHtml(model, { editable = true } = {}) {
  const headCells = model.days
    .map((day) => `<button type="button" class="sm-head${day.isWeekend ? ' is-weekend' : ''}${day.isToday ? ' is-today' : ''}${day.holidayName ? ' is-holiday' : ''}" data-open-day="${day.date}" title="${day.holidayName ? `🎉 ${escapeHtml(day.holidayName)} · ` : ''}открыть день">
      <span class="sm-head-num">${day.dayNum}</span>
      <span class="sm-head-wd">${day.weekdayShort}</span>
      ${day.holidayName ? '<span class="sm-head-holiday" aria-hidden="true">🎉</span>' : ''}
    </button>`)
    .join('');
  const rowsHtml = model.rows
    .map((row) => {
      const name = row.master.name ?? '';
      const cells = row.cells
        .map((cell) => `<${editable && !cell.missing ? 'button type="button"' : 'div'} class="sm-cell sm-cell--${cell.status}${cell.missing ? ' is-missing' : ''}${model.days.find((d) => d.date === cell.date)?.isToday ? ' is-today' : ''}"
          data-date="${cell.date}" data-master-id="${escapeHtml(cell.masterId)}" data-status="${cell.status}" title="${escapeHtml(cellTitle(cell, name))}">
          ${cellInnerHtml(cell)}
        </${editable && !cell.missing ? 'button' : 'div'}>`)
        .join('');
      // Кружок сотрудника - общий компонент проекта (assets/crm-avatar.js), не своя
      // вёрстка: фото/инициалы и их фолбэк уже решены там один раз для всей CRM.
      return `<div class="sm-name" title="${escapeHtml(name)}">
          ${avatarMarkup(row.master)}
          <span class="sm-name-text">${escapeHtml(name)}</span>
        </div>${cells}`;
    })
    .join('');
  return `<div class="sched-matrix" style="--sm-cols:${model.days.length}">
    <div class="sm-corner"></div>${headCells}${rowsHtml}
  </div>`;
}

// Все сетевые запросы вида в одном месте. Мастеров обычно 2-5, поэтому график и
// недельный шаблон тянутся параллельно на каждого, а брони - ОДНИМ запросом на весь
// диапазон (сервер и так отдаёт их сразу по всем мастерам, см. api/routes/bookings.js).
export async function loadMatrixData({ masters, from, to, fetchJson, holidayMapForRange }) {
  const [schedules, weeklies, bookingsRes, holidayMap] = await Promise.all([
    Promise.all(masters.map((m) => fetchJson(`/schedule-range?masterId=${encodeURIComponent(m.id)}&from=${from}&to=${to}`))),
    Promise.all(masters.map((m) => fetchJson(`/master-weekly-schedule?masterId=${encodeURIComponent(m.id)}`).catch(() => []))),
    fetchJson(`/bookings?from=${from}&to=${to}`),
    holidayMapForRange(from, to),
  ]);
  return {
    schedulesByMasterId: new Map(masters.map((m, i) => [m.id, schedules[i]])),
    weeklyByMasterId: new Map(masters.map((m, i) => [m.id, weeklies[i]])),
    bookings: bookingsRes.bookings ?? [],
    holidayMap,
  };
}

// Общая обвязка кликов: шапка даты → "День", ячейка → редактор графика этого мастера
// на эту дату (или тоже "День", если editable=false).
export function wireMatrixClicks(container, { onOpenDay, onEditCell, editable = true }) {
  container.querySelectorAll('[data-open-day]').forEach((btn) => {
    btn.addEventListener('click', () => onOpenDay(btn.dataset.openDay));
  });
  container.querySelectorAll('button.sm-cell').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (editable) onEditCell(btn.dataset.date, btn.dataset.masterId);
      else onOpenDay(btn.dataset.date);
    });
  });
}
