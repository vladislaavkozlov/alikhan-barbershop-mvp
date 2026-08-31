import { API, apiSend, fetchJson, getToken } from './crm-auth.js';
import { mediaUrl } from '../storage.js';
import {
  ICON_ACCESS,
  ICON_ADD,
  ICON_DETAILS,
  ICON_PROFILE,
  ICON_PUBLIC,
  ICON_SCHEDULE,
  ICON_UPLOAD,
  verticalIcon,
} from './crm-icons.js';
import { initCrmNavigationPanels } from './crm-navigation-panels.js';
import { collectServiceChanges, DURATION_ERROR, markInvalidServiceDurations, markInvalidServicePrices, PRICE_ERROR, renderMasterServiceEditor, saveServiceChanges } from './crm-master-services.js';
import { errorMessage, showError, showSuccess } from './crm-toast.js';
import { setButtonBusy, showSpinner, skeletonMarkup } from './crm-loading.js';
import { avatarMarkup } from './crm-avatar.js';
import { cropSquareImage } from './crm-image-crop.js';
import { hasWeeklyScheduleChanges, saveWeeklySchedule, wireWeeklyScheduleEditor } from './crm-schedule-editor.js';
import { PHONE_PLACEHOLDER, formatStoredPhone, wirePhoneFields } from './crm-phone.js';
import { todayStr } from './crm-shared.js';
import { scheduleExceptionLabel } from './crm-schedule-shared.js';
import { dateSelectValue, renderDateSelect, renderTimeSelect, timeSelectValue } from './crm-widgets.js';
import { T, Tc, P, C, currentAppearance } from './crm-terms.js';

// Вызовом, не константой (Этап B): слово роли приходит из словаря вертикали
const roleLabels = () => ({ owner: 'Владелец', manager: 'Управляющий', admin: 'Администратор', master: Tc('master.nom') });
const editableRoles = ['master', 'admin', 'manager'];
// Кто правит карточку сотрудника (имя, контакты, услуги, роль, фото) - ровно те же
// роли, что MANAGEMENT_ROLES на сервере (api/lib/permissions.js). Администратор сюда
// НЕ входит: с 16.08.2026 он видит тот же раздел «Сотрудники», но только смотрит.
const MANAGEMENT_VIEWERS = ['owner', 'manager'];
// График с 28.08.2026 (правка Влада) правят только владелец и управляющий. До этого
// сюда входил и администратор: он ставил смены и выходные по своей точке. Сервер
// теперь такие запросы отклоняет (api/routes/schedule.js, замок canManageStaff), и
// список здесь совпадает с ним - иначе интерфейс показывал бы форму, ведущую в отказ.
const SCHEDULE_EDITORS = ['owner', 'manager'];
// Показываем ли человеку его услуги. Единственный критерий - принимает ли он клиентов:
// у администратора услуг нет вовсе, и каталог со снятыми галками в его карточке - это
// не «нельзя менять», а «этого у меня нет». Поля providesServices может не быть в
// старом снимке состава - тогда считаем, что человек принимает: потерять секцию услуг
// у мастера хуже, чем показать лишнюю у того, кого в снимке нет.
export function showsServicesSection(staff) {
  return staff?.providesServices !== false;
}
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

// Вызовом, не константой: подписи берутся из словаря вертикали, а он приезжает с
// сервера уже после загрузки модуля (Этап B, 24.08.2026)
const roleDescriptions = () => ({
  master: P('team.roleMaster'),
  admin: P('team.roleAdmin'),
  manager: 'Команда, график и финансы',
});

// name у радиокнопок обязан быть уникальным НА КАРТОЧКУ: радио группируются по имени
// в пределах всего документа, поэтому общий name="role" делал из всех карточек команды
// и формы добавления одну группу - отмеченной оставалась ровно одна роль на странице,
// и текущая роль сотрудника не подсвечивалась (найдено 13.08.2026 по скриншоту Влада).
function rolePicker(selectedRole, name) {
  return `<fieldset class="team-role-picker" data-role><legend>Роль сотрудника</legend>${editableRoles.map((role) => `<label class="team-role-option"><input type="radio" name="${name}" value="${role}" ${selectedRole === role ? 'checked' : ''}><span><strong>${roleLabels()[role]}</strong><small>${roleDescriptions()[role]}</small></span></label>`).join('')}</fieldset>`;
}

// Роль, которую этот зритель менять не может (владелец всегда, чужие роли для
// управляющего) - показываем той же карточкой, что и выбираемые, только подсвеченной
// и неактивной: одинаковый язык интерфейса вместо отдельной текстовой строки.
function roleBadge(role) {
  const description = role === 'owner' ? 'Полный доступ и защищённая учётная запись' : roleDescriptions()[role] ?? ''; // другое значение: «учётная запись» - это аккаунт в системе, а не визит клиента
  return `<fieldset class="team-role-picker team-role-picker-single" data-role><legend>Роль сотрудника</legend><label class="team-role-option"><input type="radio" checked disabled><span><strong>${roleLabels()[role] ?? esc(role)}</strong><small>${description}</small></span></label></fieldset>`;
}

// Отмеченная роль, которую этот зритель РЕАЛЬНО может назначить. Отличать от
// roleBadge обязательно: он рисует такую же на вид отмеченную радиокнопку, но
// disabled и БЕЗ атрибута value - у такого input `.value` равен строке "on"
// (умолчание браузера для radio без value). Эта строка и уезжала на сервер как
// роль, когда владелец сохранял карточку владельца, а сервер честно отвечал
// invalid_role - "Данные сохранены, а роль не изменилась: Такой роли не
// существует" (Влад, 16.08.2026). Заодно это обрывало сохранение на полпути: до
// "Сохранено" и до перезагрузки расписания после смены "Принимает клиентов"
// выполнение уже не доходило.
function selectedRoleInput(card) {
  return card.querySelector('.team-role-picker input[type="radio"]:checked:not([disabled])');
}

