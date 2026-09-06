import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../assets/mockup-crm.css', import.meta.url), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

test('День: контейнер прокручивается только горизонтально', () => {
  const styles = rule('.panel-sp-day .schedule-scroll');
  assert.match(styles, /overflow-x:\s*auto/);
  assert.match(styles, /overflow-y:\s*hidden/);
});

test('День: высота резервируется до загрузки и одинакова у всех колонок', () => {
  assert.match(rule('.panel-sp-day .schedule-grid'), /min-height:\s*748px/);
  assert.match(rule('.panel-sp-day .schedule-col'), /height:\s*748px/);
  assert.match(rule('.panel-sp-day .schedule-col-head'), /height:\s*98px/);
  assert.match(rule('.panel-sp-day .schedule-col-head'), /box-sizing:\s*border-box/);
});

test('День: шкала времени закреплена слева без непрозрачного столба над сеткой', () => {
  const styles = rule('.panel-sp-day .hour-gutter');
  const rowStyles = rule('.panel-sp-day .schedule-row-with-gutter');
  assert.match(styles, /position:\s*sticky/);
  assert.match(styles, /left:\s*0/);
  assert.match(styles, /z-index:\s*\d+/);
  assert.match(styles, /background:\s*transparent/);
  assert.match(styles, /box-shadow:\s*none/);
  // Ширину строки задаёт область прокрутки, а не содержимое (правка 06.09.2026).
  // Раньше здесь стоял width:max-content, и колонку растягивал самый длинный текст в
  // карточке записи: на телефоне колонка врача уезжала за правый край экрана. Теперь
  // разъезжается сетка - по минимуму колонок, то есть от числа врачей
  assert.match(rowStyles, /width:\s*100%/);
  assert.doesNotMatch(rowStyles, /max-content/);
});

test('День: колонки разъезжаются от числа врачей, а не от длины текста в записи', () => {
  // Минимум колонки живёт в .schedule-grid и остаётся единственным, что включает
  // горизонтальную прокрутку: три колонки по 220px не помещаются в телефон и дают
  // скролл, одна занимает всю доступную ширину
  assert.match(rule('.schedule-grid'), /grid-auto-columns:\s*minmax\(220px,\s*1fr\)/);
  assert.match(rule('.panel-sp-day .schedule-row-with-gutter > .schedule-grid'), /min-width:\s*0/);
});

test('День: полупрозрачная панель часов ограничена дорожкой и не обрезает 10:00 или 20:00', () => {
  const marks = rule('.panel-sp-day .hour-marks');
  assert.match(marks, /box-sizing:\s*border-box/);
  assert.match(marks, /background:\s*color-mix\([^;]+transparent\)/);
  assert.match(marks, /backdrop-filter:\s*blur\(/);
  assert.match(marks, /border-radius:\s*10px/);
  assert.match(rule('.panel-sp-day .hour-marks span:first-child'), /transform:\s*translateY\(0\)/);
  const lastMark = rule('.panel-sp-day .hour-marks span:last-child');
  assert.match(lastMark, /top:\s*calc\(100%\s*-\s*1px\)\s*!important/);
  assert.match(lastMark, /transform:\s*translateY\(-100%\)/);
});
