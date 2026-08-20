// Логика тарифа на публичном сайте (20.08.2026, Фаза 4 плана
// plans/2026-08-20-top-master-tarif.md). Клиент выбирает услуги, потом тариф - «у
// обычного мастера за стандартную оплату» или «у топ-мастера за +», и только потом
// самого мастера. Всё, что здесь проверяется, - чистые функции над строками
// /master-services, без DOM: ровно они решают, кто попадёт в какой тариф и какую цену
// клиент увидит на карточке «от».
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  masterCoversServices,
  masterTierForServices,
  masterTotalsForServices,
  minTotalByTier,
} from '../storage.js';

// Топ Мастер: стрижка топовая и дороже. Обычный: тот же набор по каталожной цене.
// Узкий мастер оказывает только бороду - на паре услуг он не подходит вовсе.
const ROWS = [
  { masterId: 'top', serviceId: 'strizhka', price: 3000, durationMin: 60, isTop: true },
  { masterId: 'top', serviceId: 'boroda', price: 1600, durationMin: 30, isTop: false },
  { masterId: 'usual', serviceId: 'strizhka', price: 2000, durationMin: 60, isTop: false },
  { masterId: 'usual', serviceId: 'boroda', price: 1600, durationMin: 30, isTop: false },
  { masterId: 'narrow', serviceId: 'boroda', price: 1400, durationMin: 30, isTop: false },
];

test('мастер подходит, только если оказывает ВСЕ выбранные услуги', () => {
  // Иначе клиент дошёл бы до выбора времени и получил отказ сервера
  // (unknown_master_service) уже после ввода имени и телефона
  assert.equal(masterCoversServices(ROWS, 'top', ['strizhka', 'boroda']), true);
  assert.equal(masterCoversServices(ROWS, 'narrow', ['strizhka', 'boroda']), false);
  assert.equal(masterCoversServices(ROWS, 'narrow', ['boroda']), true);
});

test('услуг не выбрано - подходят все, список мастеров пока не сужаем', () => {
  assert.equal(masterCoversServices(ROWS, 'narrow', []), true);
});

test('тариф мастера считается по тем же правилам, что и на сервере', () => {
  // resolveMasterTier (api/routes/bookings.js): хотя бы одна топ-услуга в наборе -
  // визит топовый. Разойдись эти два правила, клиент выбрал бы «обычного», а в CRM
  // запись оказалась бы топовой
  assert.equal(masterTierForServices(ROWS, 'top', ['strizhka', 'boroda']), 'top');
  assert.equal(masterTierForServices(ROWS, 'top', ['boroda']), 'standard');
  assert.equal(masterTierForServices(ROWS, 'usual', ['strizhka']), 'standard');
});

test('мастер, который услугу не оказывает, тарифа по ней не имеет', () => {
  assert.equal(masterTierForServices(ROWS, 'narrow', ['strizhka']), null);
  assert.equal(masterTierForServices(ROWS, 'top', []), null);
});

test('итог по мастеру - сумма его собственных цен и длительностей', () => {
  assert.deepEqual(masterTotalsForServices(ROWS, 'top', ['strizhka', 'boroda']), { price: 4600, durationMin: 90 });
  assert.deepEqual(masterTotalsForServices(ROWS, 'usual', ['strizhka', 'boroda']), { price: 3600, durationMin: 90 });
});

test('итог по мастеру, который оказывает не всё, не выдумывается', () => {
  // Сложить то, что есть, и показать цифру как полную - значит соврать в цене
  assert.equal(masterTotalsForServices(ROWS, 'narrow', ['strizhka', 'boroda']), null);
});

test('на карточках тарифов - минимальная цена в каждой группе', () => {
  assert.deepEqual(minTotalByTier(ROWS, ['top', 'usual', 'narrow'], ['strizhka']), { standard: 2000, top: 3000 });
});

test('в тариф попадают только мастера, которых реально можно выбрать', () => {
  // Список приходит уже отфильтрованным (уволенные, без графика - filterBookableMasters),
  // и цена «от» обязана считаться по нему же, иначе клиент увидит цену мастера,
  // которого в списке нет
  assert.deepEqual(minTotalByTier(ROWS, ['usual'], ['strizhka']), { standard: 2000, top: null });
});

test('нет топ-мастеров по этим услугам - тарифа top нет вовсе, а не ноль', () => {
  assert.deepEqual(minTotalByTier(ROWS, ['usual', 'narrow'], ['boroda']), { standard: 1400, top: null });
});

test('услуги не выбраны - цен «от» ещё нет', () => {
  assert.deepEqual(minTotalByTier(ROWS, ['top', 'usual'], []), { standard: null, top: null });
});
