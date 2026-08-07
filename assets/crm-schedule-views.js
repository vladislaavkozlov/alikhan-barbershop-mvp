// Окно 18 (04.08.2026) - вкладки Расписание → Неделя/Месяц владельца и админа были
// статичной вёрсткой-примером Окна 9 (фейковые "Клиент К (пример)", захардкоженные
// "Выходной" по дням недели, month-grid с числами "N записей пример") - ничего не
// читало из базы. "Мой день" была живой (Окно 15), но жёстко привязана к todayStr(),
// без навигации вперёд/назад. Этот модуль получает готовые хелперы параметром
// (fetchJson/apiSend/renderDateSelect/...), а не импортирует их из crm-auth.js -
// crm-auth.js уже импортирует renderDayCalendar из crm-calendar.js, обратный импорт
// отсюда создал бы циклическую зависимость модулей без необходимости.
//
// Декомпозирован 07.08.2026 (тем же методом, что и Этап 1 crm-auth.js, см.
// plans/archive/) - это не набор независимых доменов, а одна стейт-машина навигации
// (День/Неделя/Месяц/Год делят общую выбранную дату и кэш праздников), поэтому файл
// остаётся оркестратором: держит общее состояние и хелперы, вызываемые всеми видами,
// а сами виды живут в crm-schedule-view-{day,week,month,year}.js и получают то, что
// им нужно, через ctx (см. CLAUDE.md, "assets/crm-schedule-views.js" был крупнейшим
// фронтенд-файлом проекта на момент аудита).
import { mastersOf } from './crm-calendar.js';
import { viewAnchorLabel, YEAR_PANEL_YEAR } from './crm-schedule-shared.js';
import { wireDayView } from './crm-schedule-view-day.js';
import { wireWeekView } from './crm-schedule-view-week.js';
import { wireMonthView } from './crm-schedule-view-month.js';
import { wireYearView } from './crm-schedule-view-year.js';

function el(id) {
  return document.getElementById(id);
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

  // view.loadDay/loadWeek/loadMonth/renderYear заполняются НИЖЕ, после того как все
  // четыре вида инициализированы - setView вызывается асинхронно (событием/кликом),
  // всегда уже после того, как wireXView() ниже отработают синхронно. Обычный приём
  // разрыва циклической инициализации (setView нужен видам для перехода друг в друга,
  // а сам setView должен уметь вызвать загрузчик каждого вида).
  const view = {};

  // Единая точка смены вида и/или даты: и клик по вкладке, и клик по дню из
  // Недели/Месяца, и стрелки навигации проходят здесь - поэтому подпись-якорь,
  // отмеченная вкладка и содержимое панели физически не могут разойтись.
  async function setView(v, date) {
    if (date) scheduleViewState.date = date;
    scheduleViewState.view = v;
    const radio = el(RADIO_ID_BY_VIEW[v]);
    if (radio && !radio.checked) radio.checked = true; // программная установка .checked события change не даёт - обновляем всё сами
    renderViewAnchor();
    crossfadeActivePanel();
    if (v === 'day') await view.loadDay(scheduleViewState.date);
    else if (v === 'week') await view.loadWeek();
    else if (v === 'month') await view.loadMonth();
    else if (v === 'year') await view.renderYear();
  }

  // ── Праздники (Окно 24, 05.08.2026) ──────────────────────────────────────
  // Календарь года запрашивается один раз на год и кэшируется: Неделя и Месяц
  // перерисовываются на каждое листание, и без кэша каждое нажатие стрелки давало бы
  // лишний сетевой запрос за списком, который меняется раз в год.
  const holidayCacheByYear = new Map();

  async function holidaysOfYear(year) {
    if (!holidayCacheByYear.has(year)) {
      try {
        const rows = await fetchJson(`/holidays?year=${year}`);
        holidayCacheByYear.set(year, new Map(rows.map((h) => [h.date, h.name])));
      } catch {
        // Календарь - подсказка поверх графика, а не сам график: если он не
        // загрузился, вкладки обязаны работать как раньше, просто без бейджей.
        holidayCacheByYear.set(year, new Map());
      }
    }
    return holidayCacheByYear.get(year);
  }

  // Неделя может пересекать границу года (31 декабря - 1 января), поэтому карта дат
  // собирается по всем годам диапазона, а не по году его начала.
  async function holidayMapForRange(from, to) {
    const years = new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))]);
    const maps = await Promise.all([...years].map((y) => holidaysOfYear(y)));
    return new Map(maps.flatMap((m) => [...m]));
  }

  function wireViewTabs() {
    Object.entries(RADIO_ID_BY_VIEW).forEach(([v, radioId]) => {
      el(radioId)?.addEventListener('change', (e) => {
        if (e.target.checked) setView(v);
      });
    });
    renderViewAnchor();
  }

  const dayApi = wireDayView({
    staff, staffList, services, priceOf, fetchJson, renderDateSelect, renderDayCalendar,
    scheduleViewState, holidaysOfYear, setView,
  });
  const weekApi = wireWeekView({
    masters, fetchJson, holidayMapForRange, scheduleViewState, setView,
  });
  const monthApi = wireMonthView({
    masters, isSolo, fetchJson, apiSend, holidayMapForRange, renderTimeSelect, timeSelectValue,
    scheduleViewState, setView,
  });
  const yearApi = wireYearView({
    apiSend, holidaysOfYear, holidayCacheByYear, scheduleViewState, yearPanelYear: YEAR_PANEL_YEAR,
    loadMonth: monthApi.loadMonth, loadWeek: weekApi.loadWeek, wireConflictOpenButtons: monthApi.wireConflictOpenButtons,
  });
  Object.assign(view, {
    loadDay: dayApi.loadDay, loadWeek: weekApi.loadWeek, loadMonth: monthApi.loadMonth, renderYear: yearApi.renderYear,
  });

  wireViewTabs();
}
