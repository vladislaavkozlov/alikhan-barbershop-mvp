import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const pages = [
  ['crm-owner.html', 'owner', 'Владелец'],
  ['crm-admin.html', 'admin', 'Администратор'],
  ['crm-master.html', 'master', 'Мастер'],
];

test('каждый кабинет показывает одну статичную метку своей роли без переходов', async () => {
  for (const [path, role, label] of pages) {
    const html = await readFile(new URL(path, root), 'utf8');
    const block = html.match(/<div class="role-switch" id="roleSwitch">([\s\S]*?)<\/div>/)?.[1] || '';

    assert.doesNotMatch(block, /<a\b/, `${path}: роль не должна быть ссылкой`);
    assert.doesNotMatch(block, /href=/, `${path}: роль не должна вести на другую страницу`);
    assert.equal((block.match(/data-role=/g) || []).length, 1, `${path}: должна остаться одна роль`);
    assert.match(block, new RegExp(`<span class="crm-top-action" data-role="${role}" aria-current="page">${label}<\\/span>`));
  }
});

test('auth работает с индикатором роли, а CSS не раскрывает hidden-элементы', async () => {
  const auth = await readFile(new URL('assets/crm-auth.js', root), 'utf8');
  const css = await readFile(new URL('assets/crm-navigation-panels.css', root), 'utf8');

  assert.match(auth, /#roleSwitch \[data-role\]/);
  assert.match(css, /\.crm-top-action\[hidden\][\s\S]*?display: none/);
});
