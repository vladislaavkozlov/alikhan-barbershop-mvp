import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

// 16.08.2026. PUT /auth/pin и колонка must_change_pin существовали в API с самого
// начала, но ни один кабинет их не показывал: сотрудник, заведённый владельцем,
// оставался с временным PIN, который знает тот, кто его заводил, навсегда.
test('мастер и администратор могут сменить свой PIN из «Личных данных»', async () => {
  const [master, admin] = await Promise.all([source('crm-master.html'), source('crm-admin.html')]);

  for (const [name, html] of [['мастер', master], ['администратор', admin]]) {
    assert.match(html, /id="pinNew"/, `${name}: нет поля нового PIN`);
    assert.match(html, /id="pinRepeat"/, `${name}: нет повтора PIN`);
    assert.match(html, /id="pinSaveBtn"/, `${name}: нет кнопки смены`);
    assert.match(html, /id="pinMustChange"/, `${name}: нет подсказки о временном PIN`);
    assert.match(html, /import '\.\/assets\/crm-pin\.js'/, `${name}: модуль не подключён`);
    // PIN не должен попадать в историю браузера и автозаполнение старого пароля
    assert.match(html, /id="pinNew" type="password"[^>]*autocomplete="new-password"/, `${name}: поле PIN не закрыто`);
    assert.match(html, /id="pinRepeat" type="password"[^>]*autocomplete="new-password"/, `${name}: повтор PIN не закрыт`);
  }
});

test('смена PIN повторяет правило сервера и не оставляет введённое на экране', async () => {
  const [pin, auth] = await Promise.all([source('assets/crm-pin.js'), source('api/routes/auth.js')]);

  // сервер принимает ровно шесть цифр - интерфейс обязан говорить об этом заранее
  assert.match(auth, /\/\^\\d\{6\}\$\/\.test\(String\(body\.newPin/);
  assert.match(pin, /const PIN_LENGTH = 6/);
  assert.match(pin, /PIN_RE\.test\(newPin\)/);
  assert.match(pin, /newPin !== repeat/);
  // введённый PIN стирается из полей после успеха
  assert.match(pin, /newEl\.value = '';\s*\n\s*repeatEl\.value = '';/);
  // и никуда не логируется
  assert.doesNotMatch(pin, /console\.(log|info|warn|error)/);
  // флаг временного PIN из ответа входа наконец читается
  assert.match(pin, /staff\?\.mustChangePin/);
});
