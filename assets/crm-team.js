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
import { collectServiceChanges, DURATION_ERROR, markInvalidServiceDurations, renderMasterServiceEditor, saveServiceChanges } from './crm-master-services.js';
import { errorMessage, showError, showSuccess } from './crm-toast.js';
import { hasWeeklyScheduleChanges, saveWeeklySchedule, wireWeeklyScheduleEditor } from './crm-schedule-editor.js';
import { PHONE_PLACEHOLDER, formatStoredPhone, wirePhoneFields } from './crm-phone.js';
import { todayStr } from './crm-shared.js';
import { scheduleExceptionLabel } from './crm-schedule-shared.js';
import { dateSelectValue, renderDateSelect, renderTimeSelect, timeSelectValue } from './crm-widgets.js';

const roleLabel = { owner: 'Владелец', manager: 'Управляющий', admin: 'Администратор', master: 'Мастер' };
const editableRoles = ['master', 'admin', 'manager'];
let lastCreatedCredentials = null;
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const section = (title, description, icon, content, modifier = '') => `<section class="team-editor-section${modifier ? ` ${modifier}` : ''}"><header class="team-section-head"><span class="team-section-icon" aria-hidden="true">${icon}</span><div><h3>${title}</h3><p>${description}</p></div></header>${content}</section>`;
// Локальная дата салона, не UTC: new Date().toISOString() ночью (в MSK это 00:00-03:00)
// отдаёт ещё вчерашнее число - календарь тогда предлагал бы "сегодня" вчерашним днём,
// а список разовых изменений показывал бы уже прошедший день. Тот же todayStr(), что
// использует весь остальной фронтенд (crm-shared.js).
const today = todayStr;
// Список уже добавленных изменений показывал дату машинным "2026-08-15" - на экране
// салона это читается хуже, чем привычные "15.08.2026" (тот же вид, что на кнопке
// самого календаря-виджета).
const humanDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? iso.split('-').reverse().join('.') : String(iso ?? ''));

function toggleControl({ name, title, description, checked, disabled = false }) {
  return `<label class="toggle-row team-toggle-row"><span><span class="tr-label">${title}</span><span class="tr-sub">${description}</span></span><span class="switch"><input name="${name}" type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="track"></span><span class="knob"></span></span></label>`;
}

// Выбор точки работы убран из интерфейса 13.08.2026 по решению Влада: салон один,
// а в справочнике locations с самого первого сида лежат две записи - поле показывало
// выбор, которого в жизни нет, и предлагало ошибиться. Значение по-прежнему уезжает
// на сервер (контракт PUT /staff и POST /staff не меняется), просто скрытым полем:
// у существующего сотрудника - его текущая точка, у нового - первая из справочника.
// Появится вторая настоящая точка - вернуть сюда <select> из истории этого файла.
function locationControl(staff, locations) {
  return `<input type="hidden" name="locationId" value="${esc(staff.locationId ?? locations[0]?.id ?? '')}">`;
}

const roleDescription = {
  master: 'Свои записи и график',
  admin: 'Записи и клиенты своей точки',
  manager: 'Команда, график и финансы',
};

// name у радиокнопок обязан быть уникальным НА КАРТОЧКУ: радио группируются по имени
// в пределах всего документа, поэтому общий name="role" делал из всех карточек команды
// и формы добавления одну группу - отмеченной оставалась ровно одна роль на странице,
// и текущая роль сотрудника не подсвечивалась (найдено 13.08.2026 по скриншоту Влада).
function rolePicker(selectedRole, name) {
  return `<fieldset class="team-role-picker" data-role><legend>Роль сотрудника</legend>${editableRoles.map((role) => `<label class="team-role-option"><input type="radio" name="${name}" value="${role}" ${selectedRole === role ? 'checked' : ''}><span><strong>${roleLabel[role]}</strong><small>${roleDescription[role]}</small></span></label>`).join('')}</fieldset>`;
}

