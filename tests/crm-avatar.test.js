// Аватар сотрудника в кружках «Дня» и «Команды» (правка Влада 15.08.2026).
// Проверяются чистые функции модуля: выбор ссылки на фото и запасные инициалы.
// Показ в самих разделах - живой прогон tools/verify-2026-08-15-avatarki-masterov.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ??= {};
window.ALIKHAN_API_URL = 'https://api.example.test';
const { avatarUrlOf, avatarMarkup, initialsOfName } = await import('../assets/crm-avatar.js');

test('фото берётся из состава сотрудника и становится полным адресом', () => {
  const staff = { name: 'Алиовсад', media: [{ kind: 'portfolio', url: '/media/work.webp' }, { kind: 'avatar', url: '/media/face.webp' }] };
  // Относительный адрес от API - фронтенд живёт на другом домене, без базы фото не загрузится
  assert.equal(avatarUrlOf(staff), 'https://api.example.test/media/face.webp');
});

test('фото нет - и ссылки нет, кружок останется с инициалами', () => {
  assert.equal(avatarUrlOf({ name: 'Алиовсад', media: [{ kind: 'portfolio', url: '/media/work.webp' }] }), null);
  assert.equal(avatarUrlOf({ name: 'Алиовсад' }), null);
  assert.equal(avatarUrlOf(null), null);
});

test('готовый внешний адрес не ломается второй базой', () => {
  assert.equal(avatarUrlOf({ media: [{ kind: 'avatar', url: 'https://cdn.example.com/a.webp' }] }), 'https://cdn.example.com/a.webp');
});

test('инициалы: одно слово - две буквы, два слова - по первой', () => {
  assert.equal(initialsOfName('Алиовсад'), 'АЛ');
  assert.equal(initialsOfName('Алиовсад Магомедов'), 'АМ');
  assert.equal(initialsOfName('  Елизавета   Петрова  '), 'ЕП');
  assert.equal(initialsOfName(''), '');
});

test('в разметке с фото - картинка, без фото - прежний кружок с буквами', () => {
  const withPhoto = avatarMarkup({ name: 'Алиовсад', media: [{ kind: 'avatar', url: '/media/face.webp' }] });
  assert.match(withPhoto, /class="avatar avatar--photo"/);
  assert.match(withPhoto, /<img src="https:\/\/api\.example\.test\/media\/face\.webp"/);
  assert.match(withPhoto, /loading="lazy"/);

  const without = avatarMarkup({ name: 'Алиовсад' });
  assert.equal(without, '<div class="avatar">АЛ</div>');
});

test('имя с кавычками и скобками не ломает разметку', () => {
  const markup = avatarMarkup({ name: '<img onerror="alert(1)">' });
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;/);
});
