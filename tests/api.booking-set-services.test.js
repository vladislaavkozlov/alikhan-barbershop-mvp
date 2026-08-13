// PUT /bookings/:id/services - полный состав услуг записи (13.08.2026, Влад:
// "клиент решил уже в кресле, что хочет другую услугу - её можно будет изменить?").
// До этого дня состав только дополнялся (PATCH), снять услугу было нечем.
//
// ЧТО ПОКРЫТО ЗДЕСЬ: чистая функция плана замены - что удалить, что добавить, какой
// будет длительность. Именно в ней живёт разница с PATCH-версией: длительность
// считается от НАЧАЛА записи по полному составу, а не сдвигом от прежнего конца,
// иначе при снятии услуги слот остался бы прежней длины.
//
// ЧТО ПОКРЫТО ЖИВЫМ ПРОГОНОМ: сама транзакция, пересчёт end_time в базе и работа
// через интерфейс - handleBookingSetServices работает на общем pool, под fake client
// его не подставить без рефакторинга стабильного кода (та же причина, что в
// tests/api.booking-reschedule.test.js). Живьём -
// tools/verify-2026-08-13-okno59-kartochka-zapisi.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServicesReplacement } from '../api/server.mjs';

const ms = (rows) => rows.map(([service_id, duration_min]) => ({ service_id, duration_min }));

test('замена состава: одна услуга меняется на другую - одна снимается, одна добавляется', () => {
  const plan = resolveServicesReplacement({
    serviceIds: ['britie'],
    masterServiceRows: ms([['britie', 40]]),
    currentServiceIds: ['strizhka'],
  });
  assert.deepEqual(plan.added, ['britie']);
  assert.deepEqual(plan.removed, ['strizhka']);
  assert.equal(plan.durationMin, 40);
});

test('замена состава: длительность считается по ПОЛНОМУ составу, а не приростом', () => {
  const plan = resolveServicesReplacement({
    serviceIds: ['strizhka', 'vosk'],
    masterServiceRows: ms([['strizhka', 40], ['vosk', 15]]),
    currentServiceIds: ['strizhka', 'boroda'],
  });
  assert.equal(plan.durationMin, 55);
  assert.deepEqual(plan.added, ['vosk']);
  assert.deepEqual(plan.removed, ['boroda']);
});

test('замена состава: состав не изменился - ни удалений, ни добавлений', () => {
  const plan = resolveServicesReplacement({
    serviceIds: ['strizhka'],
    masterServiceRows: ms([['strizhka', 40]]),
    currentServiceIds: ['strizhka'],
  });
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.durationMin, 40);
});

test('замена состава: пустой список - ошибка, запись без услуг существовать не должна', () => {
  assert.deepEqual(resolveServicesReplacement({ serviceIds: [], masterServiceRows: [], currentServiceIds: ['strizhka'] }), { error: 'missing_fields' });
  assert.deepEqual(resolveServicesReplacement({ serviceIds: null, masterServiceRows: [], currentServiceIds: [] }), { error: 'missing_fields' });
});

test('замена состава: услуга не из прайса этого мастера - ошибка, а не тихий пропуск', () => {
  const plan = resolveServicesReplacement({
    serviceIds: ['strizhka', 'spa-uhod'],
    masterServiceRows: ms([['strizhka', 40]]), // spa-uhod у мастера нет
    currentServiceIds: ['strizhka'],
  });
  assert.deepEqual(plan, { error: 'unknown_master_service' });
});

test('замена состава: дубликаты в запросе схлопываются и не ломают сверку с прайсом', () => {
  const plan = resolveServicesReplacement({
    serviceIds: ['strizhka', 'strizhka'],
    masterServiceRows: ms([['strizhka', 40]]),
    currentServiceIds: [],
  });
  assert.deepEqual(plan.serviceIds, ['strizhka']);
  assert.deepEqual(plan.added, ['strizhka']);
  assert.equal(plan.durationMin, 40);
});
