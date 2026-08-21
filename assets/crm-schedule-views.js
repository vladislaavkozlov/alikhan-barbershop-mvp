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
import { mastersOf, upsertDayBooking } from './crm-calendar.js';
import { viewAnchorLabel, YEAR_PANEL_YEAR, mondayOf } from './crm-schedule-shared.js';
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
  // Задача J (Окно 53) - живая репродукция нашла РЕАЛЬНЫЙ триггер повторного запуска
  // (план его не находил чтением статики): crm-walkin.js зовёт renderLiveProof(staff)
  // ПОСЛЕ КАЖДОЙ успешной записи walk-in (не только при заходе на страницу), а
  // renderLiveProof (crm-dashboard.js) внутри зовёт wireScheduleViews(...) заново.
  // Сам crm-dashboard.js уже честно предупреждал об этом классе бага (комментарий у
  // window.__refreshScheduleViews ниже, Окно 45/46): "renderLiveProof вызывать
  // повторно нельзя... wire*-функции вешают обработчики на статичные DOM-узлы один
  // раз, повторный вызов задвоил бы клики" - crm-walkin.js не следует этому
  // собственному правилу проекта. wireMonthView создавал #monthModeToggle без
  // проверки существования (буквальная причина из промпта) - но это лишь ВИДИМЫЙ
  // симптом: второй проход wireScheduleViews() пересоздаёт ВЕСЬ scheduleViewState
  // (новый объект) и вешает ВТОРОЙ комплект обработчиков (day-nav/week-nav/
  // month-nav/wireViewTabs) поверх статичных узлов, которые никуда не делись после
  // первого прохода - отсюда и "путаница со статусами" (два независимых состояния
  // конкурируют за одну и ту же разметку), не только задвоенный переключатель.
  // Идемпотентный guard здесь чинит ОБА симптома одним и тем же корнем, а не только
  // видимый DOM-узел: повторный вызов не перевешивает ничего, а просто перечитывает
  // данные открытых карточек - тем же путём, что уже безопасно делает кнопка
  // "Обновить данные" (window.__refreshScheduleViews, см. ниже).
  if (window.__scheduleViewsWired) {
    window.__refreshScheduleViews?.();
    return { refresh: window.__refreshScheduleViews };
  }
  window.__scheduleViewsWired = true;

  const { staff, staffList, services, priceOf, fetchJson, apiSend, renderDateSelect, renderTimeSelect, timeSelectValue, todayStr, renderDayCalendar } = ctx;
  const isSolo = staff.role === 'master';
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
  // Виды, чьи данные заведомо разошлись с сервером (17.08.2026). Новая запись
  // вставляется в «День» точечно (upsertDayBooking), а «Неделя»/«Месяц» - это агрегаты
  // (загрузка в %, число записей на дату), их одной карточкой не поправишь. Тянуть
  // ради них сразу два запроса на каждую чужую запись - ровно то «обновление всего
  // кабинета», от которого уходим, тем более что обе карточки у владельца по умолчанию
  // свёрнуты. Поэтому помечаем и перечитываем в момент, когда человек их открывает.
  const staleViews = new Set();

  async function ensureFresh(v) {
    if (!staleViews.has(v)) return;
    staleViews.delete(v);
    if (v === 'day') await view.loadDay(scheduleViewState.date);
    else if (v === 'week') await view.loadWeek();
    else if (v === 'month') await view.loadMonth();
  }

  // Окно 65 (21.08.2026) - при СМЕНЕ ДАТЫ соседние виды могут показывать уже не тот
  // период. Поймано глазами на снимке прогона: подпись карточки говорила «Месяц ·
  // Август 2026», а в сетке под ней стоял сентябрь. Механика: подпись-якорь рисуется
  // из общей даты на каждый setView (Окно 25), а данные вида перечитываются только
  // когда он активен - клик по дню в полоске возвращал дату в август, подпись Месяца
  // менялась, содержимое оставалось сентябрьским.
  // Перечитываем не всё подряд, а только те виды, у которых реально сменился ПЕРИОД:
  // смена даты внутри той же недели Неделю не трогает, внутри того же месяца - Месяц.
  // Открытый вид перечитывается сразу (человек смотрит на него), свёрнутый - помечается
  // устаревшим и дочитывается при раскрытии (тот же приём, что staleViews выше).
  function periodKeys(dateStr) {
    return { week: mondayOf(dateStr), month: dateStr.slice(0, 7) };
  }

  async function syncPeriodDependentViews(activeView, before, after) {
    const jobs = [];
    for (const v of ['week', 'month']) {
      if (v === activeView) continue;
      if (before[v] === after[v]) continue;
      const card = el(DETAILS_ID_BY_VIEW[v]);
      // На crm-admin/crm-master карточек нет: там виден ровно один вид за раз, и
      // неактивный физически не показан - его достаточно пометить устаревшим.
      const visible = card ? card.open : false;
      if (visible) jobs.push(v === 'week' ? view.loadWeek() : view.loadMonth());
      else staleViews.add(v);
    }
    await Promise.all(jobs);
  }

  async function setView(v, date) {
    const before = periodKeys(scheduleViewState.date);
    if (date) scheduleViewState.date = date;
    const after = periodKeys(scheduleViewState.date);
    scheduleViewState.view = v;
    staleViews.delete(v); // ниже вид грузится целиком - помечать нечего
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
    await syncPeriodDependentViews(v, before, after);
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
        if (!details.open) return;
        if (scheduleViewState.view !== v) setView(v);
        // Вид уже активен, но его данные устарели, пока карточка была свёрнута
        // (см. staleViews) - перечитываем ровно его, в момент, когда он понадобился
        else ensureFresh(v);
      });
    });
    renderViewAnchor();
  }

  // Правка 20.08.2026 (Влад: «переходишь с "Команды" на "Расписание" - "День" должен быть
  // сразу открыт»). Раскрытость карточек живёт в DOM и переживает переключение разделов:
  // свернул "День", ушёл в "Команду", вернулся - раздел встречал пустым списком свёрнутых
  // карточек, хотя заходят в него ради сегодняшнего дня. Слушаем 'crm:section'
  // (assets/crm-app-shell.js goToSection) и на каждом входе в "Расписание" поднимаем
  // "День". Неделю/Месяц не трогаем: карточки независимые (Окно 45), закрывать их - значило
  // бы отменять осознанный выбор человека, а "День" сверху ему не мешает.
  // Само открытие делает toggle-обработчик выше: он же вызовет setView('day') с загрузкой,
  // если активен был другой вид. Если карточка уже открыта, toggle не сработает - тогда
  // сами дочитываем устаревшие данные (staleViews).
  function raiseDayOnEnter(e) {
    if (e.detail?.section !== 'schedule') return;
    const details = el(DETAILS_ID_BY_VIEW.day);
    if (!details) return; // crm-admin.html/crm-master.html - там карточек нет, вид виден всегда
    if (!details.open) details.open = true;
    else ensureFresh('day');
  }

  document.addEventListener('crm:section', raiseDayOnEnter);

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
    masters, isSolo, fetchJson, holidayMapForRange, scheduleViewState, setView, getMonthApi: () => monthApi,
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
  // Правка 14.08.2026 - два уточнения к тому же механизму:
  // 1. Карточки-details есть ТОЛЬКО на crm-owner.html; crm-admin.html/crm-master.html
  //    показывают виды старыми radio-вкладками (#sp-day/#sp-week/#sp-month), где
  //    el('scheduleCard-*') всегда null - до этой правки refresh() там был полным
  //    no-op (пустой jobs), то есть "Обновить данные" на админке расписание не
  //    трогала вовсе. Для таких страниц перечитываем АКТИВНЫЙ вид.
  // 2. { all: true } - принудительно перечитать День+Неделю+Месяц независимо от того,
  //    что сейчас раскрыто/активно. Нужно после операции, которая меняет сами данные
  //    (удаление записи, crm-booking-status.js wireBookingDelete): закрытая карточка
  //    держит в DOM УЖЕ ОТРИСОВАННУЮ разметку, а обработчик toggle раскрытия зовёт
  //    setView только если вид сменился (scheduleViewState.view !== v) - свёрнутая
  //    "Неделя", бывшая активным видом, после раскрытия показала бы старый рендер с
  //    удалённой записью. Кнопка "Обновить данные" зовёт refresh() без аргументов и
  //    работает как раньше (закрытое не тянем - незачем грузить невидимое).
  async function refresh({ all = false } = {}) {
    const hasCards = Boolean(el(DETAILS_ID_BY_VIEW.day));
    const needs = (v) => all
      || (hasCards ? Boolean(el(DETAILS_ID_BY_VIEW[v])?.open) : scheduleViewState.view === v);
    const jobs = [];
    if (needs('day')) jobs.push(view.loadDay(scheduleViewState.date));
    if (needs('week')) jobs.push(view.loadWeek());
    if (needs('month')) jobs.push(view.loadMonth());
    await Promise.all(jobs);
  }

  // crm-dashboard.js вызывает wireScheduleViews() как часть более длинной цепочки
  // инициализации (assets/crm-dashboard.js) и не прокидывает возврат наружу к
  // crm-owner.html - тот же приём window-хука, что уже применяют window.updateNotifBadge/
  // window.openRebookBooking в этом проекте для похожей задачи "дотянуться из другого
  // модуля без циклического импорта".
  window.__refreshScheduleViews = refresh;

  // «Открыть запись» из ленты уведомлений (20.08.2026). Календарь листается по ДАТЕ, а
  // не по id брони, поэтому уведомление отдаёт дату записи, а этот хук переводит вид
  // «День» на неё и возвращает промис - вызывающий дожидается отрисовки, прежде чем
  // искать карточку .appt[data-id]. Тот же приём window-хука, что у
  // __refreshScheduleViews/__insertDayBooking: дотянуться из другого модуля без
  // циклического импорта (crm-notifications.js ← crm-schedule-views.js ← crm-dashboard.js).
  window.__openScheduleDay = (date) => setView('day', date);

  // Точка входа «показать одну запись прямо сейчас» (17.08.2026, Влад: «при создании
  // записи она просто мгновенно должна появляться у всех»). Зовут двое:
  //   - assets/crm-walkin.js сразу после успешного сохранения формы - из ответа
  //     сервера, вообще без сетевых запросов;
  //   - assets/crm-live.js по событию от сервера, когда записал кто-то другой.
  // Возвращает false, если точечно не вышло (открыт другой день, колонки мастера нет,
  // день закрыт как выходной) - тогда вызывающий делает обычную полную перерисовку.
  // staffList - тот же снимок состава, по которому построены колонки «Дня» (он
  // снимается один раз при входе, см. комментарий у freshStaffById в crm-calendar.js).
  // Для мастера, появившегося уже после входа, колонки в гриде нет вовсе - вставка
  // честно вернёт false, и запись покажет полная перерисовка.
  window.__insertDayBooking = (booking) => {
    const inserted = upsertDayBooking(booking, {
      staff,
      staffList,
      services,
      priceOf,
      date: scheduleViewState.date,
    });
    if (inserted) {
      // «День» уже показывает запись, а агрегаты Недели/Месяца - ещё нет
      staleViews.add('week');
      staleViews.add('month');
      const weekOpen = el(DETAILS_ID_BY_VIEW.week)?.open || (!el(DETAILS_ID_BY_VIEW.day) && scheduleViewState.view === 'week');
      const monthOpen = el(DETAILS_ID_BY_VIEW.month)?.open || (!el(DETAILS_ID_BY_VIEW.day) && scheduleViewState.view === 'month');
      // Открытую карточку человек видит прямо сейчас - её обновляем сразу, свёрнутая
      // подождёт своего раскрытия (ensureFresh)
      if (weekOpen) ensureFresh('week');
      if (monthOpen) ensureFresh('month');
    }
    return inserted;
  };

  return { refresh };
}
