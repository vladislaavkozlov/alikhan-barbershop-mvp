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
  constructor(panels) {
    super();
    this.panels = panels;
    panels.forEach((panel) => { panel.parent = this; });
  }

  querySelectorAll(selector) {
    assert.equal(selector, ':scope > details.staff-card');
    return this.panels;
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
