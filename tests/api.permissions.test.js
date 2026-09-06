import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ASSIGNABLE_ROLES,
  BOOKING_OPERATOR_ROLES,
  BOOKING_STAFF_ROLES,
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

// Баг с прода 13.08.2026: управляющий получал 401 на смене статуса визита. Четыре
// роута (статус визита, добавление услуг, карточка клиента, клиенты в зоне риска)
// держали список ролей литералом ['owner','admin','master'] и не получили manager,
// когда роль вводило Окно 57. Тест держит два условия: общий список ролей знает
// управляющего, и в роутах нет литералов, мимо которых проедет следующая роль.
test('роуты записи и клиентов пускают управляющего наравне с владельцем', async () => {
  assert.deepEqual(BOOKING_STAFF_ROLES, ['owner', 'manager', 'admin', 'master']);
  const root = new URL('../', import.meta.url);
  for (const file of ['api/routes/bookings.js', 'api/routes/clients.js']) {
    const src = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(src, /requireRole\(auth, \[/, `${file}: список ролей должен идти из permissions.js, не литералом`);
  }
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

// 06.09.2026, разбор жалобы «сыплются ошибки: не удалось загрузить график». Гейт
// реестра отвечал 401 и на «нет сессии», и на «сессия есть, но роль не та». Кабинет
// переводит любой 401 в «Сессия закончилась. Войдите заново» (assets/crm-toast.js,
// STATUS_TEXT) - и человек с недостающими правами входил по кругу, каждый раз получая
// тот же совет. Разделение кодов важнее формальности: 401 говорит «войди», 403 -
// «войти не поможет, дело в роли».
test('гейт прав: 401 только когда сессии нет, нехватка роли - это 403', async () => {
  const source = await readFile(new URL('../api/server.mjs', import.meta.url), 'utf8');
  const gate = source.slice(source.indexOf("if (matchedRoute.auth !== 'public')"), source.indexOf('// /health обработан выше'));
  assert.match(gate, /if \(!gateAuth\) return sendJson\(res, 401/, 'отсутствие сессии обязано оставаться 401');
  assert.match(gate, /canManageStaff\(gateAuth\)\) return sendJson\(res, 403/, 'management без прав - 403');
  assert.match(gate, /requireRole\(gateAuth, \['owner'\]\)\) return sendJson\(res, 403/, 'owner-роуты без прав - 403');
  // Комментарии из проверки убираем: в них 401 и 403 упоминаются как раз для того,
  // чтобы объяснить разницу, и ловить их регуляркой значит ловить собственный текст
  const code = gate.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const codeWithoutNoSession = code.replace(/if \(!gateAuth\) return sendJson\(res, 401[^\n]*\n/, '');
  assert.doesNotMatch(codeWithoutNoSession, /401/, 'других 401 в гейте быть не должно');
});
