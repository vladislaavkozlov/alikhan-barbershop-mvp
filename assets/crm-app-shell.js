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
import { ICON_SCHEDULE, ICON_TEAM, ICON_FINANCE, ICON_ANALYTICS } from './crm-icons.js';

const SECTION_RADIO = { schedule: 'pt-a', team: 'pt-b', finance: 'pt-c', analytics: 'pt-d' };
const SECTION_LABEL = {
  schedule: 'Расписание',
  team: 'Команда',
  finance: 'Финансы',
  analytics: 'Аналитика',
};
const SECTION_ICON = {
  schedule: ICON_SCHEDULE,
  team: ICON_TEAM,
  finance: ICON_FINANCE,
  analytics: ICON_ANALYTICS,
};
const SECTION_ORDER = ['schedule', 'team', 'finance', 'analytics'];

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
}

function updateTitle() {
  const title = el('shellSectionTitle');
  if (title) title.textContent = SECTION_LABEL[currentSection] ?? '';
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

  updateTitle();
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
