// Окно 40 (06.08.2026, Задача 2) - вкладка "Сегодня" (crm-owner.html): два новых
// списка алертов (мастера без графика, необработанные заявки) через
// GET /owner/alerts (computeOwnerAlerts, api/server.mjs). Выручка сегодня и клиенты
// в риске на этой же вкладке рендерятся уже существующими модулями без изменений
// (renderLiveProof заполняет #revenueTodayAmount, assets/crm-clients.js заполняет
// #raList) - этот файл их не трогает и не дублирует запрос.
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

// Прямое действие каждой строки - переключить раздел на то место, где эту
// проблему реально решают (график - "Команда", заявки - история в "Расписание"),
// не просто показать текст. Окно 41 - переведено с прямого radio.checked=true на
// общий роутер app shell (assets/crm-app-shell.js), сама панель не изменилась.
function goToTab(sectionId) {
  goToSection(sectionId);
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
        btn.addEventListener('click', () => goToTab('schedule'));
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

export function wireOwnerToday() {
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
