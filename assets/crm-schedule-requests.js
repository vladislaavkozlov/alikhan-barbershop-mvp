// Окно 23 (04.08.2026, Задача 2) - история заявок мастеров на изменение графика в
// кабинете ВЛАДЕЛЬЦА, с отменой уже одобренного отгула/отпуска целиком.
//
// Почему новый файл, а не правка существующего экрана: на момент этого окна у
// владельца истории заявок не было вообще - живой grep показал, что разметка
// `crm-owner.html` слова `schedule-requests` не содержит, а единственное место, где
// владелец видит заявку, это колокольчик уведомлений (`assets/crm-notifications.js`,
// кнопки "Одобрить"/"Отклонить" на уведомлении типа schedule_request_new). После
// одобрения уведомление помечается прочитанным, и заявка больше не всплывает нигде -
// отменять было буквально не с чего. Список `#reqHistory` из `assets/crm-auth.js` -
// это история МАСТЕРА про самого себя (crm-master.html), не владельца.
// ТЗ Окна 23 исходило из того, что история владельца уже есть - фактически её
// пришлось создать, зона правки от этого не изменилась (crm-owner.html + свой модуль).
//
// Файл сознательно не трогает `assets/crm-auth.js` (зона Окна 27),
// `assets/crm-schedule-views.js` и `assets/crm-calendar.js` (зона Окна 25) - только
// импортирует из crm-auth.js уже экспортированные хелперы fetchJson/apiSend, как это
// делает и crm-schedule-views.js.
import { fetchJson, apiSend } from './crm-auth.js';

