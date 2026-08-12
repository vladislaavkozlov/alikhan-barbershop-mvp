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
