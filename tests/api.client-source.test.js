// Источник клиента + метка "новый клиент" (17.08.2026, миграция 050, задача Влада:
// "в карточке записи 'День' - откуда пришёл клиент, через яндекс карты или 2гис;
// если клиент новый - '+1 новый клиент'").
//
// ЧТО ПОКРЫТО ЗДЕСЬ: два чистых правила, от которых зависит, что попадёт в базу и
// что человек увидит на карточке - нормализация ключа канала и вычисление "первого
// визита". Оба намеренно вынесены из роутов отдельными функциями, как уже сделано
// у normalizeStaffComment (tests/api.booking-staff-comment.test.js).
//
// ЧТО ПОКРЫТО ЖИВЫМ ПРОГОНОМ, а не здесь: сам INSERT/UPDATE колонки и обратное
// чтение через GET /bookings - роуты работают на общем pool, подменить его fake
// клиентом без рефакторинга стабильного кода нельзя (та же причина, что в
// tests/api.booking-reschedule.test.js). Живьём -
// tools/verify-2026-08-17-istochnik-i-raskrytie.mjs на эфемерной базе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientSource, firstBookingIdByClient, CLIENT_SOURCE_KEYS } from '../api/server.mjs';

test('источник: известный ключ проходит как есть', () => {
  assert.deepEqual(normalizeClientSource('yandex_maps'), { value: 'yandex_maps' });
  assert.deepEqual(normalizeClientSource(' 2gis '), { value: '2gis' });
});

test('источник: пусто = "неизвестно" (null), а не пустая строка в базе', () => {
  assert.deepEqual(normalizeClientSource(''), { value: null });
  assert.deepEqual(normalizeClientSource('   '), { value: null });
  assert.deepEqual(normalizeClientSource(null), { value: null });
  assert.deepEqual(normalizeClientSource(undefined), { value: null });
});

// Тихая подмена чужого ключа на "other" превратила бы опечатку в интеграции в цифру
// канала, которую владелец потом прочитает как факт - поэтому 400, а не молчание.
test('источник: неизвестный ключ и чужой тип - ошибка, а не молчаливая запись', () => {
  assert.deepEqual(normalizeClientSource('яндекс'), { error: 'unknown_client_source' });
  assert.deepEqual(normalizeClientSource('google_maps'), { error: 'unknown_client_source' });
  assert.deepEqual(normalizeClientSource(42), { error: 'invalid_client_source' });
  assert.deepEqual(normalizeClientSource({ source: '2gis' }), { error: 'invalid_client_source' });
});

test('источник: словарь держит оба канала, ради которых заводилось поле', () => {
  assert.ok(CLIENT_SOURCE_KEYS.includes('yandex_maps'));
  assert.ok(CLIENT_SOURCE_KEYS.includes('2gis'));
});

const row = (id, clientId, date, startTime, status = 'planned') => ({
  id, client_id: clientId, date, start_time: startTime, status,
});

test('новый клиент: метку получает самая ранняя бронь, не все брони клиента', () => {
  const first = firstBookingIdByClient([
    row('b-2', 'client-1', '2026-09-01', '12:00'),
    row('b-1', 'client-1', '2026-08-17', '10:00'),
  ]);
  assert.equal(first.get('client-1'), 'b-1');
});

// Две брони в один день - решает время, иначе метка прыгала бы между ними от
// порядка строк в ответе базы.
test('новый клиент: в один день первой считается более ранняя по времени', () => {
  const first = firstBookingIdByClient([
    row('b-late', 'client-1', '2026-08-17', '18:30'),
    row('b-early', 'client-1', '2026-08-17', '09:15'),
  ]);
  assert.equal(first.get('client-1'), 'b-early');
});

// Отменённая бронь визитом не была - человек не приходил, и следующая запись у него
// по-прежнему первая.
test('новый клиент: отменённая бронь не отбирает метку у следующей', () => {
  const first = firstBookingIdByClient([
    row('b-cancelled', 'client-1', '2026-08-10', '10:00', 'cancelled'),
    row('b-real', 'client-1', '2026-08-17', '10:00'),
  ]);
  assert.equal(first.get('client-1'), 'b-real');
});

// Неявка - другое дело: салон этого человека уже привлёк, второй раз он не новый.
test('новый клиент: неявка считается за первый визит - клиента уже привлекли', () => {
  const first = firstBookingIdByClient([
    row('b-noshow', 'client-1', '2026-08-10', '10:00', 'no_show'),
    row('b-next', 'client-1', '2026-08-17', '10:00'),
  ]);
  assert.equal(first.get('client-1'), 'b-noshow');
});

// Walk-in без телефона (миграция 041) намеренно не связывается с прошлыми визитами
// по одному имени - утверждать про него "новый" было бы выдумкой.
test('новый клиент: запись без client_id в расчёт не входит вовсе', () => {
  const first = firstBookingIdByClient([
    row('b-walkin', null, '2026-08-17', '10:00'),
    row('b-known', 'client-1', '2026-08-17', '11:00'),
  ]);
  assert.equal(first.size, 1);
  assert.equal(first.get('client-1'), 'b-known');
});

test('новый клиент: у каждого клиента своя первая бронь', () => {
  const first = firstBookingIdByClient([
    row('b-a2', 'client-a', '2026-08-20', '10:00'),
    row('b-a1', 'client-a', '2026-08-01', '10:00'),
    row('b-b1', 'client-b', '2026-08-15', '10:00'),
  ]);
  assert.equal(first.get('client-a'), 'b-a1');
  assert.equal(first.get('client-b'), 'b-b1');
});

// Даты из pg приходят объектами Date, а не строками - если бы функция сравнивала их
// как есть, ключ сортировки склеился бы из "Mon Aug 17 2026..." и правило поехало бы
// на границе месяца ("Aug" < "Sep" случайно верно, а "Feb" < "Jan" уже нет).
test('новый клиент: даты-объекты из базы сравниваются как календарные, не как текст', () => {
  const first = firstBookingIdByClient([
    { id: 'b-jan', client_id: 'client-1', date: new Date('2027-01-10T00:00:00Z'), start_time: '10:00', status: 'planned' },
    { id: 'b-feb', client_id: 'client-1', date: new Date('2027-02-10T00:00:00Z'), start_time: '10:00', status: 'planned' },
  ]);
  assert.equal(first.get('client-1'), 'b-jan');
});