const CATEGORY_LABEL = { otgul: 'Отгул разовый', otpusk: 'Отпуск', grafik_standard: 'Постоянный график' };
const STATUS_LABEL = {
  pending: 'На рассмотрении',
  approved: 'Одобрено',
  rejected: 'Отклонено',
  cancelled: 'Одобрение отменено',
};

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function periodOf(r) {
  if (r.category === 'grafik_standard') return 'весь недельный график';
  if (r.requestType === 'day_off') return r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} – ${r.dateTo}`;
  return `${r.dateFrom} ${r.startTime}–${r.endTime}`;
}

// Отменять имеет смысл только действующее разовое исключение на даты. Одобренный
// ПОСТОЯННЫЙ график (grafik_standard) сюда не попадает намеренно: его одобрение
// заменило master_weekly_schedule целиком, прежний график нигде не сохранён, и
// сервер на такую попытку честно отвечает 409 cannot_cancel_weekly.
function isCancellable(r) {
  return r.status === 'approved' && r.category !== 'grafik_standard' && r.requestType !== 'weekly_schedule';
}

export function initOwnerScheduleRequests() {
  const listEl = el('ownerReqList');
  if (!listEl) return; // страница без этого блока - модуль просто молчит

  let masterNameById = new Map();

  async function loadMasters() {
    try {
      const staff = await fetchJson('/staff');
      masterNameById = new Map(staff.map((s) => [s.id, s.name]));
    } catch {
      // имя мастера - украшение строки, без него список всё равно рабочий
    }
  }

  const STATUS_BADGE_CLASS = {
    pending: 'badge-status-pending',
    approved: 'badge-on',
    rejected: 'badge-status-rejected',
    cancelled: 'badge-off',
  };

  function rowHtml(r) {
    const master = masterNameById.get(r.masterId) ?? r.masterId;
    const label = CATEGORY_LABEL[r.category] ?? (r.requestType === 'day_off' ? 'Выходной' : 'Перерыв');
    const status = STATUS_LABEL[r.status] ?? r.status;
    const statusClass = STATUS_BADGE_CLASS[r.status] ?? 'badge-off';
    const comment = r.masterComment ? `<p class="req-card-comment">«${escapeHtml(r.masterComment)}»</p>` : '';
    const action = isCancellable(r)
      ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel-req="${r.id}">Отменить</button>`
      : '';
    return `<article class="req-card" data-req-row="${r.id}">
        <div class="req-card-main">
          <div class="req-card-title">
            <strong>${escapeHtml(master)}</strong>
            <span class="badge ${statusClass}">${escapeHtml(status)}</span>
          </div>
          <p class="req-card-meta">${escapeHtml(label)} · ${escapeHtml(periodOf(r))}</p>
          ${comment}
        </div>
        <div class="req-card-action" data-action-slot="${r.id}">${action}</div>
      </article>`;
  }

  async function load() {
    listEl.innerHTML = '<span class="note">Загрузка…</span>';
    try {
      const rows = await fetchJson('/schedule-requests');
      if (!rows.length) {
        listEl.innerHTML = '<span class="note">Заявок от мастеров пока не было</span>';
        return;
      }
      listEl.innerHTML = rows.map(rowHtml).join('');
      wireCancelButtons();
    } catch (err) {
      listEl.innerHTML = `<span class="note">Не удалось загрузить: ${escapeHtml(err.message)}</span>`;
    }
  }

  // Подтверждение сделано двухшаговой заменой кнопки прямо в строке, а не нативным
  // window.confirm(): нативный диалог рисуется системой, а не темой сайта - ровно то,
  // из-за чего КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md запрещает нативные виджеты выбора
  // (Алихан заметил это на телефоне, 30.07.2026). Своего компонента-подтверждения в
  // проекте на момент этого окна не было - живой grep по assets/ показал ноль
  // вызовов confirm() и ни одного confirm-диалога, поэтому паттерн вводится здесь
  // минимальным: вопрос + "Да, отменить" / "Нет" в той же строке.
  function wireCancelButtons() {
    listEl.querySelectorAll('[data-cancel-req]').forEach((btn) => {
      btn.addEventListener('click', () => askConfirm(btn.dataset.cancelReq));
    });
  }

  function askConfirm(requestId) {
    const slot = listEl.querySelector(`[data-action-slot="${requestId}"]`);
    if (!slot) return;
    slot.innerHTML = `<span class="note" style="margin-right:8px">Снять блокировку со всех дат заявки?</span>
      <button class="btn btn-primary btn-sm" type="button" data-confirm-yes="${requestId}">Да, отменить</button>
      <button class="btn btn-ghost btn-sm" type="button" data-confirm-no="${requestId}">Нет</button>`;
    slot.querySelector('[data-confirm-yes]').addEventListener('click', () => doCancel(requestId, slot));
    slot.querySelector('[data-confirm-no]').addEventListener('click', () => {
      slot.innerHTML = `<button class="btn btn-ghost btn-sm" type="button" data-cancel-req="${requestId}">Отменить</button>`;
      slot.querySelector('[data-cancel-req]').addEventListener('click', () => askConfirm(requestId));
    });
  }

  async function doCancel(requestId, slot) {
    slot.innerHTML = '<span class="note">Отменяю…</span>';
    try {
      const { ok, status, data } = await apiSend(`/schedule-requests/${requestId}/cancel`, 'PATCH');
      if (!ok) {
        const reason =
          data?.error === 'cannot_cancel_weekly'
            ? 'постоянный график так не отменить - задайте новый в блоке «График работы»'
            : data?.error === 'not_approved'
              ? 'заявка уже не в статусе «Одобрено»'
              : `HTTP ${status}`;
        slot.innerHTML = `<span class="note">Не удалось: ${escapeHtml(reason)}</span>`;
        return;
      }
      // Перечитываем список СВЕЖИМ запросом, а не правим строку оптимистично - тот же
      // принцип, что у loadMonth() после правки дня (Окно 18): показываем то, что
      // реально лежит в базе, а не то, что мы ожидали туда записать.
      await load();
    } catch (err) {
      slot.innerHTML = `<span class="note">Не удалось: ${escapeHtml(err.message)}</span>`;
    }
  }

  el('ownerReqReload')?.addEventListener('click', load);

  // Блок живёт внутри #crmMain, который initCrmAuth (assets/crm-auth.js) держит
  // скрытым до успешного входа. Своего хука "пользователь вошёл" crm-auth.js не
  // отдаёт, а править его нельзя (зона Окна 27) - поэтому ждём снятия hidden
  // наблюдателем. Если страница уже открыта залогиненной (восстановленная сессия),
  // hidden снимается синхронно до этого места, поэтому проверяем и текущее состояние.
  const main = el('crmMain');
  if (!main) return;
  let started = false;
  function startOnce() {
    if (started || main.hidden) return;
    started = true;
    loadMasters().then(load);
  }
  new MutationObserver(startOnce).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  startOnce();
}
