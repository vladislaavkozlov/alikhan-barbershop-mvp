// Вид "Неделя". Окно 65 (21.08.2026) - переписан на общий компонент "график работы"
// (assets/crm-schedule-matrix.js): матрица мастера × 7 дат вместо прежних 7 карточек-
// колонок ЗА ОДНОГО мастера (Окно 44). Причина - заказчик показал Yclients: там
// недели-как-своего-экрана нет, есть график команды, у которого меняется ширина окна
// дат. Прежний переключатель мастера (#weekMasterSwitch) исчез вместе с причиной
// существовать: матрица показывает всех сразу, а строка сама называет, чей это день.
//
// Что осталось прежним и осознанно: диапазон - производная от общей scheduleViewState.date
// (Окно 25), а не своя переменная; листание стрелками двигает общий якорь на понедельник
// соседней недели; клик по дате уводит в "День" через тот же setView.
import { mondayOf, addDays, escapeHtml } from './crm-schedule-shared.js';
import { buildMatrixModel, matrixHtml, loadMatrixData, wireMatrixClicks } from './crm-schedule-matrix.js';
import { errorMessage, showError } from './crm-toast.js';
import { showSkeleton } from './crm-loading.js';

export function wireWeekView(ctx) {
  const { masters, isSolo, fetchJson, holidayMapForRange, scheduleViewState, setView } = ctx;

  async function loadWeek() {
    const grid = document.getElementById('weekGrid');
    if (!grid) return;
    const from = mondayOf(scheduleViewState.date);
    const to = addDays(from, 6);
    showSkeleton(grid, 4, { tall: true });
    try {
      const data = await loadMatrixData({ masters, from, to, fetchJson, holidayMapForRange });
      const model = buildMatrixModel({ masters, from, to, ...data });
      grid.innerHTML = matrixHtml(model, { editable: !isSolo });
      wireMatrixClicks(grid, {
        editable: !isSolo,
        onOpenDay: (date) => setView('day', date),
        // Клик по ячейке правит график ИМЕННО того мастера, чья это строка - поэтому
        // общий masterId переставляется здесь, а не остаётся тем, что выбрали в другом
        // виде (до Окна 65 его выбирали пилюлями-переключателем).
        onEditCell: (date, masterId) => {
          scheduleViewState.masterId = masterId;
          ctx.getMonthApi?.()?.openDayEditModal?.(date, masterId);
        },
      });
    } catch (err) {
      grid.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить неделю'))}</span>`;
      showError(errorMessage(err, 'Не удалось загрузить неделю'));
    }
  }

  const grid = document.getElementById('weekGrid');
  if (grid) {
    document.getElementById('weekNavPrev')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), -7)));
    document.getElementById('weekNavNext')?.addEventListener('click', () => setView('week', addDays(mondayOf(scheduleViewState.date), 7)));
    loadWeek();
  } // страница без реальной Недели - loadWeek выше уже сам не делает ничего без #weekGrid

  return { loadWeek };
}
