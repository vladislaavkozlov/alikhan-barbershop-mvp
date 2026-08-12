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

test('раздел сотрудников не предлагает администратору функции владельца и показывает Елизавету', async () => {
  const html = await source('crm-admin.html');

  assert.doesNotMatch(html, /\+ Добавить сотрудника/);
  assert.doesNotMatch(html, /Роль и список услуг - только для просмотра, менять может владелец/);
  assert.match(html, /staffCard-master-3/);
  assert.match(html, /Елизавета/);
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
  assert.match(shell, /order: \['schedule', 'team', 'profile'\]/);
  assert.match(shell, /profile: 'pt-c'/);
  assert.match(self, /current\.name \|\| staff\.name/);
  assert.match(self, /current\.phone \|\| staff\.phone/);
  assert.match(self, /current\.email \|\| staff\.email/);
});

test('список сотрудников сохраняет мастера без графика, расписание исключает его отдельно', async () => {
  const schedule = await source('assets/crm-calendar.js');
  const staffRoute = await source('api/lib/schedule-core.js');

  assert.match(staffRoute, /viewerRole === 'admin'/);
  assert.match(staffRoute, /hasWorkingSchedule/);
  assert.match(schedule, /hasWorkingSchedule !== false/);
});
