import { API, apiSend, fetchJson, getToken } from './crm-auth.js';
import { mediaUrl } from '../storage.js';
import {
  ICON_ACCESS,
  ICON_ADD,
  ICON_DETAILS,
  ICON_PROFILE,
  ICON_PUBLIC,
  ICON_SCHEDULE,
  ICON_SERVICES,
  ICON_UPLOAD,
} from './crm-icons.js';
import { initCrmNavigationPanels } from './crm-navigation-panels.js';
import { renderMasterServiceEditor } from './crm-master-services.js';
import { wireWeeklyScheduleEditor } from './crm-schedule-editor.js';

const roleLabel = { owner: 'Владелец', manager: 'Управляющий', admin: 'Администратор', master: 'Мастер' };
const editableRoles = ['master', 'admin', 'manager'];
let lastCreatedCredentials = null;
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const section = (title, description, icon, content, modifier = '') => `<section class="team-editor-section${modifier ? ` ${modifier}` : ''}"><header class="team-section-head"><span class="team-section-icon" aria-hidden="true">${icon}</span><div><h3>${title}</h3><p>${description}</p></div></header>${content}</section>`;
const today = () => new Date().toISOString().slice(0, 10);

function toggleControl({ name, title, description, checked, disabled = false }) {
  return `<label class="toggle-row team-toggle-row"><span><span class="tr-label">${title}</span><span class="tr-sub">${description}</span></span><span class="switch"><input name="${name}" type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="track"></span><span class="knob"></span></span></label>`;
}

function locationControl(staff, locations) {
  if (locations.length < 2) return `<input type="hidden" name="locationId" value="${esc(staff.locationId ?? locations[0]?.id ?? '')}">`;
  return `<div class="field"><label>Точка работы</label><select name="locationId">${locations.map((location) => `<option value="${esc(location.id)}" ${String(location.id) === String(staff.locationId) ? 'selected' : ''}>${esc(location.name)}</option>`).join('')}</select></div>`;
}

const roleDescription = {
  master: 'Свои записи и график',
  admin: 'Записи и клиенты своей точки',
  manager: 'Команда, график и финансы',
};

function rolePicker(selectedRole, name = 'role') {
  return `<fieldset class="team-role-picker" data-role><legend>Роль сотрудника</legend>${editableRoles.map((role) => `<label class="team-role-option"><input type="radio" name="${name}" value="${role}" ${selectedRole === role ? 'checked' : ''}><span><strong>${roleLabel[role]}</strong><small>${roleDescription[role]}</small></span></label>`).join('')}</fieldset>`;
}

function roleControl(staff, viewerRole) {
  if (staff.role === 'owner' || viewerRole !== 'owner') return `<div class="team-role-static"><span>Роль сотрудника</span><strong>${roleLabel[staff.role] ?? staff.role}</strong>${staff.role === 'owner' ? '<small>Защищённая учётная запись</small>' : ''}</div>`;
  return rolePicker(staff.role);
}

function mediaMarkup(staff) {
  const media = staff.media ?? [];
  // Снят с приёма - профиля на сайте нет в любом случае: /public/masters отбирает
  // только тех, кто оказывает услуги. Тумблер поэтому неактивен (состояние читается
  // по самому контролу, без текстовых пояснений - правка Влада 13.08.2026), своё
  // значение он сохраняет: вернут мастера на приём, витрина включится обратно сама.
  const offDuty = staff.providesServices === false;
  return `<div class="team-media-upload"><div><strong>Фото профиля</strong><small>Квадратное фото будет смотреться лучше</small></div><label class="team-file-action">${ICON_UPLOAD}<span>Выбрать фото</span><input class="team-file-native" name="avatar" type="file" accept="image/jpeg,image/png,image/webp"></label></div>
  <div class="team-editor-grid"><div class="field"><label>Стаж</label><input name="experience" value="${esc(staff.experienceText)}" placeholder="Например, 6 лет"></div><div class="field"><label>Сильные стороны</label><input name="strengths" value="${esc(staff.strengthsText)}" placeholder="Например, фейды и борода"></div></div>
  <div class="field"><label>Курсы и сертификаты</label><textarea name="certificates" placeholder="Название курса или сертификата">${esc(staff.certificatesText)}</textarea></div>
  <div class="team-media-upload"><div><strong>Портфолио</strong><small>До 20 фото в JPEG, PNG или WebP, каждое до 8 МБ</small></div><label class="team-file-action">${ICON_UPLOAD}<span>Добавить работы</span><input class="team-file-native" name="portfolio" type="file" multiple accept="image/jpeg,image/png,image/webp"></label></div>
  <div class="team-media-list" data-media-list data-staff-id="${esc(staff.id)}">${media.map((item) => mediaItem(item, media.filter((entry) => entry.kind === 'portfolio').findIndex((entry) => entry.id === item.id), media)).join('')}</div>
  ${toggleControl({ name: 'publicProfileEnabled', title: 'Показывать профиль на сайте', description: 'Профиль появится после настройки услуг и графика', checked: staff.publicProfileEnabled, disabled: offDuty })}`;
}

