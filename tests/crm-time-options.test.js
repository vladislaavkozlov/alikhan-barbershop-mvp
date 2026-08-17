// 17.08.2026 - «круглосуточно» в разделе «Команда» (Влад). Единственный источник
// опций всех time-пикеров CRM - SHOP_TIME_OPTIONS (assets/crm-widgets.js): пока он
// шёл от 10:00 до 20:00, ночной график физически нельзя было выбрать ни в графике,
// ни в перерыве, ни в форме записи.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHOP_TIME_OPTIONS } from '../assets/crm-widgets.js';

test('список времени покрывает полные сутки шагом 15 минут', () => {
  assert.equal(SHOP_TIME_OPTIONS[0], '00:00');
  assert.equal(SHOP_TIME_OPTIONS[1], '00:15');
  assert.ok(SHOP_TIME_OPTIONS.includes('02:30'));
  assert.ok(SHOP_TIME_OPTIONS.includes('10:00'));
  assert.ok(SHOP_TIME_OPTIONS.includes('20:00'));
  assert.ok(SHOP_TIME_OPTIONS.includes('23:45'));
  // 96 четвертей суток + отдельная 23:59
  assert.equal(SHOP_TIME_OPTIONS.length, 97);
});

test('последнее значение - 23:59: конец смены «до полуночи» выбирается явно', () => {
  assert.equal(SHOP_TIME_OPTIONS.at(-1), '23:59');
});

test('значения идут по возрастанию без дублей', () => {
  const asMin = SHOP_TIME_OPTIONS.map((t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  });
  assert.deepEqual(asMin, [...new Set(asMin)]);
  assert.deepEqual(asMin, [...asMin].sort((a, b) => a - b));
});

test('длинный список открывается прокрученным к выбранному значению', () => {
  // 97 опций против max-height 220px (.custom-select-list, mockup-crm.css): без
  // прокрутки к выбранному владелец видит начало суток и не находит 23:00
  const js = readFileSync(new URL('../assets/mockup-crm.js', import.meta.url), 'utf8');
  const open = js.match(/function openCustomSelect\(wrap\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(open, /\.custom-select-option\.selected/);
  assert.match(open, /scrollTop/);
});
