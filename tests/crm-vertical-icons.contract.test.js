// Иконки и заливка кнопок в кабинете клиники (31.08.2026, две находки Влада на
// боевом кабинете Карины):
//   1. кнопки «Включить уведомления» и «Добавить» в процедурах читались пустой
//      пилюлей - молочный текст на молочной заливке;
//   2. «Команда» и «Процедуры и время» стояли с ножницами барбершопа.
// Тест держит обе правки и, что важнее, держит правило отката: у Алихана (вертикаль
// barbershop) не меняется ни иконка, ни цвет.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ICON_SERVICES, ICON_TEAM, ICON_SERVICES_CLINIC, ICON_TEAM_CLINIC, verticalIcon } from '../assets/crm-icons.js';

const root = new URL('../', import.meta.url);

test('клиника получает свои иконки, барбершоп - прежние ножницы', () => {
  assert.equal(verticalIcon('team', 'clinic'), ICON_TEAM_CLINIC);
  assert.equal(verticalIcon('services', 'clinic'), ICON_SERVICES_CLINIC);
  assert.equal(verticalIcon('team', 'barbershop'), ICON_TEAM);
  assert.equal(verticalIcon('services', 'barbershop'), ICON_SERVICES);
  // Ножницы в клинике - ровно та жалоба, ради которой правка и сделана
  assert.notEqual(verticalIcon('team', 'clinic'), ICON_TEAM);
  assert.notEqual(verticalIcon('services', 'clinic'), ICON_SERVICES);
});

test('неизвестная вертикаль открывается барбершопной иконкой, а не пустым местом', () => {
  for (const vertical of ['dental', '', undefined, null]) {
    assert.equal(verticalIcon('team', vertical), ICON_TEAM);
    assert.equal(verticalIcon('services', vertical), ICON_SERVICES);
  }
  assert.equal(verticalIcon('nosuchkey', 'clinic'), '');
});

test('иконки клиники нарисованы тем же line-art набором', () => {
  for (const icon of [ICON_TEAM_CLINIC, ICON_SERVICES_CLINIC]) {
    assert.match(icon, /viewBox="0 0 20 20"/);
    assert.match(icon, /stroke="currentColor"/);
    assert.match(icon, /stroke-width="1\.6"/);
  }
});

test('сайдбар берёт иконку команды по вертикали и пересобирает её, когда приедет словарь', async () => {
  const js = await readFile(new URL('assets/crm-app-shell.js', root), 'utf8');
  assert.match(js, /verticalIcon\('team', currentAppearance\(\)\.vertical\)/);
  assert.match(js, /team: teamIcon\(\)/);
  assert.doesNotMatch(js, /ICON_TEAM\b/);
  // Пересборка иконки внутри обработчика crm:appearance - без неё до перезагрузки
  // страницы в меню оставались бы ножницы из запасного словаря
  const handler = js.slice(js.indexOf("document.addEventListener('crm:appearance'"));
  assert.match(handler, /\.app-nav-icon/);
  assert.match(handler, /icon\.innerHTML = activeConfig\.icon\[id\]/);
});

test('главная кнопка в теме клиники залита графитом, а не молоком на молоке', async () => {
  const css = await readFile(new URL('assets/crm-theme-clinic.css', root), 'utf8');
  const rule = css.match(/\[data-theme="clinic"\] \.btn-primary,\n\[data-theme="clinic"\] button\.btn-primary,[^}]*\}/);
  assert.ok(rule, 'нет правила заливки главной кнопки в теме клиники');
  assert.match(rule[0], /background:\s*var\(--accent\)/);
  assert.match(rule[0], /color:\s*var\(--leather\)/);
  // Выключенная кнопка не должна остаться чёрной пилюлей
  assert.match(css, /\[data-theme="clinic"\] \.btn-primary:disabled/);
  // Правило висит на теме - у Алихана оно не применяется вовсе
  assert.doesNotMatch(css, /\n\.btn-primary\s*\{/);
});
