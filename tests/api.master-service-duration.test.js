// Вторая половина фикса бага P2 (15.08.2026) - серверная. PUT
// /master-services/:masterId/:serviceId раньше отвергал только ровно ноль
// (`durationMin <= 0`), а всё прочее некорректное (null, "", "abc", 1.5, -10)
// проваливалось в ветку "не передано" и молча подменялось каталожной длительностью
// с ответом 200 - клиент видел успех, в базу уезжала чужая цифра.
//
// Чистые предикаты, без Postgres - тот же приём, что в api.staff-role-lock.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDurationOmitted, isValidDuration } from '../api/routes/services.js';

test('длительность считается непереданной только когда ключа в теле нет вовсе', () => {
  assert.equal(isDurationOmitted(undefined), true);
  // ноль, пустая строка и явный null - это ввод, а не отсутствие: подменять их
  // каталожными 60 минутами и отвечать 200 нельзя, ровно из этого вырос баг P2
  assert.equal(isDurationOmitted(null), false);
  assert.equal(isDurationOmitted(0), false);
  assert.equal(isDurationOmitted(''), false);
  assert.equal(isDurationOmitted('abc'), false);
});

test('корректная длительность - целое число больше нуля', () => {
  assert.equal(isValidDuration(45), true);
  assert.equal(isValidDuration(1), true);
});

test('всё, что владелец мог ввести неверно, отвергается', () => {
  for (const bad of [0, -10, 1.5, '', '60', 'abc', NaN, Infinity, true, {}]) {
    assert.equal(isValidDuration(bad), false, `${JSON.stringify(bad)} не должно проходить как длительность`);
  }
});

test('переданный ноль - это 400, а не подстановка каталожного значения', () => {
  // ровно ветвление роута: не омитнуто и не валидно => invalid_duration
  const rejected = (value) => !isDurationOmitted(value) && !isValidDuration(value);
  assert.equal(rejected(0), true);
  assert.equal(rejected(''), true);
  assert.equal(rejected(null), true);
  assert.equal(rejected(-5), true);
  assert.equal(rejected(45), false);
  assert.equal(rejected(undefined), false, 'поле не передано - берём каталожную длительность, как и раньше');
});
