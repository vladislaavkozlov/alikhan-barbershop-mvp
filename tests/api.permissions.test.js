import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ASSIGNABLE_ROLES,
  BOOKING_OPERATOR_ROLES,
  MANAGEMENT_ROLES,
  canManageStaff,
  canMutateProtectedOwner,
  guardAccountLockout,
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

test('роль защищённого owner не изменяется никакой управляющей ролью', () => {
  assert.equal(canMutateProtectedOwner({ role: 'owner' }, { protectedOwner: true }), false);
  assert.equal(canMutateProtectedOwner({ role: 'manager' }, { protectedOwner: true }), false);
  assert.equal(canMutateProtectedOwner({ role: 'owner' }, { protectedOwner: false }), true);
});

// Регрессия 13.08.2026: замок стоял на всём PUT /staff/:id, и владелец не мог
// сохранить собственную карточку вообще - CRM отвечала "Не удалось сохранить".
test('защищённого owner нельзя уволить и отрезать от системы никакой ролью', () => {
  const requested = { employed: false, hasSystemAccess: false };
  assert.deepEqual(guardAccountLockout({ protectedOwner: true }, requested), { employed: true, hasSystemAccess: true });
  assert.deepEqual(guardAccountLockout({ protectedOwner: true, isSelf: false }, requested), { employed: true, hasSystemAccess: true });
});

test('никто не снимает рабочий статус и доступ сам с себя - защита от самоблокировки', () => {
  const requested = { employed: false, hasSystemAccess: false };
  assert.deepEqual(guardAccountLockout({ isSelf: true }, requested), { employed: true, hasSystemAccess: true });
  assert.deepEqual(guardAccountLockout({ protectedOwner: false, isSelf: true }, requested), { employed: true, hasSystemAccess: true });
});

test('чужую карточку обычного сотрудника управляющий по-прежнему может закрыть', () => {
  const requested = { employed: false, hasSystemAccess: false };
  assert.deepEqual(guardAccountLockout({ protectedOwner: false, isSelf: false }, requested), { employed: false, hasSystemAccess: false });
});

test('замок не трогает поля, которые никого не запирают', () => {
  const requested = { employed: true, hasSystemAccess: true, name: 'Алиовсад', publicProfileEnabled: true };
  assert.deepEqual(guardAccountLockout({ protectedOwner: true }, requested), requested);
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
