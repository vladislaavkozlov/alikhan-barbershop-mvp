// Этап B: две ловушки, на которых я уже споткнулся (24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// 1. Подпись, собранная КОНСТАНТОЙ модуля, вычисляется при импорте - то есть раньше,
//    чем словарь вертикали приедет с сервера. Слово застывает барбершопным, и врач
//    видит «мастер» до перезагрузки страницы. Поэтому такие таблицы переведены в
//    функции: `const roleLabels = () => ({...})`.
// 2. Переведя таблицу в функцию, легко забыть поправить обращения к ней. Так и
//    случилось: `roleLabel[role]` осталось в трёх местах, и раздел «Команда» у
//    владельца и администратора падал с «roleLabel is not defined». Поймала это
//    сверка экранов до и после, а не тесты - значит теста не хватало.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../assets/', import.meta.url);

test('таблица-функция нигде не используется как объект', async () => {
  const problems = [];
  for (const file of (await readdir(ROOT)).filter((f) => f.endsWith('.js'))) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    for (const match of source.matchAll(/^const (\w+) = \(\) => /gm)) {
      const name = match[1];
      if (new RegExp(`\\b${name}\\[`).test(source)) problems.push(`${file}: ${name}[...] вместо ${name}()[...]`);
    }
  }
  assert.deepEqual(problems, []);
});

test('словарь вертикали не зовётся на верхнем уровне модуля', async () => {
  const problems = [];
  for (const file of (await readdir(ROOT)).filter((f) => f.endsWith('.js'))) {
    if (file === 'crm-terms.js') continue;
    const source = await readFile(new URL(file, ROOT), 'utf8');
    let depth = 0;
    source.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
      // Вызов словаря на нулевой глубине скобок = он выполнится при импорте модуля.
      // Стрелка на той же строке до вызова означает отложенный вызов - это как раз
      // тот вид, к которому такие таблицы и приводились
      const call = line.search(/(?:^|[^\w.])(?:T|Tc|P|C)\(/);
      const arrow = line.indexOf('=>');
      const deferred = arrow !== -1 && arrow < call;
      if (!isComment && depth === 0 && call !== -1 && !deferred && !line.startsWith('import')) {
        problems.push(`${file}:${index + 1}: ${trimmed.slice(0, 70)}`);
      }
      if (!isComment) for (const ch of line) {
        if ('{(['.includes(ch)) depth += 1;
        if ('})]'.includes(ch)) depth -= 1;
      }
    });
  }
  assert.deepEqual(problems, [], 'подпись вычислится до прихода словаря и застынет барбершопной');
});
