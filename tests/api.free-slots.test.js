// Свободные начала визита (01.09.2026, виджет записи на сайте клиента).
//
// Сетка слотов до этого жила только в клиентском storage.js. Перенос на сервер
// имеет смысл лишь при одном условии: правила должны совпасть с теми, что уже
// работают у Алихана, иначе сайт покажет время, которое сервер откажется писать.
import assert from 'node:assert/strict';
import test from 'node:test';
import { freeSlotsFor } from '../api/lib/schedule-core.js';

const day = { startTime: '10:00', endTime: '14:00', breaks: [] };
// Полдень 1 сентября по Москве = 09:00 UTC. Все проверки ниже - на будущую дату,
// чтобы отсечение прошедшего времени не мешало проверять остальные правила
const NOW = new Date('2026-09-01T09:00:00Z');
const FUTURE = '2026-09-10';

test('час услуги в четырёхчасовом окне - слоты через 15 минут до последнего влезающего', () => {
  const slots = freeSlotsFor(day, [], 60, FUTURE, 15, NOW);
  assert.equal(slots[0], '10:00');
  assert.equal(slots.at(-1), '13:00', 'последний слот должен закончиться ровно в 14:00');
  assert.ok(slots.includes('10:15') && slots.includes('12:45'));
});

test('чужая бронь закрывает пересекающиеся слоты, отменённая - нет', () => {
  const busy = [{ startTime: '11:00', endTime: '12:00', status: 'planned' }];
  const slots = freeSlotsFor(day, busy, 60, FUTURE, 15, NOW);
  assert.ok(!slots.includes('10:30'), 'слот, наезжающий на бронь, предложен');
  assert.ok(!slots.includes('11:00'));
  assert.ok(slots.includes('12:00'), 'время сразу после брони свободно');

  const cancelled = [{ startTime: '11:00', endTime: '12:00', status: 'cancelled' }];
  assert.ok(freeSlotsFor(day, cancelled, 60, FUTURE, 15, NOW).includes('11:00'),
    'отменённая бронь навсегда блокировала своё время - эту ошибку уже ловили в storage.js');
});

test('перерыв врача закрывает время так же, как бронь', () => {
  const withBreak = { ...day, breaks: [{ startTime: '12:00', endTime: '13:00' }] };
  const slots = freeSlotsFor(withBreak, [], 60, FUTURE, 15, NOW);
  assert.ok(!slots.includes('11:30') && !slots.includes('12:00'));
  assert.ok(slots.includes('13:00'));
});

test('сегодняшнее прошедшее время не предлагается - и считается по Москве', () => {
  // Сервер живёт в UTC. Без пересчёта на московское время «сейчас» уехало бы на
  // три часа, и в 12:00 по Ставрополю виджет предлагал бы записаться на 10:00
  const today = '2026-09-01';
  const wide = { startTime: '08:00', endTime: '20:00', breaks: [] };
  const slots = freeSlotsFor(wide, [], 60, today, 15, NOW); // NOW = 12:00 по Москве
  assert.ok(!slots.includes('10:00'), 'предложено уже прошедшее время');
  assert.ok(!slots.includes('12:00'), 'текущая минута тоже не предлагается');
  assert.equal(slots[0], '12:15', `первый слот ${slots[0]}, а должен быть сразу после «сейчас»`);
});

test('услуга длиннее рабочего окна - слотов нет, а не ошибка', () => {
  assert.deepEqual(freeSlotsFor(day, [], 300, FUTURE, 15, NOW), []);
});
