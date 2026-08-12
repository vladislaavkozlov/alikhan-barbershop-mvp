import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('кнопка мягкого обновления доступна владельцу администратору и мастеру', async () => {
  const pages = await Promise.all(['crm-owner.html', 'crm-admin.html', 'crm-master.html'].map(source));

  for (const html of pages) {
    assert.equal((html.match(/id="refreshBtn"/g) || []).length, 1);
    assert.match(html, /id="refreshBtn"[^>]*aria-label="Обновить данные"/);
    assert.match(html, /initCrmRefreshControl/);
  }
});

test('общий refresh-контрол обновляет только безопасные повторные рендеры', async () => {
  const refresh = await source('assets/crm-refresh-control.js');
  const auth = await source('assets/crm-auth.js');
  const dashboard = await source('assets/crm-dashboard.js');
  const notifications = await source('assets/crm-notifications.js');

  assert.match(refresh, /window\.__refreshScheduleViews/);
  assert.match(refresh, /window\.__refreshRoleSnapshot/);
  assert.match(refresh, /window\.__refreshNotifications/);
  assert.match(refresh, /window\.__refreshOwnerDashboard/);
  assert.doesNotMatch(refresh, /location\.reload/);
  assert.doesNotMatch(refresh, /renderLiveProof/);
  assert.match(auth, /window\.__refreshRoleSnapshot/);
  assert.match(dashboard, /refreshRoleSnapshot/);
  assert.match(notifications, /window\.__refreshNotifications/);
});

test('общий refresh-контрол блокирует повторный клик и сохраняет индикацию', async () => {
  const refresh = await source('assets/crm-refresh-control.js');

  assert.match(refresh, /button\.disabled = true/);
  assert.match(refresh, /button\.classList\.add\('is-refreshing'\)/);
  assert.match(refresh, /button\.disabled = false/);
  assert.match(refresh, /button\.classList\.remove\('is-refreshing'\)/);
});
