// Подсказка о связанной услуге в карточке сотрудника (21.08.2026, вопрос Влада:
// «если ставим мастеру стрижку 3000 вместо 2000, комплекс стрижка+борода должен
// пересчитаться автоматически?»).
//
// Решение: НЕ пересчитывать. Комплекс стоит 3500 при сумме частей 3600 - в нём зашита
// скидка, которую придумал владелец, и правила «комплекс = сумма минус X» в системе
// нет. Автоматический пересчёт означал бы выдуманную цену на боевом прайсе. Но забыть
// про связанную услугу легко, поэтому карточка сама напоминает: поменял цену части -
// проверь комплекс, и наоборот.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ??= {};
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { comboPriceHint } = await import('../assets/crm-master-services.js');

// toLocaleString('ru-RU') разделяет тысячи неразрывным пробелом - сравниваем с обычным
const hint = (...args) => { const text = comboPriceHint(...args); return text == null ? text : text.replace(/\u00a0/g, ' '); };

// Строки как в карточке: id услуги → её цена у этого мастера
const PRICES = { strizhka: 2000, boroda: 1600, 'kompleks-strizhka-boroda': 3500 };

test('поменял цену части - напоминаем про комплекс и показываем его цену', () => {
  assert.equal(
    hint('strizhka', { ...PRICES, strizhka: 3000 }),
    'Входит в «Комплекс стрижка+борода» - сейчас 3 500 ₽, проверьте и его'
  );
});

test('вторая часть комплекса ведёт себя так же', () => {
  assert.match(hint('boroda', { ...PRICES, boroda: 2000 }), /Комплекс стрижка\+борода/);
});

test('поменял цену самого комплекса - напоминаем про его состав', () => {
  assert.equal(
    hint('kompleks-strizhka-boroda', { ...PRICES, 'kompleks-strizhka-boroda': 4200 }),
    'Состоит из услуг «Стрижка» и «Борода» - по отдельности сейчас 3 600 ₽'
  );
});

test('услуга вне комплексов подсказки не получает', () => {
  assert.equal(hint('vosk', PRICES), null);
  assert.equal(hint('spa-uhod', PRICES), null);
});

test('комплекс мастеру не назначен - подсказки нет, она была бы про несуществующее', () => {
  const withoutCombo = { strizhka: 3000, boroda: 1600 };
  assert.equal(hint('strizhka', withoutCombo), null);
});

test('часть комплекса мастеру не назначена - в цене «по отдельности» не врём', () => {
  // У мастера есть комплекс и стрижка, но нет бороды: сумму частей посчитать не из чего
  const partial = { strizhka: 2000, 'kompleks-strizhka-boroda': 3500 };
  assert.equal(hint('kompleks-strizhka-boroda', partial), null);
});
