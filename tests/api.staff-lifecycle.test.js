import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidPin, normalizeEmail, newTemporaryPin } from '../api/routes/staff.js';

test('email нормализуется, а временный PIN всегда шестизначный', () => {
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('wrong'), null);
  for (let i = 0; i < 10; i++) assert.match(newTemporaryPin(), /^\d{6}$/);
});
test('PIN строго шестизначный', () => {
  assert.equal(isValidPin('123456'), true);
  assert.equal(isValidPin('abc123'), false);
});