function roleControl(staff, viewerRole) {
  if (staff.role === 'owner' || viewerRole !== 'owner') return roleBadge(staff.role);
  return rolePicker(staff.role, `role-${staff.id}`);
}

// Поля пароля намеренно БЕЗ атрибута name: снимок карточки (cardSnapshot) собирает
// значения по именам из SAVED_FIELDS, и любое названное поле разбудило бы кнопку
// «Сохранить изменения». Пароль сохраняется своей кнопкой и своим роутом, к общему
// сохранению карточки он отношения не имеет.
function pinControl(staff) {
  return `<p class="note">Пароль - минимум шесть знаков, буквы и цифры на ваш выбор. Сотрудник вводит его при входе вместе со своим логином ${esc(staff.email ?? '')}</p>
  <p class="note">Старый пароль знать не нужно: вы задаёте новый и передаёте его сотруднику</p>
  <div class="team-editor-grid"><div class="field"><label>Новый пароль</label><input class="pin-new" type="password" autocomplete="new-password" maxlength="72" placeholder="минимум 6 знаков"></div><div class="field"><label>Повторите пароль</label><input class="pin-repeat" type="password" autocomplete="new-password" maxlength="72" placeholder="минимум 6 знаков"></div></div>
  <button class="btn btn-ghost btn-sm" type="button" data-pin-save>Задать пароль</button>
  <p class="payroll-note" data-pin-note aria-live="polite"></p>`;
}

function mediaMarkup(staff) {
  const media = staff.media ?? [];
  // Снят с приёма - на сайт человек не попадёт в любом случае: /public/masters
  // отбирает только тех, кто оказывает услуги. Раньше из-за этого сам тумблер
  // делался неактивным, и получался мёртвый контрол: ползунок выглядит обычным, на
  // нажатие не отвечает, кнопка "Сохранить изменения" не просыпается, причина нигде
  // не написана (Влад, 16.08.2026). Теперь настройка переключается всегда, а почему
  // она сейчас ни на что не влияет - сказано прямо в подписи под ней.
  const offDuty = staff.providesServices === false;
  const profileHint = offDuty
    ? 'Сотрудник снят с приёма - на сайте его нет. Настройка сохранится и включится, когда вернёте на приём'
    : P('team.noProfile');
  return `<div class="team-media-upload"><div><strong>Фото профиля</strong><small>После выбора можно подвинуть и приблизить кадр. Сохранится сразу, кнопка «Сохранить изменения» для этого не нужна</small></div><label class="team-file-action">${ICON_UPLOAD}<span>Выбрать фото</span><input class="team-file-native" name="avatar" type="file" accept="image/jpeg,image/png,image/webp"></label></div>
  <div class="team-editor-grid"><div class="field"><label>Стаж</label><input name="experience" value="${esc(staff.experienceText)}" placeholder="Например, 6 лет"></div><div class="field"><label>Сильные стороны</label><input name="strengths" value="${esc(staff.strengthsText)}" placeholder="Например, фейды и борода"></div></div>
  <div class="field"><label>Курсы и сертификаты</label><textarea name="certificates" placeholder="Название курса или сертификата">${esc(staff.certificatesText)}</textarea></div>
  <div class="team-media-upload"><div><strong>Портфолио</strong><small>До 20 фото в JPEG, PNG или WebP, каждое до 8 МБ</small></div><label class="team-file-action">${ICON_UPLOAD}<span>Добавить работы</span><input class="team-file-native" name="portfolio" type="file" multiple accept="image/jpeg,image/png,image/webp"></label></div>
  <div class="team-media-list" data-media-list data-staff-id="${esc(staff.id)}">${media.map((item) => mediaItem(item, media.filter((entry) => entry.kind === 'portfolio').findIndex((entry) => entry.id === item.id), media)).join('')}</div>
  ${toggleControl({ name: 'publicProfileEnabled', title: 'Показывать профиль на сайте', description: profileHint, checked: staff.publicProfileEnabled })}`;
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
  const canManage = MANAGEMENT_VIEWERS.includes(viewerRole);
  const employmentLocked = locked || !canManage || staff.protectedOwner || isSelf;
  const fieldsLocked = locked || !canManage;
  // Подписи секций 17.08.2026: раньше карточка владельца у управляющего выглядела
  // полностью редактируемой (заголовки те же, что у владельца), а половина полей была
  // неактивна без единого слова почему. Теперь в каждой закрытой секции сказано, что
  // именно закрыто, и что при этом остаётся доступным
  const detailsTitle = !canManage
    ? 'Контакты и рабочий статус - только просмотр'
    : locked
      ? 'Карточку владельца не переименовать - витрину на сайте ниже менять можно'
      : 'Контакты и рабочий статус';
  const servicesTitle = !canManage
    ? P('team.servicesByOwner')
    : locked
      ? P('team.servicesOwnerSelf')
      : P('team.pickServices');
  return `<details class="staff-card team-editor-card" data-staff-id="${id}" data-role="${esc(staff.role)}" data-provides-services="${staff.providesServices ? '1' : '0'}" ${locked ? 'data-locked-owner' : ''}><summary>${avatarMarkup(staff)}<div class="summary-meta"><div class="name">${esc(staff.name)}</div><div class="role">${roleLabels()[staff.role] ?? staff.role}${staff.employed === false ? ` · ${esc(firedNote(staff))}` : ''}</div></div><span class="chevron">▸</span></summary><div class="staff-card-body">
  ${section('Основное', detailsTitle, ICON_DETAILS,`<div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" autocomplete="name" placeholder="Имя и фамилия" value="${esc(staff.name)}" ${fieldsLocked ? 'disabled' : ''}></div><div class="field"><label>Телефон</label><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${PHONE_PLACEHOLDER}" value="${esc(formatStoredPhone(staff.phone))}" ${fieldsLocked ? 'disabled' : ''}></div><div class="field"><label>Логин для входа</label><input name="email" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="например renat" value="${esc(staff.email)}" ${fieldsLocked ? 'disabled' : ''}></div>${locationControl(staff, locations)}</div><div class="team-toggle-stack">${toggleControl({ name: 'providesServices', title: P('team.acceptsClients'), description: P('team.acceptsHint'), checked: staff.providesServices, disabled: fieldsLocked })}</div>`)}
  ${/* Фото, портфолио и витрина на сайте - управление составом медиа, а оно на сервере
       management-only (POST/DELETE /staff/:id/media). Администратору секцию не рисуем
       вовсе: кнопка «Выбрать фото» у него давала бы только 401 в ответ. */''}
  ${canManage ? section('Профиль на сайте', P('team.publicProfileHint'), ICON_PUBLIC, mediaMarkup(staff)) : ''}
  ${/* Услуги показываем только тому, кто принимает клиентов (27.08.2026, находка
       владельца). До этой правки секция рисовалась безусловно, и администратор,
       который услуг не оказывает вовсе, видел у себя весь каталог - приглушённый
       стилем .service-picker.readonly, но видимый. Приглушённое поле читается как
       «у тебя это есть, только трогать нельзя», а у него этого нет совсем. */''}
  ${showsServicesSection(staff) ? section(P('team.servicesSection'), servicesTitle, verticalIcon('services', currentAppearance().vertical), `<div class="service-picker" data-master-id="${id}">${skeletonMarkup(4)}</div>`) : ''}
  ${/* График показываем только тем, кто его правит (28.08.2026). Администратору
       секция теперь не рисуется вовсе - показывать редактор, который на сохранении
       ответит 401, хуже, чем не показывать ничего. Смены он по-прежнему видит в
       разделе «Расписание», только read-only. */''}
  ${canManage ? section('График', 'Рабочая неделя и разовые изменения', ICON_SCHEDULE, `<div id="weeklyEditor-${id}">${skeletonMarkup(3)}</div>${exceptionEditor(staff.id)}`) : ''}
  ${/* Тумблер "Разрешить вход в CRM" убран 13.08.2026 по решению владельца: он дублировал
       "Работает в компании" в глазах салона и создавал риск случайно отрезать себе вход.
       Вход теперь есть у каждого, кто числится в составе; колонка has_system_access в схеме
       осталась и по-прежнему проверяется при входе, но через интерфейс не выключается. */''}
  ${section('Доступ', 'Роль сотрудника и её права', ICON_ACCESS, roleControl(staff, viewerRole))}
  ${/* Пароль сотрудника (20.08.2026). Секцию видит ТОЛЬКО владелец - и на сервере
       PUT /staff/:id/pin тоже owner-only (реестр роутов в api/server.mjs). У
       управляющего и администратора раздел «Сотрудники» открывается тем же
       кодом, поэтому проверка роли обязана быть здесь, а не в разметке
       страницы: иначе они увидели бы поля, которые всегда отвечают 401. */''}
  ${viewerRole === 'owner' ? section('Пароль для входа', 'Доступ сотрудника в кабинет', ICON_ACCESS, pinControl(staff)) : ''}
  ${/* Увольнение (22.08.2026). Раньше здесь был тумблер «Работает в компании» рядом с
       «Принимает клиентов» - два похожих переключателя, из которых один тихо обрывал
       человеку вход и убирал его с сайта. Теперь это отдельное названное действие с
       подтверждением, где прямым текстом сказано, что произойдёт и что останется.
       Своё сохранение ему не нужно: PUT /staff/:id/employment уходит сразу по кнопке,
       не подхватывая несохранённые правки соседних полей. */''}
  ${employmentSection(staff, employmentLocked)}
  ${/* Кнопка только у тех, кто правит карточку. Прежде она была и у администратора
       с надписью «Сохранить график» и признаком data-schedule-only - вместе с самой
       секцией графика это потеряло смысл 28.08.2026: сохранять в карточке ему больше
       нечего, а кнопка без действия читается как сломанная. */''}
  <div class="team-editor-actions">${canManage ? '<button class="btn btn-primary" type="button" data-save disabled>Сохранить изменения</button>' : ''}<p class="payroll-note" data-card-note aria-live="polite"></p></div></div></details>`;
}

