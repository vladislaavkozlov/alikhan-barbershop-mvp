// Задача 5 (Окно 14, 02.08.2026) - уведомления в личном кабинете (мастера и
// владельца). Элемент интерфейса уже открытой страницы, НЕ системный push - поллинг
// раз в 45 сек, никакого Notification API/пермишен-промптов браузера (см.
// Ограничения промпта - настоящий push на закрытый браузер вне скоупа этого окна).
// Отдельный колокольчик (id="msgBell") - НЕ тот же, что уже занят под "клиенты давно
// не приходили" (id="notif-bell"/notifRetentionPanel в crm-owner.html) - разная
// разметка/обработчики, чтобы не столкнуться.
const TOKEN_KEY = 'alikhan-crm:token';
const API = window.ALIKHAN_API_URL;
const TYPE_ICON = {
  booking_new: '📅',
  booking_reminder_15: '⏰',
  booking_start: '▶️',
  schedule_request_new: '🗓',
  schedule_request_decided: '✅',
  master_lost_schedule: '⚠️',
};

// Окно 35 (06.08.2026) - клик по уведомлению "у мастера пропал график" ведёт прямым
// действием к его карточке в разделе "Сотрудники" (вкладка pt-b, переключатель на
// чистом CSS radio - см. crm-owner.html), не просто показывает текст. Карточки
// мастеров сейчас статичный HTML с id="staffCard-<masterId>" (id мастера в БД
// буквально совпадает с мокап-разметкой - master-1/master-2/master-3, см.
// api/migrations/002_schema.sql) - открываем <details> и скроллим к ней.
function openMasterCard(masterId) {
  const tab = document.getElementById('pt-b');
  if (tab) tab.checked = true;
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
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
async function apiPatch(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
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

  async function refreshBadge() {
    try {
      const { count } = await apiGet('/notifications/unread-count');
      badge.textContent = count;
      badge.hidden = count === 0;
    } catch {
      // тихо - основной индикатор живой базы уже есть в liveProof выше на странице
    }
  }

  async function renderList() {
    list.innerHTML = '<div class="note" style="padding:10px">Загрузка…</div>';
    try {
      const items = await apiGet('/notifications');
      if (!items.length) {
        list.innerHTML = '<div class="note" style="padding:10px">Уведомлений нет</div>';
        return;
      }
      list.innerHTML = items
        .map((n) => {
          const actions =
            n.type === 'schedule_request_new' && staff.role === 'owner' && n.scheduleRequestId
              ? `<div class="msg-actions">
                   <button class="btn-ghost btn-sm" type="button" data-decide="approved" data-req="${n.scheduleRequestId}" data-ntf="${n.id}">Одобрить</button>
                   <button class="btn-ghost btn-sm" type="button" data-decide="rejected" data-req="${n.scheduleRequestId}" data-ntf="${n.id}">Отклонить</button>
                 </div>`
              : '';
          return `<div class="msg-item${n.read ? '' : ' msg-item--unread'}" data-ntf-id="${n.id}" data-type="${n.type}" data-related-master-id="${n.relatedMasterId ?? ''}">
              <span class="msg-ico">${TYPE_ICON[n.type] ?? '🔔'}</span>
              <div class="msg-body">
                <div class="msg-title">${n.title}</div>
                ${n.body ? `<div class="msg-sub">${n.body}</div>` : ''}
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
          btn.closest('.msg-actions').innerHTML = 'Сохраняю…';
          try {
            await apiPatch(`/schedule-requests/${requestId}/decision`, { decision });
            await apiPost(`/notifications/${ntfId}/read`);
            renderList();
            refreshBadge();
          } catch (err) {
            btn.closest('.msg-actions').innerHTML = `Не удалось: ${err.message}`;
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="note" style="padding:10px">Не удалось загрузить: ${err.message}</div>`;
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
  setInterval(refreshBadge, 45 * 1000);
}
