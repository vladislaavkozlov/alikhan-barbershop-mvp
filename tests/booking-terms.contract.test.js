// Условия записи (20.08.2026, постановка Влада: «у записи должен быть по умолчанию
// комментарий "откуда пришёл клиент и на каких условиях", например "запись к топ
// мастеру"»).
//
// Строка собирается из данных брони (client_source + master_tier), а не пишется текстом
// в staff_comment: текстовый автокомментарий затирал бы ручной комментарий сотрудника и
// врал бы после переноса записи или смены состава услуг - тариф там пересчитывается,
// а однажды записанный текст остался бы прежним.
import assert from 'node:assert/strict';
import test from 'node:test';

const { bookingTermsLabel, masterTierLabel } = await import('../assets/booking-terms.js');

test('топ-тариф называется словами, которые сказал Влад', () => {
  assert.equal(masterTierLabel('top'), 'запись к топ-мастеру');
});

test('обычный тариф тоже назван - в карточке записи это ответ на вопрос «а почему не топ»', () => {
  assert.equal(masterTierLabel('standard'), 'обычный тариф');
});

test('запись, сделанная до появления тарифов, тарифа не имеет', () => {
  // master_tier IS NULL у всех броней старше миграции 054. Подписать их «обычным
  // тарифом» задним числом значило бы придумать факт, которого в системе не было
  assert.equal(masterTierLabel(null), null);
  assert.equal(masterTierLabel(undefined), null);
  assert.equal(masterTierLabel('vip'), null, 'неизвестное значение не выдумываем');
});

test('канал и тариф в одной строке, через ту же точку, что и остальные детали карточки', () => {
  assert.equal(
    bookingTermsLabel({ clientSource: 'yandex_maps', masterTier: 'top' }),
    'Яндекс Карты · запись к топ-мастеру'
  );
});

test('канала нет - остаются одни условия', () => {
  // Клиент зашёл мимо или позвонил: источника в технике не существует, и пустой
  // разделитель в начале строки выглядел бы как потерянные данные
  assert.equal(bookingTermsLabel({ clientSource: null, masterTier: 'top' }), 'запись к топ-мастеру');
});

test('тарифа нет - остаётся один канал, как было до фичи', () => {
  assert.equal(bookingTermsLabel({ clientSource: '2gis', masterTier: null }), '2ГИС');
});

test('нет ни того, ни другого - строки нет вовсе, а не пустая подпись', () => {
  assert.equal(bookingTermsLabel({ clientSource: null, masterTier: null }), null);
  assert.equal(bookingTermsLabel({}), null);
});

test('неизвестный канал не превращается в мусор на карточке', () => {
  assert.equal(bookingTermsLabel({ clientSource: 'facebook_ads', masterTier: 'standard' }), 'обычный тариф');
});