// Подпись уволенного - одна на карточку и на её свёрнутый вид: дату увольнения видно
// в списке сразу, не раскрывая карточку (иначе блок «Уволенные» отвечает только на
// вопрос «кто ушёл», но не «когда»)
function firedNote(staff) {
  const since = humanDate(staff.employmentEndedAt);
  return since ? `Не работает с ${since}` : 'Не работает';
}

// Секция «Состав команды». У работающего - кнопка «Уволить», у уволенного - дата и
// возврат в команду. Замок тот же, что на сервере (guardAccountLockout): владельца и
// самого себя уволить нельзя.
//
// Пояснение «Себя уволить нельзя - это закрыло бы вам вход в CRM» убрано 28.08.2026
// по правке Влада: запрет очевиден без слов, а надпись занимала место и звучала как
// отказ системы там, где человек ничего и не пытался сделать. Кнопки в этом случае
// просто нет - замок на сервере от этого никуда не делся.
function employmentSection(staff, employmentLocked) {
  const fired = staff.employed === false;
  if (fired) {
    return section('Состав команды', firedNote(staff), ICON_PROFILE,
      `<div class="team-employment" data-employment data-staff-id="${esc(staff.id)}" data-employed="0">
        <p class="payroll-note">${P('team.historyKept')}</p>
        <div class="team-employment-actions" data-employment-actions></div>
      </div>`);
  }
  if (employmentLocked) {
    return section('Состав команды', 'Работает в компании', ICON_PROFILE,
      `<div class="team-employment" data-employed="1"></div>`);
  }
  return section('Состав команды', 'Работает в компании', ICON_PROFILE,
    `<div class="team-employment" data-employment data-staff-id="${esc(staff.id)}" data-employed="1">
      <div class="team-employment-actions" data-employment-actions></div>
    </div>`);
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
  return `<div class="team-schedule-exception" data-schedule-exception data-staff-id="${esc(staffId)}"><div class="team-exception-head"><div><h4>Разовое изменение</h4><p>Добавьте выходной или отдельный перерыв, не меняя рабочую неделю</p></div></div><div class="team-editor-grid"><div class="field"><label>С даты</label><div id="${esc(ids.from)}-slot"></div></div><div class="field"><label>По дату</label><div id="${esc(ids.to)}-slot"></div></div></div><fieldset class="team-exception-types"><legend>Тип изменения</legend><label><input type="radio" name="exceptionType-${esc(staffId)}" value="dayOff" checked><span><strong>Выходной</strong><small>Закрыть весь день</small></span></label><label><input type="radio" name="exceptionType-${esc(staffId)}" value="break"><span><strong>Перерыв</strong><small>Закрыть часть дня</small></span></label></fieldset><div class="team-break-fields" data-break-fields hidden><div class="field"><label>Перерыв с</label><div id="${esc(ids.breakStart)}-slot"></div></div><div class="field"><label>До</label><div id="${esc(ids.breakEnd)}-slot"></div></div></div><button class="btn btn-ghost" type="button" data-exception-save>Добавить изменение</button><p class="payroll-note" data-exception-note aria-live="polite"></p><div class="team-exception-list" data-exception-list>${skeletonMarkup(2)}</div></div>`;
}

