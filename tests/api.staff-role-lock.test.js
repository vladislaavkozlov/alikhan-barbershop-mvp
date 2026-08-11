// Инцидент прав 11.08.2026 - замок последнего владельца (isLastOwnerDemotion,
// api/routes/staff.js). Владелец сменил СЕБЕ роль на 'мастер' в кабинете и запер
// систему: PUT /staff/:id/role доступен только owner, а других владельцев на проде
// не осталось (тестовые и QA-owner вычищены миграциями 014/024/027/035/039) -
// вернуть роль было некому ни одним запросом из интерфейса, починка потребовала
// миграции 043_restore_owner_role.sql, то есть деплоя.
//
// Чистая функция, без Postgres - тот же приём, что в api.schedule-range.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLastOwnerDemotion } from '../api/server.mjs';

// Боевой состав на момент инцидента: master-1 Алиовсад (owner, основатель),
// master-2 Мамедхан (admin, миграция 014), master-3 Елизавета (master).
const SOLE_OWNER = ['master-1'];

test('ровно тот запрос, что запер прод: единственный владелец снимает роль с себя', () => {
  assert.equal(isLastOwnerDemotion(SOLE_OWNER, 'master-1', 'master'), true);
  assert.equal(isLastOwnerDemotion(SOLE_OWNER, 'master-1', 'admin'), true);
});

test('второй путь к тому же тупику: владелец снимает роль с ДРУГОГО последнего владельца', () => {
  // Условие строится на состоянии базы, не на auth.id - иначе владелец A мог бы
  // запереть систему, сняв роль с последнего владельца B, не тронув себя.
  assert.equal(isLastOwnerDemotion(['master-2'], 'master-2', 'master'), true);
});

test('владельцев двое - понижение одного из них разрешено, система не запирается', () => {
  assert.equal(isLastOwnerDemotion(['master-1', 'master-2'], 'master-1', 'master'), false);
  assert.equal(isLastOwnerDemotion(['master-1', 'master-2'], 'master-2', 'admin'), false);
});

test('выдача роли владельца не блокируется никогда', () => {
  // Иначе замок сломал бы штатный сценарий "передать/добавить владельца" - в том
  // числе единственный путь, которым владельцев может стать двое.
  assert.equal(isLastOwnerDemotion(SOLE_OWNER, 'master-2', 'owner'), false);
  assert.equal(isLastOwnerDemotion(SOLE_OWNER, 'master-1', 'owner'), false);
});

test('смена роли НЕ-владельца не задевается замком', () => {
  // Мамедхан admin→master и Елизавета master→admin проходят как раньше, пока
  // единственный владелец - Алиовсад.
  assert.equal(isLastOwnerDemotion(SOLE_OWNER, 'master-2', 'master'), false);
  assert.equal(isLastOwnerDemotion(SOLE_OWNER, 'master-3', 'admin'), false);
});

test('база уже без владельцев - замок не мешает вернуть роль и не падает', () => {
  // Ровно состояние прода до миграции 043. Понижение кого угодно здесь ничего не
  // ухудшает (владельцев и так нет), а выдача роли обязана пройти.
  assert.equal(isLastOwnerDemotion([], 'master-1', 'owner'), false);
  assert.equal(isLastOwnerDemotion([], 'master-2', 'master'), false);
});
