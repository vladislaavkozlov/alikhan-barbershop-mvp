// График работы меняют только владелец и управляющий (правка Влада 28.08.2026).
//
// До этой правки изменение стояло на BOOKING_OPERATOR_ROLES - в этот список входит
// администратор, и он мог править смены мастеров своей точки. Здесь закрепляется
// новое правило и, отдельно, то, что ЧТЕНИЕ графика администратору осталось: без
// него он не сможет работать с записями, и сужение прав превратилось бы в поломку.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MANAGEMENT_ROLES, BOOKING_OPERATOR_ROLES, canManageStaff } from '../api/lib/permissions.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('право менять график - ровно владелец и управляющий', () => {
  assert.deepEqual(MANAGEMENT_ROLES, ['owner', 'manager']);
  assert.equal(canManageStaff({ role: 'owner' }), true);
  assert.equal(canManageStaff({ role: 'manager' }), true);
  assert.equal(canManageStaff({ role: 'admin' }), false, 'администратор снова получил право менять график');
  assert.equal(canManageStaff({ role: 'master' }), false);
  // Список операторов записи при этом не сужался - он про работу с записями
  assert.deepEqual(BOOKING_OPERATOR_ROLES, ['owner', 'manager', 'admin']);
});

test('все четыре точки изменения графика закрыты управленческим замком', async () => {
  const schedule = await source('api/routes/schedule.js');
  // Четыре точки правки графика: разовые исключения, создание смены, удаление
  // смены, недельный график. Плюс пятая - закрытие салона на праздники, она стояла
  // под этим замком и до правки, её сюда не переводили
  const guards = schedule.match(/if \(!canManageStaff\(auth\)\) return sendJson\(res, 401/g) ?? [];
  assert.equal(guards.length, 5, `точек с управленческим замком должно быть 5, найдено ${guards.length}`);
  // И ни одна из них не осталась на прежнем, более широком списке
  assert.doesNotMatch(
    schedule,
    /if \(!requireRole\(auth, BOOKING_OPERATOR_ROLES\)\) return sendJson\(res, 401/,
    'какая-то точка изменения графика всё ещё пускает администратора',
  );
});

test('чтение графика администратору осталось - иначе он не сможет работать с записями', async () => {
  const schedule = await source('api/routes/schedule.js');
  // Ветки «админ видит только свою точку» относятся к чтению и обязаны сохраниться
  assert.match(schedule, /auth\.role === 'admin'/, 'вместе с правкой вырезали и чтение графика для администратора');
});

test('интерфейс не ведёт в отказ: правка дня закрыта и в матрице, и в самой модалке', async () => {
  const views = await source('assets/crm-schedule-views.js');
  const month = await source('assets/crm-schedule-view-month.js');
  const week = await source('assets/crm-schedule-view-week.js');

  assert.match(views, /const canEditSchedule = staff\.role === 'owner' \|\| staff\.role === 'manager';/);
  // Прежний признак выводился из одного лишь isSolo - то есть «все, кроме мастера»
  assert.doesNotMatch(month, /editable: !isSolo/, 'месяц снова разрешает правку всем, кроме мастера');
  assert.doesNotMatch(week, /editable: !isSolo/, 'неделя снова разрешает правку всем, кроме мастера');
  assert.match(month, /if \(!canEditSchedule\) return;/, 'модалка правки дня открывается без проверки прав');
});
