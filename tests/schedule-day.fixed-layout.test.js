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
  assert.match(rowStyles, /width:\s*max-content/);
  assert.match(rowStyles, /min-width:\s*100%/);
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
