import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('все три кабинета подключают общий слой навигационных панелей', async () => {
  const pages = await Promise.all(['crm-owner.html', 'crm-admin.html', 'crm-master.html'].map(source));

  for (const html of pages) {
    assert.match(html, /<body class="crm-navigation-ui">/);
    assert.match(html, /assets\/crm-navigation-panels\.css/);
    assert.match(html, /class="[^"]*crm-top-action/);
  }
  assert.equal((pages[0].match(/<details class="staff-card/g) || []).length, 12);
  assert.equal((pages[1].match(/<details class="staff-card/g) || []).length, 2);
  assert.equal((pages[2].match(/<details class="staff-card/g) || []).length, 1);
});

test('стиль ограничен CRM-кабинетами и описывает оба состояния', async () => {
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(css, /\.crm-navigation-ui details\.staff-card/);
  assert.match(css, /details\.staff-card\[open\]/);
  assert.match(css, /\.crm-navigation-ui \.crm-top-action/);
  assert.match(css, /\.crm-navigation-ui \.owner-schedule-alert/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

test('служебные иконки и иконка предупреждения не имеют постоянных рамок', async () => {
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(css, /\.notif-bell\.crm-top-action,[\s\S]*?\.logout-btn\.crm-top-action \{[\s\S]*?border: 0;/);
  assert.match(css, /\.owner-schedule-alert__icon \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/);
});

test('верхние SVG и предупреждения используют цвет и геометрию иконок сайдбара', async () => {
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(css, /\.notif-bell\.crm-top-action \{[\s\S]*?color: var\(--text-muted\);/);
  assert.match(css, /\.notif-bell\.crm-top-action svg \{[\s\S]*?width: 18px;[\s\S]*?height: 18px;[\s\S]*?stroke-width: 1\.6;/);
  assert.match(css, /\.owner-schedule-alert__icon \{[\s\S]*?color: var\(--text-muted\);/);
});

test('панели начинаются с общего края без старой внешней карточки', async () => {
  const css = await source('assets/crm-navigation-panels.css');
  const owner = await source('crm-owner.html');

  assert.match(css, /\.page-tabs > \.tab-panel > section \{[\s\S]*?background: transparent;[\s\S]*?border: 0;[\s\S]*?padding: 0;/);
  assert.ok(owner.indexOf('class="staff-list schedule-view-cards"') < owner.indexOf('id="ownerAlertsSchedule"'));
});

test('панельные иконки не имеют рамок и используют цвет сайдбара', async () => {
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(css, /details\.staff-card \.avatar-icon \{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?color: var\(--text-muted\);/);
  assert.match(css, /details\.staff-card\[open\] \.avatar-icon \{[\s\S]*?background: transparent;[\s\S]*?color: var\(--accent\);/);
});

test('все навигационные стрелки используют ровный SVG-mask и меняют цвет', async () => {
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(css, /\.chevron::before[\s\S]*?mask:[^;]*data:image\/svg\+xml/);
  assert.match(css, /\.day-nav-btn::before[\s\S]*?mask:[^;]*data:image\/svg\+xml/);
  assert.match(css, /\.custom-date-nav-btn::before[\s\S]*?mask:[^;]*data:image\/svg\+xml/);
  assert.match(css, /summary:hover \.chevron[\s\S]*?color: var\(--text\);/);
  assert.match(css, /\.day-nav-btn:hover[\s\S]*?color: var\(--text\);/);
});

test('hover верхних действий и закрытых панелей повторяет поверхность сайдбара', async () => {
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(css, /\.crm-top-action:hover[\s\S]*?background: var\(--surface-2\);[\s\S]*?color: var\(--text\);/);
  assert.match(css, /details\.staff-card:not\(\[open\]\):hover[\s\S]*?background: var\(--surface-2\);/);
});

test('предупреждение о графике использует новый семантический компонент', async () => {
  const js = await source('assets/crm-schedule-alerts.js');

  assert.match(js, /owner-schedule-alert/);
  assert.match(js, /owner-schedule-alert__icon/);
  assert.match(js, /owner-schedule-alert__action/);
  assert.match(js, /data-open-schedule-tab/);
});

test('утверждённая дизайн-конвенция сохранена в проекте', async () => {
  const convention = await source('docs/design/crm-navigation-panels.md');

  assert.match(convention, /Золотая линия состояния/);
  assert.match(convention, /crm-navigation-panels\.css/);
  assert.match(convention, /crm-navigation-panels-approved\.png/);
});

test('общий модуль управляет всеми панелями только внутри своего списка', async () => {
  const js = await source('assets/crm-navigation-panels.js');
  const pages = await Promise.all(['crm-owner.html', 'crm-admin.html', 'crm-master.html'].map(source));

  assert.match(js, /:scope > details\.staff-card/);
  assert.match(js, /Развернуть все/);
  assert.match(js, /Свернуть все/);
  assert.match(js, /aria-expanded/);
  for (const page of pages) assert.match(page, /initCrmNavigationPanels/);
});

test('панель новой записи доступна только ролям с правом создавать запись', async () => {
  const owner = await source('crm-owner.html');
  const admin = await source('crm-admin.html');
  const master = await source('crm-master.html');
  const walkin = await source('assets/crm-walkin.js');

  assert.match(owner, /upgradeBookingPanel/);
  assert.match(admin, /upgradeBookingPanel/);
  assert.doesNotMatch(master, /upgradeBookingPanel/);
  assert.match(walkin, /openManualBooking/);
  assert.match(walkin, /options\.manual/);
  assert.match(walkin, /closest\('details\.booking-create-card'\)/);
  assert.match(walkin, /manual[\s\S]*?hasWorkingSchedule !== false/);
  const panels = await source('assets/crm-navigation-panels.js');
  assert.match(panels, /if \(!details\.open\)[\s\S]*?form\.hidden = true/);
});

test('расписание мастера использует панели День Неделя Месяц без Года и дубля сообщений', async () => {
  const master = await source('crm-master.html');
  assert.match(master, /upgradeScheduleViews\(\['day', 'week', 'month'\]\)/);
  assert.equal((master.match(/id="msgBell"/g) || []).length, 1);
  assert.doesNotMatch(master, /toggleRetentionPanel/);
});

test('окно входа использует доступную разметку и scoped стиль CRM', async () => {
  const auth = await source('assets/crm-auth.js');
  const css = await source('assets/crm-navigation-panels.css');

  assert.match(auth, /for="loginEmail"/);
  assert.match(auth, /for="loginPin"/);
  assert.match(auth, /id="loginError"[^>]*role="alert"[^>]*aria-live="polite"/);
  assert.doesNotMatch(auth, /тестовый контур|Доступы - у Влада/);
  assert.match(css, /\.crm-navigation-ui \.login-card::before/);
  assert.match(css, /\.crm-navigation-ui \.login-card input:focus-visible/);
  const loginSelectors = css.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('.') && line.includes('.login-'));
  assert.ok(loginSelectors.length > 0);
  assert.ok(loginSelectors.every((selector) => selector.startsWith('.crm-navigation-ui')));
});
