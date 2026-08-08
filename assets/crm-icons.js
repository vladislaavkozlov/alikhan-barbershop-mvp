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
