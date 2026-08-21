// Повтор запроса к просыпающемуся серверу (21.08.2026, Влад: «жму войти - не заходит,
// обновил несколько раз и тогда зашло»). Бэкенд на Amvera уходит в спячку: замер
// показал обычный ответ 170 мс, один запрос 17 000 мс и один полный обрыв.
//
// Здесь проверяется РЕШЕНИЕ о повторе, а не сеть: что повторяется, что нет и сколько
// раз. Реальная спячка воспроизводится только на живом хостинге.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithWakeup } from '../assets/crm-shared.js';

const noSleep = async () => {};

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      const next = responses[calls.length - 1];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('обрыв связи (запрос не дошёл) повторяется, и вторая попытка возвращает ответ', async () => {
  const fake = fakeFetch([new TypeError('Failed to fetch'), { status: 200 }]);
  const res = await fetchWithWakeup('/x', {}, { fetchImpl: fake.impl, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(fake.calls.length, 2);
});

test('«сервер временно недоступен» (503) повторяется', async () => {
  const fake = fakeFetch([{ status: 503 }, { status: 200 }]);
  const res = await fetchWithWakeup('/x', {}, { fetchImpl: fake.impl, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(fake.calls.length, 2);
});

test('неверный PIN (401) НЕ повторяется - это осмысленный отказ, а не спящий сервер', async () => {
  const fake = fakeFetch([{ status: 401 }, { status: 200 }]);
  const res = await fetchWithWakeup('/auth/login', {}, { fetchImpl: fake.impl, sleep: noSleep });
  assert.equal(res.status, 401);
  assert.equal(fake.calls.length, 1, 'повтор с неверным PIN выглядел бы как подбор пароля');
});

test('ошибка сервера 500 не повторяется - повтор её не вылечит', async () => {
  const fake = fakeFetch([{ status: 500 }, { status: 200 }]);
  const res = await fetchWithWakeup('/x', {}, { fetchImpl: fake.impl, sleep: noSleep });
  assert.equal(res.status, 500);
  assert.equal(fake.calls.length, 1);
});

test('попытки не бесконечны: три и стоп, последний ответ отдаётся как есть', async () => {
  const fake = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }]);
  const res = await fetchWithWakeup('/x', {}, { fetchImpl: fake.impl, sleep: noSleep });
  assert.equal(res.status, 503);
  assert.equal(fake.calls.length, 3);
});

test('если связи нет во всех попытках - ошибка пробрасывается, а не глотается', async () => {
  const fake = fakeFetch([new TypeError('нет сети'), new TypeError('нет сети'), new TypeError('нет сети')]);
  await assert.rejects(() => fetchWithWakeup('/x', {}, { fetchImpl: fake.impl, sleep: noSleep }), /нет сети/);
  assert.equal(fake.calls.length, 3);
});

test('человеку сообщают об ожидании на каждой паузе, а не молча держат кнопку', async () => {
  const waits = [];
  const fake = fakeFetch([{ status: 503 }, { status: 200 }]);
  await fetchWithWakeup('/x', {}, { fetchImpl: fake.impl, sleep: noSleep, onWait: (n) => waits.push(n) });
  assert.deepEqual(waits, [1]);
});
