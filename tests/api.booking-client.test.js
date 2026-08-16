// PATCH /bookings/:id/client (16.08.2026, Влад: "не сохраняются изменения имени и
// номера в существующей карточке"). Правка этих двух полей действительно никуда не
// уезжала - роута под неё не существовало вовсе, форма редактирования их только
// показывала.
//
// ЧТО ПОКРЫТО ЗДЕСЬ: чистые валидаторы тела запроса - какое имя/телефон роут вообще
// принимает и что считает "поле очистили". Порог в 10 цифр важен: он тот же, по
// которому ищется существующий клиент (normalizePhoneKey, api/routes/clients.js) -
// разъедутся эти два числа, и админ сможет привязать бронь к номеру-обрубку, к
// которому потом не сойдётся ни один визит.
//
// ЧТО ПОКРЫТО ЖИВЫМ ПРОГОНОМ, а не здесь: сама транзакция роута (поиск клиента по
// нормализованному номеру, создание нового, отвязка при пустом телефоне, пересчёт
// requires_prepayment) - она работает на pool.connect(), под fake client её не
// подставить, причина та же, что у api.booking-reschedule.test.js. Живьём -
// tools/verify-2026-08-16-pravka-klienta.mjs на эфемерной базе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientName, normalizeClientPhoneInput, CLIENT_NAME_MAX_LEN } from '../api/server.mjs';

test('normalizeClientName: имя обрезается, пустое = "без имени"', () => {
  assert.deepEqual(normalizeClientName('  Владимир  '), { value: 'Владимир' });
  // Стёртое поле - это null, а не пустая строка в базе: иначе в календаре появились
  // бы записи с именем-призраком вместо честного "Без имени"
  assert.deepEqual(normalizeClientName(''), { value: null });
  assert.deepEqual(normalizeClientName('   '), { value: null });
  assert.deepEqual(normalizeClientName(null), { value: null });
  assert.deepEqual(normalizeClientName(undefined), { value: null });
  assert.deepEqual(normalizeClientName(42), { error: 'invalid_client_name' });
  assert.deepEqual(normalizeClientName('я'.repeat(CLIENT_NAME_MAX_LEN)), { value: 'я'.repeat(CLIENT_NAME_MAX_LEN) });
  assert.deepEqual(normalizeClientName('я'.repeat(CLIENT_NAME_MAX_LEN + 1)), { error: 'client_name_too_long' });
});

test('normalizeClientPhoneInput: принимает полный номер в любом формате, пустой = отвязка', () => {
  assert.deepEqual(normalizeClientPhoneInput('+7 903 444 44 44'), { value: '+7 903 444 44 44' });
  assert.deepEqual(normalizeClientPhoneInput('+79034444444'), { value: '+79034444444' });
  assert.deepEqual(normalizeClientPhoneInput('89034444444'), { value: '89034444444' });
  assert.deepEqual(normalizeClientPhoneInput(''), { value: null });
  assert.deepEqual(normalizeClientPhoneInput('   '), { value: null });
  assert.deepEqual(normalizeClientPhoneInput(null), { value: null });
  // Меньше 10 цифр - не номер, а недописанный ввод: привязка по нему завела бы
  // клиента-обрубок вместо того, чтобы найти уже существующего
  assert.deepEqual(normalizeClientPhoneInput('+7903444'), { error: 'invalid_client_phone' });
  assert.deepEqual(normalizeClientPhoneInput('телефон'), { error: 'invalid_client_phone' });
  assert.deepEqual(normalizeClientPhoneInput(79034444444), { error: 'invalid_client_phone' });
});

test('форма редактирования считает имя и телефон изменениями записи', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../assets/crm-walkin.js', import.meta.url), 'utf8');
  // Снимок "как было" обязан включать оба поля - иначе кнопка "Сохранить изменения"
  // не оживает от их правки (ровно тот баг, с которого началась задача)
  assert.match(source, /clientName: \(el\('wfClientName'\)/);
  assert.match(source, /clientPhone: \(el\('wfClientPhone'\)/);
  // И оба должны быть под слушателем input, иначе состояние кнопки не пересчитается
  assert.match(source, /'bkActualPrice', 'bkStaffComment', 'wfClientName', 'wfClientPhone'/);
  // И реально уезжать на сервер
  assert.match(source, /bookings\/\$\{encodeURIComponent\(bookingId\)\}\/client/);
});
