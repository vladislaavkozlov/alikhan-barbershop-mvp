import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('шапка администратора содержит один рабочий колокольчик без legacy retention', async () => {
  const html = await source('crm-admin.html');

  assert.equal((html.match(/id="msgBell"/g) || []).length, 1);
  assert.match(html, /id="msgBell"[^>]*>\s*<span id="msgBellIcon"><\/span>/);
  assert.doesNotMatch(html, /toggleRetentionPanel|retention-panel|Клиенты, которые давно не приходили/);
});

test('расписание администратора использует панели День Неделя Месяц Запись', async () => {
  const html = await source('crm-admin.html');

  assert.match(html, /upgradeScheduleViews\(\['day', 'week', 'month'\]\)/);
  assert.match(html, /upgradeBookingPanel\(\)/);
  assert.doesNotMatch(html, /id="sp-year"|panel-sp-year|scheduleViewAnchor/);
  assert.doesNotMatch(html, /Выручка сегодня|Неопознанных визитов сегодня/);
});

// 16.08.2026. Раньше «Сотрудники» у администратора были статичным макетом Окна 9:
// три карточки, написанные руками, с выдуманными контактами (+7 900 000-00-01),
// бейджами «пример», аналитикой «00% пример» и ролью «Администратор + Мастер» у
// человека, который давно управляющий. Новый сотрудник там не появлялся никогда.
// Теперь раздел рисует общий renderTeam из GET /staff.
test('раздел сотрудников администратора живой, а не макет с придуманными людьми', async () => {
  const html = await source('crm-admin.html');

  assert.doesNotMatch(html, /\+ Добавить сотрудника/);
  assert.doesNotMatch(html, /badge-example|>пример</);
  // именно ЗНАЧЕНИЯ полей, а не placeholder формы записи (там номер-подсказка законна)
  assert.doesNotMatch(html, /value="\+7 900 000-00-0|value="\w+@example\.com/);
  assert.doesNotMatch(html, /staff\.provides_services/);
  assert.doesNotMatch(html, /Администратор \+ Мастер/);
  assert.doesNotMatch(html, /staffCard-master-3/);
  assert.match(html, /import '\.\/assets\/crm-team\.js'/);
  assert.match(html, /assets\/crm-team-content\.css/);
  assert.match(html, /<div class="tab-panel panel-b">[\s\S]{0,200}<div class="staff-list"><\/div>/);
});

// Право смотреть состав команды не равно праву его менять: на сервере состав,
// услуги, ставки и роли - MANAGEMENT_ROLES (owner+manager), а график - шире
// (BOOKING_OPERATOR_ROLES, туда входит и admin). Карточка обязана повторять это
// разделение, иначе администратор жмёт кнопки, которые вернут ему 401
test('карточка сотрудника у администратора - просмотр, кроме графика', async () => {
  const team = await source('assets/crm-team.js');

  assert.match(team, /const MANAGEMENT_VIEWERS = \['owner', 'manager'\]/);
  // 28.08.2026: администратор больше не правит график - список сузился до тех же
  // ролей, что и на сервере
  assert.match(team, /const SCHEDULE_EDITORS = \['owner', 'manager'\]/);
  assert.match(team, /const canManage = MANAGEMENT_VIEWERS\.includes\(viewerRole\)/);
  // поля и тумблеры состава закрыты для всех, кто не управляет командой
  assert.match(team, /const fieldsLocked = locked \|\| !canManage/);
  assert.match(team, /const employmentLocked = locked \|\| !canManage/);
  // секции с management-роутами не рисуются вовсе, а не рисуются нерабочими
  assert.match(team, /canManage \? section\('Профиль на сайте'/);
  assert.match(team, /canEdit \? addCard\(locations\) : ''/);
  // Сохранять в карточке администратору больше нечего (28.08.2026): график правят
  // только владелец и управляющий, поэтому у него нет ни секции графика, ни кнопки.
  // Прежде здесь проверялись data-schedule-only и «График сохранён» - и то, и другое
  // убрано вместе с самим правом
  assert.doesNotMatch(team, /button[^>]*data-save[^>]*data-schedule-only/);
  assert.match(team, /canManage \? section\('График'/, 'секция графика показывается не только управляющим');
});

test('администратор получил раздел Личные данные на реальных данных сессии', async () => {
  const html = await source('crm-admin.html');
  const shell = await source('assets/crm-app-shell.js');
  const dashboard = await source('assets/crm-dashboard.js');
  const self = await source('assets/crm-admin-self.js');

  assert.match(html, /id="pt-c"/);
  assert.match(html, /class="tab-panel panel-c"/);
  assert.match(html, /id="adminSelfName"/);
  assert.match(html, /id="adminSelfPhone"/);
  assert.match(html, /id="adminSelfEmail"/);
  assert.match(dashboard, /wireAdminSelfData\(staff, staffList\)/);
  // «Уведомления» добавлены администратору 28.08.2026 (находка Влада): колокольчик
  // в шапке у него был, а раздела с полными карточками записей не было нигде
  assert.match(shell, /order: \['schedule', 'team', 'notifications', 'profile'\]/);
  assert.match(shell, /profile: 'pt-c'/);
  assert.match(self, /current\.name \|\| staff\.name/);
  assert.match(self, /current\.phone \|\| staff\.phone/);
  assert.match(self, /current\.email \|\| staff\.email/);
});

test('список сотрудников сохраняет мастера без графика, расписание исключает его отдельно', async () => {
  const schedule = await source('assets/crm-calendar.js');
  const staffRoute = await source('api/lib/schedule-core.js');

  // 21.08.2026 - здесь стоял литерал `viewerRole === 'admin'`, и ровно этот литерал
  // был багом: роль manager в него не попала, управляющий проваливался в ветку
  // мастера и не видел сотрудника без графика. Проверяем не написание условия, а его
  // смысл - ветка «видят весь состав» идёт по ОБЩЕМУ списку ролей-операторов записи
  assert.match(staffRoute, /BOOKING_OPERATOR_ROLES\.includes\(viewerRole\)/);
  assert.match(staffRoute, /hasWorkingSchedule/);
  assert.match(schedule, /hasWorkingSchedule !== false/);
});
