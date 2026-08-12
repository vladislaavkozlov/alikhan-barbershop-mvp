function directPanels(list) {
  return [...list.querySelectorAll(':scope > details.staff-card')];
}

function syncToggle(button, panels) {
  const allOpen = panels.every((panel) => panel.open);
  const action = allOpen ? 'Свернуть все' : 'Развернуть все';
  button.querySelector('.panel-group-toggle__label').textContent = action;
  button.setAttribute('aria-label', action);
  button.setAttribute('aria-expanded', String(allOpen));
}

export function initCrmNavigationPanels(root = document) {
  root.querySelectorAll('.staff-list').forEach((list, index) => {
    const panels = directPanels(list);
    if (!panels.length || list.dataset.panelControlsWired) return;
    list.dataset.panelControlsWired = '1';

    const controls = document.createElement('div');
    controls.className = 'panel-group-controls';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-group-toggle';
    button.innerHTML = '<span class="panel-group-toggle__icon" aria-hidden="true"><i></i><i></i></span><span class="panel-group-toggle__label"></span>';
    button.setAttribute('aria-controls', list.id || `panel-group-${index + 1}`);
    if (!list.id) list.id = `panel-group-${index + 1}`;
    controls.append(button);
    list.before(controls);

    button.addEventListener('click', () => {
      const shouldOpen = !panels.every((panel) => panel.open);
      panels.forEach((panel) => { panel.open = shouldOpen; });
      syncToggle(button, panels);
    });
    panels.forEach((panel) => panel.addEventListener('toggle', () => syncToggle(button, panels)));
    syncToggle(button, panels);
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
