// Правка Влада 15.08.2026: при входе в кабинет над расписанием висели красные
// плашки «Не удалось загрузить рабочую неделю / разовые изменения: Сессия
// закончилась. Войдите заново» - их печатали запросы, улетевшие ДО того, как
// проверка сессии решила, что сохранённая сессия для этой страницы не годится.
// Здесь проверяется вторая половина фикса: после конца сессии сообщения об ошибке
// не показываются вовсе, а уже висящие убираются - человек видит форму входа, а не
// стопку отказов. Первая половина (не запускать загрузку до входа) - живой прогон
// tools/verify-2026-08-15-vhod-bez-lozhnyh-oshibok.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

// Крошечный DOM ровно под нужды crm-toast.js: узел с классами, вложением и поиском
// по классу. Полноценный браузер здесь не нужен - логика показа не про вёрстку
function makeNode(tag = 'div') {
  const node = {
    tagName: tag,
    className: '',
    dataset: {},
    children: [],
    parent: null,
    textContent: '',
    isConnected: true,
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove(...names) { node.className = node.className.split(' ').filter((c) => c && !names.includes(c)).join(' '); },
    },
    get offsetWidth() { return 1; },
    setAttribute() {},
    addEventListener() {},
    append(child) { child.parent = node; node.children.push(child); },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); },
    // innerHTML в модуле задаёт внутренности тоста - подставляем заглушки тех узлов,
    // к которым он потом обращается по классу
    set innerHTML(html) {
      node.children = [];
      for (const cls of ['crm-toast__icon', 'crm-toast__text', 'crm-toast__close']) {
        if (html.includes(cls)) { const child = makeNode('span'); child.className = cls; node.append(child); }
      }
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) {
      const wanted = selector.replace(/^\./, '');
      const found = [];
      for (const child of node.children) {
        if (child.className.split(' ').includes(wanted)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    },
  };
  return node;
}

const body = makeNode('body');
globalThis.document = { createElement: (tag) => makeNode(tag), body };

const { showError, showSuccess, markSessionEnded, markSessionActive, isSessionEnded, dismissToasts } =
  await import('../assets/crm-toast.js');

const errors = () => body.querySelectorAll('.crm-toast--error');

test('пока сессия жива - ошибка показывается как раньше', () => {
  markSessionActive();
  dismissToasts();
  showError('Не удалось загрузить рабочую неделю: Сессия закончилась. Войдите заново');
  assert.equal(errors().length, 1);
  assert.equal(isSessionEnded(), false);
});

test('конец сессии убирает уже висящие ошибки', () => {
  markSessionActive();
  dismissToasts();
  showError('Не удалось загрузить команду');
  showError('Не удалось загрузить рабочую неделю');
  assert.equal(errors().length, 2);
  markSessionEnded();
  assert.equal(errors().length, 0, 'после выхода на форму входа старые отказы висеть не должны');
});

test('после конца сессии новые ошибки не показываются - причина одна и она на экране', () => {
  markSessionEnded();
  showError('Не удалось загрузить разовые изменения: Сессия закончилась. Войдите заново');
  showError('Не удалось загрузить рабочую неделю: Сессия закончилась. Войдите заново');
  assert.equal(errors().length, 0);
});

test('успех и подсказки не глушатся - они про другое', () => {
  markSessionEnded();
  showSuccess('Фотография сохранена');
  assert.equal(body.querySelectorAll('.crm-toast--success').length, 1);
});

test('новый вход возвращает сообщения об ошибках', () => {
  markSessionEnded();
  dismissToasts();
  markSessionActive();
  showError('Сервер не смог обработать запрос. Попробуйте ещё раз');
  assert.equal(errors().length, 1);
});
