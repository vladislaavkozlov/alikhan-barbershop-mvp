// Окно 39 (06.08.2026, Задача 2 - только crm-owner.html в первой итерации). Список
// "требует внимания" (GET /clients?risk=true) заменяет статичный декоративный пример
// "3 клиента не приходили 3+ месяца" (Клиент Ж/З/И, PRODUCT_AUDIT_REPORT.md,
// "Бизнес-проблемы"), карточка клиента (GET /clients/:id) - историю визитов и
// индикатор риска. Честная оговорка промпта: requiresPrepayment ничего не блокирует
// технически - весь текст риска приходит с сервера (risk.label, server.mjs
// describeClientRisk) уже в форме "стоит позвонить", фронт его не сочиняет и не
// подаёт как "клиент заблокирован".
import { fetchJson } from './crm-auth.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function el(id) {
  return document.getElementById(id);
}

function formatVisitDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

const STATUS_LABEL = { planned: 'ожидается', done: 'пришёл', cancelled: 'отменена', no_show: 'не пришёл' };

async function renderRiskList() {
  const list = el('raList');
  if (!list) return;
  try {
    const clients = await fetchJson('/clients?risk=true');
    if (clients.length === 0) {
      list.innerHTML = '<p class="payroll-note">Нет клиентов, которым сейчас стоит позвонить</p>';
    } else {
      list.innerHTML = clients
        .map(
          (c) => `<div class="ra-row">
            <span class="ra-name">${escapeHtml(c.name || 'Без имени')}</span>
            <span class="ra-last">${escapeHtml(c.risk.label || '')}</span>
            ${c.phone ? `<a class="btn btn-ghost btn-sm" href="tel:${escapeHtml(c.phone)}">Позвонить</a>` : ''}
            <button class="btn btn-ghost btn-sm" type="button" data-open-client-id="${escapeHtml(c.id)}">Открыть карточку</button>
            <button class="ra-dismiss" type="button" title="Скрыть из списка на эту сессию" onclick="dismissRetentionRow(this)">✕</button>
          </div>`
        )
        .join('');
      list.querySelectorAll('[data-open-client-id]').forEach((btn) => {
        btn.addEventListener('click', () => openClientCard(btn.dataset.openClientId));
      });
    }
  } catch (err) {
    list.innerHTML = `<p class="payroll-note">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
  }
  // .ra-row только что перерисованы - счётчик на колокольчике (assets/mockup-crm.js)
  // должен увидеть реальное число, не оставшееся от предыдущей загрузки/примера.
  window.updateNotifBadge?.();
}

export function wireClientsRisk() {
  const closeBtn = el('clientCardClose');
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', () => {
      el('clientCardModal').hidden = true;
    });
  }

  // #crmMain остаётся hidden (initCrmAuth, assets/crm-auth.js) до успешного входа -
  // токена ещё нет, ранний fetchJson('/clients?risk=true') получил бы 401. Тот же
  // приём, что уже применён в assets/crm-schedule-requests.js (initOwnerScheduleRequests):
  // своего хука "пользователь вошёл" crm-auth.js не отдаёт, поэтому ждём снятия
  // hidden наблюдателем. Восстановленная сессия снимает hidden синхронно раньше
  // этой точки - startOnce() проверяет и текущее состояние.
  const main = el('crmMain');
  if (!main) return;
  let started = false;
  function startOnce() {
    if (started || main.hidden) return;
    started = true;
    renderRiskList();
  }
  new MutationObserver(startOnce).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  startOnce();
}

export async function openClientCard(clientId) {
  const modal = el('clientCardModal');
  const nameEl = el('clientCardName');
  const phoneEl = el('clientCardPhone');
  const riskEl = el('clientCardRisk');
  const rebookBtn = el('clientCardRebook');
  const visitsEl = el('clientCardVisits');
  if (!modal || !nameEl || !phoneEl || !riskEl || !rebookBtn || !visitsEl) return;

  modal.hidden = false;
  nameEl.textContent = 'Загрузка…';
  phoneEl.textContent = '';
  riskEl.hidden = true;
  rebookBtn.hidden = true;
  visitsEl.innerHTML = '<span class="note">Загрузка…</span>';

  try {
    const card = await fetchJson(`/clients/${encodeURIComponent(clientId)}`);
    nameEl.textContent = card.name || 'Без имени';
    phoneEl.textContent = card.phone || '';
    if (card.risk?.label) {
      riskEl.hidden = false;
      riskEl.textContent = card.risk.label;
    }
    if (card.visits.length === 0) {
      visitsEl.innerHTML = '<span class="note">Визитов пока не было</span>';
    } else {
      visitsEl.innerHTML = card.visits
        .map((v) => {
          const services = v.services.map((s) => escapeHtml(s.name)).join(', ') || '—';
          return `<div class="break-row"><span>${formatVisitDate(v.date)} ${escapeHtml(v.startTime)}</span><span class="note">${services} · ${escapeHtml(v.masterName || '')} · ${STATUS_LABEL[v.status] || escapeHtml(v.status)}</span></div>`;
        })
        .join('');
    }
    // "Записать снова" - только если есть история (мастера/услуги брать неоткуда) и
    // страница умеет открыть форму записи в режиме будущей брони (window.openRebookBooking,
    // выставляет assets/crm-auth.js wireWalkIn только когда на странице есть
    // wfModeLabel/wfDateTimeRow - пока только crm-owner.html, это Задача 2 промпта).
    if (card.lastVisit && typeof window.openRebookBooking === 'function') {
      rebookBtn.hidden = false;
      rebookBtn.onclick = () => {
        modal.hidden = true;
        window.openRebookBooking(
          card.lastVisit.masterId,
          card.lastVisit.masterName || '',
          card.name,
          card.phone,
          card.lastVisit.services.map((s) => s.id)
        );
      };
    }
  } catch (err) {
    nameEl.textContent = 'Ошибка загрузки';
    visitsEl.innerHTML = `<span class="note">${escapeHtml(err.message)}</span>`;
  }
}
