import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthModeHintState } from '../assets/crm-schedule-view-month.js';

test('регрессия: в режиме «Все мастера» статусная легенда скрыта, подсказка агрегата видна', () => {
  assert.deepEqual(monthModeHintState('all'), {
    statusLegendHidden: true,
    aggregateHintHidden: false,
  });
});

test('регрессия: в режиме «По одному» статусная легенда видна, подсказка агрегата скрыта', () => {
  assert.deepEqual(monthModeHintState('single'), {
    statusLegendHidden: false,
    aggregateHintHidden: true,
  });
});
