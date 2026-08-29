// Каталог услуг публичного сайта строится из /public/masters (Окно 76, 29.08.2026).
// До этой правки сайт показывал зашитый в storage.js список: услуга, заведённая
// владельцем в разделе «Услуги» кабинета, до клиента не доходила, а удалённая
// продолжала висеть в форме записи.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFromPublicMasters, durationLabel } from '../storage.js';

const STATIC = [
  { id: 'strizhka', name: 'Стрижка', durationMin: 60, price: 2000, composition: 'Состав из макета' },
  { id: 'vosk', name: 'Воск', durationMin: 15, price: 500, composition: 'Состав воска' },
];

test('услуга, заведённая в кабинете, попадает в каталог сайта', () => {
  const catalog = catalogFromPublicMasters(
    [{ id: 'm1', services: [{ id: 'svc-abc', name: 'Детская стрижка', price: 1200, durationMin: 30 }] }],
    STATIC
  );
  assert.deepEqual(catalog.map((s) => [s.id, s.name]), [['svc-abc', 'Детская стрижка']]);
  assert.equal(catalog[0].composition, '', 'описания у новой услуги нет - карточка прайса идёт без него');
  assert.equal(catalog[0].durationLabel, '30 мин');
});

test('удалённая из каталога услуга на сайте не остаётся', () => {
  const catalog = catalogFromPublicMasters(
    [{ id: 'm1', services: [{ id: 'strizhka', name: 'Стрижка', price: 2000, durationMin: 60 }] }],
    STATIC
  );
  assert.equal(catalog.some((s) => s.id === 'vosk'), false);
});

test('описание услуги из макета сохраняется по совпадению id', () => {
  const [service] = catalogFromPublicMasters(
    [{ id: 'm1', services: [{ id: 'strizhka', name: 'Стрижка', price: 2000, durationMin: 60 }] }],
    STATIC
  );
  assert.equal(service.composition, 'Состав из макета');
  assert.equal(service.priceLabel, `2${'\u00a0'}000₽`, 'разделитель разрядов - неразрывный пробел, как его ставит toLocaleString');
});

test('у разных мастеров разная цена - в каталоге минимальная', () => {
  const [service] = catalogFromPublicMasters(
    [
      { id: 'm1', services: [{ id: 'strizhka', name: 'Стрижка', price: 2600, durationMin: 60 }] },
      { id: 'm2', services: [{ id: 'strizhka', name: 'Стрижка', price: 2000, durationMin: 45 }] },
    ],
    STATIC
  );
  assert.equal(service.price, 2000);
  assert.equal(service.durationMin, 45);
});

test('переименование услуги в кабинете доезжает до сайта', () => {
  const [service] = catalogFromPublicMasters(
    [{ id: 'strizhka', services: [{ id: 'strizhka', name: 'Мужская стрижка', price: 2200, durationMin: 60 }] }],
    STATIC
  );
  assert.equal(service.name, 'Мужская стрижка');
});

test('подпись длительности', () => {
  assert.equal(durationLabel(15), '15 мин');
  assert.equal(durationLabel(60), '1 час');
  assert.equal(durationLabel(90), '1 час 30 мин');
  assert.equal(durationLabel(120), '2 ч');
});

test('подпись цены в прайсе - минимальная по мастерам, а не цена первого в списке', () => {
  const [service] = catalogFromPublicMasters(
    [
      { id: 'm1', services: [{ id: 'strizhka', name: 'Стрижка', price: 2600, durationMin: 60 }] },
      { id: 'm2', services: [{ id: 'strizhka', name: 'Стрижка', price: 2000, durationMin: 45 }] },
    ],
    STATIC
  );
  assert.equal(service.priceLabel, `2${'\u00a0'}000₽`);
  assert.equal(service.durationLabel, '45 мин');
});
