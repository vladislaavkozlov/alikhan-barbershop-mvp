import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor() {
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

class FakePanel extends FakeElement {
  constructor(open = false) {
    super();
    this.open = open;
  }

  toggle() {
    this.parent.listeners.get('toggle')?.();
  }
}

class FakeList extends FakeElement {
  // nested - карточки, вложенные ВНУТРЬ одной из карточек списка (так устроен блок
  // «Зарплаты мастеров» в «Финансах»: он сам карточка, а внутри список сотрудников).
  // Селектор ':scope > ...' их не видит, 'details.staff-card' видит - на этой разнице
  // и держится «Развернуть все» = развернуть ВСЁ
  constructor(panels, nested = []) {
    super();
    this.panels = panels;
    this.nested = nested;
    [...panels, ...nested].forEach((panel) => { panel.parent = this; });
  }

  querySelectorAll(selector) {
    if (selector === ':scope > details.staff-card') return this.panels;
    assert.equal(selector, 'details.staff-card');
    return [...this.panels, ...this.nested];
  }

  before(controls) {
    this.controls = controls;
  }

  addPanel(panel) {
    panel.parent = this;
    this.panels.push(panel);
  }
}

class FakeButton extends FakeElement {
  constructor() {
    super();
    this.label = new FakeElement();
  }

  set innerHTML(value) {
    this.html = value;
  }

  querySelector(selector) {
    assert.equal(selector, '.panel-group-toggle__label');
    return this.label;
  }

  click() {
    this.listeners.get('click')?.();
  }
}

class FakeDocument {
  createElement(tagName) {
    if (tagName === 'button') return new FakeButton();
    return Object.assign(new FakeElement(), { append(child) { this.child = child; } });
  }
}

test('общий контрол команды управляет карточками, добавленными после инициализации', async () => {
  const { initCrmNavigationPanels } = await import('../assets/crm-navigation-panels.js');
  const originalDocument = globalThis.document;
  const list = new FakeList([new FakePanel(), new FakePanel(), new FakePanel()]);
  const root = {
    ownerDocument: new FakeDocument(),
    querySelectorAll(selector) {
      assert.equal(selector, '.staff-list');
      return [list];
    },
  };

  globalThis.document = root.ownerDocument;
  try {
    initCrmNavigationPanels(root);
    const button = list.controls.child;
    const newMember = new FakePanel();
    list.addPanel(newMember);

    button.click();

    assert.equal(list.panels.every((panel) => panel.open), true);
    assert.equal(button.label.textContent, 'Свернуть все');

    newMember.open = false;
    newMember.toggle();
    assert.equal(button.label.textContent, 'Развернуть все');
  } finally {
    globalThis.document = originalDocument;
  }
});

// Правка Влада 21.08.2026: «когда во вкладке "Финансы" нажимаешь "развернуть все",
// разворачивается только блок "зарплаты мастеров"». Кнопка знала лишь прямых детей
// списка, поэтому карточки сотрудников внутри блока оставались закрытыми, и раскрытие
// выглядело сработавшим наполовину
test('«Развернуть все» раскрывает и вложенные карточки, а не только верхний уровень', async () => {
  const { initCrmNavigationPanels } = await import('../assets/crm-navigation-panels.js');
  const originalDocument = globalThis.document;
  const revenue = new FakePanel();
  const payroll = new FakePanel();
  const masterCards = [new FakePanel(), new FakePanel()];
  const list = new FakeList([revenue, payroll], masterCards);
  const root = {
    ownerDocument: new FakeDocument(),
    querySelectorAll() { return [list]; },
  };

  globalThis.document = root.ownerDocument;
  try {
    initCrmNavigationPanels(root);
    const button = list.controls.child;

    button.click();
    assert.equal(revenue.open, true, '«Выручка» должна раскрыться вместе со всеми');
    assert.equal(payroll.open, true);
    assert.equal(masterCards.every((c) => c.open), true, 'карточки сотрудников внутри блока тоже');
    assert.equal(button.label.textContent, 'Свернуть все');

    button.click();
    assert.equal([revenue, payroll, ...masterCards].every((c) => !c.open), true, 'повторное нажатие сворачивает всё');
    assert.equal(button.label.textContent, 'Развернуть все');
  } finally {
    globalThis.document = originalDocument;
  }
});

// Закрытая вложенная карточка держит кнопку в положении «Развернуть все» - иначе
// подпись обещала бы сворачивание там, где раскрыто ещё не всё
test('одна закрытая карточка внутри блока не даёт кнопке перейти в «Свернуть все»', async () => {
  const { initCrmNavigationPanels } = await import('../assets/crm-navigation-panels.js');
  const originalDocument = globalThis.document;
  const nested = new FakePanel();
  const list = new FakeList([new FakePanel(true), new FakePanel(true)], [nested]);
  const root = { ownerDocument: new FakeDocument(), querySelectorAll() { return [list]; } };

  globalThis.document = root.ownerDocument;
  try {
    initCrmNavigationPanels(root);
    assert.equal(list.controls.child.label.textContent, 'Развернуть все');
  } finally {
    globalThis.document = originalDocument;
  }
});
