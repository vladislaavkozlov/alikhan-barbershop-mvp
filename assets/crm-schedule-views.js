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
  // Задача I (Окно 53) - masterId добавлен в тот же общий объект, тем же принципом,
  // что и date (Окно 25 выше): без этого weekMasterId/monthMasterId были НЕЗАВИСИМЫМИ
  // переменными внутри каждого вида (независимо инициализировались одним и тем же
  // дефолтом masters[0], но расходились после первого же переключения мастера в
  // ОДНОМ виде) - живой прогон подтвердил, что "расхождение % загрузки" (46% vs 24%
  // на тот же день) было сравнением % ДВУХ РАЗНЫХ мастеров, не багом формулы.
  const scheduleViewState = { date: todayStr(), view: 'day', masterId: masters[0]?.id ?? null };
  const RADIO_ID_BY_VIEW = { day: 'sp-day', week: 'sp-week', month: 'sp-month', year: 'sp-year' };
  const PANEL_SELECTOR_BY_VIEW = { day: '.panel-sp-day', week: '.panel-sp-week', month: '.panel-sp-month', year: '.panel-sp-year' };
  // Окно 45 (08.08.2026) - День/Неделя/Месяц теперь сворачиваемые карточки
  // (details.schedule-view-card), а не radio-пилюли. Карточек можно раскрыть сразу
  // несколько (решение Влада) - sp-* radio остались как внутреннее состояние "какой
  // вид активен для якоря/загрузки", setView теперь ещё и раскрывает нужную карточку.
  // Год (crm-owner.html такой карточки не заводит - вкладка "Год" отдельная,
  // DETAILS_ID_BY_VIEW.year намеренно не задан).
  const DETAILS_ID_BY_VIEW = { day: 'scheduleCard-day', week: 'scheduleCard-week', month: 'scheduleCard-month' };

  function renderViewAnchor() {
    // crm-admin.html/crm-master.html - старый общий якорь над .seg-tabs, актуален,
    // потому что там виден только ОДИН активный вид за раз.
    const anchorEl = el('scheduleViewAnchor');
    if (anchorEl) {
      anchorEl.textContent = viewAnchorLabel(scheduleViewState.view, scheduleViewState.date);
      return;
    }
    // crm-owner.html (Окно 45+) - День/Неделя/Месяц независимые карточки, общий якорь
    // визуально "убегал" от своей карточки, когда открыта не она (правка 08.08.2026).
    // Подпись живёт внутри каждой карточки (см. КОНВЕНЦИЯ-КАРТОЧКИ-РАЗДЕЛОВ.md) и
    // обновляется всегда, не только для активного вида - у Недели/Месяца общая дата
    // с Днём (Окно 25), так что обе подписи корректны независимо от того, какая
    // карточка сейчас открыта.
    const weekEl = el('scheduleAnchor-week');
    if (weekEl) weekEl.textContent = viewAnchorLabel('week', scheduleViewState.date);
    const monthEl = el('scheduleAnchor-month');
    if (monthEl) monthEl.textContent = viewAnchorLabel('month', scheduleViewState.date);
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
    const details = el(DETAILS_ID_BY_VIEW[v]);
    if (details && !details.open) details.open = true; // напр. клик по дню в Месяце должен раскрыть карточку "День"
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
    // Окно 45 (08.08.2026) - ручное раскрытие карточки (клик по summary) тоже должно
    // запускать setView (загрузка данных вида + якорь), не только программные переходы
    // через radio. Guard на scheduleViewState.view защищает от двойного вызова, когда
    // setView САМ программно раскрывает карточку (см. правку setView выше) - к этому
    // моменту view уже равен v, повторный вызов не нужен.
    Object.entries(DETAILS_ID_BY_VIEW).forEach(([v, detailsId]) => {
      const details = el(detailsId);
      details?.addEventListener('toggle', () => {
        if (details.open && scheduleViewState.view !== v) setView(v);
      });
    });
    renderViewAnchor();
  }

  const dayApi = wireDayView({
    staff, staffList, services, priceOf, fetchJson, renderDateSelect, renderDayCalendar,
    scheduleViewState, holidaysOfYear, setView,
  });
  // Задача I (Окно 53) - getWeekApi/getMonthApi: ленивые геттеры, не сами объекты
  // напрямую - week/monthApi ещё не существуют в момент wireWeekView/wireMonthView
  // (взаимная ссылка друг на друга при создании), но к моменту РЕАЛЬНОГО клика по
  // переключателю мастера (событие пользователя, всегда позже обеих строк ниже) оба
  // уже точно присвоены - замыкание видит актуальное значение переменной, не то, что
  // было на момент создания геттера.
  let weekApi, monthApi;
  weekApi = wireWeekView({
    masters, fetchJson, holidayMapForRange, scheduleViewState, setView, getMonthApi: () => monthApi,
  });
  monthApi = wireMonthView({
    masters, isSolo, fetchJson, apiSend, holidayMapForRange, renderTimeSelect, timeSelectValue,
    scheduleViewState, setView, getWeekApi: () => weekApi,
  });
  const yearApi = wireYearView({
    apiSend, holidaysOfYear, holidayCacheByYear, scheduleViewState, yearPanelYear: YEAR_PANEL_YEAR,
    loadMonth: monthApi.loadMonth, loadWeek: weekApi.loadWeek, wireConflictOpenButtons: monthApi.wireConflictOpenButtons,
  });
  Object.assign(view, {
    loadDay: dayApi.loadDay, loadWeek: weekApi.loadWeek, loadMonth: monthApi.loadMonth, renderYear: yearApi.renderYear,
  });

  wireViewTabs();

  // Окно 45 (08.08.2026) - кнопка мягкого обновления рядом с колокольчиком дёргает
  // это, а не wireScheduleViews(...) заново (та навесила бы весь набор обработчиков
  // повторно). Перечитывает только карточки, которые СЕЙЧАС раскрыты - можно
  // раскрыть несколько (День+Неделя+Месяц) одновременно, обновляем все открытые,
  // закрытые не трогаем (нет смысла тянуть данные для того, что не видно).
  async function refresh() {
    const jobs = [];
    if (el(DETAILS_ID_BY_VIEW.day)?.open) jobs.push(view.loadDay(scheduleViewState.date));
    if (el(DETAILS_ID_BY_VIEW.week)?.open) jobs.push(view.loadWeek());
    if (el(DETAILS_ID_BY_VIEW.month)?.open) jobs.push(view.loadMonth());
    await Promise.all(jobs);
  }

  // crm-dashboard.js вызывает wireScheduleViews() как часть более длинной цепочки
  // инициализации (assets/crm-dashboard.js) и не прокидывает возврат наружу к
  // crm-owner.html - тот же приём window-хука, что уже применяют window.updateNotifBadge/
  // window.openRebookBooking в этом проекте для похожей задачи "дотянуться из другого
  // модуля без циклического импорта".
  window.__refreshScheduleViews = refresh;

  return { refresh };
}
