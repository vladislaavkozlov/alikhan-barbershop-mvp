import { API, apiSend, fetchJson, getToken } from './crm-auth.js';
import { ICON_TEAM } from './crm-icons.js';
import { initCrmNavigationPanels } from './crm-navigation-panels.js';
import { renderMasterServiceEditor } from './crm-master-services.js';
import { wireWeeklyScheduleEditor } from './crm-schedule-editor.js';

const roleLabel = { owner: 'Владелец', manager: 'Управляющий', admin: 'Администратор', master: 'Мастер' };
const editableRoles = ['master', 'admin', 'manager'];
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const section = (title, content) => `<section class="team-editor-section"><h3><span aria-hidden="true">${ICON_TEAM}</span> ${title}</h3>${content}</section>`;
const today = () => new Date().toISOString().slice(0, 10);

function locationControl(staff, locations) {
  if (locations.length < 2) return `<input type="hidden" name="locationId" value="${esc(staff.locationId ?? locations[0]?.id ?? '')}">`;
  return `<div class="field"><label>Точка работы</label><select name="locationId">${locations.map((location) => `<option value="${esc(location.id)}" ${String(location.id) === String(staff.locationId) ? 'selected' : ''}>${esc(location.name)}</option>`).join('')}</select></div>`;
}

function roleControl(staff, viewerRole) {
  if (staff.role === 'owner' || viewerRole !== 'owner') return `<div class="field"><label>Роль</label><output>${roleLabel[staff.role] ?? staff.role}</output></div>`;
  return `<div class="field"><label>Роль</label><select data-role aria-label="Роль сотрудника">${editableRoles.map((role) => `<option value="${role}" ${staff.role === role ? 'selected' : ''}>${roleLabel[role]}</option>`).join('')}</select></div>`;
}

function mediaMarkup(staff) {
  const media = staff.media ?? [];
  return `<div class="team-media-input"><label>Основная фотография<input name="avatar" type="file" accept="image/jpeg,image/png,image/webp"></label></div>
  <div class="team-editor-grid"><div class="field"><label>Стаж</label><input name="experience" value="${esc(staff.experienceText)}"></div><div class="field"><label>Сильные стороны</label><input name="strengths" value="${esc(staff.strengthsText)}"></div></div>
  <div class="field"><label>Курсы и сертификаты</label><textarea name="certificates">${esc(staff.certificatesText)}</textarea></div>
  <div class="team-media-input"><label>Портфолио работ<input name="portfolio" type="file" multiple accept="image/jpeg,image/png,image/webp"></label><small>JPEG, PNG или WebP, до 8 МБ на файл, не более 20 фотографий</small></div>
  <div class="team-media-list" data-media-list data-staff-id="${esc(staff.id)}">${media.map((item) => mediaItem(item, media.filter((entry) => entry.kind === 'portfolio').findIndex((entry) => entry.id === item.id), media)).join('')}</div>
  <label class="toggle-row"><span class="tr-label">Показывать на сайте</span><input name="publicProfileEnabled" type="checkbox" ${staff.publicProfileEnabled ? 'checked' : ''}></label>`;
}

function mediaItem(media, index, all) {
  const name = media.kind === 'avatar' ? 'Основная' : `Работа ${index + 1}`;
  const move = media.kind === 'portfolio'
    ? `<div class="team-media-actions"><button type="button" data-media-left="${esc(media.id)}" aria-label="Переместить фотографию влево" ${index === 0 ? 'disabled' : ''}>←</button><button type="button" data-media-right="${esc(media.id)}" aria-label="Переместить фотографию вправо" ${index === all.filter((item) => item.kind === 'portfolio').length - 1 ? 'disabled' : ''}>→</button></div>`
    : '';
  return `<figure class="team-media-item" data-media-id="${esc(media.id)}" data-media-kind="${esc(media.kind)}"><img src="${esc(media.url)}" alt="${name}"><figcaption>${name}${move}<button type="button" data-media-delete="${esc(media.id)}" aria-label="Удалить ${name.toLowerCase()}">Удалить</button></figcaption></figure>`;
}

