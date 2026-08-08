// Окно 41 (07.08.2026) - app shell владельца (sidebar + topbar + роутинг между
// разделами), первое окно 13-оконного плана премиального редизайна
// (plans/2026-08-06-owner-crm-premium-redesign.md, план восстанавливается заново -
// исходный файл потерян). "Сегодня"/"Расписание"/"Команда"/"Финансы" продолжают
// показывать РОВНО тот же контент, что и раньше (panel-today/panel-a/panel-b/
// panel-c), роутинг лишь переключает те же скрытые radio-input, что уже управляют
// их видимостью через существующий CSS (:checked ~ .panel-X) - ничего в самих
// панелях не переписано.
//
// ШАГ 0 промпта нашёл 3 места, которые раньше напрямую трогали radio pt-*:
// (1) инлайн-кнопка "Выручка за неделю/месяц →" на "Сегодня" (crm-owner.html),
// (2) goToTab() в crm-owner-today.js (алерты "мастер без графика"/заявка,
//     файл переименован в crm-schedule-alerts.js Окном 42),
// (3) openMasterCard() в crm-notifications.js (клик по уведомлению). Все три
// переведены на goToSection() - см. правки в соответствующих файлах.
//
// Правка (после 41): пункты "Клиенты"/"Настройки" убраны из sidebar целиком -
// решение Влада, не показывать в меню то, что ведёт на заглушку "в разработке",
// подрывает премиум-ощущение, ради которого затевался редизайн (прецедент - Окно
// 36, честный интерфейс, убирать нерабочее, не оговаривать его текстом). Каждый
// пункт возвращается в SECTION_LABEL/SECTION_ICON/SECTION_ORDER ровно в том окне,
// где раздел реально наполняется контентом (Клиенты, Настройки - номера окон,
// присвоенные в исходном плане, не переиспользовать для другого смысла).
//
// Окно 42 (07.08.2026, ПРОМПТ-ОКНО-42-ДЕМОНТАЖ-СЕГОДНЯ.md): пункт "Сегодня" убран
// целиком (не заглушка - был наполнен, но 2 из 3 виджетов дублировали другие
// разделы, третий переехал в счётчик колокольчика без своего экрана). Вход по
// умолчанию - "Расписание", не "Сегодня".
//
// Правка Влада 07.08.2026 - добавлен пункт "Аналитика" (radio pt-d/panel-d,
// свободный с Окна 36): переиспользован сразу с реальным содержимым
// ("Возвращаемость клиентов", перенесена из "Сотрудники"), не пустой заглушкой -
// тот же принцип, что уже применён к Клиентам/Настройкам выше (пункт появляется
// в момент, когда раздел реально наполнен). Эмодзи-иконки заменены на SVG
// (assets/crm-icons.js) - разный рендер эмодзи по ОС/браузерам ломал премиум-вид.
import { ICON_SCHEDULE, ICON_TEAM, ICON_FINANCE, ICON_ANALYTICS, ICON_BELL, ICON_SIDEBAR_TOGGLE } from './crm-icons.js';

// Правка 07.08.2026 - добавлен пункт "Уведомления" (radio pt-e/panel-e, новый слот):
// "Заявки мастеров на изменение графика" переехали сюда из "Расписания" целиком
// (crm-owner.html). Иконка переиспользует ICON_BELL (тот же SVG, что уже стоит в
// колокольчике topbar) - "в стиле новых иконок" в буквальном смысле, без новой SVG.
const SECTION_RADIO = { schedule: 'pt-a', team: 'pt-b', finance: 'pt-c', analytics: 'pt-d', notifications: 'pt-e' };
const SECTION_LABEL = {
  schedule: 'Расписание',
  team: 'Команда',
  finance: 'Финансы',
  analytics: 'Аналитика',
  notifications: 'Уведомления',
};
const SECTION_ICON = {
  schedule: ICON_SCHEDULE,
  team: ICON_TEAM,
  finance: ICON_FINANCE,
  analytics: ICON_ANALYTICS,
  notifications: ICON_BELL,
};
const SECTION_ORDER = ['schedule', 'team', 'finance', 'analytics', 'notifications'];

let currentSection = 'schedule';

function el(id) {
  return document.getElementById(id);
}