// Роль, которую этот зритель менять не может (владелец всегда, чужие роли для
// управляющего) - показываем той же карточкой, что и выбираемые, только подсвеченной
// и неактивной: одинаковый язык интерфейса вместо отдельной текстовой строки.
function roleBadge(role) {
  const description = role === 'owner' ? 'Полный доступ и защищённая учётная запись' : roleDescription[role] ?? '';
  return `<fieldset class="team-role-picker team-role-picker-single" data-role><legend>Роль сотрудника</legend><label class="team-role-option"><input type="radio" checked disabled><span><strong>${roleLabel[role] ?? esc(role)}</strong><small>${description}</small></span></label></fieldset>`;
}

function roleControl(staff, viewerRole) {
  if (staff.role === 'owner' || viewerRole !== 'owner') return roleBadge(staff.role);
  return rolePicker(staff.role, `role-${staff.id}`);
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
  ${section('Основное', 'Контакты и рабочий статус', ICON_DETAILS, `<div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" autocomplete="name" placeholder="Имя и фамилия" value="${esc(staff.name)}" ${locked ? 'disabled' : ''}></div><div class="field"><label>Телефон</label><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${PHONE_PLACEHOLDER}" value="${esc(formatStoredPhone(staff.phone))}" ${locked ? 'disabled' : ''}></div><div class="field"><label>Email для входа</label><input name="email" type="email" inputmode="email" autocomplete="email" placeholder="mail@example.com" value="${esc(staff.email)}" ${locked ? 'disabled' : ''}></div>${locationControl(staff, locations)}</div><div class="team-toggle-stack">${toggleControl({ name: 'employed', title: 'Работает в компании', description: 'Сотрудник остаётся в активном составе', checked: staff.employed, disabled: employmentLocked })}${toggleControl({ name: 'providesServices', title: 'Принимает клиентов', description: 'Можно назначить услуги и открыть запись', checked: staff.providesServices, disabled: locked })}</div>`)}
  ${section('Профиль на сайте', 'Фото и информация для клиентов', ICON_PUBLIC, mediaMarkup(staff))}
  ${section('Услуги и время', 'Выберите услуги и укажите длительность', ICON_SERVICES, `<div class="service-picker" data-master-id="${id}"><span class="note">Загружаю услуги…</span></div>`)}
  ${section('График', 'Рабочая неделя и разовые изменения', ICON_SCHEDULE, `<div id="weeklyEditor-${id}"><span class="note">Загружаю график…</span></div>${exceptionEditor(staff.id)}`)}
  ${/* Тумблер "Разрешить вход в CRM" убран 13.08.2026 по решению владельца: он дублировал
       "Работает в компании" в глазах салона и создавал риск случайно отрезать себе вход.
       Вход теперь есть у каждого, кто числится в составе; колонка has_system_access в схеме
       осталась и по-прежнему проверяется при входе, но через интерфейс не выключается. */''}
  ${section('Доступ', 'Роль сотрудника и её права', ICON_ACCESS, roleControl(staff, viewerRole))}
  <div class="team-editor-actions"><button class="btn btn-primary" type="button" data-save disabled>Сохранить изменения</button><p class="payroll-note" data-card-note aria-live="polite"></p></div></div></details>`;
}

// Даты и время здесь - слоты под кастомные виджеты проекта (.custom-date /
// .custom-select), а не нативные <input type="date">/<input type="time">.
// Нативные рисует ОС своим системным календарём мимо темы CRM - ровно то, что
// запрещает КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md и что Влад увидел живьём 13.08.2026.
// Виджеты наполняются в wireExceptionPickers после вставки разметки в DOM
// (renderDateSelect/renderTimeSelect ищут слот по id), значения читаются через
// dateSelectValue/timeSelectValue - у виджета значение в dataset.value, не в .value.
const exceptionFieldIds = (staffId) => ({
  from: `teamExcFrom-${staffId}`,
  to: `teamExcTo-${staffId}`,
  breakStart: `teamExcBreakStart-${staffId}`,
  breakEnd: `teamExcBreakEnd-${staffId}`,
});

function exceptionEditor(staffId) {
  const ids = exceptionFieldIds(staffId);
  return `<div class="team-schedule-exception" data-schedule-exception data-staff-id="${esc(staffId)}"><div class="team-exception-head"><div><h4>Разовое изменение</h4><p>Добавьте выходной или отдельный перерыв, не меняя рабочую неделю</p></div></div><div class="team-editor-grid"><div class="field"><label>С даты</label><div id="${esc(ids.from)}-slot"></div></div><div class="field"><label>По дату</label><div id="${esc(ids.to)}-slot"></div></div></div><fieldset class="team-exception-types"><legend>Тип изменения</legend><label><input type="radio" name="exceptionType-${esc(staffId)}" value="dayOff" checked><span><strong>Выходной</strong><small>Закрыть весь день</small></span></label><label><input type="radio" name="exceptionType-${esc(staffId)}" value="break"><span><strong>Перерыв</strong><small>Закрыть часть дня</small></span></label></fieldset><div class="team-break-fields" data-break-fields hidden><div class="field"><label>Перерыв с</label><div id="${esc(ids.breakStart)}-slot"></div></div><div class="field"><label>До</label><div id="${esc(ids.breakEnd)}-slot"></div></div></div><button class="btn btn-ghost" type="button" data-exception-save>Добавить изменение</button><p class="payroll-note" data-exception-note aria-live="polite"></p><div class="team-exception-list" data-exception-list><span class="note">Загружаю изменения…</span></div></div>`;
}

function addCard(locations) {
  const empty = { locationId: locations[0]?.id ?? '' };
  const credentials = lastCreatedCredentials;
  return `<details class="staff-card team-add-card" ${credentials ? 'open' : ''}><summary><div class="avatar-icon" aria-hidden="true">${ICON_ADD}</div><div class="summary-meta"><div class="name">Добавить сотрудника</div><div class="role">Создать доступ в CRM</div></div><span class="chevron">▸</span></summary><div class="staff-card-body"><div class="team-add-intro"><span aria-hidden="true">${ICON_PROFILE}</span><div><h3>Новый сотрудник</h3><p>Заполните данные для первого входа. Профиль для сайта настроите после создания</p></div></div><div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" autocomplete="name" placeholder="Имя и фамилия"></div><div class="field"><label>Телефон</label><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${PHONE_PLACEHOLDER}"></div><div class="field"><label>Email для входа</label><input name="email" type="email" inputmode="email" autocomplete="email" placeholder="mail@example.com"></div>${locationControl(empty, locations)}</div>${rolePicker('master', 'role-new')}${toggleControl({ name: 'providesServices', title: 'Принимает клиентов', description: 'Услуги и график нужно настроить отдельно', checked: false })}<div class="team-editor-actions"><button class="btn btn-primary" type="button" data-create>Создать сотрудника</button><p class="payroll-note" data-card-note aria-live="polite"></p></div><div class="team-create-result" data-create-result ${credentials ? '' : 'hidden'}><strong>Данные для первого входа</strong><span>${credentials ? esc(credentials.name) : ''} сможет войти по email и временному PIN</span><code data-temporary-pin>${credentials ? esc(credentials.pin) : ''}</code><button class="btn btn-ghost btn-sm" type="button" data-copy-pin>Скопировать PIN</button></div></div></details>`;
}

function cardValue(card, name) {
  return card.querySelector(`[name="${name}"]:checked`) ?? card.querySelector(`[name="${name}"]`);
}
function showNote(host, text) {
  const selector = host.matches?.('[data-schedule-exception]') ? '[data-exception-note]' : '[data-card-note]';
  const note = host.querySelector(selector) ?? host.querySelector('.payroll-note');
  if (note) note.textContent = text;
}
// Карточка сотрудника длинная - её строка статуса живёт в самом низу, и до неё нужно
// листать (правка Влада 15.08.2026). Поэтому любое сообщение о результате дублируется
// всплывающим окном внизу экрана: в карточке остаётся привязка к месту, на экране -
// сам текст. noteFail для готовой фразы, noteApiFail - когда причину знает сервер
function noteFail(host, text) {
  showNote(host, text);
  showError(text);
  return text;
}
function noteApiFail(host, result, prefix) {
  return noteFail(host, errorMessage(result, prefix));
}
function noteOk(host, text) {
  showNote(host, text);
  showSuccess(text);
  return text;
}

async function saveCard(card) {
  const id = card.dataset.staffId;
  // Длительность проверяем ДО первого запроса и до "Сохраняю…": ноль (или пустое
  // поле) раньше молча превращался в каталожные 60 минут, карточка рапортовала
  // "Сохранено", а после перезагрузки владелец видел прежнюю цифру - баг P2 от
  // 15.08.2026. Теперь сохранение не начинается вовсе, пока цифра не исправлена
  const picker = card.querySelector('.service-picker');
  if (markInvalidServiceDurations(picker).length) {
    picker?.querySelector('.sc-duration-input.is-invalid')?.focus();
    return noteFail(card, DURATION_ERROR);
  }
  showNote(card, 'Сохраняю…');
  const value = (name) => cardValue(card, name);
  const providesServicesChanged = value('providesServices').checked !== (card.dataset.providesServices === '1');
  // Услуги уезжают той же кнопкой, что и остальная карточка - отправляем их первыми,
  // чтобы отказ был виден до того, как остальное уже сохранилось
  const serviceChanges = collectServiceChanges(picker);
  if (serviceChanges.length) {
    const failedService = await saveServiceChanges(id, serviceChanges);
    if (failedService) return noteApiFail(card, failedService, 'Не удалось сохранить услуги');
  }
  // График уезжает той же кнопкой (13.08.2026). Своя кнопка «Сохранить график» под
  // блоком убрана: две кнопки сохранения в одной карточке путали - общая их не
  // видела и оставалась серой, пока правишь график. Отправляем до остальных полей,
  // потому что именно здесь возможен отказ сервера из-за живых записей клиентов.
  if (hasWeeklyScheduleChanges(id)) {
    const scheduleResult = await saveWeeklySchedule(id);
    if (!scheduleResult.ok) {
      return scheduleResult.conflict
        ? noteFail(card, 'График не сохранён: на это время уже есть записи, они показаны в блоке «График»')
        : noteApiFail(card, scheduleResult, 'Не удалось сохранить график');
    }
  }
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
  if (!main.ok) return noteApiFail(card, main, 'Не удалось сохранить сотрудника');
  const profile = await apiSend(`/staff/${encodeURIComponent(id)}/portfolio`, 'PUT', {
    experienceText: value('experience').value.trim() || null,
    strengthsText: value('strengths').value.trim() || null,
    certificatesText: value('certificates').value.trim() || null,
    publicProfileEnabled: value('publicProfileEnabled').checked,
  });
  if (!profile.ok) return noteApiFail(card, profile, 'Основное сохранено, а профиль для сайта - нет');
  const role = card.querySelector('.team-role-picker input[type="radio"]:checked');
  if (role) {
    const roleResult = await apiSend(`/staff/${encodeURIComponent(id)}/role`, 'PUT', { role: role.value });
    if (!roleResult.ok) return noteApiFail(card, roleResult, 'Данные сохранены, а роль не изменилась');
  }
  noteOk(card, 'Сохранено');
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
    if (!result.ok) { noteFail(card, errorMessage(result, `${file.name}: не удалось загрузить`)); return; }
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
  if (!result.ok) return noteApiFail(card, result, 'Не удалось изменить порядок фотографий');
  await renderTeam();
}

async function loadExceptions(root) {
  const id = root.dataset.staffId;
  const list = root.querySelector('[data-exception-list]');
  try {
    const shifts = await fetchJson(`/schedule?masterId=${encodeURIComponent(id)}`);
    const upcoming = shifts.filter((shift) => shift.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
    list.innerHTML = upcoming.length ? upcoming.map((shift) => {
      const label = scheduleExceptionLabel(shift);
      return `<div class="team-exception-item"><span>${esc(humanDate(shift.date))} - ${esc(label)}</span><button type="button" data-exception-delete="${esc(shift.date)}">Удалить</button></div>`;
    }).join('') : '<span class="note">Нет запланированных изменений</span>';
  } catch (err) { list.innerHTML = '<span class="note">Не удалось загрузить изменения. Повторите попытку</span>'; showError(errorMessage(err, 'Не удалось загрузить разовые изменения')); }
}

function rangeDates(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end && dates.length <= 31) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setDate(cursor.getDate() + 1); }
  return dates;
}

// Тип разового изменения. Радиокнопки получили уникальный на карточку name (см.
// exceptionEditor) - искать их общим именем больше нельзя, ищем внутри своего
// fieldset. Та же причина, что у ролей выше: одинаковый name склеивал бы карточки
// всех мастеров в одну радиогруппу на весь документ.
function exceptionTypeValue(root) {
  return root.querySelector('.team-exception-types input[type="radio"]:checked')?.value ?? 'dayOff';
}

async function saveException(root) {
  const ids = exceptionFieldIds(root.dataset.staffId);
  const from = dateSelectValue(ids.from);
  const to = dateSelectValue(ids.to) || from;
  const note = root.querySelector('.payroll-note');
  if (!from || to < from) return noteFail(root, 'Укажите дату начала - и дату конца не раньше неё');
  const dates = rangeDates(from, to);
  if (dates.length > 31) return noteFail(root, 'Диапазон не может быть длиннее 31 дня');
  const type = exceptionTypeValue(root);
  try {
    const result = await apiSend('/schedule-exceptions', 'POST', {
      masterId: root.dataset.staffId, dateFrom: from, dateTo: to, type,
      breakStart: timeSelectValue(ids.breakStart), breakEnd: timeSelectValue(ids.breakEnd),
    });
    if (!result.ok) { noteFail(root, result.status === 409 ? 'На это время уже есть запись - разовое изменение не сохранено' : errorMessage(result, 'Не удалось сохранить разовое изменение')); await loadExceptions(root); return; }
    noteOk(root, 'Разовое изменение сохранено');
    await loadExceptions(root);
  } catch (err) {
    noteFail(root, errorMessage(err, 'Не удалось сохранить разовое изменение'));
  }
}

// Поля, которые уезжают на сервер по кнопке "Сохранить изменения". Услуги, график и
// фотографии сохраняются сами по себе, отдельными запросами - их правка кнопку не
// касается, поэтому в снимок они не входят.
const SAVED_FIELDS = ['name', 'phone', 'email', 'locationId', 'employed', 'providesServices', 'publicProfileEnabled', 'experience', 'strengths', 'certificates'];

function cardSnapshot(card) {
  const values = SAVED_FIELDS.map((name) => {
    const field = card.querySelector(`[name="${name}"]`);
    if (!field) return '';
    return field.type === 'checkbox' ? String(field.checked) : String(field.value);
  });
  values.push(card.querySelector('.team-role-picker input[type="radio"]:checked')?.value ?? '');
  return values.join('\u0000');
}

// Кнопка сохранения активна только когда в карточке реально что-то изменили: до
// этого нажимать нечего, и активная кнопка вводит в заблуждение (правка Влада
// 13.08.2026). Снимок снимается при отрисовке, сравнение - на каждый ввод.
function updateSaveState(card) {
  const button = card.querySelector('[data-save]');
  if (!button || card.dataset.lockedOwner !== undefined) return;
  const fieldsChanged = cardSnapshot(card) !== card.dataset.snapshot;
  const servicesChanged = collectServiceChanges(card.querySelector('.service-picker')).length > 0;
  const scheduleChanged = hasWeeklyScheduleChanges(card.dataset.staffId);
  button.disabled = !fieldsChanged && !servicesChanged && !scheduleChanged;
}

function wireDirtyTracking(root) {
  root.querySelectorAll('.team-editor-card').forEach((card) => {
    card.dataset.snapshot = cardSnapshot(card);
    updateSaveState(card);
  });
  // renderTeam перерисовывает содержимое host многократно, а сам host остаётся -
  // делегированные слушатели вешаем ровно один раз, иначе они копятся с каждой
  // перерисовкой (тот же класс бага, о котором предупреждает crm-dashboard.js).
  if (root.dataset.dirtyWired) return;
  root.dataset.dirtyWired = '1';
  const onEdit = (event) => {
    const card = event.target.closest?.('.team-editor-card');
    if (card) updateSaveState(card);
  };
  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);
  root.addEventListener('crm:card-dirty', onEdit);
  // Время в графике и перерывах выбирается своим дропдауном - нативного change он
  // не шлёт, только это событие (assets/mockup-crm.js, pickCustomSelectOption)
  root.addEventListener('customselect:change', onEdit);
}

// Наполняет слоты разового изменения кастомными виджетами. Даты начинаются с
// сегодняшней и в прошлое не выбираются (minDate) - разовый выходной задним числом
// смысла не имеет, а раньше это позволял нативный min="" (и то только на части
// браузеров). Время - тот же дропдаун с шагом 15 минут в часах салона, что уже
// стоит в недельном графике рядом.
function wireExceptionPickers(editor) {
  const ids = exceptionFieldIds(editor.dataset.staffId);
  const start = today();
  renderDateSelect(`${ids.from}-slot`, ids.from, start, start);
  renderDateSelect(`${ids.to}-slot`, ids.to, start, start);
  renderTimeSelect(`${ids.breakStart}-slot`, ids.breakStart, '13:00');
  renderTimeSelect(`${ids.breakEnd}-slot`, ids.breakEnd, '14:00');
}

function wire(root) {
  wirePhoneFields(root);
  root.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', () => saveCard(button.closest('[data-staff-id]'))));
  root.querySelectorAll('input[type=file]').forEach((input) => input.addEventListener('change', () => uploadMedia(input.closest('[data-staff-id]'), input)));
  root.querySelectorAll('[data-media-list]').forEach((list) => list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const card = list.closest('[data-staff-id]');
    if (button.dataset.mediaDelete) {
      const result = await apiSend(`/staff/${encodeURIComponent(card.dataset.staffId)}/media/${encodeURIComponent(button.dataset.mediaDelete)}`, 'DELETE');
      if (!result.ok) return noteApiFail(card, result, 'Не удалось удалить фотографию');
      return renderTeam();
    }
    if (button.dataset.mediaLeft) return reorderMedia(card, button.dataset.mediaLeft, -1);
    if (button.dataset.mediaRight) return reorderMedia(card, button.dataset.mediaRight, 1);
  }));
  root.querySelectorAll('[data-schedule-exception]').forEach((editor) => {
    wireExceptionPickers(editor);
    loadExceptions(editor);
    const breakFields = editor.querySelector('[data-break-fields]');
    const syncType = () => { breakFields.hidden = exceptionTypeValue(editor) !== 'break'; };
    editor.querySelectorAll('.team-exception-types input[type="radio"]').forEach((input) => input.addEventListener('change', syncType));
    syncType();
    editor.querySelector('[data-exception-save]').addEventListener('click', () => saveException(editor));
    editor.querySelector('[data-exception-list]').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-exception-delete]');
      if (!button) return;
      const result = await apiSend(`/schedule?masterId=${encodeURIComponent(editor.dataset.staffId)}&date=${button.dataset.exceptionDelete}`, 'DELETE');
      if (!result.ok) return noteApiFail(editor, result, 'Не удалось удалить разовое изменение');
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
      showError('Не удалось скопировать PIN. Выделите его и скопируйте вручную');
    }
  });
  create?.addEventListener('click', async () => {
    const card = create.closest('details');
    const value = (name) => cardValue(card, name);
    showNote(card, 'Создаю…');
    const out = await apiSend('/staff', 'POST', { name: value('name').value, phone: value('phone').value, email: value('email').value, locationId: value('locationId')?.value || null, role: card.querySelector('.team-role-picker input[type="radio"]:checked')?.value, providesServices: value('providesServices').checked });
    if (!out.ok) return noteApiFail(card, out, 'Не удалось создать сотрудника');
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
      const picker = host.querySelector(`.service-picker[data-master-id="${staff.id}"]`);
      renderMasterServiceEditor(picker, staff.id, staffCanEdit && staff.providesServices !== false, services, masterServices, () => {
        picker.closest('.team-editor-card')?.dispatchEvent(new CustomEvent('crm:card-dirty', { bubbles: true }));
      });
      wireWeeklyScheduleEditor(staff.id, staffCanEdit, fetchJson);
    });
    wire(host);
    wireDirtyTracking(host);
    initCrmNavigationPanels();
  } catch (err) {
    host.innerHTML = '<p class="note">Не удалось загрузить команду. Повторите попытку</p>';
    showError(errorMessage(err, 'Не удалось загрузить команду'));
  }
}

// Страница импортирует модуль до завершения входа. Первый прямой вызов из HTML
// корректно ничего не делает без токена, поэтому после успешной аутентификации
// перерисовываем команду тем же источником данных, а не оставляем статичный макет
document.addEventListener('crm:authenticated', () => { renderTeam(); });
