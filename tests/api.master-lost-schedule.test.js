// Окно 35 (06.08.2026) - юниты на findMastersMissingSchedule: чистая разница множеств
// «кто оказывает услуги» минус «у кого есть рабочий график».
//
// 20.08.2026: сценарии про notifyOwnerAboutMastersMissingSchedule удалены вместе с самой
// функцией - уведомление «у мастера пропал график» снято из ленты по решению Влада
// (лента теперь только про записи клиентов, миграция 051). Сам РАСЧЁТ остался и покрыт
// ниже: на нём держится баннер «Нет рабочего графика» наверху раздела «Расписание»
// (GET /owner/alerts → computeOwnerAlerts, api/routes/clients.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMastersMissingSchedule } from '../api/server.mjs';

test('findMastersMissingSchedule: разница множеств - только не попавшие в scheduled', () => {
  assert.deepEqual(findMastersMissingSchedule(['master-1', 'master-2', 'master-3'], new Set(['master-1', 'master-3'])), [
    'master-2',
  ]);
});

test('findMastersMissingSchedule: все бронируемы - пустой результат', () => {
  assert.deepEqual(findMastersMissingSchedule(['master-1', 'master-2'], new Set(['master-1', 'master-2'])), []);
});
