import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('solo-режим расписания определяется ролью мастера, а не удалённым DOM-маркером', async () => {
  for (const path of ['assets/crm-schedule-views.js', 'assets/crm-calendar.js']) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.match(source, /staff\.role === ['"]master['"]/);
    assert.doesNotMatch(source, /walkinSoloTrigger/);
  }
});
