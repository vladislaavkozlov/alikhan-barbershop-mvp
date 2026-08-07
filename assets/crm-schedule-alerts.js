// Окно 42 (07.08.2026) - переименован из crm-owner-today.js (демонтаж вкладки
// "Сегодня", ПРОМПТ-ОКНО-42-ДЕМОНТАЖ-СЕГОДНЯ.md): два алерта (мастера без графика,
// необработанные заявки), GET /owner/alerts (computeOwnerAlerts, api/server.mjs) -
// теперь рендерятся наверху раздела "Расписание" (crm-owner.html, #ownerAlertsSchedule/
// #ownerAlertsRequests), а не на отдельной вкладке. Выручка сегодня и риск-список
// клиентов, которые раньше жили на той же вкладке "Сегодня", убраны этим же окном -
// см. правки в crm-owner.html/assets/crm-clients.js, этот файл их не касается.
import { fetchJson } from './crm-auth.js';
import { goToSection } from './crm-app-shell.js';

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Те же ярлыки, что assets/crm-schedule-requests.js (история заявок владельца) -
// одна заявка не должна называться по-разному на двух экранах.
const CATEGORY_LABEL = { otgul: 'Отгул разовый', otpusk: 'Отпуск', grafik_standard: 'Постоянный график' };

function periodOf(r) {
  if (r.category === 'grafik_standard') return 'весь недельный график';
  if (r.requestType === 'day_off') return r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} – ${r.dateTo}`;
  return `${r.dateFrom} ${r.startTime}–${r.endTime}`;
}

// "Настроить график" по-прежнему уводит в "Команду" - там и чинится отсутствующий
// график мастера, баннер уже живёт в "Расписании" (Окно 42), но это другой раздел.
function goToTab(sectionId) {
  goToSection(sectionId);
}

// "Открыть" у заявки на рассмотрении раньше переключало на вкладку "Расписание"
// (баннер жил на "Сегодня") - Окно 42 переносит сам баннер в "Расписание", так что
// переключать раздел больше незачем, нужен скролл до истории заявок ниже на той же
// странице (#scheduleRequestsHistory, crm-owner.html) - тот же приём, что уже
// применяет openMasterCard (assets/crm-notifications.js) для карточки мастера.
function scrollToRequestsHistory() {
  el('scheduleRequestsHistory')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderOwnerAlerts() {
  const scheduleEl = el('ownerAlertsSchedule');
  const requestsEl = el('ownerAlertsRequests');
  if (!scheduleEl && !requestsEl) return;

  try {
    const { mastersWithoutSchedule, pendingRequests } = await fetchJson('/owner/alerts');

    // Пустое состояние ("всё в порядке") - один текст на оба списка, не два пустых
    // блока подряд (DoD промпта: не показывать декоративных пустых блоков).
    if (mastersWithoutSchedule.length === 0 && pendingRequests.length === 0) {
      if (scheduleEl) scheduleEl.innerHTML = '<p class="payroll-note">Всё в порядке - открытых алертов нет</p>';
      if (requestsEl) requestsEl.innerHTML = '';
      window.updateNotifBadge?.();
      return;
    }

    if (scheduleEl) {
      scheduleEl.innerHTML = mastersWithoutSchedule
        .map(
          (m) => `<div class="break-row">
            <span class="note" style="font-style:normal;color:var(--text)">⚠ У мастера ${escapeHtml(m.name)} нет рабочего графика - клиенты не могут записаться</span>
            <button class="btn btn-ghost btn-sm" type="button" data-open-schedule-tab>Настроить график</button>
          </div>`
        )
        .join('');
      scheduleEl.querySelectorAll('[data-open-schedule-tab]').forEach((btn) => {
        btn.addEventListener('click', () => goToTab('team'));
      });
    }

    if (requestsEl) {
      requestsEl.innerHTML = pendingRequests
        .map((r) => {
          const label = CATEGORY_LABEL[r.category] ?? (r.requestType === 'day_off' ? 'Выходной' : 'Перерыв');
          const master = r.masterName || r.masterId;
          return `<div class="break-row">
            <span class="note" style="font-style:normal;color:var(--text)">📋 ${escapeHtml(master)} · ${escapeHtml(label)} · ${escapeHtml(periodOf(r))} - на рассмотрении</span>
            <button class="btn btn-ghost btn-sm" type="button" data-open-requests-tab>Открыть</button>
          </div>`;
        })
        .join('');
      requestsEl.querySelectorAll('[data-open-requests-tab]').forEach((btn) => {
        btn.addEventListener('click', () => scrollToRequestsHistory());
      });
    }

    // Список только что перерисован - счётчик на колокольчике (assets/mockup-crm.js)
    // должен увидеть реальные числа, тот же приём, что уже применяет renderRiskList
    // (assets/crm-clients.js).
    window.updateNotifBadge?.();
  } catch (err) {
    const msg = `<p class="payroll-note">Не удалось загрузить: ${escapeHtml(err.message)}</p>`;
    if (scheduleEl) scheduleEl.innerHTML = msg;
    if (requestsEl) requestsEl.innerHTML = '';
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
