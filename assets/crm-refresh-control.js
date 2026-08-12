export function initCrmRefreshControl(root = document) {
  const button = root.getElementById('refreshBtn');
  if (!button || button.dataset.refreshWired) return;
  button.dataset.refreshWired = '1';

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-refreshing');
    button.setAttribute('aria-busy', 'true');
    try {
      const jobs = [
        window.__refreshScheduleViews?.(),
        window.__refreshRoleSnapshot?.(),
        window.__refreshNotifications?.(),
        window.__refreshOwnerDashboard?.(),
      ].filter((job) => job && typeof job.then === 'function');
      await Promise.allSettled(jobs);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      setTimeout(() => button.classList.remove('is-refreshing'), 500);
    }
  });
}
