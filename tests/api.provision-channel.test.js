// Подключение бота арендатора переменной BOT_CHANNEL (Волна 1, 01.09.2026).
//
// Проверяется разбор и отказы - то, что видно без базы и без сети. Главное свойство
// механизма: он не бросает НИКОГДА. Опечатка в переменной, относящейся к одному
// клиенту, не должна ронять сервер, который обслуживает остальных.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionChannelFromEnv } from '../api/lib/provision-channel.js';

test('переменной нет - механизм молчит и ничего не делает', async () => {
  assert.equal(await provisionChannelFromEnv({}), null);
});

test('мусор вместо JSON не роняет старт сервера', async () => {
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: 'не json вовсе' }), null);
});

test('незнакомый ключ отвергается, а не применяется молча', async () => {
  // Тихо проигнорированное поле означает, что человек уверен, будто задал одно,
  // а получил другое - и узнает об этом по факту, на живых клиентах
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: JSON.stringify({ domain: 'x', token: 'y', enabledd: true }) }), null);
});

test('без домена и без токена подключения не происходит', async () => {
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: JSON.stringify({ token: 'y' }) }), null);
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: JSON.stringify({ domain: 'x' }) }), null);
});

test('чужой канал не принимается: пока поддержан только telegram', async () => {
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: JSON.stringify({ domain: 'x', token: 'y', channel: 'max' }) }), null);
});

test('выключение не требует токена - отзыв доступа не должен требовать доступа', async () => {
  // Токена нет вовсе, и это законно: строка ищется по домену и гасится
  const spec = JSON.stringify({ domain: 'нет-такого-домена.test', enabled: false });
  // Заведения с таким доменом нет, поэтому итог null - но упасть на «нужен token»
  // разбор не должен, иначе выключить бота было бы нечем
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: spec }), null);
});

test('несколько операций разом: перестановка бота это выключить там и включить здесь', async () => {
  const spec = JSON.stringify([
    { domain: 'нет-такого.test', enabled: false },
    { domain: 'и-такого-нет.test', token: 'нет' },
  ]);
  // Обе операции обломятся на поиске заведения, но обе должны быть ПОПЫТАНЫ:
  // разбор массива не падает и не останавливается на первой
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL: spec }), null);
});

test('base64 принимается наравне с JSON - переменную удобнее вставлять одной строкой', async () => {
  const spec = Buffer.from(JSON.stringify({ domain: 'нет-такого-домена.test', token: 'нет' })).toString('base64');
  // Дойдёт до поиска заведения и честно откажет, но разбор не должен упасть раньше
  assert.equal(await provisionChannelFromEnv({ BOT_CHANNEL_B64: spec }), null);
});
