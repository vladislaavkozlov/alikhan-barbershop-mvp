// Правка Влада 07.08.2026 - набор line-art SVG-иконок взамен эмодзи (🗓/✂️/₽/🔔/✉),
// которые ломали премиум-ощущение редизайна Окна 41 (разный стиль отрисовки эмодзи
// на разных ОС/браузерах, не совпадает с темой сайта). Единый viewBox 20x20,
// stroke="currentColor" - цвет наследуется от родителя (.app-nav-item/.notif-bell),
// поэтому hover/active-состояния подхватываются автоматически без отдельной
// SVG-переменной на каждое состояние. Один файл, не по одной иконке на потребителя -
// используется и в sidebar (assets/crm-app-shell.js), и в топбар-колокольчике
// (crm-owner.html inline-скрипт).
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

export const ICON_SCHEDULE = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8h14"/><path d="M6.5 2.5v3M13.5 2.5v3"/><path d="M6.4 11h1M9.5 11h1M12.6 11h1M6.4 13.5h1M9.5 13.5h1"/></svg>`;

// Ножницы - оставляет узнаваемость барбершопа (замена ✂️), не generic "человечки"
export const ICON_TEAM = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5.3" r="2"/><circle cx="5" cy="14.7" r="2"/><path d="M6.6 6.6 16.5 16.5M6.6 13.4 16.5 3.5"/></svg>`;

export const ICON_FINANCE = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="5.5" width="15" height="9" rx="1.8"/><circle cx="10" cy="10" r="2.1"/><circle cx="5.2" cy="10" r="0.55" fill="currentColor" stroke="none"/><circle cx="14.8" cy="10" r="0.55" fill="currentColor" stroke="none"/></svg>`;

export const ICON_ANALYTICS = `<svg viewBox="0 0 20 20" fill="currentColor" stroke="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="3.2" height="6" rx="0.8"/><rect x="8.4" y="7" width="3.2" height="10" rx="0.8"/><rect x="13.8" y="3.5" width="3.2" height="13.5" rx="0.8"/></svg>`;

export const ICON_BELL = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><path d="M10 2.5c-2.2 0-4 1.8-4 4v2.3c0 .5-.2 1-.5 1.4L4.3 12a1 1 0 0 0 .8 1.6h9.8a1 1 0 0 0 .8-1.6l-1.2-1.8a2.3 2.3 0 0 1-.5-1.4V6.5c0-2.2-1.8-4-4-4Z"/><path d="M8.2 15.5a1.9 1.9 0 0 0 3.6 0"/></svg>`;

// Правка 08.08.2026 - сворачивание sidebar до одних иконок (assets/crm-app-shell.js,
// toggleSidebar). Двойной шеврон "‹‹" - при свёрнутом меню CSS разворачивает его на
// 180° в ту же иконку "»", без второй SVG под обратное состояние.
export const ICON_SIDEBAR_TOGGLE = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><path d="M12.5 4 7 10l5.5 6"/><path d="M7.5 4 2 10l5.5 6"/></svg>`;

// Окно 47 (09.08.2026) - раздел "Личные данные" мастера в sidebar. Профиль/анкета,
// тот же line-art стиль (STROKE), не эмодзи - см. остальные иконки этого файла.
// Раздел «Клиенты» (21.08.2026). Два человека, дальний - полупрозрачной обводки:
// «Команда» рядом в меню уже занята парой людей другого рисунка (ICON_TEAM), и
// одинаковые силуэты в соседних пунктах читались бы как один раздел. Тот же line-art
// набор, тот же viewBox и та же обводка, что у остальных.
export const ICON_CLIENTS = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="7" r="2.7"/><path d="M2.8 16.5c0-2.9 2.3-4.8 5.2-4.8s5.2 1.9 5.2 4.8"/><path d="M13.6 5.1a2.5 2.5 0 0 1 0 4.8M15.6 16.5c0-2.2-.8-3.7-2.1-4.5" opacity="0.55"/></svg>`;

export const ICON_PROFILE = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="6.8" r="3"/><path d="M4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/></svg>`;

