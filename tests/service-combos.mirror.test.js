// Влад, 16.08.2026: "если выбрать просто 'Борода' и 'Стрижка + борода', он позволит
// это сохранить. Тоже самое с бритьем... можно выбрать 'борода' + 'бритье' +
// 'стрижка + борода'".
//
// Правило блокировки было односторонним: оно запрещало добавить составляющую ПОСЛЕ
// комплекса, но не разбирало обратный порядок. Здесь проверяется, что выбор теперь
// сходится к одному и тому же набору независимо от порядка кликов, и что серверная
// копия правил не разъехалась с фронтовой.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SERVICE_COMBOS,
  toggleServiceSelection,
  absorbComboComponents,
  hasComboConflict,
  isServiceBlockedByCombo,
} from '../storage.js';
import { SERVICE_COMBOS as SERVER_COMBOS, hasComboConflict as serverHasComboConflict } from '../api/lib/service-combos.js';

const KOMPLEKS = 'kompleks-strizhka-boroda';
const ids = (set) => [...set].sort();
const pick = (...clicks) => clicks.reduce((acc, id) => toggleServiceSelection(id, acc), new Set());

test('комплекс поглощает услугу, выбранную ДО него (баг Влада)', () => {
  assert.deepEqual(ids(pick('boroda', KOMPLEKS)), [KOMPLEKS]);
  assert.deepEqual(ids(pick('britie', KOMPLEKS)), [KOMPLEKS]);
  assert.deepEqual(ids(pick('firmennaya-okantovka', KOMPLEKS)), [KOMPLEKS]);
  // Тот самый набор из жалобы: борода + бритьё + комплекс
  assert.deepEqual(ids(pick('boroda', 'britie', KOMPLEKS)), [KOMPLEKS]);
});

test('порядок кликов не меняет итог', () => {
  assert.deepEqual(ids(pick('strizhka', 'boroda')), [KOMPLEKS]); // слияние двух составляющих
  assert.deepEqual(ids(pick('boroda', 'strizhka')), [KOMPLEKS]);
  assert.deepEqual(ids(pick(KOMPLEKS, 'boroda')), [KOMPLEKS]); // добавить составляющую нельзя
  assert.deepEqual(ids(pick('boroda', KOMPLEKS)), [KOMPLEKS]); // а тут она поглощается
});

test('услуги вне комплекса живут рядом с ним как раньше', () => {
  assert.deepEqual(ids(pick(KOMPLEKS, 'vosk')), [KOMPLEKS, 'vosk']);
  assert.deepEqual(ids(pick('vosk', KOMPLEKS)), [KOMPLEKS, 'vosk']);
  assert.deepEqual(ids(pick('tonirovka', 'spa-uhod')), ['spa-uhod', 'tonirovka']);
});

test('повторный клик снимает услугу и ничего не сворачивает', () => {
  assert.deepEqual(ids(pick('vosk', 'vosk')), []);
  assert.deepEqual(ids(pick('boroda', KOMPLEKS, KOMPLEKS)), []); // комплекс сняли - борода не возвращается
  assert.deepEqual(ids(pick('strizhka', 'strizhka', 'boroda')), ['boroda']);
});

test('исходный набор не мутируется', () => {
  const before = new Set(['boroda']);
  toggleServiceSelection(KOMPLEKS, before);
  assert.deepEqual(ids(before), ['boroda']);
});

test('ни один достижимый набор не остаётся противоречивым', () => {
  const all = ['strizhka', 'boroda', KOMPLEKS, 'britie', 'firmennaya-okantovka', 'tonirovka', 'vosk', 'spa-uhod'];
  // Все перестановки из трёх кликов - грубая, но исчерпывающая проверка того, что
  // до противоречия нельзя дойти вообще никаким путём
  for (const a of all) {
    for (const b of all) {
      for (const c of all) {
        const set = pick(a, b, c);
        assert.equal(hasComboConflict(set), false, `${a} → ${b} → ${c} дало ${ids(set).join(' + ')}`);
      }
    }
  }
});

test('hasComboConflict видит противоречие в готовом наборе (записи до 16.08.2026)', () => {
  assert.equal(hasComboConflict([KOMPLEKS, 'boroda']), true);
  assert.equal(hasComboConflict(['strizhka', KOMPLEKS]), true);
  assert.equal(hasComboConflict([KOMPLEKS, 'vosk']), false);
  assert.equal(hasComboConflict(['strizhka', 'boroda']), false); // не свёрнуто, но и не противоречиво
  assert.equal(hasComboConflict([]), false);
});

test('absorbComboComponents только убирает лишнее, ничего не добавляя', () => {
  assert.deepEqual(ids(absorbComboComponents([KOMPLEKS, 'boroda', 'vosk'])), [KOMPLEKS, 'vosk']);
  assert.deepEqual(ids(absorbComboComponents(['boroda', 'vosk'])), ['boroda', 'vosk']);
  assert.equal(isServiceBlockedByCombo('vosk', new Set([KOMPLEKS])), false);
});

// Серверная копия правил (api/lib/service-combos.js) не импортируется из storage.js
// намеренно: на Amvera уезжает только содержимое api/. Значит копии обязан сверять тест.
test('серверные правила комбо совпадают с фронтовыми', () => {
  assert.deepEqual(SERVER_COMBOS, SERVICE_COMBOS);
  for (const set of [[KOMPLEKS, 'boroda'], [KOMPLEKS, 'britie'], [KOMPLEKS, 'vosk'], ['strizhka', 'boroda'], []]) {
    assert.equal(serverHasComboConflict(set), hasComboConflict(set), set.join('+'));
  }
});

test('сервер отказывает противоречивому составу на всех трёх входах', async () => {
  const source = await readFile(new URL('../api/routes/bookings.js', import.meta.url), 'utf8');
  // POST /bookings (запись с сайта), PUT /services (полный состав), PATCH /services (дописать)
  assert.equal((source.match(/hasComboConflict\(/g) || []).length, 3);
  assert.match(source, /error: 'combo_conflict'/);
});
