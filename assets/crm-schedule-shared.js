// Декомпозиция crm-schedule-views.js (07.08.2026, тем же методом, что и Этап 1
// crm-auth.js - см. plans/archive/) - чистые хелперы и константы, общие для всех
// четырёх видов (День/Неделя/Месяц/Год). Поведение не менялось, код перенесён
// 1:1 с исходных верхнеуровневых строк crm-schedule-views.js.

export const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const MONTH_LABEL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// Родительный падеж - нужен только подписи-якорю ("5 августа"), в заголовках
// Месяца остаётся именительный MONTH_LABEL ("Август 2026"), как было до Окна 25.
export const MONTH_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// Справочный производственный календарь на вкладке "Год" - статичная разметка на
// 2026 (crm-owner.html, панель panel-sp-year, см. Окно 20): он НЕ перерисовывается
// под якорную дату, поэтому подпись обязана называть именно этот год, а не год якоря.
export const YEAR_PANEL_YEAR = 2026;
// Тот же глобальный дефолт, что и на сервере (api/server.mjs: GLOBAL_DEFAULT_START/END) -
// нужен здесь только чтобы понять, отличается ли конкретный день от "стандартного"
// недельного графика (🟡 в Месяце), сам источник истины - всегда ответ сервера.
export const GLOBAL_DEFAULT_START = '10:00';
export const GLOBAL_DEFAULT_END = '20:00';

export function el(id) {
  return document.getElementById(id);
}
export function pad2(n) {
  return String(n).padStart(2, '0');
}
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function isoWeekdayOf(dateStr) {
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
export function ruPluralBooking(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запись';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'записи';
  return 'записей';
}
// Склонение "даты" в кнопке массового закрытия - тот же приём, что ruPluralBooking
// выше: "Закрыть 1 дату / 2 даты / 5 дат всем мастерам".
export function ruPluralDate(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'дату';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'даты';
  return 'дат';
}
export function fmtRu(dateStr) {
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

// ── Праздники (Окно 24, 05.08.2026) ────────────────────────────────────────
// Вкладка "Год" перестала быть текстом в разметке и рисуется из GET /holidays. Сетка
// остаётся той же - 12 карточек-месяцев, включая пустые: месяц без праздников честно
// говорит "без праздников" ровно как в статике, которую этот рендер заменяет.
export function groupHolidaysByMonth(holidays) {
  const months = MONTH_LABEL.map((name, i) => ({ name, month: i + 1, holidays: [] }));
  for (const h of holidays ?? []) {
    const monthIdx = Number(h.date.slice(5, 7)) - 1;
    if (months[monthIdx]) months[monthIdx].holidays.push(h);
  }
  for (const m of months) m.holidays.sort((a, b) => a.date.localeCompare(b.date));
  return months;
}

// Владелец отмечает галочками произвольный набор дат, а POST /holidays/close принимает
// диапазон from-to - подряд идущие даты схлопываем в один запрос. Иначе "закрыть
// новогодние каникулы" ушло бы восемью отдельными запросами вместо одного.
export function groupDatesToRanges(dates) {
  const sorted = [...new Set(dates ?? [])].sort();
  const ranges = [];
  for (const date of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.to, 1) === date) last.to = date;
    else ranges.push({ from: date, to: date });
  }
  return ranges;
}

// Праздничность даты НЕ зависит от того, работает ли мастер в этот день (мастер может
// выйти 23 февраля - день останется рабочим и праздничным одновременно), поэтому
// бейдж считается по отдельной карте дат, а не по полям графика.
export function holidayNameOf(holidayMap, dateStr) {
  return holidayMap?.get(dateStr) ?? null;
}

// Окно 28 (05.08.2026) - точки статуса дня в сетке Месяца. Раньше это были эмодзи
// 🟢/🟡/🔴 прямо в тексте ячейки: их рисует шрифт операционной системы (на маке -
// глянцевые объёмные шарики ярко-зелёного/красного), в приглушённую тёмно-зелёную
// палитру CRM они не попадают ни оттенком, ни блеском. Теперь это обычный кружок на
// переменных проекта (--success/--accent/--danger), как .lp-dot в "живой боевой базе".
// Смысловое различие трёх статусов сохранено, и цвет - не единственный носитель
// смысла: у кружка есть title/aria-label словами (дальтонизм, скринридер).
const DAY_STATUS_TITLE = { work: 'Обычный день', edit: 'Разовая правка на эту дату', off: 'Выходной' };
export function dayStatusDot(status) {
  const title = DAY_STATUS_TITLE[status] ?? '';
  return `<span class="day-dot day-dot--${status}" role="img" title="${title}" aria-label="${title}"></span>`;
}

