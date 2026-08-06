// Окно 35 (06.08.2026) - юниты на findMastersMissingSchedule/notifyOwnerAboutMastersMissingSchedule
// (FINAL_PRODUCT_DECISION.md MUST HAVE Epic 3 - владелец не должен узнавать о пропавшем
// графике мастера только ручной curl-проверкой). In-memory fake client - тот же приём, что
// уже применён в tests/api.master-not-bookable.test.js для mastersWithWorkingSchedule, плюс
// симуляция ON CONFLICT DO NOTHING постоянного уникального индекса notifications_master_dedup
// (миграция 037) через Set дедуп-ключей - реальное поведение живого Postgres-индекса
// перепроверяется живым прогоном на локальной базе (см. DoD промпта), не здесь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMastersMissingSchedule, notifyOwnerAboutMastersMissingSchedule } from '../api/server.mjs';

function makeFakeClient({ staffRows, workingMasterIds, existingNotifications = [] }) {
  const dedupKey = (r) => `${r.staffId}|${r.type}|${r.relatedMasterId}`;
  const seen = new Set(existingNotifications.map(dedupKey));
  const insertedCalls = [];
  return {
    insertedCalls,
    async query(sql, params) {
      if (/FROM staff WHERE employed = true AND provides_services = true/.test(sql)) {
        return { rows: staffRows };
      }
      if (/FROM master_weekly_schedule/.test(sql)) {
        const [masterIds] = params;
        const matched = masterIds.filter((id) => workingMasterIds.has(id));
        return { rows: matched.map((id) => ({ master_id: id })) };
      }
      if (/INSERT INTO notifications/.test(sql)) {
        const [, staffId, type, , , relatedMasterId] = params;
        const row = { staffId, type, relatedMasterId };
        if (!seen.has(dedupKey(row))) {
          seen.add(dedupKey(row));
          insertedCalls.push(row);
        }
        return { rows: [] };
      }
      throw new Error(`Неожиданный SQL в fake client: ${sql}`);
    },
  };
}

// ── findMastersMissingSchedule - чистая функция, без DB вообще ──────────────

test('findMastersMissingSchedule: разница множеств - только не попавшие в scheduled', () => {
  assert.deepEqual(findMastersMissingSchedule(['master-1', 'master-2', 'master-3'], new Set(['master-1', 'master-3'])), [
    'master-2',
  ]);
});

test('findMastersMissingSchedule: все бронируемы - пустой результат', () => {
  assert.deepEqual(findMastersMissingSchedule(['master-1', 'master-2'], new Set(['master-1', 'master-2'])), []);
});

// ── Сценарий 1 промпта: мастер стал небронируем → ровно одно новое уведомление ──

test('Сценарий 1: мастер без графика → владельцу создаётся ровно одно уведомление master_lost_schedule', async () => {
  const client = makeFakeClient({
    staffRows: [{ id: 'master-2', name: 'Мамедхан' }],
    workingMasterIds: new Set(), // потерял единственный is_working=true день
  });
  await notifyOwnerAboutMastersMissingSchedule(client, 'owner-test');
  assert.equal(client.insertedCalls.length, 1);
  assert.deepEqual(client.insertedCalls[0], { staffId: 'owner-test', type: 'master_lost_schedule', relatedMasterId: 'master-2' });
});

// ── Сценарий 2 промпта: уже уведомляли, мастер остаётся небронируем → без дублей ──

test('Сценарий 2: уже есть уведомление про этого мастера → повторно не создаётся', async () => {
  const client = makeFakeClient({
    staffRows: [{ id: 'master-2', name: 'Мамедхан' }],
    workingMasterIds: new Set(),
    existingNotifications: [{ staffId: 'owner-test', type: 'master_lost_schedule', relatedMasterId: 'master-2' }],
  });
  await notifyOwnerAboutMastersMissingSchedule(client, 'owner-test');
  assert.equal(client.insertedCalls.length, 0);
});

// ── Сценарий 3 промпта: график восстановлен, потом снова пропал - простое решение,
// постоянный дедуп-индекс не даёт создать новое уведомление повторно ──────────

test('Сценарий 3: график был восстановлен и снова пропал → новое уведомление не плодится (permanent dedup)', async () => {
  const client = makeFakeClient({
    staffRows: [{ id: 'master-2', name: 'Мамедхан' }],
    workingMasterIds: new Set(), // сейчас снова небронируем
    existingNotifications: [{ staffId: 'owner-test', type: 'master_lost_schedule', relatedMasterId: 'master-2' }], // уведомляли до восстановления
  });
  await notifyOwnerAboutMastersMissingSchedule(client, 'owner-test');
  assert.equal(client.insertedCalls.length, 0);
});

// ── Сценарий 4 промпта: все мастера бронируемы → уведомлений не создаётся вовсе ──

test('Сценарий 4: все мастера бронируемы → пустой алерт не создаётся', async () => {
  const client = makeFakeClient({
    staffRows: [
      { id: 'master-1', name: 'Али' },
      { id: 'master-2', name: 'Мамедхан' },
    ],
    workingMasterIds: new Set(['master-1', 'master-2']),
  });
  await notifyOwnerAboutMastersMissingSchedule(client, 'owner-test');
  assert.equal(client.insertedCalls.length, 0);
});

// ── Несколько мастеров без графика одновременно - каждый получает своё уведомление ──

test('Несколько мастеров без графика → уведомление создаётся на каждого независимо', async () => {
  const client = makeFakeClient({
    staffRows: [
      { id: 'master-1', name: 'Али' },
      { id: 'master-2', name: 'Мамедхан' },
      { id: 'master-3', name: 'Елизавета' },
    ],
    workingMasterIds: new Set(['master-1']), // master-2 и master-3 без графика
  });
  await notifyOwnerAboutMastersMissingSchedule(client, 'owner-test');
  assert.equal(client.insertedCalls.length, 2);
  const masterIds = client.insertedCalls.map((c) => c.relatedMasterId).sort();
  assert.deepEqual(masterIds, ['master-2', 'master-3']);
});

// ── Не-мастера (providesServices=false) не участвуют вовсе - запрос к staff уже
// фильтрует по provides_services=true, эта проверка ловит регресс в самом SQL ──

test('Пустой список staffRows (например все уволены) - не бьёт по mastersWithWorkingSchedule и не создаёт уведомлений', async () => {
  const client = makeFakeClient({ staffRows: [], workingMasterIds: new Set() });
  await notifyOwnerAboutMastersMissingSchedule(client, 'owner-test');
  assert.equal(client.insertedCalls.length, 0);
});