function sidebarMarkup() {
  const items = SECTION_ORDER.map(
    (id) =>
      `<button type="button" class="app-nav-item" data-section="${id}" aria-current="false">
        <span class="app-nav-icon" aria-hidden="true">${SECTION_ICON[id]}</span>
        <span class="app-nav-label">${SECTION_LABEL[id]}</span>
      </button>`
  ).join('');
  return `
    <nav class="app-nav">${items}</nav>
    <div class="app-sidebar-location">Алихан, Ставрополь</div>
    <div class="app-sidebar-profile" id="appShellProfile">Владелец</div>
  `;
}

// Правка 08.08.2026 - свернуть sidebar до одних иконок (просьба Влада). Класс живёт
// на body (не на самой .app-sidebar) - тем же классом управляется и padding-left
// контента (см. assets/crm-app-shell.css), одна точка истины на оба эффекта.
// localStorage не заводим - в рамках SPA-сессии переключение между разделами не
// перезагружает страницу (goToSection ниже - тот же документ), состояние и так
// не сбрасывается, пока владелец не выйдет/не обновит страницу вручную.
const SIDEBAR_COLLAPSED_CLASS = 'app-shell-sidebar-collapsed';

function toggleSidebar() {
  const collapsed = document.body.classList.toggle(SIDEBAR_COLLAPSED_CLASS);
  const btn = el('appSidebarToggle');
  if (btn) btn.setAttribute('aria-label', collapsed ? 'Развернуть меню' : 'Свернуть меню');
}

// Правка 08.08.2026 (Влад: "не по краю формы, а какого-то чёрта по середине" -
// кнопка сначала центрировалась по ШИРИНЕ .app-sidebar) - кнопка вынесена из
// .app-sidebar отдельным элементом-соседом body, а не потомком: сама панель
// держит overflow-y:auto (нужен для скролла длинного списка разделов), из-за
// чего браузер по спеке CSS2.1 вычисляет overflow-x тоже как auto - кнопка,
// торчащая наполовину ЗА границу панели (классический паттерн VS Code/Notion/
// Linear - кружок ровно на линии раздела сайдбар/контент), обрезалась бы этим
// скроллом, будучи потомком. position:fixed в CSS привязывает её к той же
// координате (left: переменная ширины сайдбара), что и граница панели.
function insertToggleButton() {
  if (el('appSidebarToggle')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-sidebar-toggle';
  btn.id = 'appSidebarToggle';
  btn.setAttribute('aria-label', 'Свернуть меню');
  btn.innerHTML = `<span class="app-nav-icon" aria-hidden="true">${ICON_SIDEBAR_TOGGLE}</span>`;
  btn.addEventListener('click', toggleSidebar);
  document.body.appendChild(btn);
}

function insertSidebar() {
  if (el('appSidebar')) return;
  const aside = document.createElement('aside');
  aside.className = 'app-sidebar';
  aside.id = 'appSidebar';
  aside.innerHTML = sidebarMarkup();
  document.body.insertBefore(aside, document.body.firstChild);
  aside.querySelectorAll('[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => goToSection(btn.dataset.section));
  });
  insertToggleButton();
}

function updateActiveNav() {
  document.querySelectorAll('.app-nav-item').forEach((btn) => {
    const active = btn.dataset.section === currentSection;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'true' : 'false');
  });
}

export function getCurrentSection() {
  return currentSection;
}

export function goToSection(sectionId) {
  if (!SECTION_LABEL[sectionId]) return;
  currentSection = sectionId;
  document.body.dataset.shellSection = sectionId;

  const radioId = SECTION_RADIO[sectionId];
  if (radioId) {
    const radio = el(radioId);
    if (radio && !radio.checked) radio.checked = true;
  }

  updateActiveNav();
}

export function initAppShell() {
  const main = el('crmMain');
  if (!main) return;

  insertSidebar();

  // #crmMain остаётся hidden до успешного входа (initCrmAuth, crm-auth.js) - тот
  // же приём синхронизации, что уже использует wireOwnerToday (crm-owner-today.js).
  function sync() {
    document.body.classList.toggle('app-shell-active', !main.hidden);
  }
  new MutationObserver(sync).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  sync();

  goToSection('schedule');
}

// Мост для инлайн-обработчиков в HTML (тот же установившийся в проекте паттерн,
// что уже применён к window.toggleRetentionPanel/window.updateNotifBadge).
window.crmGoToSection = goToSection;