// 16.08.2026 - вызов меню-шторки на телефоне (assets/crm-app-shell.js, mobile drawer).
// Три штриха вместо привычных трёх РАВНЫХ: нижний короче, как в наборе иконок этой
// CRM (ICON_ANALYTICS тоже строит ритм из разной длины) - иначе иконка читается как
// generic-гамбургер из бутстрапа и выбивается из line-art набора.
export const ICON_MENU = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><path d="M3 5.5h14M3 10h14M3 14.5h9"/></svg>`;

// Иконки внутренних разделов карточки сотрудника. Та же сетка 20x20 и тот же
// stroke, что у оболочки CRM, но разные метафоры помогают быстро сканировать
// длинную раскрытую карточку без повторяющихся ножниц у каждого заголовка
export const ICON_DETAILS = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3.5" width="14" height="13" rx="2"/><circle cx="7" cy="8" r="1.7"/><path d="M10.5 7.3h3.5M10.5 10h3.5M5.2 13.2h8.8"/></svg>`;
export const ICON_PUBLIC = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7"/><path d="M3.5 8h13M3.5 12h13M10 3c2 2 3 4.3 3 7s-1 5-3 7c-2-2-3-4.3-3-7s1-5 3-7Z"/></svg>`;
export const ICON_SERVICES = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5.3" r="2"/><circle cx="5" cy="14.7" r="2"/><path d="M6.6 6.6 16.5 16.5M6.6 13.4 16.5 3.5"/></svg>`;
export const ICON_ACCESS = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="10" r="4"/><path d="M11 10h6M14 10v2M16.5 10v2"/></svg>`;
export const ICON_UPLOAD = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><path d="M10 13V3M6.5 6.5 10 3l3.5 3.5"/><path d="M4 11.5v3A2.5 2.5 0 0 0 6.5 17h7a2.5 2.5 0 0 0 2.5-2.5v-3"/></svg>`;
export const ICON_ADD = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><path d="M10 4v12M4 10h12"/></svg>`;

// Иконки ленты уведомлений (20.08.2026). Раньше типы записи рисовались эмодзи (📅/📤/📥,
// Окна 14 и 55) - в узкой панели колокольчика это не бросалось в глаза, но в крупной
// карточке раздела эмодзи стоит рядом с сайдбаром, набранным одним стилем штриховых
// SVG, и выпадает из него: своя палитра, свой вес, свой рендер в каждой ОС.
// Направление переноса по-прежнему различается стрелкой - мастеру в списке из десяти
// строк важно видеть, ушла запись или пришла, не вчитываясь в текст.
export const ICON_BOOKING_NEW = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8h14"/><path d="M6.5 2.5v3M13.5 2.5v3"/><path d="M10 10.5v4M8 12.5h4"/></svg>`;
export const ICON_BOOKING_MOVED_OUT = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8h14"/><path d="M6.5 2.5v3M13.5 2.5v3"/><path d="M7 12.5h6M10.5 10l2.5 2.5-2.5 2.5"/></svg>`;
// Отменённая запись - тот же календарь, но перечёркнутый крестиком
export const ICON_BOOKING_CANCELLED = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8h14"/><path d="M6.5 2.5v3M13.5 2.5v3"/><path d="M8 11.5l4 4M12 11.5l-4 4"/></svg>`;
export const ICON_BOOKING_MOVED_IN = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8h14"/><path d="M6.5 2.5v3M13.5 2.5v3"/><path d="M13 12.5H7M9.5 10 7 12.5 9.5 15"/></svg>`;

// Крестик «убрать из колокольчика» (20.08.2026). Тот же STROKE, что весь набор -
// иконка живёт внутри строки уведомления и наследует её цвет
export const ICON_CLOSE = `<svg viewBox="0 0 20 20" ${STROKE} xmlns="http://www.w3.org/2000/svg"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>`;
