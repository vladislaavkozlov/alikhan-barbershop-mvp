// Состояния загрузки CRM - один язык для всех ролей (правка Влада 15.08.2026).
// Раньше каждый блок писал своё «Загружаю…» обычным текстом: непонятно, идёт ли
// работа или интерфейс завис, и содержимое прыгало, когда данные приходили.
// Здесь два инструмента: полосы-заготовки под форму будущего содержимого и
// компактная строка с индикатором для узких мест. Стили - assets/crm-loading.css.

// Разметка полос-заготовок. rows - сколько строк занять, tall - высокие блоки
// (карточки, а не строки текста)
export function skeletonMarkup(rows = 3, { tall = false } = {}) {
  const cls = `crm-skeleton__row${tall ? ' crm-skeleton__row--tall' : ''}`;
  return `<div class="crm-skeleton" role="status" aria-label="Загружаю данные">${
    Array.from({ length: rows }, () => `<span class="${cls}"></span>`).join('')
  }</div>`;
}

export function showSkeleton(host, rows = 3, options) {
  if (!host) return;
  host.innerHTML = skeletonMarkup(rows, options);
}

// Строка с крутящимся индикатором - там, где заготовки не помещаются
export function loadingLineMarkup(text = 'Загружаю…') {
  return `<span class="crm-loading-line" role="status"><span class="crm-spinner" aria-hidden="true"></span>${text}</span>`;
}

// Текст ставим отдельно через textContent: подпись может однажды прийти не из кода,
// а из данных, и тогда шаблонная строка стала бы дырой
export function showLoadingLine(host, text = 'Загружаю…') {
  if (!host) return;
  host.innerHTML = '<span class="crm-loading-line" role="status"><span class="crm-spinner" aria-hidden="true"></span><span class="crm-loading-line__text"></span></span>';
  host.querySelector('.crm-loading-line__text').textContent = text;
}

// ── Экран первичной загрузки кабинета ───────────────────────────────────────
// Между входом и готовым интерфейсом проходит несколько запросов подряд; до этой
// правки человек всё это время смотрел на полупустой каркас страницы
let loaderEl = null;

export function showPageLoader(text = 'Готовлю рабочий стол…') {
  if (loaderEl?.isConnected) return loaderEl;
  loaderEl = document.createElement('div');
  loaderEl.className = 'crm-page-loader';
  // Порядок и подача - как на экране входа: кикер «CRM», бренд, дальше действие
  loaderEl.innerHTML = `<div class="crm-page-loader__card"><p class="crm-page-loader__kicker">CRM</p><span class="crm-page-loader__brand">АЛИХАН</span><span class="crm-spinner crm-spinner--lg" aria-hidden="true"></span><p class="crm-page-loader__text" role="status"></p></div>`;
  loaderEl.querySelector('.crm-page-loader__text').textContent = text;
  document.body.append(loaderEl);
  return loaderEl;
}

export function hidePageLoader() {
  const el = loaderEl;
  if (!el?.isConnected) return;
  loaderEl = null;
  // Даём экрану уйти плавно, но снимаем его и по таймеру - если анимации в системе
  // выключены, событие animationend не придёт вовсе
  el.classList.add('crm-page-loader--out');
  const remove = () => el.remove();
  el.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, 400);
}