function staffCard(staff, viewerRole, locations) {
  const id = esc(staff.id);
  const locked = viewerRole === 'manager' && staff.protectedOwner;
  return `<details class="staff-card team-editor-card" data-staff-id="${id}" ${locked ? 'data-locked-owner' : ''}><summary><div class="avatar">${esc(staff.name).slice(0, 2)}</div><div class="summary-meta"><div class="name">${esc(staff.name)}</div><div class="role">${roleLabel[staff.role] ?? staff.role}</div></div><span class="chevron">▸</span></summary><div class="staff-card-body">
  ${section('Основное', `<div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" value="${esc(staff.name)}" ${locked ? 'disabled' : ''}></div><div class="field"><label>Телефон</label><input name="phone" value="${esc(staff.phone)}" ${locked ? 'disabled' : ''}></div><div class="field"><label>Email для входа</label><input name="email" type="email" value="${esc(staff.email)}" ${locked ? 'disabled' : ''}></div>${locationControl(staff, locations)}<label class="toggle-row"><span class="tr-label">Работает в компании</span><input name="employed" type="checkbox" ${staff.employed ? 'checked' : ''} ${locked ? 'disabled' : ''}></label></div><label class="toggle-row"><span class="tr-label">Оказывает услуги</span><input name="providesServices" type="checkbox" ${staff.providesServices ? 'checked' : ''} ${locked ? 'disabled' : ''}></label>`)}
  ${section('Профиль на сайте', mediaMarkup(staff))}
  ${section('Услуги и время', `<div class="service-picker" data-master-id="${id}"><span class="note">Загружаю услуги…</span></div>`)}
  ${section('График', `<div id="weeklyEditor-${id}"><span class="note">Загружаю график…</span></div>${exceptionEditor(staff.id)}`)}
  ${section('Доступ', `${roleControl(staff, viewerRole)}<label class="toggle-row"><span class="tr-label">Доступ к системе</span><input name="hasSystemAccess" type="checkbox" ${staff.hasSystemAccess ? 'checked' : ''} ${locked ? 'disabled' : ''}></label>`)}
  <div class="team-editor-actions"><button class="btn btn-primary" type="button" data-save ${locked ? 'disabled' : ''}>Сохранить</button><p class="payroll-note" aria-live="polite"></p></div></div></details>`;
}

function exceptionEditor(staffId) {
  return `<div class="team-schedule-exception" data-schedule-exception data-staff-id="${esc(staffId)}"><h4>Разовое изменение</h4><p class="note">Поставьте выходной или перерыв на одну дату либо диапазон. Недельный график не изменится</p><div class="team-editor-grid"><div class="field"><label>С даты</label><input name="dateFrom" type="date" min="${today()}"></div><div class="field"><label>По дату</label><input name="dateTo" type="date" min="${today()}"></div></div><div class="team-editor-grid"><div class="field"><label>Что изменить</label><select name="exceptionType"><option value="dayOff">Выходной на весь день</option><option value="break">Разовый перерыв</option></select></div><div class="field" data-break-fields><label>Начало перерыва</label><input name="breakStart" type="time" value="13:00"><label>Конец перерыва</label><input name="breakEnd" type="time" value="14:00"></div></div><button class="btn" type="button" data-exception-save>Сохранить изменение</button><p class="payroll-note" aria-live="polite"></p><div class="team-exception-list" data-exception-list><span class="note">Загружаю ближайшие изменения…</span></div></div>`;
}

function addCard(locations) {
  const empty = { locationId: locations[0]?.id ?? '' };
  return `<details class="staff-card team-add-card"><summary><div class="avatar-icon" aria-hidden="true">${ICON_TEAM}</div><div class="summary-meta"><div class="name">Добавить сотрудника</div><div class="role">Создать учётную запись и выдать временный PIN</div></div><span class="chevron">▸</span></summary><div class="staff-card-body"><div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name"></div><div class="field"><label>Телефон</label><input name="phone"></div><div class="field"><label>Email</label><input name="email" type="email"></div>${locationControl(empty, locations)}<div class="field"><label>Роль</label><select name="role">${editableRoles.map((role) => `<option value="${role}">${roleLabel[role]}</option>`).join('')}</select></div></div><label class="toggle-row"><span class="tr-label">Оказывает услуги</span><input name="providesServices" type="checkbox"></label><button class="btn btn-primary" type="button" data-create>Создать сотрудника</button><p class="payroll-note" aria-live="polite"></p></div></details>`;
}

