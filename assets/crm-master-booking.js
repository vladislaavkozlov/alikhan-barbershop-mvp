// Панель открытой записи в кабинете мастера (13.08.2026, вторая итерация по правкам
// Влада). Мастер запись НЕ ведёт: не создаёт, не переносит, не удаляет, не правит
// состав услуг и не выставляет статус - всё это делает администратор. Значит и
// интерфейс у него не форма, а карточка визита на просмотр: время, клиент, что
// делаем, сколько это стоит по прайсу.
//
// Почему отдельный модуль, а не режим общей формы (первая итерация была именно ею):
// от формы после снятия всех операций не осталось ничего, кроме разметки - ни одного
// общего обработчика, зато оставалась вся её ролевая обвязка (чекбоксы, submit,
// поиск клиента, дропдаун мастера), которую пришлось бы гасить условиями. Read-only
// панель на 100 строк честнее и не тянет за собой ничего из crm-walkin.js.
import { el, formatMoney, masterCommissionLabel } from './crm-shared.js';
import { escapeHtml } from './crm-schedule-shared.js';
import { sortByServiceOrder } from '../storage.js';

// Статус визита мастер видит, но не меняет: "Ожидание" до визита, "Обслужен" по
// факту завершённой сделки, "Не пришёл" ставит администратор (решение Влада
// 13.08.2026). Отмена - тоже не его. Названия те же, что в карточке записи у
// владельца и админа (crm-owner.html/crm-admin.html) - один статус не может
// называться на двух страницах по-разному.
const STATUS_LABEL = {
  planned: 'Ожидание',
  done: 'Обслужен',
  no_show: 'Не пришёл',
  cancelled: 'Отменена',
};

// Услуги записи - именно те, что в ней сохранены, а не весь прайс мастера: выбирать
// ему нечего. Имя и цену берём из его master_services (у мастеров прайс разный),
// общий /services - страховка на случай пары, которую не завели.
function serviceRows(serviceIds, masterId, services, masterServices) {
  // Единый порядок показа услуг (storage.js SERVICE_ORDER) - состав записи в
  // карточке мастера читается так же, как список в форме записи
  return sortByServiceOrder(serviceIds, (id) => id).map((serviceId) => {
    const own = masterServices.find((r) => r.masterId === masterId && r.serviceId === serviceId);
    const base = services.find((s) => s.id === serviceId);
    return {
      id: serviceId,
      name: base?.name ?? serviceId,
      price: own?.price ?? base?.price ?? null,
      durationMin: own?.durationMin ?? base?.durationMin ?? null,
    };
  });
}

export function wireMasterBookingView(staff, services, masterServices, pctOf = null) {
  const panel = el('masterBookingView');
  if (!panel) return; // не страница мастера - тихий no-op, как у остальных wire-функций

  const card = panel.closest('details');
  const whenEl = el('mbWhen');
  const clientEl = el('mbClient');
  const statusEl = el('mbStatus');
  const servicesEl = el('mbServices');
  const totalEl = el('mbTotal');
  const commissionRow = el('mbCommissionRow');
  const commissionEl = el('mbCommission');
  const commissionNoteEl = el('mbCommissionNote');
  const emptyEl = el('mbEmpty');

  // Календарь рисует карточки записей строкой HTML с onclick= (HTML-атрибут резолвится
  // только через window - то же ограничение, что у виджетов даты). Регистрируем ту же
  // точку входа, что и общая форма у владельца с админом: buildApptCard зовёт
  // window.openBookingEdit, если она есть.
  window.openBookingEdit = (node) => {
    const d = node.dataset;
    document.querySelectorAll('.appt--selected').forEach((n) => {
      if (n !== node) n.classList.remove('appt--selected');
    });
    node.classList.add('appt--selected');

    const serviceIds = (d.serviceIds || '').split(',').filter(Boolean);
    const rows = serviceRows(serviceIds, d.masterId, services, masterServices);
    const priced = rows.filter((r) => r.price != null);
    const total = priced.length ? priced.reduce((sum, r) => sum + r.price, 0) : null;
    const totalMin = rows.filter((r) => r.durationMin != null).reduce((sum, r) => sum + r.durationMin, 0);

    if (whenEl) whenEl.textContent = d.planned || '';
    if (clientEl) clientEl.textContent = d.client || 'Без имени';
    if (statusEl) {
      const status = d.realStatus || 'planned';
      statusEl.textContent = STATUS_LABEL[status] ?? status;
      statusEl.className = `mb-status mb-status--${status}`;
    }
    if (servicesEl) {
      servicesEl.innerHTML = rows.length
        ? rows.map((r) => `<li><span class="mb-service-name">${escapeHtml(r.name)}</span><span class="mb-service-meta">${r.price == null ? '' : escapeHtml(formatMoney(r.price))}${r.durationMin == null ? '' : ` · ${r.durationMin} мин`}</span></li>`).join('')
        : '<li class="note">Услуги по этой записи не указаны</li>';
    }
    if (totalEl) {
      totalEl.textContent = total == null
        ? ''
        : `Итого ${totalMin ? `${totalMin} мин · ` : ''}${formatMoney(total)}`;
    }

    // Комиссия. Фактическую сумму визита вписывает администратор (PATCH
    // /bookings/:id/actual-price, мастеру закрыто) - если она уже стоит, комиссия
    // считается ОТ НЕЁ и это факт. Пока не вписана - считаем по прайсу и честно
    // помечаем "предварительно", чтобы цифра не выглядела окончательной.
    if (commissionRow && commissionEl) {
      const actual = d.actualPrice ? Number(d.actualPrice) : null;
      const base = Number.isFinite(actual) ? actual : total;
      const { amount, text } = masterCommissionLabel({
        total: base,
        pct: pctOf ? pctOf(d.masterId) : null,
        isOwner: staff.role === 'owner',
      });
      commissionRow.hidden = false;
      commissionEl.textContent = amount == null ? '—' : formatMoney(amount);
      if (commissionNoteEl) {
        commissionNoteEl.textContent = amount == null || Number.isFinite(actual)
          ? text
          : `${text} - предварительно, по прайсу. Итог считается от суммы, которую проведёт администратор`;
      }
    }

    if (emptyEl) emptyEl.hidden = true;
    panel.hidden = false;
    if (card && !card.open) card.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}
