// Контракт разметки расписания на трёх CRM-страницах. Окно 65 (21.08.2026) переписал
// его целиком: Неделя и Месяц больше не свои сетки, а один компонент "график работы"
// (матрица мастера × даты, assets/crm-schedule-matrix.js), поэтому проверять теперь
// нужно не порядок переключателя мастера и легенды, а что на КАЖДОЙ странице есть
// узлы, которые ищут модули, и что удалённое не осталось висеть в вёрстке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CRM_PAGES = ['crm-owner.html', 'crm-admin.html', 'crm-master.html'];
const TEAM_PAGES = ['crm-owner.html', 'crm-admin.html'];
const read = (page) => readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');

test('полоска дней есть на всех CRM-страницах и лежит ВНУТРИ панели «День»', () => {
  for (const page of CRM_PAGES) {
    const html = read(page);
    const dayPanel = html.indexOf('class="seg-panel panel-sp-day"');
    const strip = html.indexOf('id="dayStrip"');
    const weekPanel = html.indexOf('class="seg-panel panel-sp-week"');
    assert.ok(dayPanel >= 0, `${page}: панель дня`);
    assert.ok(strip > dayPanel, `${page}: полоска после начала панели дня`);
    assert.ok(strip < weekPanel, `${page}: полоска до панели недели (иначе висит на всех вкладках)`);
  }
});

test('период показан между стрелками навигации, а не отдельной лентой месяцев', () => {
  // Правка Влада 21.08.2026: лента «Июль Август Сентябрь…» убрана, показанный период
  // стоит между ‹ и › - как дата во вкладке «День». Порядок узлов и проверяем.
  for (const page of CRM_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /monthStrip|month-strip/, `${page}: лента месяцев должна быть удалена`);
    for (const view of ['week', 'month']) {
      const prev = html.indexOf(`id="${view}NavPrev"`);
      const label = html.indexOf(`id="${view}NavLabel"`);
      const next = html.indexOf(`id="${view}NavNext"`);
      assert.ok(prev >= 0 && label > prev && next > label, `${page}: подпись ${view} между стрелками`);
    }
  }
});

test('дублирующих подписей-якорей в шапках карточек не осталось', () => {
  // «Неделя · 17-23 августа» в шапке говорила то же, что подпись между стрелками
  const html = read('crm-owner.html');
  assert.doesNotMatch(html, /scheduleAnchor-week|scheduleAnchor-month/);
});

test('переключатели мастера удалены вместе со своей причиной существовать', () => {
  // Матрица показывает всю команду сразу, выбирать одного мастера больше незачем.
  // Забытый в разметке пустой .master-switch-row остался бы мёртвым отступом.
  for (const page of CRM_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /id="weekMasterSwitch"/, page);
    assert.doesNotMatch(html, /id="monthMasterSwitch"/, page);
  }
});

test('легенды над сеткой нет ни на одной странице', () => {
  // Убрана 21.08.2026 по просьбе Влада: три строки пояснений съедали экран на телефоне,
  // а признаки читаются с самой ячейки (штриховка - выходной, полоса слева - правка).
  // Подсказка про клик осталась в title каждой ячейки (assets/crm-schedule-matrix.js).
  for (const page of CRM_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /sm-legend/, page);
    assert.doesNotMatch(html, /Полоса слева/, page);
    assert.doesNotMatch(html, /Штриховка - выходной/, page);
    assert.doesNotMatch(html, /day-legend/, page);
  }
});

test('текстовая подсказка про общую загрузку команды не вернулась', () => {
  for (const page of CRM_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /Процент показывает общую загрузку команды за день/, page);
    assert.doesNotMatch(html, /id="monthAggregateHint"/, page);
  }
});
