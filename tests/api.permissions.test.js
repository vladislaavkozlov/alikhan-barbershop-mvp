import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ASSIGNABLE_ROLES,
  BOOKING_OPERATOR_ROLES,
  MANAGEMENT_ROLES,
  canManageStaff,
  canMutateProtectedOwner,
  isAssignableRole,
} from '../api/lib/permissions.js';

test('manager является управляющей ролью, но owner не назначается через обычный editor', () => {
  assert.deepEqual(MANAGEMENT_ROLES, ['owner', 'manager']);
  assert.deepEqual(BOOKING_OPERATOR_ROLES, ['owner', 'manager', 'admin']);
  assert.deepEqual(ASSIGNABLE_ROLES, ['master', 'admin', 'manager']);
  assert.equal(isAssignableRole('owner'), false);
  assert.equal(isAssignableRole('manager'), true);
});

test('только owner и manager получают управляющие права', () => {
  assert.equal(canManageStaff({ role: 'owner' }), true);
  assert.equal(canManageStaff({ role: 'manager' }), true);
  assert.equal(canManageStaff({ role: 'admin' }), false);
  assert.equal(canManageStaff({ role: 'master' }), false);
});

test('защищённый owner не изменяется никакой управляющей ролью', () => {
  assert.equal(canMutateProtectedOwner({ role: 'owner' }, { protectedOwner: true }), false);
  assert.equal(canMutateProtectedOwner({ role: 'manager' }, { protectedOwner: true }), false);
  assert.equal(canMutateProtectedOwner({ role: 'owner' }, { protectedOwner: false }), true);
});

test('сервер проверяет актуальный доступ и CRM перечитывает /auth/me', async () => {
  const root = new URL('../', import.meta.url);
  const [auth, staff, client] = await Promise.all([
    readFile(new URL('api/lib/auth.js', root), 'utf8'),
    readFile(new URL('api/routes/staff.js', root), 'utf8'),
    readFile(new URL('assets/crm-auth.js', root), 'utf8'),
  ]);
  assert.match(auth, /s\.employed = true AND s\.has_system_access = true/);
  assert.match(staff, /protected_owner/);
  assert.match(staff, /error: 'protected_owner'/);
  assert.match(client, /fetchJson\('\/auth\/me'\)/);
  assert.match(client, /manager: 'crm-owner\.html'/);
  assert.match(client, /isManagementIndicator/);
});
