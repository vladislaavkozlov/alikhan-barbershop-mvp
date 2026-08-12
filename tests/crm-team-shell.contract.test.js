import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ASSIGNABLE_ROLES,
  BOOKING_OPERATOR_ROLES,
  MANAGEMENT_ROLES,
  PUBLIC_MASTER_FORBIDDEN_FIELDS,
  STAFF_CONTRACT_FIELDS,
  TEAM_SECTION_ORDER,
} from './fixtures/team-contracts.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('контракт shell фиксирует существующие sidebar, topbar и закрытую карточку', async () => {
  const [owner, shell, panels] = await Promise.all([
    source('crm-owner.html'), source('assets/crm-app-shell.js'), source('assets/crm-navigation-panels.css'),
  ]);
  assert.match(owner, /<body class="crm-navigation-ui">/);
  assert.match(owner, /id="crmMain"/);
  assert.match(shell, /className = 'app-sidebar'/);
  assert.match(shell, /app-sidebar-toggle/);
  assert.match(panels, /details\.staff-card:not\(\[open\]\):hover/);
  assert.match(panels, /details\.staff-card summary \{/);
});

test('контракты ролей и публичных данных соответствуют ТЗ', () => {
  assert.deepEqual(MANAGEMENT_ROLES, ['owner', 'manager']);
  assert.deepEqual(BOOKING_OPERATOR_ROLES, ['owner', 'manager', 'admin']);
  assert.deepEqual(ASSIGNABLE_ROLES, ['master', 'admin', 'manager']);
  assert.ok(STAFF_CONTRACT_FIELDS.includes('providesServices'));
  assert.ok(STAFF_CONTRACT_FIELDS.includes('publicProfileEnabled'));
  for (const field of ['phone', 'email', 'role', 'pin', 'hasSystemAccess']) {
    assert.ok(PUBLIC_MASTER_FORBIDDEN_FIELDS.includes(field));
  }
  assert.deepEqual(TEAM_SECTION_ORDER, ['Основное', 'Профиль на сайте', 'Услуги и время', 'График', 'Доступ']);
});