function cardValue(card, name) { return card.querySelector(`[name="${name}"]`); }
function showNote(host, text) { host.querySelector('.payroll-note').textContent = text; }

async function saveCard(card) {
  const id = card.dataset.staffId;
  showNote(card, 'Сохраняю…');
  const value = (name) => cardValue(card, name);
  const main = await apiSend(`/staff/${encodeURIComponent(id)}`, 'PUT', {
    name: value('name').value,
    phone: value('phone').value,
    email: value('email').value,
    locationId: value('locationId')?.value || null,
    employed: value('employed').checked,
    providesServices: value('providesServices').checked,
    hasSystemAccess: value('hasSystemAccess').checked,
  });
  if (!main.ok) return showNote(card, 'Не удалось сохранить. Повторите попытку');
  const profile = await apiSend(`/staff/${encodeURIComponent(id)}/portfolio`, 'PUT', {
    experienceText: value('experience').value.trim() || null,
    strengthsText: value('strengths').value.trim() || null,
    certificatesText: value('certificates').value.trim() || null,
    publicProfileEnabled: value('publicProfileEnabled').checked,
  });
  if (!profile.ok) return showNote(card, 'Основное сохранено, профиль не сохранился. Повторите попытку');
  const role = card.querySelector('[data-role]');
  if (role) {
    const roleResult = await apiSend(`/staff/${encodeURIComponent(id)}/role`, 'PUT', { role: role.value });
    if (!roleResult.ok) return showNote(card, 'Данные сохранены, но роль не изменилась. Повторите попытку');
  }
  showNote(card, 'Сохранено');
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
  const note = card.querySelector('.payroll-note');
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
    }).join('') : '<span class="note">Ближайших разовых изменений нет</span>';
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
  create?.addEventListener('click', async () => {
    const card = create.closest('details');
    const value = (name) => cardValue(card, name);
    showNote(card, 'Создаю…');
    const out = await apiSend('/staff', 'POST', { name: value('name').value, phone: value('phone').value, email: value('email').value, locationId: value('locationId')?.value || null, role: value('role').value, providesServices: value('providesServices').checked });
    showNote(card, out.ok ? `Создан. Временный PIN: ${out.data.temporaryPin}` : 'Не удалось создать. Проверьте поля и повторите попытку');
    if (out.ok) await renderTeam();
  });
}

export async function renderTeam() {
  if (!getToken()) return;
  const host = document.querySelector('.panel-b .staff-list');
  if (!host) return;
  try {
    const [rows, services, masterServices, me, locations] = await Promise.all([
      fetchJson('/staff'), fetchJson('/services'), fetch(`${API}/master-services`).then((response) => response.json()), fetchJson('/auth/me'), fetchJson('/locations'),
    ]);
    host.innerHTML = rows.map((staff) => staffCard(staff, me.staff.role, locations)).join('') + addCard(locations);
    const canEdit = ['owner', 'manager'].includes(me.staff.role);
    rows.forEach((staff) => {
      renderMasterServiceEditor(host.querySelector(`.service-picker[data-master-id="${staff.id}"]`), staff.id, canEdit && !(me.staff.role === 'manager' && staff.protectedOwner), services, masterServices);
      wireWeeklyScheduleEditor(staff.id, canEdit && !(me.staff.role === 'manager' && staff.protectedOwner), fetchJson);
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