function addCard(locations) {
  const empty = { locationId: locations[0]?.id ?? '' };
  const credentials = lastCreatedCredentials;
  return `<details class="staff-card team-add-card" ${credentials ? 'open' : ''}><summary><div class="avatar-icon" aria-hidden="true">${ICON_ADD}</div><div class="summary-meta"><div class="name">Добавить сотрудника</div><div class="role">Создать доступ в CRM</div></div><span class="chevron">▸</span></summary><div class="staff-card-body"><div class="team-add-intro"><span aria-hidden="true">${ICON_PROFILE}</span><div><h3>Новый сотрудник</h3><p>Заполните данные для первого входа. Логин - имя латиницей, например renat. Профиль для сайта настроите после создания</p></div></div><div class="team-editor-grid"><div class="field"><label>Имя</label><input name="name" autocomplete="name" placeholder="Имя и фамилия"></div><div class="field"><label>Телефон</label><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${PHONE_PLACEHOLDER}"></div><div class="field"><label>Логин для входа</label><input name="email" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="например renat"></div>${locationControl(empty, locations)}</div>${rolePicker('master', 'role-new')}${toggleControl({ name: 'providesServices', title: P('team.acceptsClients'), description: P('team.acceptsHintNew'), checked: false })}<div class="team-editor-actions"><button class="btn btn-primary" type="button" data-create>Создать сотрудника</button><p class="payroll-note" data-card-note aria-live="polite"></p></div><div class="team-create-result" data-create-result ${credentials ? '' : 'hidden'}><strong>Данные для первого входа</strong><span>${credentials ? esc(credentials.name) : ''} сможет войти по своему логину и временному паролю</span><code data-temporary-pin>${credentials ? esc(credentials.pin) : ''}</code><button class="btn btn-ghost btn-sm" type="button" data-copy-pin>Скопировать пароль</button></div></div></details>`;
}

