// Окно 28 (05.08.2026) - мелкая полировка CRM владельца. Юниты на два чистых хелпера
// из assets/crm-schedule-views.js: определение выходного дня для модалки дня и разметку
// точки статуса в сетке Месяца. DOM не нужен - обе функции чистые (тот же приём, что в
// schedule-views.navigation.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDayOffShift, dayStatusDot } from '../assets/crm-schedule-views.js';

test('isDayOffShift: перерыв во всю смену - выходной, при стандартной смене 10:00-20:00', () => {
  assert.equal(
    isDayOffShift({ startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] }),
    true
  );
});

test('isDayOffShift: РАННЯЯ смена 09:00-18:00, закрытая целиком - тоже выходной (регрессия Окна 28)', () => {
  // Ровно тот баг, ради которого хелпер и появился: сравнение с литералами 10:00-20:00
  // давало false, и модалка открывала закрытый день как "Рабочий день".
  assert.equal(
    isDayOffShift({ startTime: '09:00', endTime: '18:00', breaks: [{ startTime: '09:00', endTime: '18:00' }] }),
    true
  );
  // И наоборот: старая проверка считала выходным день с перерывом 10:00-20:00 у смены
  // 09:00-22:00, хотя мастер работает 09:00-10:00 и 20:00-22:00.
  assert.equal(
    isDayOffShift({ startTime: '09:00', endTime: '22:00', breaks: [{ startTime: '10:00', endTime: '20:00' }] }),
    false
  );
});

test('isDayOffShift: обычный обеденный перерыв выходным не делает', () => {
  assert.equal(
    isDayOffShift({ startTime: '10:00', endTime: '20:00', breaks: [{ startTime: '13:00', endTime: '14:00' }] }),
    false
  );
  assert.equal(isDayOffShift({ startTime: '10:00', endTime: '20:00', breaks: [] }), false);
});

test('isDayOffShift: смены на этот день нет вовсе - не выходной, не падаем', () => {
  assert.equal(isDayOffShift(undefined), false);
  assert.equal(isDayOffShift(null), false);
  assert.equal(isDayOffShift({ startTime: '10:00', endTime: '20:00' }), false); // ответ без поля breaks
});

test('dayStatusDot: кружок вместо эмодзи, со словесной подписью для каждого статуса', () => {
  const work = dayStatusDot('work');
  assert.match(work, /class="day-dot day-dot--work"/);
  assert.match(work, /aria-label="Обычный день"/);
  assert.match(dayStatusDot('edit'), /day-dot--edit/);
  assert.match(dayStatusDot('off'), /aria-label="Выходной"/);
  // Смысл не должен держаться на одном цвете - подпись словами обязана быть у всех трёх
  for (const status of ['work', 'edit', 'off']) {
    assert.match(dayStatusDot(status), /title="[^"]+"/);
    assert.doesNotMatch(dayStatusDot(status), /🟢|🟡|🔴/);
  }
});
