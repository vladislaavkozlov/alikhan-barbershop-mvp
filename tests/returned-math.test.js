// Офлайн-тесты счётчика возвращённых денег (api/lib/returned.js).
//
// Главное, что проверяется здесь, - честность атрибуции. Счётчик существует ради
// гарантии «не вернули больше, чем стоит подписка - месяц не оплачивается», и цифра
// в нём должна выдерживать спор с владельцем клиники. Поэтому визит без доставленного
// сообщения не засчитывается ни при каких обстоятельствах: система не может ставить
// себе в заслугу человека, которому ничего не отправляла.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReturn, summarizeReturned, RETURN_REASONS } from '../api/lib/returned.js';

test('без доставленного сообщения возврат не засчитывается никогда', () => {
  // Даже самый «возвратный» набор признаков без отправки не считается: клиент
  // подтвердил, имел неявки и был просрочен - но сообщение не ушло
  assert.equal(
    classifyReturn({ messageSent: false, clientConfirmed: true, priorNoShows: 3, wasOverdue: true }),
    null
  );
});

test('подтверждение кнопкой - самое сильное основание', () => {
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: true, priorNoShows: 0, wasOverdue: false }),
    'confirmed'
  );
});

test('клиент с историей неявок, пришедший после напоминания', () => {
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: false, priorNoShows: 2, wasOverdue: false }),
    'reminded_risky'
  );
});

test('просроченный клиент, вернувшийся после напоминания', () => {
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: false, priorNoShows: 0, wasOverdue: true }),
    'returned_overdue'
  );
});

test('нажал «Приду» на подтверждении записи, до напоминания - засчитывается', () => {
  // Клиент часто отвечает сразу на подтверждение, за сутки до напоминания. Требовать
  // именно напоминание значило бы выбросить самых отзывчивых людей из подсчёта
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: true, priorNoShows: 0, wasOverdue: false }),
    'confirmed'
  );
});

test('не нажал кнопку, но был в группе риска - засчитывается', () => {
  // Вопрос владельца 02.09.2026: «а если не нажал и пришёл?». Молчаливый клиент с
  // историей неявок засчитывается по второму основанию - кнопка не единственный путь
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: false, priorNoShows: 1, wasOverdue: false }),
    'reminded_risky'
  );
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: false, priorNoShows: 0, wasOverdue: true }),
    'returned_overdue'
  );
});

test('обычный визит без признаков риска не засчитывается', () => {
  // Человек в сроке, без неявок, просто пришёл по записи. Напоминание ему ушло, но
  // приписывать его возврату нельзя - он и так собирался прийти
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: false, priorNoShows: 0, wasOverdue: false }),
    null
  );
});

test('один визит засчитывается один раз, по самому сильному основанию', () => {
  // Все три признака сразу - основание одно, самое надёжное
  assert.equal(
    classifyReturn({ messageSent: true, clientConfirmed: true, priorNoShows: 5, wasOverdue: true }),
    'confirmed'
  );
});

test('сумма раскладывается по основаниям и сходится с общей', () => {
  const visits = [
    { reason: 'confirmed', amount: 1000 },
    { reason: 'confirmed', amount: 500 },
    { reason: 'reminded_risky', amount: 2000 },
    { reason: 'returned_overdue', amount: 3000 },
  ];
  const s = summarizeReturned({ visits, hasMessaging: true });
  assert.equal(s.total, 6500);
  assert.equal(s.byReason.confirmed, 1500);
  assert.equal(s.byReason.reminded_risky, 2000);
  assert.equal(s.byReason.returned_overdue, 3000);
  assert.equal(s.count, 4);
});

test('нет отправленных сообщений - null, а не ноль', () => {
  // Тот же принцип, что у «Недополученной прибыли»: «бот ещё не заговорил» и
  // «мы ничего не вернули» - разные сообщения владельцу, и первое из второго не
  // выводится. Ноль на этом месте означал бы, что система работала и не справилась
  const s = summarizeReturned({ visits: [], hasMessaging: false });
  assert.equal(s.total, null);
  assert.equal(s.count, 0);
});

test('сообщения были, но ни один визит не засчитан - честный ноль', () => {
  const s = summarizeReturned({ visits: [], hasMessaging: true });
  assert.equal(s.total, 0);
  assert.equal(s.count, 0);
});

test('состав оснований зафиксирован', () => {
  assert.deepEqual([...RETURN_REASONS], ['confirmed', 'reminded_risky', 'returned_overdue']);
});
