// Окно 65 (21.08.2026), правка «сделай Неделю и Месяц как День». Дорожка расписания в
// «Дне» (.schedule-track) и ячейка графика работы (.sm-cell) обязаны красться ОДНИМИ
// переменными: до этой правки цвета стояли литералами в двух файлах, и в светлой теме
// они разошлись - у дорожки #FFFDF7, у ячейки #F7F3E9 (замер живьём, жалоба Влада
// «фон карточек не как в Дне»). Тест держит единый источник, а живой прогон
// (tools/verify-2026-08-21-okno65-grafik-raboty.mjs) отдельно сверяет вычисленный цвет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');
const MOCKUP = read('mockup-crm.css');
const SHELL = read('crm-app-shell.css');
const DAYLIGHT = read('crm-theme-daylight.css');

function ruleBody(css, selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, `правило ${selector} не найдено`);
  return css.slice(start, css.indexOf('}', start));
}

test('дорожка "Дня" красится переменными --track-*, а не литералами', () => {
  assert.match(ruleBody(MOCKUP, '.schedule-track'), /background-color:\s*var\(--track-bg\)/);
  assert.match(ruleBody(MOCKUP, '.schedule-track.day-off'), /background-color:\s*var\(--track-off-bg\)/);
  assert.match(ruleBody(MOCKUP, '.schedule-track.day-off'), /var\(--track-off-stripe\)/);
  assert.match(ruleBody(MOCKUP, '.schedule-track.no-schedule'), /background-color:\s*var\(--track-none-bg\)/);
});

test('ячейка графика работы берёт те же переменные, что дорожка', () => {
  assert.match(ruleBody(SHELL, '.sm-cell'), /background:\s*var\(--track-bg\)/);
  assert.match(ruleBody(SHELL, '.sm-cell--off'), /background-color:\s*var\(--track-off-bg\)/);
  assert.match(ruleBody(SHELL, '.sm-cell--off'), /var\(--track-off-stripe\)/);
  assert.match(ruleBody(SHELL, '.sm-cell.is-missing'), /background:\s*var\(--track-none-bg\)/);
});

test('светлая тема переопределяет переменные, а не каждое место по отдельности', () => {
  for (const name of ['--track-bg', '--track-off-bg', '--track-off-stripe', '--track-none-bg']) {
    assert.match(DAYLIGHT, new RegExp(`${name}:`), `${name} не задан в светлой теме`);
  }
  // Литерального фона у дорожки в теме остаться не должно - иначе он снова разойдётся
  // с ячейкой, которая его не видит
  assert.doesNotMatch(ruleBody(DAYLIGHT, '.schedule-track'), /background-color:/);
});

test('обе темы задают все четыре переменные дорожки', () => {
  for (const name of ['--track-bg', '--track-off-bg', '--track-off-stripe', '--track-none-bg']) {
    assert.match(MOCKUP, new RegExp(`${name}:`), `${name} не задан в базовой (тёмной) теме`);
  }
});
