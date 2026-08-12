import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthWeekdayHeaderHtml } from '../assets/crm-schedule-view-month.js';

const CRM_PAGES = ['crm-owner.html', 'crm-admin.html', 'crm-master.html'];
const TEAM_PAGES = ['crm-owner.html', 'crm-admin.html'];

test('месяц: сетка начинается с заголовков дней недели Пн-Вс', () => {
  const html = monthWeekdayHeaderHtml();
  assert.deepEqual(
    [...html.matchAll(/class="month-weekday"[^>]*>([^<]+)</g)].map((match) => match[1]),
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  );
});

test('месяц: текстовая подсказка про общую загрузку удалена со всех CRM-страниц', () => {
  for (const page of CRM_PAGES) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /Процент показывает общую загрузку команды за день/, page);
    assert.doesNotMatch(html, /id="monthAggregateHint"/, page);
  }
});

test('месяц: легенда владельца и администратора расположена после выбора мастера и перед сеткой', () => {
  for (const page of TEAM_PAGES) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const switchIndex = html.indexOf('id="monthMasterSwitch"');
    const legendIndex = html.indexOf('id="monthStatusLegend"');
    const gridIndex = html.indexOf('id="monthGrid"');
    assert.ok(switchIndex >= 0 && switchIndex < legendIndex, page);
    assert.ok(legendIndex < gridIndex, page);
  }
});

test('месяц: легенда мастера остаётся перед календарной сеткой', () => {
  const html = readFileSync(new URL('../crm-master.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('day-legend') < html.indexOf('id="monthGrid"'));
});
