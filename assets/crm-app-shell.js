// Окно 41 (07.08.2026) - app shell владельца (sidebar + topbar + роутинг между
// разделами), первое окно 13-оконного плана премиального редизайна
// (plans/2026-08-06-owner-crm-premium-redesign.md). Инфраструктурный слой -
// разделы "Клиенты"/"Настройки" пока без контента (заглушки, наполнение - Окна
// 48/51), "Сегодня"/"Расписание"/"Команда"/"Финансы" продолжают показывать РОВНО
// тот же контент, что и раньше (panel-today/panel-a/panel-b/panel-c), роутинг
// лишь переключает те же скрытые radio-input, что уже управляют их видимостью
// через существующий CSS (:checked ~ .panel-X) - ничего в самих панелях не
// переписано.
//
// ШАГ 0 промпта нашёл 3 места, которые раньше напрямую трогали radio pt-*:
// (1) инлайн-кнопка "Выручка за неделю/месяц →" на "Сегодня" (crm-owner.html),
// (2) goToTab() в crm-owner-today.js (алерты "мастер без графика"/заявка),
// (3) openMasterCard() в crm-notifications.js (клик по уведомлению). Все три
// переведены на goToSection() - см. правки в соответствующих файлах.

const SECTION_RADIO = { today: 'pt-today', schedule: 'pt-a', team: 'pt-b', finance: 'pt-c' };
const SECTION_LABEL = {
  today: 'Сегодня',
  schedule: 'Расписание',
  clients: 'Клиенты',
  team: 'Команда',
  finance: 'Финансы',
  settings: 'Настройки',
};
const SECTION_ICON = {
  today: '🏠',
  schedule: '🗓',
  clients: '👥',
  team: '✂️',
  finance: '₽',
  settings: '⚙️',
};
const SECTION_ORDER = ['today', 'schedule', 'clients', 'team', 'finance', 'settings'];
const STUB_NOTE = { clients: 'Полный раздел - Окно 48', settings: 'Полный раздел - Окно 51' };

let currentSection = 'today';

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
    <div class="app-sidebar-brand">АЛИХАН</div>
    <nav class="app-nav">${items}</nav>
    <button type="button" class="app-nav-cta" id="appShellNewBooking" title="Скоро - Окно 45" disabled>+ Новая запись</button>
    <div class="app-sidebar-location">Алихан, Ставрополь</div>
    <div class="app-sidebar-profile" id="appShellProfile">Владелец</div>
  `;
}

function stubMarkup(sectionId) {
  return `<div class="shell-section-empty" data-stub="${sectionId}">
    <p class="note">Раздел «${SECTION_LABEL[sectionId]}» в разработке - ${STUB_NOTE[sectionId] ?? 'скоро'}</p>
  </div>`;
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

function insertStubs() {
  const pageTabs = document.querySelector('.page-tabs');
  if (!pageTabs || el('shellStub-clients')) return;
  ['clients', 'settings'].forEach((id) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = stubMarkup(id);
    const stub = wrap.firstElementChild;
    stub.id = `shellStub-${id}`;
    pageTabs.insertAdjacentElement('afterend', stub);
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
  insertStubs();

  // #crmMain остаётся hidden до успешного входа (initCrmAuth, crm-auth.js) - тот
  // же приём синхронизации, что уже использует wireOwnerToday (crm-owner-today.js).
  function sync() {
    document.body.classList.toggle('app-shell-active', !main.hidden);
  }
  new MutationObserver(sync).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  sync();

  goToSection('today');
}

// Мост для инлайн-обработчиков в HTML (тот же установившийся в проекте паттерн,
// что уже применён к window.toggleRetentionPanel/window.updateNotifBadge).
window.crmGoToSection = goToSection;
