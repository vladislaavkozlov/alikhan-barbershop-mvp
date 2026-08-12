import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthModeHintState } from '../assets/crm-schedule-view-month.js';

test('регрессия: в режиме «Все мастера» статусная легенда скрыта', () => {
  assert.deepEqual(monthModeHintState('all'), {
    statusLegendHidden: true,
  });
});

test('регрессия: в режиме «По одному» статусная легенда видна', () => {
  assert.deepEqual(monthModeHintState('single'), {
    statusLegendHidden: false,
  });
});
