// Окно 22 (04.08.2026, Задача 1) - unit на filterStaffForViewer: мастер без рабочего
// графика (is_working=true нигде в master_weekly_schedule) не должен быть виден
// не-владельцу, владелец видит всех + hasWorkingSchedule. In-memory, без реального
// Postgres - тот же приём, что уже используется в tests/api.schedule-range.test.js
// (server.mjs экспортирует чистую функцию, сервер сам не стартует при импорте).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterStaffForViewer } from '../api/server.mjs';

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

test('admin/master не видят мастера без рабочего графика вовсе', () => {
  const forAdmin = filterStaffForViewer(STAFF, 'admin', SCHEDULED);
  assert.deepEqual(
    forAdmin.map((r) => r.id),
    ['master-1', 'master-2', 'admin-1']
  );
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

test('пустой scheduledMasterIds - все providesServices=true скрыты от не-владельца', () => {
  const result = filterStaffForViewer(STAFF, 'admin', new Set());
  assert.deepEqual(
    result.map((r) => r.id),
    ['admin-1']
  );
});
