// Окно 39 (06.08.2026, Задача 2 - только crm-owner.html в первой итерации). Список
// "требует внимания" (GET /clients?risk=true) заменяет статичный декоративный пример
// "3 клиента не приходили 3+ месяца" (Клиент Ж/З/И, PRODUCT_AUDIT_REPORT.md,
// "Бизнес-проблемы"), карточка клиента (GET /clients/:id) - историю визитов и
// индикатор риска. Честная оговорка промпта: requiresPrepayment ничего не блокирует
// технически - весь текст риска приходит с сервера (risk.label, server.mjs
// describeClientRisk) уже в форме "стоит позвонить", фронт его не сочиняет и не
// подаёт как "клиент заблокирован".
//
// Окно 42 (07.08.2026, ПРОМПТ-ОКНО-42-ДЕМОНТАЖ-СЕГОДНЯ.md): у списка больше нет
// экрана на crm-owner.html (раздел "Клиенты" - Окно 48, пока заглушка) - решение
// Влада не городить временный дом ради одного списка. Ни #raList, ни счётчика
// #riskClientsBadge на странице сейчас нет (правка 07.08.2026 - колокольчик риск-
// клиентов объединён с колокольчиком уведомлений, assets/crm-notifications.js
// считает риск-клиентов отдельным fetch'ем для общего бейджа) - renderRiskList()
// ниже сразу выходит по guard'у и ничего не делает на этой странице, сам модуль не
// удалён и вернётся к полноценному рендеру, когда появится раздел "Клиенты".
import { fetchJson } from './crm-auth.js';
import { errorMessage, showError } from './crm-toast.js';
import { showSkeleton, showSpinner } from './crm-loading.js';

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

// Названия статусов - те же, что в карточке записи (13.08.2026: "Пришёл" стал
// "Обслужен" - done значит завершённую сделку, а не просто явку), только строчными:
// здесь они идут внутри строки визита, не отдельным контролом.
const STATUS_LABEL = { planned: 'ожидается', done: 'обслужен', cancelled: 'отменена', no_show: 'не пришёл' };

// Окно 45 (08.08.2026) - экспортирован для кнопки мягкого обновления (вызывать
// именно эту функцию, не wireClientsRisk() заново - та навесила бы обработчик
// на #clientCardClose второй раз).
export async function renderRiskList() {
  const list = el('raList');
  const badge = el('riskClientsBadge');
  // Ни списка (страница без раздела "Клиенты"), ни бейджа (страница без этого
  // колокольчика вообще) - нечего обновлять, тихо выходим (тот же no-op паттерн,
  // что и у wireNotifications, assets/crm-notifications.js).
  if (!list && !badge) return;
  try {
    const clients = await fetchJson('/clients?risk=true');
    if (badge) badge.textContent = String(clients.length);
    if (list) {
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
    }
  } catch (err) {
    if (list) list.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(err, 'Не удалось загрузить список клиентов'))}</p>`;
    showError(errorMessage(err, 'Не удалось загрузить список клиентов'));
  }
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
  showSpinner(nameEl, 'Загружаю карточку клиента');
  phoneEl.textContent = '';
  riskEl.hidden = true;
  rebookBtn.hidden = true;
  showSkeleton(visitsEl, 3);

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
          // Комментарий сотрудника к визиту (13.08.2026, миграция 048) - "почему сумма
          // отличалась от прайса". Именно история клиента - место, где это читают
          // спустя месяцы, поэтому строка идёт прямо под визитом. Мастеру поле не
          // приходит вовсе (shapeClientCardForViewer), у него строки просто не будет.
          const comment = v.staffComment
            ? `<span class="visit-comment">💬 ${escapeHtml(v.staffComment)}</span>`
            : '';
          return `<div class="break-row"><span>${formatVisitDate(v.date)} ${escapeHtml(v.startTime)}</span><span class="note">${services} · ${escapeHtml(v.masterName || '')} · ${STATUS_LABEL[v.status] || escapeHtml(v.status)}${comment}</span></div>`;
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
    nameEl.textContent = 'Карточка не открылась';
    visitsEl.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить карточку клиента'))}</span>`;
    showError(errorMessage(err, 'Не удалось загрузить карточку клиента'));
  }
}
