// Окно 65 (21.08.2026) - полоска дней недели под "Днём". Прямо со скриншота Yclients,
// который прислал заказчик: там нижняя строка "пн 10 · вт 11 · ... · вс 16" - основной
// способ перейти на другой день, а не стрелки ‹ › по одному дню и не отдельный экран
// "Неделя". На телефоне полоска липнет к низу экрана (position: sticky, см.
// .day-strip в assets/crm-app-shell.css), на десктопе остаётся обычной строкой.
//
// Почему отдельный модуль, а не пара строк внутри crm-schedule-view-day.js: полоска -
// это второй, самостоятельный носитель ОДНОГО и того же состояния (выбранная дата,
// scheduleViewState.date), у неё своя модель (какая неделя показана) и свой рендер,
// который зовут и при смене даты, и при листании недели.
import { WEEKDAY_SHORT, isoWeekdayOf, mondayOf, addDays, MONTH_GENITIVE } from './crm-schedule-shared.js';
import { todayStr } from './crm-calendar.js';

// Чистая функция (офлайн-тест tests/schedule-daystrip.model.test.js): семь дней недели,
// содержащей выбранную дату. Неделя с понедельника - та же конвенция, что у вида
// "Неделя" (mondayOf), чтобы полоска и график не расходились в том, где начинается неделя.
export function dayStripModel(selectedDate, today = todayStr()) {
  const from = mondayOf(selectedDate);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const weekday = isoWeekdayOf(date);
    return {
      date,
      dayNum: Number(date.slice(8, 10)),
      weekdayShort: WEEKDAY_SHORT[weekday - 1],
      isWeekend: weekday >= 6,
      isToday: date === today,
      isSelected: date === selectedDate,
    };
  });
}

// Подпись месяца над полоской: неделя может лежать в двух месяцах сразу (30 сентября -
// 6 октября), тогда названы оба - иначе строка "1 2 3 4 5 6 7" не говорит, какой это месяц.
export function dayStripMonthLabel(selectedDate) {
  const days = dayStripModel(selectedDate);
  const firstMonth = Number(days[0].date.slice(5, 7));
  const lastMonth = Number(days[6].date.slice(5, 7));
  const year = days[6].date.slice(0, 4);
  if (firstMonth === lastMonth) return `${MONTH_GENITIVE[firstMonth - 1]} ${year}`;
  return `${MONTH_GENITIVE[firstMonth - 1]} - ${MONTH_GENITIVE[lastMonth - 1]} ${year}`;
}

const DOCK_QUERY = '(max-width: 1023.98px)';
const BODY_DOCKED_CLASS = 'day-strip-docked';

export function wireDayStrip({ scheduleViewState, setView }) {
  const strip = document.getElementById('dayStrip');
  if (!strip) return { render: () => {} }; // страница без полоски работает как раньше
  // Панель "Дня" - носитель ответа "полоска сейчас уместна?": она скрыта и когда
  // карточка свёрнута, и когда открыт другой раздел (offsetParent === null).
  const host = strip.closest('.seg-panel') ?? strip.parentElement;
  // На crm-owner.html "День" - сворачиваемая карточка <details>, и её тело НЕ исчезает
  // из потока при сворачивании (у карточек своя анимация раскрытия, см.
  // КОНВЕНЦИЯ-КАРТОЧКИ-РАЗДЕЛОВ.md): замер на свёрнутой карточке даёт живые
  // getClientRects и высоту 795px. Поэтому "видно ли День" - это ДВА независимых
  // вопроса: раскрыта ли карточка (card.open) и показан ли вообще раздел (rects).
  // На crm-admin.html/crm-master.html карточек нет, вкладки переключаются radio+CSS,
  // там card === null и хватает одних rects.
  const card = strip.closest('details');
  // Якорь исходного места: пристыкованную полоску приходится physically переносить в
  // <body> (см. ниже), и без якоря вернуть её потом ровно туда, где она стояла в
  // разметке, было бы нечем.
  const anchor = document.createComment('day-strip');
  strip.parentNode.insertBefore(anchor, strip);

  function syncDock() {
    // getClientRects().length, а не offsetParent: пустой список честно значит "этого
    // сейчас нет на экране" и покрывает и скрытый раздел, и display:none у вкладки.
    const dayVisible = (host?.getClientRects().length ?? 0) > 0 && (!card || card.open);
    const docked = window.matchMedia(DOCK_QUERY).matches && dayVisible;
    // Перенос в <body> - не украшение, а условие работы position:fixed (поймано живым
    // прогоном 21.08.2026: замер дал bottom -626px при высоте экрана 844). Любой предок
    // с transform/filter становится containing block для fixed-потомка, и полоска
    // считает "низ экрана" от анимированной карточки раздела, а не от вьюпорта. В CRM
    // такие предки есть всегда (переходы между разделами, раскрытие карточек), убирать
    // их ради полоски нельзя - переносим саму полоску.
    if (docked && strip.parentNode !== document.body) document.body.appendChild(strip);
    if (!docked && strip.parentNode === document.body) anchor.parentNode?.insertBefore(strip, anchor.nextSibling);
    strip.classList.toggle('is-docked', docked);
    // Пристыкованная полоска вынута из потока и накрывает низ страницы - отступ снизу
    // отдаём body, иначе последняя карточка раздела уезжает под неё
    document.body.classList.toggle(BODY_DOCKED_CLASS, docked);
  }

  function render() {
    const days = dayStripModel(scheduleViewState.date);
    strip.innerHTML = `<div class="day-strip-head">
        <button type="button" class="day-strip-arrow" data-strip-shift="-7" aria-label="Предыдущая неделя">‹</button>
        <span class="day-strip-month">${dayStripMonthLabel(scheduleViewState.date)}</span>
        <button type="button" class="day-strip-arrow" data-strip-shift="7" aria-label="Следующая неделя">›</button>
      </div>
      <div class="day-strip-row">${days
        .map((day) => `<button type="button" class="day-strip-day${day.isSelected ? ' is-selected' : ''}${day.isToday ? ' is-today' : ''}${day.isWeekend ? ' is-weekend' : ''}" data-strip-date="${day.date}" aria-current="${day.isSelected ? 'date' : 'false'}">
          <span class="day-strip-wd">${day.weekdayShort}</span>
          <span class="day-strip-num">${day.dayNum}</span>
        </button>`)
        .join('')}</div>`;
    strip.querySelectorAll('[data-strip-date]').forEach((btn) => {
      btn.addEventListener('click', () => setView('day', btn.dataset.stripDate));
    });
    // Стрелки листают НЕДЕЛЮ и переносят выбранный день на тот же день недели соседней -
    // иначе после листания полоска показывала бы одну неделю, а календарь под ней день
    // из другой.
    strip.querySelectorAll('[data-strip-shift]').forEach((btn) => {
      btn.addEventListener('click', () => setView('day', addDays(scheduleViewState.date, Number(btn.dataset.stripShift))));
    });
  }

  render();
  syncDock();
  // Полоска то уместна, то нет: свернули карточку "День", ушли в другой раздел,
  // повернули телефон. Все три случая - смена видимости панели, поэтому слушаем ровно
  // те события, после которых она меняется, а не опрашиваем DOM по таймеру.
  document.addEventListener('crm:section', () => setTimeout(syncDock, 0));
  document.getElementById('scheduleCard-day')?.addEventListener('toggle', syncDock);
  window.addEventListener('resize', syncDock);
  window.matchMedia(DOCK_QUERY).addEventListener?.('change', syncDock);

  return { render: () => { render(); syncDock(); } };
}
