// Задача 5 (Окно 14, 02.08.2026) - уведомления в личном кабинете (мастера и
// владельца). Элемент интерфейса уже открытой страницы, НЕ системный push - поллинг
// раз в 45 сек, никакого Notification API/пермишен-промптов браузера (см.
// Ограничения промпта - настоящий push на закрытый браузер вне скоупа этого окна).
//
// Правка Влада 07.08.2026 - колокольчик "клиенты, которым стоит позвонить"
// (crm-clients.js, GET /clients?risk=true) объединён с этим (id="msgBell") в одну
// кнопку - раньше это были два разных колокольчика с разными обработчиками,
// теперь один, бейдж = сумма /notifications/unread-count + /clients?risk=true.
// Второй fetch сделан здесь напрямую (не импортом из crm-clients.js) - модуль уже
// no-op на страницах без #msgBell (admin/master), а risk-клиенты видны только
// владельцу, тянуть зависимость между модулями ради одного числа ни к чему.
import { goToSection } from './crm-app-shell.js';
import { ICON_BELL } from './crm-icons.js';
// Окно 55, Задача F (10.08.2026) - XSS в списке уведомлений. Заголовок и текст
// уведомления вставлялись в list.innerHTML сырыми, а часть из них строится из
// пользовательского ввода: booking_new несёт ИМЯ КЛИЕНТА (с Окна 14), а имя приходит
// из АНОНИМНОГО POST /bookings с публичного сайта. Подтверждено живым прогоном
// 10.08.2026 на эфемерной базе: clientName = '<img src=x onerror=alert(1)>'
// сохраняется (200), долетает до уведомления мастера и отдаётся GET /notifications
// дословно. Экранирование берём готовое из crm-schedule-shared.js - та же функция
// уже защищает пять других CRM-файлов, своей копии не заводим.
import { escapeHtml } from './crm-schedule-shared.js';
import { errorMessage, showError } from './crm-toast.js';
import { showSpinner, skeletonMarkup } from './crm-loading.js';

const TOKEN_KEY = 'alikhan-crm:token';
const API = window.ALIKHAN_API_URL;
const TYPE_ICON = {
  booking_new: '📅',
  booking_reminder_15: '⏰',
  booking_start: '▶️',
  schedule_request_new: '🗓',
  schedule_request_decided: '✅',
  master_lost_schedule: '⚠️',
  // Окно 55, Задача F - типы перенесённой записи (задеплоены на прод 10.08.2026,
  // Окно 54 Задача C). До этой правки показывался дефолтный 🔔, и "запись ушла" от
  // "запись пришла" на глаз не отличались. Стрелки направления, а не одна общая
  // иконка переноса: мастер в списке из десяти уведомлений должен видеть, потерял он
  // клиента или получил, не вчитываясь в текст.
  booking_moved_out: '📤',
  booking_moved_in: '📥',
};

