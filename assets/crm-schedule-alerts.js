// Окно 42 (07.08.2026) - переименован из crm-owner-today.js (демонтаж вкладки
// "Сегодня", ПРОМПТ-ОКНО-42-ДЕМОНТАЖ-СЕГОДНЯ.md): алерт "мастер без графика",
// GET /owner/alerts (computeOwnerAlerts, api/server.mjs) - рендерится наверху
// раздела "Расписание" (crm-owner.html, #ownerAlertsSchedule), а не на отдельной
// вкладке. Выручка сегодня и риск-список клиентов, которые раньше жили на той же
// вкладке "Сегодня", убраны этим же окном - см. правки в crm-owner.html/
// assets/crm-clients.js, этот файл их не касается.
//
// Правка 07.08.2026 (правка Влада): компактный алерт "заявка на рассмотрении" убран
// целиком - он дублировал историю заявок (#scheduleRequestsHistory,
// assets/crm-schedule-requests.js), которая после Окна 42 живёт на той же странице
// чуть ниже и уже показывает те же pending-заявки текстом. Пока баннер был на
// отдельной вкладке "Сегодня" (до Окна 42), дублирования не было; после переезда
// обоих блоков на "Расписание" верхний алерт стал лишним повтором того, что и так
// открыто видно ниже.
import { fetchJson } from './crm-auth.js';
import { goToSection } from './crm-app-shell.js';
import { errorMessage, showError } from './crm-toast.js';
import { T, Tc, P, C } from './crm-terms.js';

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// "Настроить график" по-прежнему уводит в "Команду" - там и чинится отсутствующий
// график мастера, баннер уже живёт в "Расписании" (Окно 42), но это другой раздел.
function goToTab(sectionId) {
  goToSection(sectionId);
}

// Окно 45 (08.08.2026) - экспортирован для кнопки мягкого обновления (вызывать
// именно эту функцию, не wireScheduleAlerts() заново - та завела бы второй
// MutationObserver на #crmMain).
export async function renderOwnerAlerts() {
  const scheduleEl = el('ownerAlertsSchedule');
  if (!scheduleEl) return;

  try {
    const { mastersWithoutSchedule } = await fetchJson('/owner/alerts');

    // Пустое состояние - правка Влада 08.08.2026: убрана декоративная реассюрирующая
    // строка ("Всё в порядке..."), блок просто пуст, когда алертов нет.
    if (mastersWithoutSchedule.length === 0) {
      scheduleEl.innerHTML = '';
      window.updateNotifBadge?.();
      return;
    }

    scheduleEl.innerHTML = mastersWithoutSchedule
      .map(
        (m) => `<div class="owner-schedule-alert" role="status">
          <span class="owner-schedule-alert__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="5" width="17" height="15" rx="2.2"/>
              <path d="M3.5 9.5h17M8 3v3.5M16 3v3.5M8.5 14.5h7M12 11v7"/>
            </svg>
          </span>
          <span class="owner-schedule-alert__copy">
            <strong>Нет рабочего графика</strong>
            <span>${escapeHtml(P('schedule.masterUnbookable', { name: m.name }))}</span>
          </span>
          <button class="owner-schedule-alert__action" type="button" data-open-schedule-tab>Настроить график</button>
        </div>`
      )
      .join('');
    scheduleEl.querySelectorAll('[data-open-schedule-tab]').forEach((btn) => {
      btn.addEventListener('click', () => goToTab('team'));
    });

    // Список только что перерисован - счётчик на колокольчике (assets/mockup-crm.js)
    // должен увидеть реальные числа, тот же приём, что уже применяет renderRiskList
    // (assets/crm-clients.js).
    window.updateNotifBadge?.();
  } catch (err) {
    scheduleEl.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(err, 'Не удалось загрузить график'))}</p>`;
    showError(errorMessage(err, 'Не удалось загрузить график'));
  }
}

export function wireScheduleAlerts() {
  // #crmMain остаётся hidden (initCrmAuth, assets/crm-auth.js) до успешного входа -
  // тот же приём ожидания, что уже применён в assets/crm-clients.js
  // (wireClientsRisk)/assets/crm-schedule-requests.js (initOwnerScheduleRequests).
  const main = el('crmMain');
  if (!main) return;
  let started = false;
  function startOnce() {
    if (started || main.hidden) return;
    started = true;
    renderOwnerAlerts();
  }
  new MutationObserver(startOnce).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  startOnce();
}
