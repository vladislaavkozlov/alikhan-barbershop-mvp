import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('публичный сайт не подставляет статических мастеров при доступном API и показывает поля профиля', async () => {
  const source = await readFile(new URL('app.js', root), 'utf8');
  assert.match(source, /window\.ALIKHAN_API_URL \? \[\] : getMasters\(\)/);
  for (const field of ['experienceText', 'strengthsText', 'certificatesText', 'portfolio', 'photoUrl']) {
    assert.match(source, new RegExp(field));
  }
  // Редизайн 18.08.2026: витрина команды больше не рисует текст-заглушку поверх
  // разметки - пока список мастеров пуст (запрос идёт или упал), в сетке остаются
  // карточки-фоллбэк из index.html, и ни одна из них не выдаётся за данные CRM
  assert.match(source, /if \(!mastersGrid \|\| !masters\.length\) return;/);
});
