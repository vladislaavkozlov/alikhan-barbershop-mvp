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

test('лента месяцев есть на всех страницах и стоит перед сеткой месяца', () => {
  for (const page of CRM_PAGES) {
    const html = read(page);
    const stripIndex = html.indexOf('id="monthStrip"');
    const gridIndex = html.indexOf('id="monthGrid"');
    assert.ok(stripIndex >= 0, `${page}: лента месяцев`);
    assert.ok(stripIndex < gridIndex, `${page}: лента перед сеткой`);
  }
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

test('легенда показывает ровно те признаки, что есть в ячейках матрицы', () => {
  // Прежняя легенда из трёх цветных точек (.day-dot) объясняла разметку СТАРОЙ сетки
  // месяца - в матрице точек нет, статус несёт сама ячейка (полоса слева у правки,
  // пунктир у выходного). Легенда, объясняющая несуществующее, хуже отсутствующей.
  for (const page of CRM_PAGES) {
    const html = read(page);
    const legendIndex = html.indexOf('sm-legend', html.indexOf('panel-sp-month'));
    const gridIndex = html.indexOf('id="monthGrid"');
    assert.ok(legendIndex >= 0 && legendIndex < gridIndex, page);
    const legend = html.slice(legendIndex, gridIndex);
    assert.match(legend, /sm-legend-chip--edit/, page);
    assert.match(legend, /sm-legend-chip--off/, page);
    assert.doesNotMatch(legend, /day-dot--work/, `${page}: точка "обычный день" в матрице ничего не обозначает`);
  }
});

test('у владельца и админа Неделя объясняет, что делает клик по ячейке и по дате', () => {
  // Ячейка открывает редактор графика, шапка даты уводит в «День» - это не угадывается
  // по виду, поэтому подпись обязана быть в разметке, а не только в title элементов.
  for (const page of TEAM_PAGES) {
    const html = read(page);
    const weekPanel = html.slice(html.indexOf('panel-sp-week'), html.indexOf('id="weekGrid"'));
    assert.match(weekPanel, /нажмите на ячейку/i, page);
  }
});

test('текстовая подсказка про общую загрузку команды не вернулась', () => {
  for (const page of CRM_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /Процент показывает общую загрузку команды за день/, page);
    assert.doesNotMatch(html, /id="monthAggregateHint"/, page);
  }
});