function mediaItem(media, index, all) {
  const name = media.kind === 'avatar' ? 'Основная' : `Работа ${index + 1}`;
  const move = media.kind === 'portfolio'
    ? `<div class="team-media-actions"><button type="button" data-media-left="${esc(media.id)}" aria-label="Переместить фотографию назад" ${index === 0 ? 'disabled' : ''}>Назад</button><button type="button" data-media-right="${esc(media.id)}" aria-label="Переместить фотографию вперёд" ${index === all.filter((item) => item.kind === 'portfolio').length - 1 ? 'disabled' : ''}>Вперёд</button></div>`
    : '';
  return `<figure class="team-media-item" data-media-id="${esc(media.id)}" data-media-kind="${esc(media.kind)}"><img src="${esc(mediaUrl(API, media.url))}" alt="${name}"><figcaption><span>${name}</span>${move}<button class="team-media-delete" type="button" data-media-delete="${esc(media.id)}" aria-label="Удалить ${name.toLowerCase()}">Удалить</button></figcaption></figure>`;
}

function staffCard(staff, viewerRole, locations, viewerId) {
  const id = esc(staff.id);
  const locked = viewerRole === 'manager' && staff.protectedOwner;
  // Рабочий статус нельзя снять с владельца и с самого себя (13.08.2026): выключенный
  // тумблер убирает человека с сайта и обрывает его сессии - для владельца это то же
  // самозапирание, от которого защищена его роль, для управляющего это способ случайно
  // выкинуть себя из CRM без пути назад. Бэкенд форсит это независимо от интерфейса
  // (guardAccountLockout), здесь тумблер просто не даёт нажать.
  const isSelf = viewerId != null && staff.id === viewerId;
  const employmentLocked = locked || staff.protectedOwner || isSelf;
  return `<details class="staff-card team-editor-card" data-staff-id="${id}" data-provides-services="${staff.providesServices ? '1' : '0'}" ${locked ? 'data-locked-owner' : ''}><summary><div class="avatar">${esc(staff.name).slice(0, 2)}</div><div class="summary-meta"><div class="name">${esc(staff.name)}</div><div class="role">${roleLabel[staff.role] ?? staff.role}</div></div><span class="chevron">▸</span></summary><div class="staff-card-body">
  ${section('Основное', 'Контакты и рабочий статус', ICON_DETAILS, `<div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" value="${esc(staff.name)}" ${locked ? 'disabled' : ''}></div><div class="field"><label>Телефон</label><input name="phone" value="${esc(staff.phone)}" ${locked ? 'disabled' : ''}></div><div class="field"><label>Email для входа</label><input name="email" type="email" value="${esc(staff.email)}" ${locked ? 'disabled' : ''}></div>${locationControl(staff, locations)}</div><div class="team-toggle-stack">${toggleControl({ name: 'employed', title: 'Работает в компании', description: 'Сотрудник остаётся в активном составе', checked: staff.employed, disabled: employmentLocked })}${toggleControl({ name: 'providesServices', title: 'Принимает клиентов', description: 'Можно назначить услуги и открыть запись', checked: staff.providesServices, disabled: locked })}</div>`)}
  ${section('Профиль на сайте', 'Фото и информация для клиентов', ICON_PUBLIC, mediaMarkup(staff))}
  ${section('Услуги и время', 'Выберите услуги и укажите длительность', ICON_SERVICES, `<div class="service-picker" data-master-id="${id}"><span class="note">Загружаю услуги…</span></div>`)}
  ${section('График', 'Рабочая неделя и разовые изменения', ICON_SCHEDULE, `<div id="weeklyEditor-${id}"><span class="note">Загружаю график…</span></div>${exceptionEditor(staff.id)}`)}
  ${/* Тумблер "Разрешить вход в CRM" убран 13.08.2026 по решению владельца: он дублировал
       "Работает в компании" в глазах салона и создавал риск случайно отрезать себе вход.
       Вход теперь есть у каждого, кто числится в составе; колонка has_system_access в схеме
       осталась и по-прежнему проверяется при входе, но через интерфейс не выключается. */''}
  ${section('Доступ', 'Роль сотрудника и её права', ICON_ACCESS, roleControl(staff, viewerRole))}
  <div class="team-editor-actions"><button class="btn btn-primary" type="button" data-save ${locked ? 'disabled' : ''}>Сохранить изменения</button><p class="payroll-note" data-card-note aria-live="polite"></p></div></div></details>`;
}

function exceptionEditor(staffId) {
  return `<div class="team-schedule-exception" data-schedule-exception data-staff-id="${esc(staffId)}"><div class="team-exception-head"><div><h4>Разовое изменение</h4><p>Добавьте выходной или отдельный перерыв, не меняя рабочую неделю</p></div></div><div class="team-editor-grid"><div class="field"><label>С даты</label><input name="dateFrom" type="date" min="${today()}"></div><div class="field"><label>По дату</label><input name="dateTo" type="date" min="${today()}"></div></div><fieldset class="team-exception-types"><legend>Тип изменения</legend><label><input type="radio" name="exceptionType" value="dayOff" checked><span><strong>Выходной</strong><small>Закрыть весь день</small></span></label><label><input type="radio" name="exceptionType" value="break"><span><strong>Перерыв</strong><small>Закрыть часть дня</small></span></label></fieldset><div class="team-break-fields" data-break-fields hidden><div class="field"><label>С</label><input name="breakStart" type="time" value="13:00"></div><div class="field"><label>До</label><input name="breakEnd" type="time" value="14:00"></div></div><button class="btn btn-ghost" type="button" data-exception-save>Добавить изменение</button><p class="payroll-note" data-exception-note aria-live="polite"></p><div class="team-exception-list" data-exception-list><span class="note">Загружаю изменения…</span></div></div>`;
}

function addCard(locations) {
  const empty = { locationId: locations[0]?.id ?? '' };
  const credentials = lastCreatedCredentials;
  return `<details class="staff-card team-add-card" ${credentials ? 'open' : ''}><summary><div class="avatar-icon" aria-hidden="true">${ICON_ADD}</div><div class="summary-meta"><div class="name">Добавить сотрудника</div><div class="role">Создать доступ в CRM</div></div><span class="chevron">▸</span></summary><div class="staff-card-body"><div class="team-add-intro"><span aria-hidden="true">${ICON_PROFILE}</span><div><h3>Новый сотрудник</h3><p>Заполните данные для первого входа. Профиль для сайта настроите после создания</p></div></div><div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" autocomplete="name"></div><div class="field"><label>Телефон</label><input name="phone" autocomplete="tel"></div><div class="field"><label>Email для входа</label><input name="email" type="email" autocomplete="email"></div>${locationControl(empty, locations)}</div>${rolePicker('master')}${toggleControl({ name: 'providesServices', title: 'Принимает клиентов', description: 'Услуги и график нужно настроить отдельно', checked: false })}<div class="team-editor-actions"><button class="btn btn-primary" type="button" data-create>Создать сотрудника</button><p class="payroll-note" data-card-note aria-live="polite"></p></div><div class="team-create-result" data-create-result ${credentials ? '' : 'hidden'}><strong>Данные для первого входа</strong><span>${credentials ? esc(credentials.name) : ''} сможет войти по email и временному PIN</span><code data-temporary-pin>${credentials ? esc(credentials.pin) : ''}</code><button class="btn btn-ghost btn-sm" type="button" data-copy-pin>Скопировать PIN</button></div></div></details>`;
}