function cardValue(card, name) {
  return card.querySelector(`[name="${name}"]:checked`) ?? card.querySelector(`[name="${name}"]`);
}
function noteElOf(host) {
  const selector = host.matches?.('[data-schedule-exception]') ? '[data-exception-note]' : '[data-card-note]';
  return host.querySelector(selector) ?? host.querySelector('.payroll-note');
}
function showNote(host, text) {
  const note = noteElOf(host);
  if (note) note.textContent = text;
}
// Пока идёт сохранение, в строке статуса крутится индикатор, а не слово «Сохраняю…»
// (правка Влада 15.08.2026: «вместо красивой анимации снова надпись Сохраняю»).
// Результат придёт сюда же обычным текстом - через noteOk/noteFail
function showNoteSpinner(host, label) {
  showSpinner(noteElOf(host), label);
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
// Успех - только всплывающим окном внизу экрана (правка Влада 17.08.2026: «справа от
// кнопки высвечиваются подписи "сохранено...", их нужно убрать»). Строку у кнопки
// заодно чистим: там мог остаться индикатор сохранения или прошлая ошибка, и без
// очистки рядом с кнопкой навсегда повисало бы «Сохраняю карточку сотрудника».
// Отказы по-прежнему пишутся и в карточку тоже (noteFail): причину нужно видеть
// рядом с полем, которое её вызвало, а не только в окне, которое само уедет
function noteOk(host, text) {
  showNote(host, '');
  showSuccess(text);
  return text;
}

async function saveCard(card) {
  // Длительность проверяем ДО первого запроса и до индикатора: ноль (или пустое
  // поле) раньше молча превращался в каталожные 60 минут, карточка рапортовала
  // "Сохранено", а после перезагрузки владелец видел прежнюю цифру - баг P2 от
  // 15.08.2026. Теперь сохранение не начинается вовсе, пока цифра не исправлена
  const picker = card.querySelector('.service-picker');
  if (markInvalidServiceDurations(picker).length) {
    picker?.querySelector('.sc-duration-input.is-invalid')?.focus();
    return noteFail(card, DURATION_ERROR);
  }
  // Цена - та же проверка до первого запроса (20.08.2026): негодная цифра на сервере
  // молча подменилась бы каталожной ценой с ответом 200, и владелец увидел бы
  // «Сохранено» с чужой суммой в собственном прайсе - ровно баг P2, но про деньги
  if (markInvalidServicePrices(picker).length) {
    picker?.querySelector('.sc-price-input.is-invalid')?.focus();
    return noteFail(card, PRICE_ERROR);
  }
  const saveButton = card.querySelector('[data-save]');
  setButtonBusy(saveButton);
  showNoteSpinner(card, 'Сохраняю карточку сотрудника');
  try {
    return await saveCardSteps(card);
  } catch (err) {
    // Неожиданный сбой в самом коде сохранения раньше уходил в консоль браузера:
    // индикатор так и крутился, а человек не знал, сохранилось что-то или нет
    return noteFail(card, errorMessage(err, 'Не удалось сохранить карточку'));
  } finally {
    // Кнопка освобождается на ЛЮБОМ выходе - и на отказе сервера, и на успехе.
    // renderTeam ниже всё равно перерисует карточку, но между отказом и следующим
    // действием человека кнопка не должна оставаться заблокированной
    setButtonBusy(saveButton, false);
    updateSaveState(card);
  }
}

async function saveCardSteps(card) {
  const id = card.dataset.staffId;
  const value = (name) => cardValue(card, name);
  const providesServicesChanged = value('providesServices').checked !== (card.dataset.providesServices === '1');
  // Услуги уезжают той же кнопкой, что и остальная карточка - отправляем их первыми,
  // чтобы отказ был виден до того, как остальное уже сохранилось
  const serviceChanges = collectServiceChanges(card.querySelector('.service-picker'));
  if (serviceChanges.length) {
    const failedService = await saveServiceChanges(id, serviceChanges);
    if (failedService) return noteApiFail(card, failedService, P('team.servicesSaveFailed'));
  }
  // График уезжает той же кнопкой (13.08.2026). Своя кнопка «Сохранить график» под
  // блоком убрана: две кнопки сохранения в одной карточке путали - общая их не
  // видела и оставалась серой, пока правишь график. Отправляем до остальных полей,
  // потому что именно здесь возможен отказ сервера из-за живых записей клиентов.
  if (hasWeeklyScheduleChanges(id)) {
    const scheduleResult = await saveWeeklySchedule(id);
    if (!scheduleResult.ok) {
      if (scheduleResult.conflict) {
        return noteFail(card, P('team.scheduleConflict'));
      }
      // Причину уже назвал сам редактор графика (reported) - конкретной фразой с днём
      // недели и часами. Второе, общее «Не удалось сохранить график. Повторите попытку»
      // только мешало: на скриншоте Влада 17.08.2026 висели два окна сразу, полезным
      // было одно. Дублируем причину в строку под кнопкой, но не всплываем повторно
      if (scheduleResult.reported) {
        showNote(card, scheduleResult.message ?? 'График не сохранён');
        return scheduleResult.message ?? null;
      }
      return noteApiFail(card, scheduleResult, 'Не удалось сохранить график');
    }
  }
  const main = await apiSend(`/staff/${encodeURIComponent(id)}`, 'PUT', {
    name: value('name').value,
    phone: value('phone').value,
    email: value('email').value,
    locationId: value('locationId')?.value || null,
    // employed сюда больше не идёт (22.08.2026) - трудоустройство меняет только
    // PUT /staff/:id/employment. Сервер без этого поля оставляет колонку как есть
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
  // Роль уезжает, только когда её реально сменили: она живёт отдельным
  // owner-роутом, и лишний PUT на каждое сохранение карточки ничего не давал, зато
  // добавлял шаг, на котором всё могло оборваться
  const role = selectedRoleInput(card);
  if (role && role.value !== card.dataset.role) {
    const roleResult = await apiSend(`/staff/${encodeURIComponent(id)}/role`, 'PUT', { role: role.value });
    if (!roleResult.ok) return noteApiFail(card, roleResult, 'Данные сохранены, а роль не изменилась');
  }
  // Фотографии, помеченные к удалению, убираем последними: удаление необратимо, и
  // пока предыдущие шаги могут отказать, снимок остаётся на месте
  const pendingDelete = [...card.querySelectorAll('.team-media-item.is-pending-delete')];
  let avatarDeleted = false;
  for (const item of pendingDelete) {
    const result = await apiSend(`/staff/${encodeURIComponent(id)}/media/${encodeURIComponent(item.dataset.mediaId)}`, 'DELETE');
    if (!result.ok) return noteApiFail(card, result, 'Данные сохранены, а фотографию удалить не вышло');
    if (item.dataset.mediaKind === 'avatar') avatarDeleted = true;
  }
  noteOk(card, 'Сохранено');
  // Смена "Принимает клиентов" перестраивает состав колонок в Расписании, а тот
  // список собирается один раз при инициализации страницы (mastersOf в
  // wireScheduleViews) - повторный renderTeam его не трогает, и снятый с приёма
  // мастер оставался бы в календаре кликабельным до ручного F5 (жалоба Влада
  // 13.08.2026). Полная перезагрузка вместо точечной перерисовки сознательно:
  // renderLiveProof повторно звать нельзя, он задваивает обработчики (см.
  // crm-dashboard.js), а смена этого флага - редкая операция, не ежедневная.
  // Надпись у кнопки заменена всплывающим окном 17.08.2026 (та же правка Влада, что и
  // в noteOk): это был второй источник «сохранено...» справа от кнопки. Окну дана
  // секунда, иначе перезагрузка смахнёт его раньше, чем человек успеет прочитать -
  // и сохранение выглядело бы как самопроизвольный скачок страницы
  if (providesServicesChanged) {
    showSuccess('Сохранено, обновляю расписание');
    await new Promise((done) => setTimeout(done, 1000));
    window.location.reload();
    return;
  }
  await renderTeam();
  // Удалили фото профиля - кружки в «Дне»/«Неделе»/«Месяце» должны вернуться к
  // инициалам сразу, без перезагрузки страницы
  if (avatarDeleted) await window.__refreshScheduleViews?.({ all: true });
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
  let files = [...input.files];
  if (!files.length) return;
  const note = card.querySelector('[data-card-note]');
  const kind = input.name === 'avatar' ? 'avatar' : 'portfolio';
  // Фото профиля человек кадрирует сам (просьба Влада 15.08.2026): до этой правки в
  // кружок попадал центр исходника, и лицо на вертикальном снимке с телефона
  // срезалось. Портфолио показывается целиком, его кадрировать незачем
  if (kind === 'avatar') {
    let cropped;
    try {
      cropped = await cropSquareImage(files[0]);
    } catch {
      note.textContent = `${files[0].name}: не удалось открыть файл как изображение`;
      input.value = '';
      return;
    }
    // Отказались от кадрирования - ничего не загружаем и не пишем в базу
    if (!cropped) { input.value = ''; return; }
    files = [cropped];
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.size > 8 * 1024 * 1024) { note.textContent = `${file.name}: файл больше 8 МБ`; return; }
    const result = await uploadFile(card, file, kind, (percent) => { note.textContent = `Загружаю ${file.name}${percent == null ? '…' : `: ${percent}%`}`; });
    if (!result.ok) { noteFail(card, errorMessage(result, `${file.name}: не удалось загрузить`)); return; }
  }
  // Жалоба Влада 21.08.2026: «когда грузишь фото профиля, кнопка "Сохранить изменения"
  // не становится доступной». Живой прогон (tools/verify-2026-08-21-foto-profilya.mjs)
  // показал, что дело не в кнопке: фото уходит на сервер сразу, отдельным запросом, и
  // кнопке тут нечего делать - она сохраняет ПОЛЯ карточки. Настоящая поломка была в
  // обратной связи: подпись «Фото профиля обновлено» писалась в узел, который через
  // строку затирала renderTeam() (замер дал пустой [data-card-note] после загрузки).
  // Человек видел ровно ничего: серая кнопка и молчание, отсюда вывод «не сработало».
  // Теперь сообщение живёт в тосте (он переживает перерисовку) и заново ставится в
  // подпись УЖЕ НОВОЙ карточки после renderTeam.
  const doneText = kind === 'avatar' ? 'Фото профиля сохранено' : 'Фотографии загружены';
  // Тот же файл, выбранный второй раз подряд, иначе не вызывает change - человек
  // не смог бы перекадрировать снимок, не выбрав сначала какой-нибудь другой
  input.value = '';
  const staffId = card.dataset.staffId;
  await renderTeam();
  showSuccess(doneText);
  showNote(document.querySelector(`.team-editor-card[data-staff-id="${CSS.escape(staffId)}"]`), doneText);
  // Фото стоит не только в «Команде»: те же кружки в «Дне»/«Неделе»/«Месяце».
  // Перерисовываем расписание сразу, чтобы новое фото было видно без перезагрузки
  // страницы (Влад, 15.08.2026)
  if (kind === 'avatar') await window.__refreshScheduleViews?.({ all: true });
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
    if (!result.ok) { noteFail(root, result.status === 409 ? P('team.exceptionConflict') : errorMessage(result, 'Не удалось сохранить разовое изменение')); await loadExceptions(root); return; }
    noteOk(root, 'Разовое изменение сохранено');
    await loadExceptions(root);
  } catch (err) {
    noteFail(root, errorMessage(err, 'Не удалось сохранить разовое изменение'));
  }
}

// Поля, которые уезжают на сервер по кнопке "Сохранить изменения". Услуги, график и
// фотографии сохраняются сами по себе, отдельными запросами - их правка кнопку не
// касается, поэтому в снимок они не входят.
const SAVED_FIELDS = ['name', 'phone', 'email', 'locationId', 'providesServices', 'publicProfileEnabled', 'experience', 'strengths', 'certificates'];

function cardSnapshot(card) {
  const values = SAVED_FIELDS.map((name) => {
    const field = card.querySelector(`[name="${name}"]`);
    if (!field) return '';
    return field.type === 'checkbox' ? String(field.checked) : String(field.value);
  });
  values.push(selectedRoleInput(card)?.value ?? '');
  return values.join('\u0000');
}

// Кнопка сохранения активна только когда в карточке реально что-то изменили: до
// этого нажимать нечего, и активная кнопка вводит в заблуждение (правка Влада
// 13.08.2026). Снимок снимается при отрисовке, сравнение - на каждый ввод.
// Ранний выход по data-locked-owner убран 17.08.2026 (Влад на проде, кабинет
// управляющего): карточка владельца получает этот признак у управляющего, и кнопка
// сохранения оставалась серой НАВСЕГДА - при том что витрина на сайте («Показывать
// профиль на сайте», стаж, сильные стороны, фото) в ней не заблокирована и щёлкается.
// Получался ровно тот мёртвый контрол, который чинили 16.08.2026 в mediaMarkup:
// галка переключается, кнопка не просыпается, применилось или нет - не понять.
// Сервер эту правку разрешает: замок защищённого владельца сужен 13.08.2026 до роли,
// доступа и трудоустройства (api/lib/permissions.js), а витрина прямо помечена как
// «никого не может запереть в системе» (handleStaffPortfolio). Роль и рабочий статус
// заперты по-прежнему - своими признаками (roleBadge без value, employmentLocked).
function updateSaveState(card) {
  const button = card.querySelector('[data-save]');
  if (!button) return;
  const fieldsChanged = cardSnapshot(card) !== card.dataset.snapshot;
  const servicesChanged = collectServiceChanges(card.querySelector('.service-picker')).length > 0;
  const scheduleChanged = hasWeeklyScheduleChanges(card.dataset.staffId);
  // Помеченная к удалению фотография - тоже несохранённое изменение: без этого
  // кнопка оставалась серой и удалить снимок было нечем
  const mediaMarked = Boolean(card.querySelector('.team-media-item.is-pending-delete'));
  button.disabled = !fieldsChanged && !servicesChanged && !scheduleChanged && !mediaMarked;
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

// Владелец задаёт пароль сотруднику (20.08.2026, переименовано в Окне 72). Отдельная
// кнопка и отдельный роут: к общему «Сохранить изменения» это не относится, иначе
// пароль уезжал бы вместе с
// именем и телефоном, и его нельзя было бы задать, не тронув остальное.
async function savePin(button) {
  const card = button.closest('[data-staff-id]');
  const staffId = card?.dataset.staffId;
  const newEl = card?.querySelector('.pin-new');
  const repeatEl = card?.querySelector('.pin-repeat');
  const note = card?.querySelector('[data-pin-note]');
  if (!staffId || !newEl || !repeatEl) return;
  const fail = (text, focus) => {
    if (note) note.textContent = text;
    showError(text);
    focus?.focus();
  };
  const newPin = newEl.value.trim();
  // Минимум шесть знаков - то же правило, что на сервере (isValidSecret,
  // api/routes/staff.js). Держим его здесь, чтобы человек узнал об этом до
  // отправки, а не из отказа
  if (newPin.length < 6) return fail('Пароль - минимум шесть знаков', newEl);
  if (newPin.length > 72) return fail('Пароль слишком длинный - до 72 знаков', newEl);
  if (newPin !== repeatEl.value.trim()) return fail('Пароль и повтор не совпали', repeatEl);
  setButtonBusy(button, true);
  const result = await apiSend(`/staff/${staffId}/pin`, 'PUT', { newPin });
  setButtonBusy(button, false);
  if (!result.ok) {
    const text = errorMessage(result, 'Не удалось задать пароль');
    if (note) note.textContent = text;
    showError(text);
    return;
  }
  // Поля не оставляем заполненными: карточка часто открыта на экране в зале,
  // и заданный пароль не должен висеть на нём до перезагрузки страницы
  newEl.value = '';
  repeatEl.value = '';
  const name = card.querySelector('.summary-meta .name')?.textContent?.trim() || 'сотрудника';
  const text = `Пароль задан. Передайте его ${name} - войти по старому уже нельзя`;
  if (note) note.textContent = text;
  showSuccess(text);
}

// Увольнение и возврат в команду. Подтверждение - двухшаговая замена кнопки прямо в
// секции, конвенция проекта (нативный window.confirm не используется, см.
// assets/crm-booking-status.js wireBookingDelete). В тексте подтверждения сказано и
// что оборвётся, и что сохранится: владелец салона должен понимать, что «уволить» в
// CRM не стирает ни выручку, ни статистику - иначе он побоится нажать и будет держать
// в команде людей, которые давно ушли
function wireEmployment(root) {
  root.querySelectorAll('[data-employment]').forEach((zone) => {
    const staffId = zone.dataset.staffId;
    const employed = zone.dataset.employed === '1';
    const actions = zone.querySelector('[data-employment-actions]');
    // Именно .team-editor-card, а не ближайший [data-staff-id]: он есть и у самой
    // зоны увольнения, и closest вернул бы её же - в подтверждении вместо имени
    // человека стояло безликое «Сотрудник» (видно на скриншоте 22.08.2026)
    const card = zone.closest('.team-editor-card');
    const name = card?.querySelector('.summary-meta .name')?.textContent?.trim() || 'Сотрудник';

    const renderIdle = () => {
      actions.innerHTML = employed
        ? '<button type="button" class="btn btn-danger btn-sm" data-fire>Уволить</button>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-rehire>Вернуть в команду</button>';
      actions.querySelector('[data-fire]')?.addEventListener('click', renderConfirmFire);
      actions.querySelector('[data-rehire]')?.addEventListener('click', () => apply(true));
    };

    const renderConfirmFire = () => {
      actions.innerHTML = `<p class="payroll-note">${esc(P('team.fireConfirm', { name }))}</p>
        <button type="button" class="btn btn-danger btn-sm" data-fire-yes>Да, уволить</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fire-no>Отмена</button>`;
      actions.querySelector('[data-fire-yes]').addEventListener('click', () => apply(false));
      actions.querySelector('[data-fire-no]').addEventListener('click', renderIdle);
    };

    const apply = async (nextEmployed) => {
      showNoteSpinner(zone, nextEmployed ? 'Возвращаю в команду' : 'Оформляю увольнение');
      const result = await apiSend(`/staff/${encodeURIComponent(staffId)}/employment`, 'PUT', { employed: nextEmployed });
      if (!result.ok) return noteApiFail(zone, result, nextEmployed ? 'Не удалось вернуть в команду' : 'Не удалось уволить');
      showSuccess(nextEmployed ? `${name} снова в команде` : `${name} уволен`);
      // Полная перезагрузка, а не renderTeam: состав команды меняет колонки в
      // «Расписании», а они собираются один раз при инициализации страницы (та же
      // причина, по которой перезагружается смена «Принимает клиентов», см. saveCard)
      await new Promise((done) => setTimeout(done, 800));
      window.location.reload();
    };

    if (actions) renderIdle();
  });
}

function wire(root) {
  wirePhoneFields(root);
  wireEmployment(root);
  root.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', () => saveCard(button.closest('[data-staff-id]'))));
  root.querySelectorAll('[data-pin-save]').forEach((button) => button.addEventListener('click', () => savePin(button)));
  root.querySelectorAll('input[type=file]').forEach((input) => input.addEventListener('change', () => uploadMedia(input.closest('[data-staff-id]'), input)));
  root.querySelectorAll('[data-media-list]').forEach((list) => list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const card = list.closest('[data-staff-id]');
    // Удаление фотографии больше не срабатывает сразу (правка Влада 15.08.2026):
    // кнопка только помечает снимок, а исчезает он с сервера по «Сохранить
    // изменения». Пока не сохранили, пометку снимает и повторный клик («Вернуть»), и
    // кнопка обновления - она перерисовывает карточки тем, что лежит в базе
    if (button.dataset.mediaDelete) {
      const item = button.closest('.team-media-item');
      const marked = item.classList.toggle('is-pending-delete');
      button.textContent = marked ? 'Вернуть' : 'Удалить';
      showNote(card, marked
        ? 'Фотография удалится, когда нажмёте «Сохранить изменения»'
        : 'Фотография остаётся на месте');
      card.dispatchEvent(new CustomEvent('crm:card-dirty', { bubbles: true }));
      return;
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
      event.currentTarget.textContent = 'Пароль скопирован';
    } catch {
      event.currentTarget.textContent = 'Не удалось скопировать';
      showError('Не удалось скопировать пароль. Выделите его и скопируйте вручную');
    }
  });
  create?.addEventListener('click', async () => {
    const card = create.closest('details');
    const value = (name) => cardValue(card, name);
    showNote(card, 'Создаю…');
    const out = await apiSend('/staff', 'POST', { name: value('name').value, phone: value('phone').value, email: value('email').value, locationId: value('locationId')?.value || null, role: selectedRoleInput(card)?.value, providesServices: value('providesServices').checked });
    if (!out.ok) return noteApiFail(card, out, 'Не удалось создать сотрудника');
    lastCreatedCredentials = { name: value('name').value.trim(), pin: out.data.temporaryPin };
    await renderTeam();
  });
}

// Защиту от параллельного запуска здесь пробовали 17.08.2026 и убрали в тот же день:
// хранение «текущего» промиса в модульной переменной приводило к тому, что раздел
// «Команда» переставал рисоваться совсем - повторные вызовы получали чужой, уже
// завершившийся пустой промис вместо настоящей отрисовки. Живой заход показал пустой
// скелетон и через 30 секунд. Если гонку двух перерисовок понадобится закрывать - делать
// это не общим замком на функцию, а проверкой актуальности данных перед записью в DOM
export async function renderTeam() {
  if (!getToken()) return;
  const host = document.querySelector('.panel-b .staff-list');
  if (!host) return;
  const openStaffIds = new Set([...host.querySelectorAll('.team-editor-card[open][data-staff-id]')].map((card) => card.dataset.staffId));
  try {
    const [rows, services, masterServices, me, locations] = await Promise.all([
      fetchJson('/staff'), fetchJson('/services'), fetch(`${API}/master-services`).then((response) => response.json()), fetchJson('/auth/me'), fetchJson('/locations'),
    ]);
    const canEdit = MANAGEMENT_VIEWERS.includes(me.staff.role);
    // Заведение сотрудника - POST /staff, тоже management. Администратору карточку
    // «Добавить сотрудника» не показываем (16.08.2026): раньше её тут не мог увидеть
    // никто, кроме владельца и управляющего, потому что раздел был только у них.
    // Уволенные отделены от действующего состава (22.08.2026). До этого они лежали в
    // общем списке вперемешку и ничем не отличались - владелец не мог сказать, кто у
    // него сейчас работает. Блок «Уволенные» свёрнут: это архив, к нему обращаются
    // редко, но данные из него никуда не деваются
    const active = rows.filter((staff) => staff.employed !== false);
    const fired = rows.filter((staff) => staff.employed === false);
    const cardsOf = (list) => list.map((staff) => staffCard(staff, me.staff.role, locations, me.staff.id)).join('');
    host.innerHTML = cardsOf(active)
      + (canEdit ? addCard(locations) : '')
      + (fired.length ? `<section class="team-fired-group"><details class="team-fired-toggle"><summary><span class="team-fired-title">Уволенные</span><span class="team-fired-count">${fired.length}</span><span class="chevron">▸</span></summary><p class="payroll-note">${P('team.firedHistoryKept')}</p>${cardsOf(fired)}</details></section>` : '');
    openStaffIds.forEach((staffId) => host.querySelector(`.team-editor-card[data-staff-id="${CSS.escape(staffId)}"]`)?.setAttribute('open', ''));
    const canEditSchedule = SCHEDULE_EDITORS.includes(me.staff.role);
    rows.forEach((staff) => {
      // Услуги снятого с приёма не выбираются вовсе (canEdit=false отключает чекбоксы
      // и поля длительности штатным путём). График сознательно НЕ отключаем: он есть и
      // у администратора - человеку нужно видеть и менять свои смены и выходные, даже
      // когда он не появляется в расписании записи (правка Влада 13.08.2026).
      const staffCanEdit = canEdit && !(me.staff.role === 'manager' && staff.protectedOwner);
      // Контейнера у того, кто клиентов не принимает, больше нет вовсе (правка
      // 27.08.2026) - редактор в этом случае даже не зовём, иначе он упал бы на null
      const picker = host.querySelector(`.service-picker[data-master-id="${staff.id}"]`);
      if (picker) {
        renderMasterServiceEditor(picker, staff.id, staffCanEdit && staff.providesServices !== false, services, masterServices, () => {
          picker.closest('.team-editor-card')?.dispatchEvent(new CustomEvent('crm:card-dirty', { bubbles: true }));
        });
      }
      wireWeeklyScheduleEditor(staff.id, canEditSchedule && !(me.staff.role === 'manager' && staff.protectedOwner), fetchJson);
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

// Кнопка обновления в шапке (assets/crm-refresh-control.js) перечитывает карточки
// команды этим хуком. Правка Влада 15.08.2026: раньше кнопка обновляла только
// календарь, уведомления и сводку - карточка сотрудника оставалась с тем, что человек
// набрал руками. Поменял длительность услуги с 40 на 20, не сохранил, нажал
// «Обновить» - и на экране по-прежнему 20, хотя в базе 40. Теперь карточки рисуются
// заново из ответа сервера, то есть показывают именно сохранённое.
window.__refreshTeam = renderTeam;

// Есть ли в команде правки, которые человек ещё не сохранил. Кнопка сохранения
// карточки активна ровно тогда, когда снимок полей разошёлся с загруженным
// (updateSaveState) - отдельного состояния для этого заводить не нужно
window.__teamHasUnsavedChanges = () =>
  document.querySelectorAll('.team-editor-card [data-save]:not([disabled])').length > 0;
