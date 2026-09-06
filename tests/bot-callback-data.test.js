// Кнопки бота по визиту (06.09.2026). Дефект найден живым прогоном Влада на кабинете
// клиники: письмо после неявки пришло, кнопка «Да, подберите время» нажалась, а бот
// ответил «Не нашли вашу запись». Причина - разбор callback_data по ВСЕМ двоеточиям
// при том, что двоеточие есть внутри самого id брони.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseCallbackData, callbackDataFits, CALLBACK_DATA_LIMIT } from '../api/lib/callback-data.js';

// Ровно та же формула, что в api/routes/bookings.js (createBookingTx). Повторена
// здесь намеренно: тест обязан сломаться, если формат id брони разойдётся с разбором
function bookingIdLikeProduction(date = '2026-09-06', startTime = '10:00') {
  const masterId = `staff-${randomBytes(12).toString('hex')}`;
  return `${date}-${startTime}-${masterId}-${randomBytes(4).toString('hex')}`;
}

test('id брони переживает дорогу до кнопки и обратно целиком', () => {
  const bookingId = bookingIdLikeProduction();
  assert.ok(bookingId.includes(':'), 'предпосылка теста: в id брони есть двоеточие');
  const { verb, id } = parseCallbackData(`rb:${bookingId}`);
  assert.equal(verb, 'rb');
  assert.equal(id, bookingId);
});

test('старый разбор split(\':\') вернул бы обрезанный id - так быть не должно', () => {
  const bookingId = bookingIdLikeProduction('2026-09-06', '10:00');
  const broken = `rb:${bookingId}`.split(':')[1];
  assert.equal(broken, '2026-09-06-10');
  assert.notEqual(parseCallbackData(`rb:${bookingId}`).id, broken);
});

test('кнопки разговора о возврате несут id клиента и тоже разбираются', () => {
  const clientId = `client-${randomBytes(6).toString('hex')}`;
  assert.deepEqual(parseCallbackData(`vb:${clientId}`), { verb: 'vb', id: clientId });
});

test('данные без двоеточия не притворяются командой с пустым id', () => {
  assert.deepEqual(parseCallbackData('rb'), { verb: 'rb', id: '' });
  assert.deepEqual(parseCallbackData(''), { verb: '', id: '' });
  assert.deepEqual(parseCallbackData(null), { verb: '', id: '' });
});

test('callback_data любой кнопки по визиту влезает в предел Telegram', () => {
  const bookingId = bookingIdLikeProduction();
  for (const verb of ['ok', 'mv', 'no', 'lt', 'l1', 'l2', 'l3', 'rb', 'rn', 'rp', 'rt', 'ro', 'rm']) {
    const data = `${verb}:${bookingId}`;
    assert.ok(
      callbackDataFits(data),
      `«${verb}» не влезает в ${CALLBACK_DATA_LIMIT} байт (${Buffer.byteLength(data)}): кнопка не отправится вовсе`,
    );
  }
});