function cardValue(card, name) {
  return card.querySelector(`[name="${name}"]:checked`) ?? card.querySelector(`[name="${name}"]`);
}
function showNote(host, text) {
  const selector = host.matches?.('[data-schedule-exception]') ? '[data-exception-note]' : '[data-card-note]';
  const note = host.querySelector(selector) ?? host.querySelector('.payroll-note');
  if (note) note.textContent = text;
}

async function saveCard(card) {
  const id = card.dataset.staffId;
  showNote(card, 'Сохраняю…');
  const value = (name) => cardValue(card, name);
  const providesServicesChanged = value('providesServices').checked !== (card.dataset.providesServices === '1');
  const main = await apiSend(`/staff/${encodeURIComponent(id)}`, 'PUT', {
    name: value('name').value,
    phone: value('phone').value,
    email: value('email').value,
    locationId: value('locationId')?.value || null,
    employed: value('employed').checked,
    providesServices: value('providesServices').checked,
    // hasSystemAccess намеренно не отправляется - тумблера больше нет, сервер
    // сохраняет текущее значение колонки (см. handleStaffUpdate)
  });
  if (!main.ok) return showNote(card, 'Не удалось сохранить. Повторите попытку');
  const profile = await apiSend(`/staff/${encodeURIComponent(id)}/portfolio`, 'PUT', {
    experienceText: value('experience').value.trim() || null,
    strengthsText: value('strengths').value.trim() || null,
    certificatesText: value('certificates').value.trim() || null,
    publicProfileEnabled: value('publicProfileEnabled').checked,
  });
  if (!profile.ok) return showNote(card, 'Основное сохранено, профиль не сохранился. Повторите попытку');
  const role = card.querySelector('[name="role"]:checked');
  if (role) {
    const roleResult = await apiSend(`/staff/${encodeURIComponent(id)}/role`, 'PUT', { role: role.value });
    if (!roleResult.ok) return showNote(card, 'Данные сохранены, но роль не изменилась. Повторите попытку');
  }
  showNote(card, 'Сохранено');
  // Смена "Принимает клиентов" перестраивает состав колонок в Расписании, а тот
  // список собирается один раз при инициализации страницы (mastersOf в
  // wireScheduleViews) - повторный renderTeam его не трогает, и снятый с приёма
  // мастер оставался бы в календаре кликабельным до ручного F5 (жалоба Влада
  // 13.08.2026). Полная перезагрузка вместо точечной перерисовки сознательно:
  // renderLiveProof повторно звать нельзя, он задваивает обработчики (см.
  // crm-dashboard.js), а смена этого флага - редкая операция, не ежедневная.
  if (providesServicesChanged) {
    showNote(card, 'Сохранено. Обновляю расписание…');
    window.location.reload();
    return;
  }
  await renderTeam();
}

