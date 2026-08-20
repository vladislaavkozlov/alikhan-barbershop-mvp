// Топ-мастер и цена услуги в карточке сотрудника (20.08.2026, постановка Влада: «в
// пункте меню "команда" по сотрудникам должна быть опция поставить галку в услугах
// "топ мастер" и чтобы была возможность ему поставить другую цену услуги»).
//
// До этой правки цена в строке услуги была текстом (.sc-price), редактировалась только
// длительность - хотя master_services.price существует с Окна 8 и роут его принимал.
//
// Фейковый DOM - тот же приём, что в crm-service-duration.behavior.test.js: проверяем
// реальные функции модуля, а не переписанную в тесте копию логики.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ??= {};
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { collectServiceChanges, markInvalidServicePrices, parsePriceValue, saveServiceChanges, PRICE_ERROR } =
  await import('../assets/crm-master-services.js');

class FakeInput {
  constructor(value) {
    this.value = value;
    this.attributes = {};
    this.classes = new Set();
    this.classList = {
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
}

class FakeLabel {
  constructor({ serviceId, checked, duration = '40', price, isTop = false, initialEnabled = true, initialDuration = 40, initialPrice, initialTop = false }) {
    this.dataset = {
      serviceId,
      initialEnabled: initialEnabled ? '1' : '0',
      initialDuration: String(initialDuration),
      initialPrice: String(initialPrice),
      initialTop: initialTop ? '1' : '0',
    };
    this.checkbox = { checked };
    this.durationInput = new FakeInput(duration);
    this.priceInput = new FakeInput(price);
    this.topInput = { checked: isTop, disabled: false };
  }
  querySelector(selector) {
    if (selector === 'input[type="checkbox"]') return this.checkbox;
    if (selector === '.sc-duration-input') return this.durationInput;
    if (selector === '.sc-price-input') return this.priceInput;
    if (selector === '.sc-top-input') return this.topInput;
    return null;
  }
}

class FakePicker {
  constructor(labels) { this.labels = labels; }
  querySelectorAll(selector) {
    assert.equal(selector, '.service-check[data-service-id]');
    return this.labels;
  }
}

const row = (over = {}) => new FakeLabel({ serviceId: 'strizhka', checked: true, price: '2000', initialPrice: 2000, ...over });

test('изменённая цена уезжает на сервер вместе с остальной строкой', () => {
  const changes = collectServiceChanges(new FakePicker([row({ price: '3000' })]));
  assert.deepEqual(changes, [{ serviceId: 'strizhka', enabled: true, durationMin: 40, price: 3000, isTop: false }]);
});

test('галка «топ» - самостоятельная правка: цена и длительность те же, а тариф новый', () => {
  const changes = collectServiceChanges(new FakePicker([row({ isTop: true })]));
  assert.deepEqual(changes, [{ serviceId: 'strizhka', enabled: true, durationMin: 40, price: 2000, isTop: true }]);
});

test('ничего не трогали - сохранять нечего, кнопка карточки остаётся серой', () => {
  assert.deepEqual(collectServiceChanges(new FakePicker([row()])), []);
});

test('снятая галка «топ» тоже правка - иначе тариф нельзя было бы отключить', () => {
  const changes = collectServiceChanges(new FakePicker([row({ isTop: false, initialTop: true })]));
  assert.deepEqual(changes, [{ serviceId: 'strizhka', enabled: true, durationMin: 40, price: 2000, isTop: false }]);
});

test('ноль, пусто, минус, дробь и текст в цене отвергаются - тот же урок, что с длительностью', () => {
  for (const bad of ['0', '', '   ', '-100', '1500.5', 'abc']) {
    const label = row({ price: bad });
    assert.deepEqual(markInvalidServicePrices(new FakePicker([label])), ['strizhka'], `цена ${JSON.stringify(bad)} должна быть отвергнута`);
    assert.equal(label.priceInput.classes.has('is-invalid'), true);
    assert.equal(label.priceInput.attributes['aria-invalid'], 'true');
    assert.equal(parsePriceValue(bad), null);
  }
  assert.equal(PRICE_ERROR, 'Цена услуги должна быть целым числом больше нуля');
});

test('пробелы и разделитель тысяч внутри цены человеку прощаются', () => {
  // Владелец вводит «3 000» или «3 000 ₽», копируя из прайса - это корректные 3000,
  // а не ошибка ввода: отбивать такое значило бы спорить с человеком на ровном месте
  assert.equal(parsePriceValue('3 000'), 3000);
  assert.equal(parsePriceValue('3000'), 3000);
  assert.equal(parsePriceValue(' 2500 '), 2500);
});

test('корректная цена не подсвечивается и уезжает целым числом', () => {
  const label = row({ price: '3 000' });
  assert.deepEqual(markInvalidServicePrices(new FakePicker([label])), []);
  assert.equal(label.priceInput.classes.has('is-invalid'), false);
  assert.deepEqual(collectServiceChanges(new FakePicker([label])), [
    { serviceId: 'strizhka', enabled: true, durationMin: 40, price: 3000, isTop: false },
  ]);
});

test('выключенная услуга с пустой ценой сохранению не мешает - её цена не уезжает', () => {
  const label = row({ checked: false, price: '' });
  assert.deepEqual(markInvalidServicePrices(new FakePicker([label])), []);
  assert.deepEqual(collectServiceChanges(new FakePicker([label])), [
    { serviceId: 'strizhka', enabled: false, durationMin: 40, price: null, isTop: false },
  ]);
});

test('выключенная услуга не может остаться топовой - тариф без услуги существовать не может', () => {
  // Сняли услугу у мастера, но галка «топ» на ней осталась: на сервер уходит
  // { enabled: false }, строка master_services удаляется целиком - и в теле запроса
  // не должно быть тарифа, который некуда применить
  const label = row({ checked: false, isTop: true, initialTop: true });
  assert.deepEqual(collectServiceChanges(new FakePicker([label])), [
    { serviceId: 'strizhka', enabled: false, durationMin: 40, price: 2000, isTop: false },
  ]);
});

test('saveServiceChanges не отправляет запрос с негодной ценой даже в обход кнопки', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true }; };
  const failed = await saveServiceChanges('master-1', [{ serviceId: 'strizhka', enabled: true, durationMin: 40, price: null, isTop: false }]);
  assert.equal(failed?.serviceId, 'strizhka');
  assert.equal(failed?.data?.error, 'invalid_price');
  assert.equal(calls, 0, 'ни одного PUT с пустой ценой');
});

test('в теле PUT едут все четыре поля строки - иначе сервер перезапишет строку целиком чужими значениями', async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true }; };
  const failed = await saveServiceChanges('master-1', [{ serviceId: 'strizhka', enabled: true, durationMin: 45, price: 3000, isTop: true }]);
  assert.equal(failed, null);
  assert.deepEqual(sent[0].body, { enabled: true, durationMin: 45, price: 3000, isTop: true });
});
