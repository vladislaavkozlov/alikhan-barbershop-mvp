import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleExceptionBreaks } from '../api/routes/schedule.js';

test('разовый выходной блокирует всё действующее рабочее окно', () => {
  assert.deepEqual(scheduleExceptionBreaks('dayOff', { startTime: '09:00', endTime: '18:00' }), [{ startTime: '09:00', endTime: '18:00' }]);
});

test('разовый перерыв принимает только интервал внутри смены', () => {
  assert.deepEqual(scheduleExceptionBreaks('break', { startTime: '10:00', endTime: '20:00' }, '13:00', '14:00'), [{ startTime: '13:00', endTime: '14:00' }]);
  assert.equal(scheduleExceptionBreaks('break', { startTime: '10:00', endTime: '20:00' }, '09:00', '11:00'), null);
  assert.equal(scheduleExceptionBreaks('break', { startTime: '10:00', endTime: '20:00' }, '14:00', '13:00'), null);
});