function mediaForCard(card) { return [...card.querySelectorAll('.team-media-item')].map((item) => ({ id: item.dataset.mediaId, kind: item.dataset.mediaKind, url: item.querySelector('img').src })); }
function uploadFile(card, file, kind, onProgress) {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API}/staff/${encodeURIComponent(card.dataset.staffId)}/media?kind=${kind}`);
    request.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    request.setRequestHeader('Content-Type', file.type);
    request.upload.onprogress = (event) => onProgress(event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null);
    request.onerror = () => resolve({ ok: false });
    request.onload = () => {
      try { resolve({ ok: request.status >= 200 && request.status < 300, data: JSON.parse(request.responseText) }); } catch { resolve({ ok: false }); }
    };
    request.send(file);
  });
}

async function uploadMedia(card, input) {
  const files = [...input.files];
  if (!files.length) return;
  const note = card.querySelector('[data-card-note]');
  const kind = input.name === 'avatar' ? 'avatar' : 'portfolio';
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.size > 8 * 1024 * 1024) { note.textContent = `${file.name}: файл больше 8 МБ`; return; }
    const result = await uploadFile(card, file, kind, (percent) => { note.textContent = `Загружаю ${file.name}${percent == null ? '…' : `: ${percent}%`}`; });
    if (!result.ok) { note.textContent = `${file.name}: не удалось загрузить. Повторите попытку`; return; }
  }
  note.textContent = 'Фотографии загружены';
  await renderTeam();
}

async function reorderMedia(card, mediaId, direction) {
  const portfolio = mediaForCard(card).filter((item) => item.kind === 'portfolio');
  const index = portfolio.findIndex((item) => item.id === mediaId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= portfolio.length) return;
  [portfolio[index], portfolio[next]] = [portfolio[next], portfolio[index]];
  const result = await apiSend(`/staff/${encodeURIComponent(card.dataset.staffId)}/media/order`, 'PUT', { mediaIds: portfolio.map((item) => item.id) });
  if (!result.ok) return showNote(card, 'Не удалось изменить порядок. Повторите попытку');
  await renderTeam();
}

async function loadExceptions(root) {
  const id = root.dataset.staffId;
  const list = root.querySelector('[data-exception-list]');
  try {
    const shifts = await fetchJson(`/schedule?masterId=${encodeURIComponent(id)}`);
    const upcoming = shifts.filter((shift) => shift.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
    list.innerHTML = upcoming.length ? upcoming.map((shift) => {
      const isDayOff = shift.breaks?.some((item) => item.startTime === shift.startTime && item.endTime === shift.endTime);
      const label = isDayOff ? 'Выходной' : `Перерыв ${shift.breaks?.map((item) => `${item.startTime}-${item.endTime}`).join(', ') || 'без перерыва'}`;
      return `<div class="team-exception-item"><span>${esc(shift.date)} - ${esc(label)}</span><button type="button" data-exception-delete="${esc(shift.date)}">Удалить</button></div>`;
    }).join('') : '<span class="note">Нет запланированных изменений</span>';
  } catch { list.innerHTML = '<span class="note">Не удалось загрузить изменения. Повторите попытку</span>'; }
}

function rangeDates(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end && dates.length <= 31) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setDate(cursor.getDate() + 1); }
  return dates;
}

async function saveException(root) {
  const from = cardValue(root, 'dateFrom').value;
  const to = cardValue(root, 'dateTo').value || from;
  const note = root.querySelector('.payroll-note');
  if (!from || to < from) return showNote(root, 'Укажите корректную дату или диапазон');
  const dates = rangeDates(from, to);
  if (dates.length > 31) return showNote(root, 'Диапазон не может быть длиннее 31 дня');
  const type = cardValue(root, 'exceptionType').value;
  try {
    const result = await apiSend('/schedule-exceptions', 'POST', {
      masterId: root.dataset.staffId, dateFrom: from, dateTo: to, type,
      breakStart: cardValue(root, 'breakStart').value, breakEnd: cardValue(root, 'breakEnd').value,
    });
    if (!result.ok) { note.textContent = result.status === 409 ? 'Есть конфликт с записью. Данные перечитаны' : 'Не удалось сохранить. Проверьте время и повторите попытку'; await loadExceptions(root); return; }
    note.textContent = 'Разовое изменение сохранено';
    await loadExceptions(root);
  } catch {
    note.textContent = 'Не удалось сохранить. Повторите попытку';
  }
}

function wire(root) {
  root.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', () => saveCard(button.closest('[data-staff-id]'))));
  root.querySelectorAll('input[type=file]').forEach((input) => input.addEventListener('change', () => uploadMedia(input.closest('[data-staff-id]'), input)));
  root.querySelectorAll('[data-media-list]').forEach((list) => list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const card = list.closest('[data-staff-id]');
    if (button.dataset.mediaDelete) {
      const result = await apiSend(`/staff/${encodeURIComponent(card.dataset.staffId)}/media/${encodeURIComponent(button.dataset.mediaDelete)}`, 'DELETE');
      if (!result.ok) return showNote(card, 'Не удалось удалить фотографию. Повторите попытку');
      return renderTeam();
    }
    if (button.dataset.mediaLeft) return reorderMedia(card, button.dataset.mediaLeft, -1);
    if (button.dataset.mediaRight) return reorderMedia(card, button.dataset.mediaRight, 1);
  }));
  root.querySelectorAll('[data-schedule-exception]').forEach((editor) => {
    loadExceptions(editor);
    const breakFields = editor.querySelector('[data-break-fields]');
    const syncType = () => { breakFields.hidden = cardValue(editor, 'exceptionType').value !== 'break'; };
    editor.querySelectorAll('[name="exceptionType"]').forEach((input) => input.addEventListener('change', syncType));
    syncType();
    editor.querySelector('[data-exception-save]').addEventListener('click', () => saveException(editor));
    editor.querySelector('[data-exception-list]').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-exception-delete]');
      if (!button) return;
      const result = await apiSend(`/schedule?masterId=${encodeURIComponent(editor.dataset.staffId)}&date=${button.dataset.exceptionDelete}`, 'DELETE');
      if (!result.ok) return showNote(editor, 'Не удалось удалить изменение. Повторите попытку');
      await loadExceptions(editor);
    });
  });
  const create = root.querySelector('[data-create]');
  root.querySelector('[data-copy-pin]')?.addEventListener('click', async (event) => {
    const pin = root.querySelector('[data-temporary-pin]')?.textContent?.trim();
    if (!pin) return;
    try {
      await navigator.clipboard.writeText(pin);
      event.currentTarget.textContent = 'PIN скопирован';
    } catch {
      event.currentTarget.textContent = 'Не удалось скопировать';
    }
  });
  create?.addEventListener('click', async () => {
    const card = create.closest('details');
    const value = (name) => cardValue(card, name);
    showNote(card, 'Создаю…');
    const out = await apiSend('/staff', 'POST', { name: value('name').value, phone: value('phone').value, email: value('email').value, locationId: value('locationId')?.value || null, role: value('role').value, providesServices: value('providesServices').checked });
    if (!out.ok) return showNote(card, 'Не удалось создать. Проверьте поля и повторите попытку');
    lastCreatedCredentials = { name: value('name').value.trim(), pin: out.data.temporaryPin };
    await renderTeam();
  });
}

export async function renderTeam() {
  if (!getToken()) return;
  const host = document.querySelector('.panel-b .staff-list');
  if (!host) return;
  const openStaffIds = new Set([...host.querySelectorAll('.team-editor-card[open][data-staff-id]')].map((card) => card.dataset.staffId));
  try {
    const [rows, services, masterServices, me, locations] = await Promise.all([
      fetchJson('/staff'), fetchJson('/services'), fetch(`${API}/master-services`).then((response) => response.json()), fetchJson('/auth/me'), fetchJson('/locations'),
    ]);
    host.innerHTML = rows.map((staff) => staffCard(staff, me.staff.role, locations, me.staff.id)).join('') + addCard(locations);
    openStaffIds.forEach((staffId) => host.querySelector(`.team-editor-card[data-staff-id="${CSS.escape(staffId)}"]`)?.setAttribute('open', ''));
    const canEdit = ['owner', 'manager'].includes(me.staff.role);
    rows.forEach((staff) => {
      // Услуги снятого с приёма не выбираются вовсе (canEdit=false отключает чекбоксы
      // и поля длительности штатным путём). График сознательно НЕ отключаем: он есть и
      // у администратора - человеку нужно видеть и менять свои смены и выходные, даже
      // когда он не появляется в расписании записи (правка Влада 13.08.2026).
      const staffCanEdit = canEdit && !(me.staff.role === 'manager' && staff.protectedOwner);
      renderMasterServiceEditor(host.querySelector(`.service-picker[data-master-id="${staff.id}"]`), staff.id, staffCanEdit && staff.providesServices !== false, services, masterServices);
      wireWeeklyScheduleEditor(staff.id, staffCanEdit, fetchJson);
    });
    wire(host);
    initCrmNavigationPanels();
  } catch {
    host.innerHTML = '<p class="note">Не удалось загрузить команду. Повторите попытку</p>';
  }
}

// Страница импортирует модуль до завершения входа. Первый прямой вызов из HTML
// корректно ничего не делает без токена, поэтому после успешной аутентификации
// перерисовываем команду тем же источником данных, а не оставляем статичный макет
document.addEventListener('crm:authenticated', () => { renderTeam(); });
