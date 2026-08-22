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
// 21.08.2026 (задача Влада) - пункт "Клиенты" вернулся в меню между "Командой" и
// "Финансами" ровно по правилу, записанному выше: раздел наполнен реальной базой
// клиентов (radio pt-f/panel-f, crm-owner.html; данные - GET /clients?all=true), а не
// заглушкой "в разработке". Порядок в ROLE_CONFIG.order задан явно - место пункта в
// меню решает он, а не порядок radio на странице. Только owner-набор разделов
// (владелец и управляющий): у администратора и мастера этого раздела нет, и сервер
// отдаёт им 403 на ?all=true, а не полагается на спрятанную кнопку.
//
// Правка Влада 07.08.2026 - добавлен пункт "Аналитика" (radio pt-d/panel-d,
// свободный с Окна 36): переиспользован сразу с реальным содержимым
// ("Возвращаемость клиентов", перенесена из "Сотрудники"), не пустой заглушкой -
// тот же принцип, что уже применён к Клиентам/Настройкам выше (пункт появляется
// в момент, когда раздел реально наполнен). Эмодзи-иконки заменены на SVG
// (assets/crm-icons.js) - разный рендер эмодзи по ОС/браузерам ломал премиум-вид.
import { ICON_SCHEDULE, ICON_TEAM, ICON_CLIENTS, ICON_FINANCE, ICON_ANALYTICS, ICON_BELL, ICON_SIDEBAR_TOGGLE, ICON_PROFILE, ICON_MENU } from './crm-icons.js';

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
    order: ['schedule', 'team', 'clients', 'finance', 'analytics', 'notifications'],
    radio: { schedule: 'pt-a', team: 'pt-b', clients: 'pt-f', finance: 'pt-c', analytics: 'pt-d', notifications: 'pt-e' },
    label: {
      schedule: 'Расписание',
      team: 'Команда',
      clients: 'Клиенты',
      finance: 'Финансы',
      analytics: 'Аналитика',
      notifications: 'Уведомления',
    },
    icon: {
      schedule: ICON_SCHEDULE,
      team: ICON_TEAM,
      clients: ICON_CLIENTS,
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
  // «Моя зарплата» убрана из меню 22.08.2026 (правка Влада). Сама вкладка исчезла
  // ещё 17.08.2026 вместе с правкой «сотрудники не должны видеть свою зарплату,
  // проценты и тд», а пункт меню остался и вёл в пустую панель pt-b - зарплату он не
  // показывал, но выглядел как раздел, которого нет. Роут /payroll для роли master
  // закрыт с того же дня (MONEY_VIEWERS, api/routes/payroll.js), сервер тут ни при чём
  master: {
    profileLabel: 'Мастер',
    defaultSection: 'today',
    order: ['today', 'profile'],
    radio: { today: 'pt-a', profile: 'pt-c' },
    label: { today: 'Мой день', profile: 'Личные данные' },
    icon: { today: ICON_SCHEDULE, profile: ICON_PROFILE },
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
  // Кнопка выхода внизу панели (16.08.2026) существует только для мобильного режима
  // (CSS прячет её на десктопе, где та же кнопка стоит в шапке). Своей логики выхода
  // у неё НЕТ - она нажимает существующий #logoutBtn. Это принципиально: выход
  // чистит сессию и токен (crm-auth.js), второй такой обработчик рано или поздно
  // разошёлся бы с первым, а цена расхождения здесь - зависшая сессия на телефоне
  // сотрудника. Одна кнопка-источник, вторая - только способ до неё дотянуться.
  return `
    <nav class="app-nav">${items}</nav>
    <div class="app-sidebar-location">Алихан, Ставрополь</div>
    <div class="app-sidebar-profile" id="appShellProfile">${activeConfig.profileLabel}</div>
    <button type="button" class="app-sidebar-logout" id="appSidebarLogout">Выйти</button>
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
  const logout = aside.querySelector('#appSidebarLogout');
  if (logout) {
    logout.addEventListener('click', () => {
      closeDrawer();
      el('logoutBtn')?.click();
    });
  }
  insertToggleButton();
}

// ═══ Мобильная шторка (16.08.2026) ═══════════════════════════════════════════
// До этой правки на телефоне левого меню не существовало вообще: весь app shell
// жил внутри @media (min-width:1024px), навигацией работала горизонтальная
// .tab-bar, у которой на 390px два последних раздела уезжают за край экрана.
//
// Здесь НЕ вторая навигация. Панель, её разметка, пункты, иконки, подсветка
// активного и подписи точки/роли - те же самые (sidebarMarkup выше, один вызов на
// оба режима). Добавляется только способ её показать на узком экране: кнопка в
// шапке, затемнение и класс на body, по которому CSS выводит панель из-за левого
// края. Ни одного дублирующего списка разделов в коде нет по построению - разойтись
// с десктопным меню он физически не может.
const DRAWER_OPEN_CLASS = 'app-shell-drawer-open';
const MOBILE_NAV_CLASS = 'app-shell-mobile-nav';

function isDrawerOpen() {
  return document.body.classList.contains(DRAWER_OPEN_CLASS);
}

function setDrawer(open) {
  document.body.classList.toggle(DRAWER_OPEN_CLASS, open);
  const btn = el('appDrawerBtn');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  }
  const sidebar = el('appSidebar');
  if (sidebar) sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
}

export function closeDrawer() {
  if (isDrawerOpen()) setDrawer(false);
}

// Кнопка встаёт СЛЕВА ОТ ЛОГОТИПА внутри общей группы, а не отдельным элементом в
// .nav: у .nav стоит justify-content:space-between, третий прямой ребёнок разъехался
// бы по краям и логотип уехал бы в середину шапки. Обёртка держит "меню + логотип +
// раздел" одним блоком слева, действия остаются справа, как были.
function insertDrawerControls() {
  const nav = document.querySelector('header.site .nav');
  const brand = nav && nav.querySelector('.brand');
  if (!nav || !brand || el('appDrawerBtn')) return false;

  const group = document.createElement('div');
  group.className = 'app-shell-brand-group';
  nav.insertBefore(group, brand);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-drawer-btn';
  btn.id = 'appDrawerBtn';
  btn.setAttribute('aria-label', 'Открыть меню');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'appSidebar');
  btn.innerHTML = `<span class="app-nav-icon" aria-hidden="true">${ICON_MENU}</span>`;
  btn.addEventListener('click', () => setDrawer(!isDrawerOpen()));

  const section = document.createElement('span');
  section.className = 'app-shell-mobile-section';
  section.id = 'appShellMobileSection';

  group.append(btn, brand, section);

  // Затемнение - <button>, а не <div>: закрытие по тапу мимо меню обязано работать и
  // с клавиатуры/скринридера, иначе на открытой шторке фокус запирается без выхода.
  if (!el('appDrawerScrim')) {
    const scrim = document.createElement('button');
    scrim.type = 'button';
    scrim.className = 'app-drawer-scrim';
    scrim.id = 'appDrawerScrim';
    scrim.setAttribute('aria-label', 'Закрыть меню');
    scrim.addEventListener('click', closeDrawer);
    document.body.appendChild(scrim);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Класс-признак "мобильная навигация реально собрана". Именно по нему CSS прячет
  // старую .tab-bar - если этот код не выполнился (ошибка импорта, старый кеш), лента
  // вкладок останется на экране и телефон не окажется вообще без способа переключить
  // раздел. Скрывать её безусловным CSS-правилом было бы ставкой на то, что скрипт
  // всегда доедет.
  document.body.classList.add(MOBILE_NAV_CLASS);
  return true;
}

function updateActiveNav() {
  document.querySelectorAll('.app-nav-item').forEach((btn) => {
    const active = btn.dataset.section === currentSection;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'true' : 'false');
  });
  const mobileSection = el('appShellMobileSection');
  if (mobileSection) mobileSection.textContent = activeConfig.label[currentSection] || '';
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

  // Выбрал раздел - шторка уходит и открывает то, что ты выбрал. Закрытие живёт
  // именно здесь, а не на клике по пункту меню, потому что в этот же раздел приводят
  // и переходы из других модулей (клик по уведомлению - crm-notifications.js,
  // алерт "мастер без графика" - crm-schedule-alerts.js): любой из них на телефоне
  // оставил бы шторку висеть поверх раздела, в который сам же и привёл.
  closeDrawer();

  // Правка 20.08.2026 - раздел объявляет о себе, чтобы модули раздела могли привести
  // себя в состояние "по умолчанию" при каждом входе, а не только при загрузке
  // страницы (Влад: заходишь в "Расписание" из "Команды" - "День" должен быть уже
  // раскрыт). Событие, а не прямое обращение к #scheduleCard-day отсюда: shell
  // отвечает за роутинг и не должен знать внутренности панелей, к тому же в раздел
  // приводят и переходы из других модулей (уведомления, алерты графика) - все они
  // идут через goToSection и потому покрыты одной точкой.
  document.dispatchEvent(new CustomEvent('crm:section', { detail: { section: sectionId } }));
}

export function initAppShell(role = 'owner') {
  const main = el('crmMain');
  if (!main) return;

  activeConfig = ROLE_CONFIG[role] || ROLE_CONFIG.owner;
  currentSection = activeConfig.defaultSection;

  insertSidebar();
  insertDrawerControls();

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
