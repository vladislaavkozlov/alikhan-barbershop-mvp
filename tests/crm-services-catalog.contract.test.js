// Каталог услуг/процедур собран формой, а не строкой описания (31.08.2026, правка
// Влада «очень костыльно выглядят формы заполнения данных в создании услуг/процедур»).
//
// Тест держит три вещи, каждая из которых уже ломалась:
//   1. карточка набрана компонентом .field с подписью над полем, а не инлайн-цифрами;
//   2. классы полей сохранены - на них завязаны чтение правок и валидация, и молчаливое
//      переименование класса означало бы «сохранение перестало видеть изменения»;
//   3. селектор карточки в разметке и в коде, который её ищет, - один и тот же.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const js = await readFile(new URL('assets/crm-services-catalog.js', root), 'utf8');
const shell = await readFile(new URL('assets/crm-app-shell.css', root), 'utf8');
const mockup = await readFile(new URL('assets/mockup-crm.css', root), 'utf8');

test('карточка услуги - форма из .field с подписями над полями', () => {
  assert.match(js, /class="field service-card-name"/);
  for (const label of ['Название', 'Цена, ₽', 'Время, мин']) {
    assert.match(js, new RegExp(`>${label}</label>`));
  }
  // Подпись связана с полем: иначе она остаётся картинкой над полем и не читается
  // с экрана
  for (const field of ['name', 'price', 'duration']) {
    assert.match(js, new RegExp(`for="svc-${field}-\\$\\{id\\}"`));
    assert.match(js, new RegExp(`id="svc-${field}-\\$\\{id\\}"`));
  }
  // Единицы переехали в подписи, значков-приписок рядом с цифрой больше нет
  assert.doesNotMatch(js, /sc-price-unit|sc-duration-unit|sc-dot|sc-meta/);
});

test('классы полей сохранены - чтение правок и валидация продолжают их находить', () => {
  for (const cls of ['sc-name-input', 'sc-price-input', 'sc-duration-input']) {
    const inMarkup = new RegExp(`class="${cls}"`);
    const inReader = new RegExp(`querySelector\\('\\.${cls}'\\)`);
    assert.ok(inMarkup.test(js), `${cls} пропал из разметки`);
    assert.ok(inReader.test(js), `${cls} не читается в readTile`);
  }
});

test('разметка карточки и селекторы кода говорят об одном классе', () => {
  assert.match(js, /class="service-card" data-service-id=/);
  const selectors = [...js.matchAll(/querySelectorAll\('([^']*data-service-id[^']*)'\)/g)].map((m) => m[1]);
  assert.ok(selectors.length >= 2, 'карточки перестали искаться по data-service-id');
  for (const selector of selectors) {
    assert.match(selector, /^\.service-card\[data-service-id\]$/);
  }
  assert.match(js, /list\.className = services\.length \? 'service-cards'/);
  // Слово service-check остаётся в шапке файла как история правки, но ни разметкой,
  // ни селектором старого компонента больше нет
  assert.doesNotMatch(js, /class="service-check/);
  assert.doesNotMatch(js, /'\.service-check/);
});

test('стили формы существуют, а стилей старой плитки каталога не осталось', () => {
  assert.match(shell, /\.service-cards \{/);
  assert.match(shell, /\.service-card \{/);
  assert.match(shell, /\.service-card-row \{/);
  assert.doesNotMatch(shell, /service-check--catalog/);
  // Одна колонка на телефоне: две колонки полей в 320px не живут
  assert.match(shell, /@media \(max-width: 640px\) \{\s*\.service-cards \{ grid-template-columns: 1fr; \}/);
});

test('инлайн-цифры в карточке сотрудника перевешивают заливку светлых тем', () => {
  const rule = mockup.match(/\.service-picker \.service-check input\.sc-price-input,\n\.service-picker \.service-check input\.sc-duration-input \{[^}]*\}/);
  assert.ok(rule, 'нет правила, возвращающего инлайн-полям прозрачный фон');
  assert.match(rule[0], /background: transparent/);
  // Цена пятизначная и шестизначная должна помещаться: 46px обрезали «10000»
  const width = mockup.match(/\.service-picker \.service-check input\.sc-price-input \{ width: (\d+)px; \}/);
  assert.ok(width && Number(width[1]) >= 60, 'поле цены снова слишком узкое');
});