// Выходной ли конкретный день по ответу GET /schedule. Та же семантика, что у
// isScheduleDayOff на сервере (api/server.mjs): перерыв накрывает смену ЭТОГО дня
// целиком - границы берутся из самой смены, а не из литералов 10:00-20:00.
// Окно 28: до этой правки модалка дня сравнивала перерыв с литералами, и у мастера
// со сменой 09:00-18:00 закрытый день показывался как "Рабочий день" (см. тот же
// класс бага в fullDayOffWindow, api/server.mjs, фикс 05.08.2026). Время в формате
// HH:MM с ведущим нулём, поэтому строковое сравнение эквивалентно сравнению минут.
export function isDayOffShift(shift) {
  if (!shift) return false;
  return (shift.breaks ?? []).some((b) => b.startTime <= shift.startTime && b.endTime >= shift.endTime);
}

// Подпись разовой правки графика в списке "Команда → мастер → График" (crm-team.js).
// Состояний ТРИ, а не два. Строка schedule_shifts на дату - это не обязательно
// выходной или перерыв: редактор дня в Месяце сохраняет разовую правку ЧАСОВ работы
// (POST /schedule с пустым breaks), и такая смена в старом коде печаталась как
// "Перерыв без перерыва" - состояние, которого не существует ни для календаря, ни
// для клиентской записи (жалоба 13.08.2026). Выходной определяется общим
// isDayOffShift, а не равенством границ: отгул/праздник закрывают день окном
// fullDayOffWindow (объединение смены и дефолта 10:00-20:00, api/lib/schedule-core.js),
// у мастера со сменой 09:00-18:00 перерыв выходного шире смены и на строгом равенстве
// прочитался бы как обычный длинный перерыв.
export function scheduleExceptionLabel(shift) {
  if (isDayOffShift(shift)) return 'Выходной';
  const breaks = shift?.breaks ?? [];
  if (breaks.length) return `Перерыв ${breaks.map((item) => `${item.startTime}-${item.endTime}`).join(', ')}`;
  if (shift?.startTime && shift?.endTime) return `Рабочий день ${shift.startTime}-${shift.endTime}`;
  return 'Изменение графика';
}

// Окно 44 (07.08.2026, ПРОМПТ-ОКНО-44-РАСПИСАНИЕ-НЕДЕЛЯ-МЕСЯЦ.md) - % загрузки дня
// для Недели/Месяца: занятые минуты (сумма длительностей неотменённых броней) от
// доступных (рабочее окно смены минус перерывы). day - элемент ответа
// GET /schedule-range (isDayOff/startTime/endTime/breaks), bookingsForDay - брони
// ИМЕННО этого мастера и этой даты (status уже отфильтрован вызывающим кодом).
// Выходной или день без доступных минут (перерыв на весь день) - 0%, не деление на
// ноль/Infinity. Округляется до целого, ограничивается [0,100] - переполнение
// возможно только если брони пересекаются (сервер такое не допускает - overlap-
// проверка в createBookingTx), но клэмп на всякий случай честнее отрицательного
// или >100% на экране.
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
export function loadPercent(day, bookingsForDay) {
  if (!day || day.isDayOff) return 0;
  const breakMin = (day.breaks ?? []).reduce((s, b) => s + (toMinutes(b.endTime) - toMinutes(b.startTime)), 0);
  const availableMin = toMinutes(day.endTime) - toMinutes(day.startTime) - breakMin;
  if (availableMin <= 0) return 0;
  const bookedMin = (bookingsForDay ?? []).reduce((s, b) => s + (toMinutes(b.endTime) - toMinutes(b.startTime)), 0);
  return Math.min(100, Math.max(0, Math.round((bookedMin / availableMin) * 100)));
}

export function viewAnchorLabel(view, dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  // День не подписывается здесь - дата и так видна и редактируема в date-picker
  // рядом (dayNavDate-slot), повторная подпись сверху была лишней (правка Влада
  // 07.08.2026). Неделя/Месяц/Год остаются - там якорь единственное место, где
  // виден показанный диапазон/год.
  if (view === 'day') return '';
  if (view === 'week') return `Неделя · ${weekRangeLabel(dateStr)}`;
  if (view === 'month') return `Месяц · ${MONTH_LABEL[m - 1]} ${y}`;
  if (view === 'year') return `Год · ${YEAR_PANEL_YEAR} (справочный)`;
  return '';
}

// Модалка редактирования дня (Задача 3) - конфликт всегда об ОДНОЙ дате (POST
// /schedule принимает одну дату за раз), но conflictsByDate остаётся массивом
// (тот же контракт 409, что и PUT /master-weekly-schedule) - на всякий случай не
// предполагаем длину 1 жёстко. Общий рендер конфликтов - используется и модалкой
// дня Месяца, и массовым закрытием праздников Года.
export function conflictListWithOpenButton(conflictsByDate) {
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

// Переключатель мастера (Неделя/Месяц) - кнопки, не radio+CSS sibling-selector как
// у старой статичной вёрстки (#wk-ivan1:checked ~ .panel-wk-ivan1): та схема требует
// одно CSS-правило НА КАЖДЫЙ id, захардкоженное в <style> HTML-файла - несовместимо
// с "строим по факту ответа /staff, не по количеству узлов в макете" (см. правку
// crm-calendar.js). Кнопки с .active классом дают тот же внешний вид (.seg-bar) без
// привязки количества мастеров к разметке.
export function buildMasterSwitch(container, masters, selectedId, onChange) {
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
