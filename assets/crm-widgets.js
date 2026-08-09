// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Кастомные виджеты выбора даты/
// времени (см. КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md) - строят HTML этих виджетов,
// сами не интерактивны. Код перенесён 1в1 из crm-auth.js, поведение не менялось.
//
// ВАЖНО (оставшаяся скрытая связь, не трогаем в этом рефакторинге): построенный
// здесь HTML использует onclick="toggleCustomSelect(this)"/onclick="toggleCustomDate(this)"
// - это HTML-атрибуты, они ВСЕГДА резолвятся через глобальный window-scope
// (платформенное ограничение браузера, не наша архитектура). Сама интерактивность
// (открытие/закрытие, месячная сетка, клик по дню) живёт в assets/mockup-crm.js -
// классическом не-module скрипте. Явный import этой связи невозможен без смены
// модели виджета (inline onclick → addEventListener), что меняло бы поведение и
// выходит за рамки structural-only переноса.
import { el, todayStr } from './crm-shared.js';

// Правка 03.08.2026: время перерыва/графика раньше вписывалось вручную текстом
// (<input type="text" placeholder="13:00">) - не по теме сайта и без валидации.
// Переиспользует уже существующий кастомный дропдаун (toggleCustomSelect/
// pickCustomSelectOption, assets/mockup-crm.js), который раньше был только у
// "Закреплён за мастером" - те же классы, тот же визуальный язык, не новый виджет.
const SHOP_TIME_OPTIONS = (() => {
  const opts = [];
  for (let m = 10 * 60; m <= 20 * 60; m += 15) {
    opts.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return opts;
})();

function buildTimeSelectHtml(id, value) {
  const v = value || '13:00';
  const options = SHOP_TIME_OPTIONS.map(
    (t) => `<div class="custom-select-option${t === v ? ' selected' : ''}" onclick="pickCustomSelectOption(this)" data-value="${t}">${t}</div>`
  ).join('');
  return `<div class="custom-select" id="${id}" data-value="${v}">
    <button type="button" class="custom-select-trigger" onclick="toggleCustomSelect(this)">${v}</button>
    <div class="custom-select-list" hidden>${options}</div>
  </div>`;
}
// Рисует time-picker внутрь ПУСТОГО контейнера slotId (тот же id, что в разметке
// HTML вместо старого <input type="text">) - сам виджет .custom-select получает
// ОТДЕЛЬНЫЙ id (valueId), иначе id задвоился бы (контейнер + вложенный div с тем
// же id). Вызывающий код читает значение через timeSelectValue(valueId).
export function renderTimeSelect(slotId, valueId, value) {
  const container = el(slotId);
  if (!container) return;
  container.innerHTML = buildTimeSelectHtml(valueId, value);
}
export function timeSelectValue(id) {
  return el(id)?.dataset.value || null;
}

// Правка 03.08.2026 (Окно 16) - свой date-picker вместо нативного <input type="date">
// (см. КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md). Взаимодействие (открытие/закрытие,
// месячная сетка, клик по дню) - assets/mockup-crm.js (toggleCustomDate и рядом),
// тот же паттерн разделения, что уже есть у time-select выше. Формат value -
// "YYYY-MM-DD", как у нативного input, чтобы не менять остальной код, который его
// использует (сравнения дат строками уже работают в этом формате).
// minDate (опционально, "YYYY-MM-DD") - дни раньше него рисуются некликабельными
// (см. renderCustomDateCalendar, assets/mockup-crm.js). Только для формы записи
// (assets/crm-walkin.js передаёт todayStr() - в прошлое не записать) - остальные
// вызовы этого виджета (расчёт ЗП за прошлый период, график/отгул мастера, навигация
// по календарю на прошедший день) законно работают и с прошлыми датами, минимум
// им не передаём, поведение не меняется.
function buildDateWidgetHtml(id, value, minDate) {
  const v = value || todayStr();
  const [y, m, d] = v.split('-');
  const minAttr = minDate ? ` data-min-date="${minDate}"` : '';
  return `<div class="custom-date" id="${id}" data-value="${v}" data-view-year="${y}" data-view-month="${m}"${minAttr}>
    <button type="button" class="custom-date-trigger" onclick="toggleCustomDate(this)">${d}.${m}.${y}</button>
    <div class="custom-date-panel" hidden></div>
  </div>`;
}
export function renderDateSelect(slotOrId, valueId, value, minDate) {
  const container = typeof slotOrId === 'string' ? el(slotOrId) : slotOrId;
  if (!container) return;
  container.innerHTML = buildDateWidgetHtml(valueId, value, minDate);
}
export function dateSelectValue(id) {
  return el(id)?.dataset.value || null;
}
