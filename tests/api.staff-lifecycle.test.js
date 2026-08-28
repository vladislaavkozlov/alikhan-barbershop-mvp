import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidPin, normalizeEmail, normalizeLogin, newTemporaryPin } from '../api/routes/staff.js';

test('логин нормализуется, а временный пароль всегда шестизначный', () => {
  // Ветка совместимости: прежние значения-адреса продолжают работать
  assert.equal(normalizeLogin('  USER@Example.COM '), 'user@example.com');
  assert.equal(normalizeLogin('bad@@mail'), null);
  // Новая форма логина - имя латиницей (Окно 72, 28.08.2026)
  assert.equal(normalizeLogin('  Aliovsad '), 'aliovsad');
  assert.equal(normalizeLogin('renat.k'), 'renat.k');
  assert.equal(normalizeLogin('admin-1'), 'admin-1');
  // Кириллица, пробелы внутри и слишком короткое - не логин
  assert.equal(normalizeLogin('ренат'), null);
  assert.equal(normalizeLogin('two words'), null);
  assert.equal(normalizeLogin('ab'), null);
  assert.equal(normalizeLogin('.leading'), null);
  assert.equal(normalizeLogin(''), null);
  // Старое имя функции работает как алиас - на него завязано подключение арендатора
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
  for (let i = 0; i < 10; i++) assert.match(newTemporaryPin(), /^\d{6}$/);
});
test('пароль - минимум шесть знаков', () => {
  assert.equal(isValidPin('123456'), true);
  assert.equal(isValidPin('abc123'), true);
  assert.equal(isValidPin('abc12'), false);
});
