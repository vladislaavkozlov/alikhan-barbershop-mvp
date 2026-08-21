function directPanels(list) {
  return [...list.querySelectorAll(':scope > details.staff-card')];
}

// «Развернуть все» - значит ВСЕ, включая карточки, вложенные в карточку (21.08.2026,
// вторая правка Влада). Единственный такой случай сегодня - «Финансы»: блок «Зарплаты
// мастеров» сам карточка, а внутри него список карточек сотрудников. До этой правки
// кнопка трогала только два блока верхнего уровня, и человек, нажав «развернуть все»,
// получал раскрытый блок с колонкой всё ещё закрытых карточек - выглядело так, будто
// кнопка сработала наполовину. Там, где вложенных карточек нет («Команда»,
// «Расписание», «Аналитика»), выборка совпадает с прежней и поведение не меняется
function allPanels(list) {
  return [...list.querySelectorAll('details.staff-card')];
}

function syncToggle(button, list) {
  const panels = allPanels(list);
  const allOpen = panels.length > 0 && panels.every((panel) => panel.open);
  const action = allOpen ? 'Свернуть все' : 'Развернуть все';
  button.querySelector('.panel-group-toggle__label').textContent = action;
  button.setAttribute('aria-label', action);
  button.setAttribute('aria-expanded', String(allOpen));
}

export function initCrmNavigationPanels(root = document) {
  const doc = root.ownerDocument || root;
  root.querySelectorAll('.staff-list').forEach((list, index) => {
    const panels = directPanels(list);
    // Список карточек ВНУТРИ карточки своей кнопки не получает: .panel-group-controls
    // висит position:fixed в одном и том же углу экрана, две кнопки просто легли бы
    // одна на другую, и человек нажимал бы верхнюю наугад. Вложенным списком управляет
    // кнопка внешнего раздела (см. allPanels выше)
    if (list.parentElement?.closest('.staff-list')) return;
    if (!panels.length || list.dataset.panelControlsWired) return;
    list.dataset.panelControlsWired = '1';

    const controls = doc.createElement('div');
    controls.className = 'panel-group-controls';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'panel-group-toggle';
    button.innerHTML = '<span class="panel-group-toggle__icon" aria-hidden="true"><i></i><i></i></span><span class="panel-group-toggle__label"></span>';
    button.setAttribute('aria-controls', list.id || `panel-group-${index + 1}`);
    if (!list.id) list.id = `panel-group-${index + 1}`;
    controls.append(button);
    list.before(controls);

    button.addEventListener('click', () => {
      const currentPanels = allPanels(list);
      const shouldOpen = !currentPanels.every((panel) => panel.open);
      currentPanels.forEach((panel) => { panel.open = shouldOpen; });
      syncToggle(button, list);
    });
    list.addEventListener('toggle', () => syncToggle(button, list), true);
    syncToggle(button, list);
  });
}

export function upgradeScheduleViews(views, root = document) {
  const legacy = root.querySelector('.panel-a .seg-tabs');
  if (!legacy || root.getElementById('scheduleCard-day')) return;

  const list = document.createElement('div');
  list.className = 'staff-list schedule-view-cards';
  for (const view of views) {
    const radio = root.getElementById(`sp-${view}`);
    const panel = legacy.querySelector(`.panel-sp-${view}`);
    if (!radio || !panel) continue;
    radio.hidden = true;
    legacy.before(radio);
    const details = document.createElement('details');
    details.className = 'staff-card schedule-view-card';
    details.id = `scheduleCard-${view}`;
    const title = { day: 'День', week: 'Неделя', month: 'Месяц' }[view];
    const subtitle = view === 'day' ? '' : `<div class="role" id="scheduleAnchor-${view}"></div>`;
    details.innerHTML = `<summary><div class="avatar-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.2"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8" y1="3" x2="8" y2="6.5"/><line x1="16" y1="3" x2="16" y2="6.5"/></svg></div><div class="summary-meta"><div class="name">${title}</div>${subtitle}</div><span class="chevron">▸</span></summary>`;
    const body = document.createElement('div');
    body.className = 'staff-card-body';
    body.append(panel);
    details.append(body);
    list.append(details);
  }
  legacy.replaceWith(list);
}

// Кабинет мастера (13.08.2026): та же карточка-обёртка, что у "День"/"Неделя"/
// "Месяц" рядом, но для read-only панели визита (assets/crm-master-booking.js).
// Отдельно от upgradeBookingPanel ниже, потому что там форма СОЗДАНИЯ записи: своя
// иконка "+", подпись "Добавить клиента в расписание" и открытие пустой формы по
// развороту карточки (openManualBooking) - мастеру не подходит ничего из этого.
export function upgradeMasterBookingPanel(root = document) {
  const view = root.getElementById('masterBookingView');
  let list = root.querySelector('.panel-a .schedule-view-cards');
  if (!view || root.getElementById('scheduleCard-booking-view')) return;
  if (!list) {
    list = document.createElement('div');
    list.className = 'staff-list schedule-booking-card';
    view.before(list);
  }
  const details = document.createElement('details');
  details.className = 'staff-card schedule-view-card booking-view-card';
  details.id = 'scheduleCard-booking-view';
  details.innerHTML = `<summary><div class="avatar-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.2"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><path d="M8.5 14h7"/></svg></div><div class="summary-meta"><div class="name">Запись</div><div class="role">Детали выбранного визита</div></div><span class="chevron">▸</span></summary>`;
  const body = document.createElement('div');
  body.className = 'staff-card-body';
  body.append(view);
  details.append(body);
  list.append(details);
}

export function upgradeBookingPanel(root = document) {
  const form = root.getElementById('walkinForm');
  let list = root.querySelector('.panel-a .schedule-view-cards');
  if (!form || root.getElementById('scheduleCard-booking')) return;
  if (!list) {
    list = document.createElement('div');
    list.className = 'staff-list schedule-booking-card';
    const legacy = root.querySelector('.panel-a .seg-tabs');
    legacy?.before(list);
  }
  const details = document.createElement('details');
  details.className = 'staff-card schedule-view-card booking-create-card';
  details.id = 'scheduleCard-booking';
  details.innerHTML = `<summary><div class="avatar-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></div><div class="summary-meta"><div class="name">Запись</div><div class="role">Добавить клиента в расписание</div></div><span class="chevron">▸</span></summary>`;
  const body = document.createElement('div');
  body.className = 'staff-card-body';
  body.append(form);
  details.append(body);
  details.addEventListener('toggle', () => {
    if (!details.open) {
      form.hidden = true;
      return;
    }
    if (form.hidden) window.openManualBooking?.();
  });
  list.append(details);
}
