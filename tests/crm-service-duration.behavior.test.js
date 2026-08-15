// Баг P2 (Влад, 15.08.2026): в карточке сотрудника указываешь длительность услуги
// 0 минут, жмёшь "Сохранить изменения" - карточка пишет "Сохранено", ошибки нет, а
// после F5 значение молча возвращается к 60. Причина была во фронте:
// collectServiceChanges читала поле как `Number(value) || initialDuration`, а
// Number("0") - falsy, поэтому ноль подменялся исходными 60 минутами, правка не
// считалась правкой и на сервер не уезжала вовсе (серверная проверка durationMin<=0
// при этом была на месте, но запрос до неё не доходил).
//
// Фейковый DOM - тот же приём, что в crm-navigation-panels.behavior.test.js:
// проверяем реальные функции модуля, а не переписанную в тесте копию логики.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ??= {};
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { collectServiceChanges, markInvalidServiceDurations, parseDurationValue, saveServiceChanges, DURATION_ERROR } =
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
  constructor({ serviceId, checked, duration, initialEnabled, initialDuration }) {
    this.dataset = { serviceId, initialEnabled: initialEnabled ? '1' : '0', initialDuration: String(initialDuration) };
    this.checkbox = { checked };
    this.durationInput = new FakeInput(duration);
  }
  querySelector(selector) {
    if (selector === 'input[type="checkbox"]') return this.checkbox;
    if (selector === '.sc-duration-input') return this.durationInput;
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

// Ровно тот случай, что описал Влад: услуга включена, в поле 0, в базе было 60
const zeroRow = () => new FakeLabel({ serviceId: 'haircut', checked: true, duration: '0', initialEnabled: true, initialDuration: 60 });

test('ноль в поле длительности - это правка, а не молчаливый откат к каталожным 60', () => {
  const picker = new FakePicker([zeroRow()]);
  const changes = collectServiceChanges(picker);
  assert.equal(changes.length, 1, 'изменение обязано попасть в список, иначе кнопка карточки останется серой');
  assert.equal(changes[0].durationMin, null, 'ноль не подменяется исходным значением');
});

test('ноль минут блокирует сохранение и подсвечивает поле', () => {
  const label = zeroRow();
  const picker = new FakePicker([label]);
  assert.deepEqual(markInvalidServiceDurations(picker), ['haircut']);
  assert.equal(label.durationInput.classes.has('is-invalid'), true);
  assert.equal(label.durationInput.attributes['aria-invalid'], 'true');
  assert.equal(DURATION_ERROR, 'Длительность услуги должна быть больше 0 минут');
});

test('пусто, минус, дробь и текст отвергаются так же, как ноль', () => {
  for (const bad of ['', '   ', '-10', '1.5', 'abc', '0']) {
    const label = new FakeLabel({ serviceId: 'beard', checked: true, duration: bad, initialEnabled: true, initialDuration: 40 });
    assert.deepEqual(markInvalidServiceDurations(new FakePicker([label])), ['beard'], `значение ${JSON.stringify(bad)} должно быть отвергнуто`);
    assert.equal(parseDurationValue(bad), null);
  }
});

test('корректная длительность сохраняется и поле не подсвечивается', () => {
  const label = new FakeLabel({ serviceId: 'haircut', checked: true, duration: '45', initialEnabled: true, initialDuration: 60 });
  const picker = new FakePicker([label]);
  assert.deepEqual(markInvalidServiceDurations(picker), []);
  assert.equal(label.durationInput.classes.has('is-invalid'), false);
  assert.deepEqual(collectServiceChanges(picker), [{ serviceId: 'haircut', enabled: true, durationMin: 45 }]);
});

test('выключенная услуга с пустым полем сохранению не мешает - её длительность не уезжает', () => {
  const label = new FakeLabel({ serviceId: 'haircut', checked: false, duration: '', initialEnabled: true, initialDuration: 60 });
  const picker = new FakePicker([label]);
  assert.deepEqual(markInvalidServiceDurations(picker), []);
  assert.deepEqual(collectServiceChanges(picker), [{ serviceId: 'haircut', enabled: false, durationMin: null }]);
});

test('подсветка снимается, когда цифру исправили', () => {
  const label = zeroRow();
  const picker = new FakePicker([label]);
  markInvalidServiceDurations(picker);
  label.durationInput.value = '30';
  assert.deepEqual(markInvalidServiceDurations(picker), []);
  assert.equal(label.durationInput.classes.has('is-invalid'), false);
  assert.equal(label.durationInput.attributes['aria-invalid'], undefined);
});

test('saveServiceChanges не отправляет запрос с неверной длительностью даже в обход кнопки', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true }; };
  const failed = await saveServiceChanges('master-1', [{ serviceId: 'haircut', enabled: true, durationMin: null }]);
  assert.equal(failed?.serviceId, 'haircut');
  // причина возвращается вместе с услугой - карточка покажет её человеку, а не «не получилось»
  assert.equal(failed?.data?.error, 'invalid_duration');
  assert.equal(calls, 0, 'ни одного PUT с пустой длительностью');
});
