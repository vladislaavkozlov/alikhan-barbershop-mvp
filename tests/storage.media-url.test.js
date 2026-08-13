import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mediaUrl } from '../storage.js';

const API = 'https://alikhancrm1-vladislaavkozlov.amvera.io';

// Регрессия 13.08.2026: API отдаёт относительный /media/<ключ>, страницы живут на
// GitHub Pages - браузер просил фото у github.io и получал 404, аватар не грузился
// молча (загрузка при этом работала, файл на бэкенде лежал целым).
test('относительный путь медиа склеивается с базой API', () => {
  assert.equal(mediaUrl(API, '/media/abc.webp'), `${API}/media/abc.webp`);
  assert.equal(mediaUrl(`${API}/`, '/media/abc.webp'), `${API}/media/abc.webp`);
  assert.equal(mediaUrl(API, 'media/abc.webp'), `${API}/media/abc.webp`);
});

test('готовый абсолютный адрес и data-URI не трогаются', () => {
  assert.equal(mediaUrl(API, 'https://cdn.example/a.webp'), 'https://cdn.example/a.webp');
  assert.equal(mediaUrl(API, '//cdn.example/a.webp'), '//cdn.example/a.webp');
  assert.equal(mediaUrl(API, 'data:image/webp;base64,AAA'), 'data:image/webp;base64,AAA');
});

test('пустое значение остаётся пустым - мастер без фото рисует инициалы', () => {
  assert.equal(mediaUrl(API, null), null);
  assert.equal(mediaUrl(API, undefined), undefined);
  assert.equal(mediaUrl(API, ''), '');
});

test('оба контура берут адрес фото из одного хелпера, не собирают строку сами', async () => {
  const root = new URL('../', import.meta.url);
  const [storage, team] = await Promise.all([
    readFile(new URL('storage.js', root), 'utf8'),
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
  ]);
  assert.match(storage, /photoUrl: mediaUrl\(apiBaseUrl, master\.photoUrl\)/);
  assert.match(storage, /portfolio: \(master\.portfolio \?\? \[\]\)\.map/);
  assert.match(team, /mediaUrl\(API, media\.url\)/);
});
