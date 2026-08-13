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
import { ICON_SCHEDULE, ICON_TEAM, ICON_FINANCE, ICON_ANALYTICS, ICON_BELL, ICON_SIDEBAR_TOGGLE, ICON_PROFILE } from './crm-icons.js';

// Правка 07.08.2026 - добавлен пункт "Уведомления" (radio pt-e/panel-e, новый слот):
// "Заявки мастеров на изменение графика" переехали сюда из "Расписания" целиком
// (crm-owner.html). Иконка переиспользует ICON_BELL (тот же SVG, что уже стоит в
// колокольчике topbar) - "в стиле новых иконок" в буквальном смысле, без новой SVG.
//
// Окно 47 (09.08.2026) - механизм был захардкожен под Owner (5 разделов). Вынесен в
// ROLE_CONFIG, чтобы тот же shell (та же анимация/сворачивание/роутинг) переиспользовали
// crm-admin.html/crm-master.html (Окна 49/50) без копирования файла - см. план
// plans/2026-08-09-admin-master-app-shell.md, Challenge Log (альтернатива "3 копии
// файла" отклонена - уже был прецедент рассинхрона копий логики, Окно 46).
// ROLE_CONFIG.owner ниже - буквально те же значения, что были захардкожены раньше
// (SECTION_RADIO/LABEL/ICON/ORDER + дефолтный раздел 'schedule'), нулевое изменение
// поведения для Owner.
const ROLE_CONFIG = {
  owner: {
    profileLabel: 'Владелец',
    defaultSection: 'schedule',
    order: ['schedule', 'team', 'finance', 'analytics', 'notifications'],
    radio: { schedule: 'pt-a', team: 'pt-b', finance: 'pt-c', analytics: 'pt-d', notifications: 'pt-e' },
    label: {
      schedule: 'Расписание',
      team: 'Команда',
      finance: 'Финансы',
      analytics: 'Аналитика',
      notifications: 'Уведомления',
    },
    icon: {
      schedule: ICON_SCHEDULE,
      team: ICON_TEAM,
      finance: ICON_FINANCE,
      analytics: ICON_ANALYTICS,
      notifications: ICON_BELL,
    },
  },
  admin: {
    profileLabel: 'Администратор',
    defaultSection: 'schedule',
    order: ['schedule', 'team', 'profile'],
    radio: { schedule: 'pt-a', team: 'pt-b', profile: 'pt-c' },
    label: { schedule: 'Расписание', team: 'Сотрудники', profile: 'Личные данные' },
    icon: { schedule: ICON_SCHEDULE, team: ICON_TEAM, profile: ICON_PROFILE },
  },
  master: {
    profileLabel: 'Мастер',
    defaultSection: 'today',
    order: ['today', 'payroll', 'profile'],
    radio: { today: 'pt-a', payroll: 'pt-b', profile: 'pt-c' },
    label: { today: 'Мой день', payroll: 'Моя зарплата', profile: 'Личные данные' },
    icon: { today: ICON_SCHEDULE, payroll: ICON_FINANCE, profile: ICON_PROFILE },
  },
};

// Подпись профиля в самом низу боковой панели. Отдельная от ROLE_CONFIG таблица,
// потому что конфиг описывает НАБОР РАЗДЕЛОВ страницы (их три: owner/admin/master),
// а подпись - РОЛЬ ВОШЕДШЕГО СОТРУДНИКА, и это разные вещи с Окна 57: управляющий
// (`manager`) работает на странице владельца, то есть с owner-набором разделов, но
// владельцем не является. Баг найден Владом 13.08.2026: вход Мамедханом показывал
// "Управляющий" в шапке (там подпись идёт от реальной роли, crm-auth.js reveal) и
// "Владелец" в боковой панели - два разных ответа на один вопрос на одном экране.
const ROLE_PROFILE_LABEL = {
  owner: 'Владелец',
  manager: 'Управляющий',
  admin: 'Администратор',
  master: 'Мастер',
};

let activeConfig = ROLE_CONFIG.owner;
let currentSection = activeConfig.defaultSection;

function el(id) {
  return document.getElementById(id);
}

function sidebarMarkup() {
  const items = activeConfig.order.map(
    (id) =>
      `<button type="button" class="app-nav-item" data-section="${id}" aria-current="false">
        <span class="app-nav-icon" aria-hidden="true">${activeConfig.icon[id]}</span>
        <span class="app-nav-label">${activeConfig.label[id]}</span>
      </button>`
  ).join('');
  return `
    <nav class="app-nav">${items}</nav>
    <div class="app-sidebar-location">Алихан, Ставрополь</div>
    <div class="app-sidebar-profile" id="appShellProfile">${activeConfig.profileLabel}</div>
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

// Разворот 09.08.2026, четвёртый заход - кнопка снова отдельный элемент-сосед body
// (не потомок .app-sidebar), position:fixed от viewport. Причина - .app-sidebar
// держит overflow-y:auto, что по CSS2.1 заставляет браузер трактовать overflow-x
// тоже как auto: пока сама панель ещё анимирует свою ширину (180ms), её текущая
// (ещё не финальная) ширина может быть УЖЕ или ЕЩЁ уже правого края, где стоит
// кнопка - и такой потомок обрезается этим scroll-overflow, даже будучи технически
// на месте (getBoundingClientRect() его находит, а реальный клик по правому краю -
// иногда нет). Сосед body этому не подвержен физически - overflow панели на него
// не действует. См. подробности в assets/crm-app-shell.css.
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
  if (!activeConfig.label[sectionId]) return;
  currentSection = sectionId;
  document.body.dataset.shellSection = sectionId;

  const radioId = activeConfig.radio[sectionId];
  if (radioId) {
    const radio = el(radioId);
    if (radio && !radio.checked) radio.checked = true;
  }

  updateActiveNav();
}

export function initAppShell(role = 'owner') {
  const main = el('crmMain');
  if (!main) return;

  activeConfig = ROLE_CONFIG[role] || ROLE_CONFIG.owner;
  currentSection = activeConfig.defaultSection;

  insertSidebar();

  // #crmMain остаётся hidden до успешного входа (initCrmAuth, crm-auth.js) - тот
  // же приём синхронизации, что уже использует wireOwnerToday (crm-owner-today.js).
  function sync() {
    document.body.classList.toggle('app-shell-active', !main.hidden);
  }
  new MutationObserver(sync).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  sync();

  // Реальная роль известна только после входа - до него в панели стоит подпись по
  // набору разделов страницы (для owner-страницы "Владелец"), и для управляющего
  // она неверна. Слушаем то же событие, которым crm-auth.js раздаёт вошедшего
  // сотрудника остальным модулям (reveal → 'crm:authenticated'), а не заводим свой
  // запрос /me: второй источник правды о роли разошёлся бы с шапкой ровно так же,
  // как разошёлся хардкод.
  document.addEventListener('crm:authenticated', (e) => {
    const label = ROLE_PROFILE_LABEL[e.detail?.role];
    const profileEl = el('appShellProfile');
    if (label && profileEl) profileEl.textContent = label;
  });

  goToSection(activeConfig.defaultSection);
}

// Мост для инлайн-обработчиков в HTML и переходов из доменных модулей.
window.crmGoToSection = goToSection;
