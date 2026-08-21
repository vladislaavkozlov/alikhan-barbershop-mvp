// Окно 22 (04.08.2026, Задача 1) - unit на filterStaffForViewer: мастер без рабочего
// графика (is_working=true нигде в master_weekly_schedule) не должен попадать в
// расписание, но остаётся виден владельцу и администратору с явным флагом. Тест
// импортирует чистую бизнес-функцию напрямую и не требует Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterStaffForViewer } from '../api/lib/schedule-core.js';

const STAFF = [
  { id: 'master-1', name: 'Алиовсад', role: 'owner', providesServices: true },
  { id: 'master-2', name: 'Мамедхан', role: 'master', providesServices: true },
  { id: 'qa-window19-master', name: 'QA Тест', role: 'master', providesServices: true },
  { id: 'admin-1', name: 'Админ', role: 'admin', providesServices: false },
];

// master-1 и master-2 настроены (есть is_working=true строка), qa-window19-master - нет.
const SCHEDULED = new Set(['master-1', 'master-2']);

test('owner видит всех мастеров + hasWorkingSchedule на каждом providesServices', () => {
  const result = filterStaffForViewer(STAFF, 'owner', SCHEDULED);
  assert.equal(result.length, 4);
  const byId = new Map(result.map((r) => [r.id, r]));
  assert.equal(byId.get('master-1').hasWorkingSchedule, true);
  assert.equal(byId.get('master-2').hasWorkingSchedule, true);
  assert.equal(byId.get('qa-window19-master').hasWorkingSchedule, false);
  // Не-мастер (providesServices=false) не размечается флагом вовсе - для него график
  // не имеет смысла, не должно выглядеть как "не настроен".
  assert.equal('hasWorkingSchedule' in byId.get('admin-1'), false);
});

test('admin видит всех сотрудников точки с флагом графика, master не видит недоступного мастера', () => {
  const forAdmin = filterStaffForViewer(STAFF, 'admin', SCHEDULED);
  assert.deepEqual(
    forAdmin.map((r) => r.id),
    ['master-1', 'master-2', 'qa-window19-master', 'admin-1']
  );
  assert.equal(forAdmin.find((r) => r.id === 'qa-window19-master').hasWorkingSchedule, false);
  const forMaster = filterStaffForViewer(STAFF, 'master', SCHEDULED);
  assert.deepEqual(
    forMaster.map((r) => r.id),
    ['master-1', 'master-2', 'admin-1']
  );
});

test('мастер с хотя бы одним is_working=true - виден всем ролям', () => {
  const result = filterStaffForViewer(STAFF, 'admin', SCHEDULED);
  assert.ok(result.some((r) => r.id === 'master-2'));
});

test('пустой scheduledMasterIds - мастеру скрыты все providesServices=true', () => {
  const result = filterStaffForViewer(STAFF, 'master', new Set());
  assert.deepEqual(
    result.map((r) => r.id),
    ['admin-1']
  );
});

// 21.08.2026 - роль manager (Окно 57) в список ролей этой функции не попала:
// управляющий проваливался в ветку мастера, и GET /staff вырезал у него из ответа
// каждого, у кого ещё нет рабочего дня в графике. Только что нанятый мастер был
// виден владельцу и невидим управляющему - и в "Команде", и в "Финансах"
test('управляющий видит состав так же, как владелец - включая мастера без графика', () => {
  const forManager = filterStaffForViewer(STAFF, 'manager', SCHEDULED);
  const forOwner = filterStaffForViewer(STAFF, 'owner', SCHEDULED);
  assert.deepEqual(forManager.map((r) => r.id), forOwner.map((r) => r.id));
  assert.deepEqual(forManager, forOwner);
});

test('управляющему тоже видно, кому график ещё не настроен (hasWorkingSchedule)', () => {
  const forManager = filterStaffForViewer(STAFF, 'manager', new Set());
  const masters = forManager.filter((r) => r.providesServices);
  assert.ok(masters.length > 0);
  assert.ok(masters.every((r) => r.hasWorkingSchedule === false), JSON.stringify(masters));
});
