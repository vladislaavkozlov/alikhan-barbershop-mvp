// Топ-мастер по услуге (20.08.2026, постановка Влада: «в карточке сотрудника галка
// "топ услуга" + возможность поставить другую цену»). Серверная половина контракта:
// валидация цены в PUT /master-services/:masterId/:serviceId и правило, по которому
// бронь получает тариф.
//
// Чистые предикаты, без Postgres - тот же приём, что в api.master-service-duration.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPriceOmitted, isValidPrice, normalizeIsTop } from '../api/routes/services.js';
import { resolveMasterTier } from '../api/routes/bookings.js';

test('цена считается непереданной только когда ключа в теле нет вовсе', () => {
  assert.equal(isPriceOmitted(undefined), true);
  // Тот же урок, что с длительностью (баг P2 от 15.08.2026): ноль, пустая строка и
  // явный null - это введённое значение, а не согласие на каталожную цену
  assert.equal(isPriceOmitted(null), false);
  assert.equal(isPriceOmitted(0), false);
  assert.equal(isPriceOmitted(''), false);
});

test('корректная цена - целое число больше нуля', () => {
  assert.equal(isValidPrice(2500), true);
  assert.equal(isValidPrice(1), true);
});

test('всё, что владелец мог ввести неверно, отвергается', () => {
  // Ноль отдельно: бесплатная услуга в прайсе барбершопа - это не цена, а не
  // заполненное поле, и молча уезжать каталожной ценой оно не должно
  for (const bad of [0, -100, 1500.5, '', '2500', 'abc', NaN, Infinity, true, {}]) {
    assert.equal(isValidPrice(bad), false, `${JSON.stringify(bad)} не должно проходить как цена`);
  }
});

test('галка «топ» - строгий boolean, чужие значения не включают тариф молча', () => {
  assert.equal(normalizeIsTop(true), true);
  assert.equal(normalizeIsTop(false), false);
  // Ключа нет - услуга не топовая (значение колонки по умолчанию), но и не «сбрасываем
  // в false то, что владелец только что включил»: роут пишет строку целиком, поэтому
  // отсутствие ключа = обычная услуга, ровно как у enabled/price
  assert.equal(normalizeIsTop(undefined), false);
  assert.equal(normalizeIsTop(null), false);
  assert.equal(normalizeIsTop('true'), false, 'строка - не согласие владельца, а мусор из формы');
  assert.equal(normalizeIsTop(1), false);
});

test('тариф брони: хотя бы одна топ-услуга у этого мастера делает запись топовой', () => {
  assert.equal(resolveMasterTier([{ is_top: false }, { is_top: true }]), 'top');
  assert.equal(resolveMasterTier([{ is_top: true }]), 'top');
});

test('ни одной топ-услуги - обычный тариф', () => {
  assert.equal(resolveMasterTier([{ is_top: false }, { is_top: false }]), 'standard');
});

test('пустой состав услуг - тарифа нет, а не «стандартный»', () => {
  // Бронь без услуг создать нельзя, но состав правится (PATCH /bookings/:id/services):
  // если в нём когда-нибудь окажется пусто, врать про условия записи нельзя
  assert.equal(resolveMasterTier([]), null);
  assert.equal(resolveMasterTier(null), null);
  assert.equal(resolveMasterTier(undefined), null);
});