// Окно 35 (06.08.2026) - клик по уведомлению "у мастера пропал график" ведёт прямым
// действием к его карточке в разделе "Команда" (Окно 41 - переведено с прямого
// radio pt-b.checked=true на общий роутер goToSection('team'), на страницах без shell
// (admin/master) goToSection() безопасно ничего не делает, как и раньше). Карточки
// мастеров сейчас статичный HTML с id="staffCard-<masterId>" (id мастера в БД
// буквально совпадает с мокап-разметкой - master-1/master-2/master-3, см.
// api/migrations/002_schema.sql) - открываем <details> и скроллим к ней.
function openMasterCard(masterId) {
  goToSection('team');
  const card = document.getElementById(`staffCard-${masterId}`);
  if (!card) return;
  card.open = true;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw Object.assign(new Error(path), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(path), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
  return res.json();
}
async function apiPatch(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(path), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
  return res.json();
}

function timeAgo(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  return `${Math.round(diffH / 24)} дн назад`;
}

export function wireNotifications(staff) {
  const bell = document.getElementById('msgBell');
  const badge = document.getElementById('msgBellBadge');
  const panel = document.getElementById('msgPanel');
  const list = document.getElementById('msgList');
  if (!bell || !badge || !panel || !list) return; // страница без этого блока - no-op

  const iconEl = document.getElementById('msgBellIcon');
  if (iconEl) iconEl.innerHTML = ICON_BELL;

  // Риск-клиенты видны только владельцу (GET /clients?risk=true owner-only на
  // сервере) - на admin/master страницах этот fetch честно вернёт 401/пусто,
  // ловим отдельно, чтобы не гасить основной счётчик уведомлений при провале.
  async function riskClientsCount() {
    try {
      const clients = await apiGet('/clients?risk=true');
      return Array.isArray(clients) ? clients.length : 0;
    } catch {
      return 0;
    }
  }

  async function refreshBadge() {
    try {
      const [{ count }, riskCount] = await Promise.all([apiGet('/notifications/unread-count'), riskClientsCount()]);
      const total = count + riskCount;
      badge.textContent = total;
      badge.hidden = total === 0;
    } catch {
      // тихо - основной индикатор живой базы уже есть в liveProof выше на странице
    }
  }

  async function renderList() {
    list.innerHTML = `<div style="padding:10px">${skeletonMarkup(3)}</div>`;
    try {
      const items = await apiGet('/notifications');
      if (!items.length) {
        list.innerHTML = '<div class="note" style="padding:10px">Уведомлений нет</div>';
        return;
      }
      list.innerHTML = items
        .map((n) => {
          const actions =
            n.type === 'schedule_request_new' && ['owner', 'manager'].includes(staff.role) && n.scheduleRequestId
              ? `<div class="msg-actions">
                   <button class="btn-ghost btn-sm" type="button" data-decide="approved" data-req="${n.scheduleRequestId}" data-ntf="${n.id}">Одобрить</button>
                   <button class="btn-ghost btn-sm" type="button" data-decide="rejected" data-req="${n.scheduleRequestId}" data-ntf="${n.id}">Отклонить</button>
                 </div>`
              : '';
          return `<div class="msg-item${n.read ? '' : ' msg-item--unread'}" data-ntf-id="${n.id}" data-type="${n.type}" data-related-master-id="${n.relatedMasterId ?? ''}">
              <span class="msg-ico">${TYPE_ICON[n.type] ?? '🔔'}</span>
              <div class="msg-body">
                <div class="msg-title">${escapeHtml(n.title)}</div>
                ${n.body ? `<div class="msg-sub">${escapeHtml(n.body)}</div>` : ''}
                <div class="msg-time">${timeAgo(n.createdAt)}</div>
                ${actions}
              </div>
            </div>`;
        })
        .join('');

      list.querySelectorAll('.msg-item').forEach((item) => {
        item.addEventListener('click', async (e) => {
          if (e.target.closest('[data-decide]')) return; // клик по кнопке решения обрабатывается отдельно ниже
          const id = item.dataset.ntfId;
          if (item.classList.contains('msg-item--unread')) {
            item.classList.remove('msg-item--unread');
            try {
              await apiPost(`/notifications/${id}/read`);
              refreshBadge();
            } catch {
              /* бейдж просто не обновится досрочно, следующий поллинг поправит */
            }
          }
          // Окно 35 - "мастер без графика" ведёт прямым действием к его карточке,
          // не просто отмечает уведомление прочитанным.
          if (item.dataset.type === 'master_lost_schedule' && item.dataset.relatedMasterId) {
            panel.classList.remove('open');
            openMasterCard(item.dataset.relatedMasterId);
          }
        });
      });

      list.querySelectorAll('[data-decide]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const requestId = btn.dataset.req;
          const decision = btn.dataset.decide;
          const ntfId = btn.dataset.ntf;
          // Решение по заявке уезжает не мгновенно - на месте кнопок крутится тот же
          // индикатор, что и везде в CRM, вместо прежней надписи «Сохраняю…»
          showSpinner(btn.closest('.msg-actions'), 'Сохраняю решение');
          try {
            await apiPatch(`/schedule-requests/${requestId}/decision`, { decision });
            await apiPost(`/notifications/${ntfId}/read`);
            renderList();
            refreshBadge();
          } catch (err) {
            btn.closest('.msg-actions').textContent = errorMessage(err, 'Не удалось выполнить действие');
            showError(errorMessage(err, 'Не удалось выполнить действие по уведомлению'));
          }
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="note" style="padding:10px"></div>';
      list.querySelector('.note').textContent = errorMessage(err, 'Не удалось загрузить уведомления');
      showError(errorMessage(err, 'Не удалось загрузить уведомления'));
    }
  }

  bell.addEventListener('click', () => {
    const opening = !panel.classList.contains('open');
    document.querySelectorAll('.msg-panel.open').forEach((p) => p.classList.remove('open'));
    if (opening) {
      panel.classList.add('open');
      renderList();
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !bell.contains(e.target)) panel.classList.remove('open');
  });

  refreshBadge();
  window.__refreshNotifications = refreshBadge;
  setInterval(refreshBadge, 45 * 1000);
}
