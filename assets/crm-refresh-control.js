import { showInfo } from './crm-toast.js';

// Кнопка обновления в шапке кабинета. Правка Влада 15.08.2026: она перечитывала
// только календарь, уведомления и сводку, поэтому карточка сотрудника оставалась с
// тем, что человек набрал руками и не сохранил - поменял длительность услуги с 40 на
// 20, нажал «Обновить» и продолжал видеть 20, хотя в базе 40. Теперь обновление
// означает «показать то, что сохранено»: карточки команды, графики и поля личных
// данных рисуются заново из ответа сервера, а несохранённые правки уходят.
export function initCrmRefreshControl(root = document) {
  const button = root.getElementById('refreshBtn');
  if (!button || button.dataset.refreshWired) return;
  button.dataset.refreshWired = '1';

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-refreshing');
    button.setAttribute('aria-busy', 'true');
    // Считаем ДО обновления: после перерисовки поля уже совпадают с сохранёнными и
    // отличить «правки были» от «правок не было» станет невозможно
    const hadUnsaved = Boolean(window.__teamHasUnsavedChanges?.() || window.__portfolioHasUnsavedChanges?.());
    try {
      const jobs = [
        window.__refreshScheduleViews?.({ all: true }),
        window.__refreshRoleSnapshot?.(),
        window.__refreshNotifications?.(),
        window.__refreshOwnerDashboard?.(),
        window.__refreshTeam?.(),
        window.__refreshTeamSchedules?.(),
        window.__refreshPortfolioFields?.(),
      ].filter((job) => job && typeof job.then === 'function');
      await Promise.allSettled(jobs);
      // Молчаливый сброс выглядел бы как потеря данных - человек должен понимать,
      // почему введённая им цифра сменилась на другую
      if (hadUnsaved) showInfo('Данные обновлены с сервера. Правки, которые не были сохранены, сброшены');
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      setTimeout(() => button.classList.remove('is-refreshing'), 500);
    }
  });
}
